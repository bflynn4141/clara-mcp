/**
 * Proxy Fetch
 *
 * Drop-in replacement for fetch() when calling the Clara proxy.
 * If a session key is available, signs the request. Otherwise falls
 * back to the old X-Clara-Address header (migration compatibility).
 *
 * Usage in tool handlers:
 *   const response = await proxyFetch(url, { method: 'POST', ... }, ctx);
 *
 * This eliminates the repetitive pattern of:
 *   headers['X-Clara-Address'] = walletAddress;
 *   const response = await fetch(url, { headers, ... });
 */

import { signedFetch } from './request-signer.js';
import type { SessionKeyData } from './session-key.js';

/**
 * Make a request to the Clara proxy, signed if possible.
 *
 * If sessionKey is provided and valid, signs the request with ECDSA.
 * Otherwise falls back to plain X-Clara-Address header.
 */
export async function proxyFetch(
  url: string,
  options: RequestInit,
  auth: { walletAddress: string; sessionKey: SessionKeyData | null },
): Promise<Response> {
  if (auth.sessionKey) {
    return signedFetch(url, options, auth.sessionKey);
  }

  // Fallback: unsigned request with just X-Clara-Address
  const headers = new Headers(options.headers);
  headers.set('X-Clara-Address', auth.walletAddress);

  return fetch(url, { ...options, headers });
}
