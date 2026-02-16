/**
 * XMTP Client Singleton
 *
 * All messaging tools share a single XMTP client instance.
 * The client is lazily initialized on first messaging tool call.
 * First call triggers XMTP identity registration (requires signing).
 * Subsequent calls reuse the existing client.
 */

import type { Client } from '@xmtp/node-sdk';
import { createClaraXmtpClient } from './client.js';
import { ClaraIdentityCache } from './identity.js';
import type { ToolContext } from '../middleware.js';

let xmtpClient: Client | null = null;
let identityCache: ClaraIdentityCache | null = null;

const PROXY_URL = process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn-me.workers.dev';

/**
 * Get or initialize the XMTP client.
 * First call triggers identity registration (Para MPC signing).
 * Subsequent calls return the cached client.
 */
export async function getOrInitXmtpClient(ctx: ToolContext): Promise<Client> {
  if (xmtpClient) return xmtpClient;

  xmtpClient = await createClaraXmtpClient({
    walletAddress: ctx.walletAddress,
    walletId: ctx.session.walletId!,
    proxyUrl: PROXY_URL,
  });

  // Initialize identity cache
  identityCache = new ClaraIdentityCache();
  await identityCache.seedFromDirectory(PROXY_URL);

  return xmtpClient;
}

export function getIdentityCache(): ClaraIdentityCache {
  if (!identityCache) {
    identityCache = new ClaraIdentityCache();
  }
  return identityCache;
}
