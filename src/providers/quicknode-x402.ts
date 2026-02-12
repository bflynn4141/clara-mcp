/**
 * QuickNode x402 RPC Provider
 *
 * Routes RPC calls through QuickNode's x402-enabled endpoints with
 * automatic SIWE authentication, JWT management, and x402 payment handling.
 *
 * Opt-in via QUICKNODE_X402=true. No API keys needed — just a wallet
 * with USDC on Base for pay-per-request billing.
 *
 * Architecture:
 *   viem http() transport → custom fetchFn → SIWE auth + Bearer JWT
 *                                          → on 402: X402Client handles payment
 */

import { type Hex } from 'viem';
import { SiweMessage, generateNonce } from 'siwe';
import { createParaAccountFromSession } from '../para/account.js';
import { X402Client } from '../para/x402.js';
import { checkSpendingLimits, recordSpending } from '../storage/spending.js';
import type { SupportedChain } from '../config/chains.js';

// ─── QuickNode x402 Gateway ─────────────────────────────

const QN_GATEWAY = 'https://x402.quicknode.com';

/** Map Clara chain names → QuickNode network identifiers */
const QN_NETWORKS: Record<SupportedChain, string> = {
  ethereum: 'ethereum-mainnet',
  base: 'base-mainnet',
  arbitrum: 'arbitrum-mainnet',
  optimism: 'optimism-mainnet',
  polygon: 'polygon-mainnet',
};

// ─── JWT Cache ──────────────────────────────────────────

interface JwtCache {
  token: string;
  expiresAt: number; // Unix ms
}

let jwtCache: JwtCache | null = null;
let authInFlight: Promise<string> | null = null;

// ─── Public API ─────────────────────────────────────────

/**
 * Check if QuickNode x402 routing is enabled
 */
export function isQuickNodeX402Enabled(): boolean {
  return process.env.QUICKNODE_X402 === 'true';
}

/**
 * Clear cached JWT (call on wallet logout)
 */
export function clearQuickNodeAuth(): void {
  jwtCache = null;
  authInFlight = null;
}

/**
 * Create a custom fetch function for viem's http() transport.
 *
 * Rewrites the URL to QuickNode's x402 gateway, injects a Bearer JWT,
 * and handles 402 Payment Required responses via the existing X402Client.
 */
export function createQuickNodeFetchFn(
  chain: SupportedChain,
): typeof globalThis.fetch {
  const network = QN_NETWORKS[chain];
  const qnUrl = `${QN_GATEWAY}/${network}`;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Authenticate (cached / deduplicated)
    const jwt = await authenticate();

    // Rewrite URL to QuickNode gateway, keep the JSON-RPC body
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${jwt}`);
    headers.set('Content-Type', 'application/json');

    const response = await fetch(qnUrl, {
      ...init,
      headers,
    });

    // Non-402 → return as-is (success or RPC error)
    if (response.status !== 402) {
      return response;
    }

    // 402 Payment Required → pay via X402Client
    console.error(`[quicknode-x402] Got 402 on ${chain}, attempting payment...`);
    return handlePayment(qnUrl, init, response);
  };
}

// ─── SIWE Authentication ────────────────────────────────

/**
 * Get a valid JWT, authenticating via SIWE if needed.
 *
 * - Cached JWTs are returned instantly
 * - Refreshes 5 min before expiry
 * - Deduplicates concurrent auth requests
 */
async function authenticate(): Promise<string> {
  // Return cached token if still valid (with 5-min buffer)
  if (jwtCache && jwtCache.expiresAt > Date.now() + 5 * 60 * 1000) {
    return jwtCache.token;
  }

  // Deduplicate concurrent auth requests
  if (authInFlight) {
    return authInFlight;
  }

  authInFlight = performSiweAuth();
  try {
    const token = await authInFlight;
    return token;
  } finally {
    authInFlight = null;
  }
}

/**
 * Full SIWE auth flow:
 * 1. Generate nonce locally (QuickNode doesn't serve nonces)
 * 2. Construct EIP-4361 SIWE message
 * 3. Sign with Para-backed account
 * 4. POST to /auth → JWT
 */
async function performSiweAuth(): Promise<string> {
  console.error('[quicknode-x402] Authenticating via SIWE...');

  const account = await createParaAccountFromSession();

  // 1. Construct SIWE message (nonce is client-generated per QuickNode spec)
  const siweMessage = new SiweMessage({
    domain: new URL(QN_GATEWAY).host,
    address: account.address,
    statement: 'I accept the Quicknode Terms of Service: https://www.quicknode.com/terms',
    uri: QN_GATEWAY,
    version: '1',
    chainId: 8453, // Base — matches QuickNode's expected chain
    nonce: generateNonce(),
    issuedAt: new Date().toISOString(),
  });

  const message = siweMessage.prepareMessage();

  // 3. Sign with Para account (Para accounts always implement signMessage)
  const signature = await account.signMessage!({ message });

  // 4. Exchange for JWT
  const authRes = await fetch(`${QN_GATEWAY}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });

  if (!authRes.ok) {
    const errorText = await authRes.text();
    throw new Error(`QuickNode auth failed: ${authRes.status} - ${errorText}`);
  }

  const authData = await authRes.json() as {
    token: string;
    accountId?: string;
    expiresAt?: string; // ISO string
    expiresIn?: number; // seconds (fallback)
  };

  // Cache JWT — handle both expiresAt (ISO) and expiresIn (seconds) formats
  const expiresAtMs = authData.expiresAt
    ? new Date(authData.expiresAt).getTime()
    : Date.now() + (authData.expiresIn || 3600) * 1000;

  jwtCache = {
    token: authData.token,
    expiresAt: expiresAtMs,
  };

  const validMinutes = Math.round((expiresAtMs - Date.now()) / 60000);
  console.error(`[quicknode-x402] Authenticated${authData.accountId ? ` as ${authData.accountId}` : ''}. JWT valid for ${validMinutes}min`);
  return authData.token;
}

// ─── x402 Payment Handling ──────────────────────────────

/**
 * Handle a 402 Payment Required response from QuickNode.
 *
 * Uses the existing X402Client to parse payment details, check spending
 * limits, sign payment authorization, and retry the request.
 */
async function handlePayment(
  url: string,
  init: RequestInit | undefined,
  initialResponse: Response,
): Promise<Response> {
  const account = await createParaAccountFromSession();

  const x402 = new X402Client(
    async (domain, types, value) => {
      return account.signTypedData!({
        domain,
        types,
        primaryType: Object.keys(types)[0],
        message: value,
      });
    },
    async () => account.address,
  );

  // Parse 402 payment details
  const details = x402.parsePaymentRequired(initialResponse);
  if (!details) {
    throw new Error('[quicknode-x402] Failed to parse 402 payment details from QuickNode');
  }

  // Check spending limits
  const amountUsd = x402.tokenAmountToUsd(details.amount, details.token);
  const limitsCheck = checkSpendingLimits(amountUsd);
  if (!limitsCheck.allowed) {
    throw new Error(
      `[quicknode-x402] Payment blocked: ${limitsCheck.reason}. ` +
      `Use wallet_spending_limits to adjust.`
    );
  }

  // Sign and create payment header
  const sigResult = await x402.createPaymentSignature(details);
  const { headerName, headerValue } = await x402.createPaymentHeader(details, sigResult);

  // Retry with payment header
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  // Keep the Bearer token too
  if (jwtCache) {
    headers.set('Authorization', `Bearer ${jwtCache.token}`);
  }
  headers.set(headerName, headerValue);

  const paidResponse = await fetch(url, {
    ...init,
    headers,
  });

  // Record spending
  recordSpending({
    timestamp: new Date().toISOString(),
    amountUsd,
    recipient: details.recipient,
    description: `QuickNode x402 RPC call`,
    url,
    chainId: details.chainId,
    paymentId: details.paymentId,
  });

  console.error(`[quicknode-x402] Paid $${amountUsd} for RPC call`);
  return paidResponse;
}
