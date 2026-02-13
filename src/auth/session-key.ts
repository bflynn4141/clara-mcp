/**
 * Session Key Manager
 *
 * Generates an ephemeral secp256k1 keypair and creates a SIWE delegation
 * message binding the session public key to the wallet address.
 *
 * The session key enables per-request signing without hitting Para's MPC
 * infrastructure (~300ms) on every HTTP call. Instead, one MPC sign
 * establishes the delegation, and all subsequent requests are signed
 * locally with the ephemeral key (<1ms).
 *
 * Key lifecycle:
 * 1. First tool call → generate keypair + sign SIWE delegation via Para MPC
 * 2. All subsequent calls → sign requests locally with session key
 * 3. After 24h → delegation expires, re-create on next call
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { SiweMessage } from 'siwe';
import { getAddress } from 'viem';
import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────

export interface SessionKeyData {
  /** Ephemeral private key (32 bytes hex, no 0x prefix) */
  privateKey: string;
  /** Compressed public key (33 bytes hex, 0x prefixed) */
  publicKey: string;
  /** Uncompressed public key (65 bytes hex, 0x prefixed) */
  publicKeyUncompressed: string;
  /** SIWE delegation message (plaintext) */
  delegationMessage: string;
  /** Wallet signature over the SIWE message (0x prefixed) */
  delegationSignature: string;
  /** Unique session identifier */
  sessionId: string;
  /** When the session was created (ISO 8601) */
  issuedAt: string;
  /** When the session expires (ISO 8601) */
  expiresAt: string;
  /** Wallet address that signed the delegation */
  walletAddress: string;
}

/**
 * Sign function type — wraps Para MPC signing.
 * Takes a plaintext message, returns 0x-prefixed signature hex.
 */
export type SignMessageFn = (message: string) => Promise<string>;

/**
 * Options for session key creation.
 */
export interface SessionKeyOptions {
  /** Proxy URL — if provided, fetches server nonce and registers session with proxy */
  proxyUrl?: string;
}

// ─── In-memory cache ────────────────────────────────────

let cachedSessionKey: SessionKeyData | null = null;

// ─── Constants ──────────────────────────────────────────

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PROXY_DOMAIN = 'clara-proxy.bflynn-me.workers.dev';
const PROXY_URI = 'https://clara-proxy.bflynn-me.workers.dev';
const CHAIN_ID = 8453; // Base

// ─── Public API ─────────────────────────────────────────

/**
 * Get or create a session key for the given wallet.
 *
 * If a valid (non-expired) session key exists in cache, returns it.
 * Otherwise generates a new ephemeral keypair and signs a SIWE
 * delegation message via the provided signFn (Para MPC).
 */
export async function getOrCreateSessionKey(
  walletAddress: string,
  signFn: SignMessageFn,
  options?: SessionKeyOptions,
): Promise<SessionKeyData> {
  // Return cached key if still valid
  if (cachedSessionKey && !isExpired(cachedSessionKey)) {
    if (cachedSessionKey.walletAddress.toLowerCase() === walletAddress.toLowerCase()) {
      return cachedSessionKey;
    }
    // Different wallet — invalidate
    cachedSessionKey = null;
  }

  // Generate ephemeral keypair
  const privateKeyBytes = secp256k1.utils.randomSecretKey();
  const privateKey = Buffer.from(privateKeyBytes).toString('hex');
  const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, true); // compressed
  const publicKeyUncompressedBytes = secp256k1.getPublicKey(privateKeyBytes, false); // uncompressed
  const publicKey = '0x' + Buffer.from(publicKeyBytes).toString('hex');
  const publicKeyUncompressed = '0x' + Buffer.from(publicKeyUncompressedBytes).toString('hex');

  // Timestamps
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  // Get SIWE nonce: server-issued (prevents delegation replay) or local fallback for tests
  let nonce: string;
  if (options?.proxyUrl) {
    const nonceResp = await fetch(`${options.proxyUrl}/auth/nonce`);
    if (!nonceResp.ok) {
      throw new Error(`Failed to get server nonce: ${nonceResp.status}`);
    }
    const nonceData = await nonceResp.json() as { nonce: string };
    // SIWE nonces must be alphanumeric (EIP-4361). Strip hyphens in case
    // the proxy returns a UUID format like "b4400d23-937e-4618-..."
    nonce = nonceData.nonce.replace(/-/g, '');
  } else {
    nonce = crypto.randomBytes(16).toString('hex');
  }

  // Build SIWE delegation message
  // SIWE requires EIP-55 checksummed address
  const checksummedAddress = getAddress(walletAddress);
  const siweMessage = new SiweMessage({
    domain: PROXY_DOMAIN,
    address: checksummedAddress,
    statement: `Delegate HTTP request signing to session key: ${publicKey}`,
    uri: PROXY_URI,
    version: '1',
    chainId: CHAIN_ID,
    nonce,
    issuedAt: now.toISOString(),
    expirationTime: expiresAt.toISOString(),
    resources: [
      'urn:clara:scope:sign',
      'urn:clara:scope:send',
      'urn:clara:scope:message',
    ],
  });

  const messageText = siweMessage.prepareMessage();

  // Sign via Para MPC (the expensive operation — ~300ms, once per session)
  const delegationSignature = await signFn(messageText);

  // Register session with proxy to get a proxy-issued sessionId.
  // This completes the session lifecycle: the proxy validates the SIWE delegation
  // and creates a KV entry mapping sessionId → { publicKey, address, expiry }.
  let sessionId: string;
  let sessionExpiresAt: string;
  if (options?.proxyUrl) {
    const regResp = await fetch(`${options.proxyUrl}/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siweMessage: messageText,
        signature: delegationSignature,
        // Send COMPRESSED key — it must match what's embedded in the SIWE statement.
        // The proxy uses secp.verify which accepts both compressed/uncompressed formats.
        sessionPublicKey: publicKey,
      }),
    });
    if (!regResp.ok) {
      const errText = await regResp.text();
      throw new Error(`Session registration failed: ${regResp.status} - ${errText}`);
    }
    const regData = await regResp.json() as { sessionId: string; expiresAt: number };
    sessionId = regData.sessionId;
    sessionExpiresAt = new Date(regData.expiresAt).toISOString();
  } else {
    // Local mode (tests): generate locally
    sessionId = crypto.randomUUID();
    sessionExpiresAt = expiresAt.toISOString();
  }

  const sessionKeyData: SessionKeyData = {
    privateKey,
    publicKey,
    publicKeyUncompressed,
    delegationMessage: messageText,
    delegationSignature,
    sessionId,
    issuedAt: now.toISOString(),
    expiresAt: sessionExpiresAt,
    walletAddress,
  };

  cachedSessionKey = sessionKeyData;
  return sessionKeyData;
}

/**
 * Get the current session key without creating one.
 * Returns null if no session key exists or it's expired.
 */
export function getCurrentSessionKey(): SessionKeyData | null {
  if (!cachedSessionKey || isExpired(cachedSessionKey)) {
    return null;
  }
  return cachedSessionKey;
}

/**
 * Invalidate the current session key (e.g., on logout).
 */
export function clearSessionKey(): void {
  cachedSessionKey = null;
}

// ─── Internal ───────────────────────────────────────────

function isExpired(key: SessionKeyData): boolean {
  return new Date(key.expiresAt).getTime() <= Date.now();
}
