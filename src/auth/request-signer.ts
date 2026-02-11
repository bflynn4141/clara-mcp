/**
 * Request Signer
 *
 * Wraps fetch with per-request signing using the ephemeral session key.
 * Each request is signed with ECDSA secp256k1 over a canonical message
 * that includes the method, path, body digest, timestamp, and nonce.
 *
 * This prevents:
 * - Address spoofing (signature proves ownership of session key)
 * - Request tampering (body digest is signed)
 * - Replay attacks (nonce + timestamp in signed message)
 *
 * The proxy verifies signatures against the session's registered public key.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as crypto from 'crypto';
import type { SessionKeyData } from './session-key.js';

// ─── Types ──────────────────────────────────────────────

export interface SignedFetchOptions extends RequestInit {
  /** Override body for signing (when body is a stream or non-string) */
  bodyForSigning?: string;
}

// ─── Public API ─────────────────────────────────────────

/**
 * Make a signed HTTP request using the session key.
 *
 * Adds authentication headers:
 * - X-Clara-Address: wallet address
 * - X-Clara-Session: session ID (maps to delegation on proxy)
 * - X-Clara-Signature: ECDSA signature over canonical message
 * - X-Clara-Timestamp: unix seconds
 * - X-Clara-Nonce: UUID v4
 */
export async function signedFetch(
  url: string,
  options: SignedFetchOptions,
  sessionKey: SessionKeyData,
): Promise<Response> {
  const method = (options.method || 'GET').toUpperCase();
  const parsedUrl = new URL(url);
  // Include query string in signed path to prevent parameter tampering
  const path = parsedUrl.pathname + parsedUrl.search;

  // Get body content for digest
  const bodyContent = options.bodyForSigning
    ?? (typeof options.body === 'string' ? options.body : '');

  // Compute body digest
  const bodyDigest = sha256hex(bodyContent);

  // Timestamp and nonce
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();

  // Build canonical message
  const canonicalMessage = buildCanonicalMessage(
    method,
    path,
    bodyDigest,
    timestamp,
    nonce,
  );

  // Sign with session key
  const signature = signCanonicalMessage(canonicalMessage, sessionKey.privateKey);

  // Merge headers
  const headers = new Headers(options.headers);
  headers.set('X-Clara-Address', sessionKey.walletAddress);
  headers.set('X-Clara-Session', sessionKey.sessionId);
  headers.set('X-Clara-Signature', signature);
  headers.set('X-Clara-Timestamp', timestamp);
  headers.set('X-Clara-Nonce', nonce);

  return fetch(url, {
    ...options,
    headers,
  });
}

// ─── Canonical Message ──────────────────────────────────

/**
 * Build the canonical message for signing.
 *
 * Format (newline-separated):
 * ```
 * CLARA-REQUEST-SIG-V1
 * {METHOD}
 * {PATH}
 * sha256:{bodyDigestHex}
 * {unixTimestamp}
 * {nonce}
 * ```
 */
export function buildCanonicalMessage(
  method: string,
  path: string,
  bodyDigest: string,
  timestamp: string,
  nonce: string,
): string {
  return [
    'CLARA-REQUEST-SIG-V1',
    method,
    path,
    `sha256:${bodyDigest}`,
    timestamp,
    nonce,
  ].join('\n');
}

/**
 * Sign a canonical message with the session private key.
 *
 * Returns 0x-prefixed hex: r (32 bytes) + s (32 bytes) + v (1 byte, Ethereum style: 27 or 28).
 * This is the standard 65-byte Ethereum signature format.
 *
 * Internally, @noble/curves v2 'recovered' format is [recovery(1), r(32), s(32)].
 * We rearrange to Ethereum convention: [r(32), s(32), v(1)] where v = recovery + 27.
 */
export function signCanonicalMessage(message: string, privateKeyHex: string): string {
  const messageHash = sha256hex(message);
  const hashBytes = hexToBytes(messageHash);
  const privateKeyBytes = hexToBytes(privateKeyHex);

  try {
    // 'recovered' format: 65 bytes = [recovery(1), r(32), s(32)]
    const sigBytes = secp256k1.sign(hashBytes, privateKeyBytes, { format: 'recovered' });
    const recovery = sigBytes[0];
    const r = sigBytes.slice(1, 33);
    const s = sigBytes.slice(33, 65);

    // Rearrange to Ethereum format: [r(32), s(32), v(1)]
    const v = recovery + 27;
    const ethSig = new Uint8Array(65);
    ethSig.set(r, 0);
    ethSig.set(s, 32);
    ethSig[64] = v;

    return '0x' + Buffer.from(ethSig).toString('hex');
  } finally {
    // Zero the private key bytes to reduce exposure window in memory.
    // The hex string itself is immutable (JS limitation), but we can at least
    // clear the typed array used for signing.
    privateKeyBytes.fill(0);
  }
}

/**
 * Verify a signature against a public key.
 * Expects Ethereum format: [r(32), s(32), v(1)] — 65 bytes total.
 * Returns true if the signature is valid.
 */
export function verifyCanonicalMessage(
  message: string,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  const messageHash = sha256hex(message);
  const hashBytes = hexToBytes(messageHash);

  // Parse Ethereum signature: [r(32), s(32), v(1)]
  const sigHex = signatureHex.startsWith('0x') ? signatureHex.slice(2) : signatureHex;
  // Extract compact r+s (64 bytes = 128 hex chars)
  const compactBytes = hexToBytes(sigHex.slice(0, 128));

  const pubKeyHex = publicKeyHex.startsWith('0x') ? publicKeyHex.slice(2) : publicKeyHex;
  const pubKeyBytes = hexToBytes(pubKeyHex);

  return secp256k1.verify(compactBytes, hashBytes, pubKeyBytes);
}

/**
 * Recover the public key from a signed message.
 * Expects Ethereum format: [r(32), s(32), v(1)] — 65 bytes total.
 * Returns compressed public key as 0x-prefixed hex.
 */
export function recoverPublicKey(
  message: string,
  signatureHex: string,
): string {
  const messageHash = sha256hex(message);
  const hashBytes = hexToBytes(messageHash);

  // Parse Ethereum signature: [r(32), s(32), v(1)]
  const sigHex = signatureHex.startsWith('0x') ? signatureHex.slice(2) : signatureHex;
  const r = hexToBytes(sigHex.slice(0, 64));
  const s = hexToBytes(sigHex.slice(64, 128));
  const v = parseInt(sigHex.slice(128, 130), 16);
  const recovery = v >= 27 ? v - 27 : v;

  // Reconstruct noble's recovered format: [recovery(1), r(32), s(32)]
  const nobleSig = new Uint8Array(65);
  nobleSig[0] = recovery;
  nobleSig.set(r, 1);
  nobleSig.set(s, 33);

  // recoverPublicKey(signature, message) — note: sig first in v2 API
  const pubKeyBytes = secp256k1.recoverPublicKey(nobleSig, hashBytes);
  return '0x' + Buffer.from(pubKeyBytes).toString('hex');
}

// ─── Helpers ────────────────────────────────────────────

/**
 * Compute SHA-256 hex digest of a string.
 */
export function sha256hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length === 0) {
    throw new Error('hexToBytes: empty hex string');
  }
  if (clean.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length hex string (${clean.length} chars)`);
  }
  if (!/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error('hexToBytes: non-hex characters in input');
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
