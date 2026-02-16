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

let initPromise: Promise<Client> | null = null;
let xmtpClient: Client | null = null;
let identityCache: ClaraIdentityCache | null = null;

const PROXY_URL = process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn-me.workers.dev';

/**
 * Get or initialize the XMTP client.
 * First call triggers identity registration (Para MPC signing).
 * Subsequent calls return the cached client.
 *
 * Uses a promise guard to prevent duplicate initialization
 * when multiple tool calls race on the first invocation.
 */
export async function getOrInitXmtpClient(ctx: ToolContext): Promise<Client> {
  if (xmtpClient) return xmtpClient;

  if (!initPromise) {
    initPromise = (async () => {
      const client = await createClaraXmtpClient({
        walletAddress: ctx.walletAddress,
        walletId: ctx.session.walletId!,
        proxyUrl: PROXY_URL,
      });

      // Initialize identity cache
      const cache = new ClaraIdentityCache();
      await cache.seedFromDirectory(PROXY_URL);

      xmtpClient = client;
      identityCache = cache;
      return client;
    })();
  }

  return initPromise;
}

export function getIdentityCache(): ClaraIdentityCache {
  if (!identityCache) {
    identityCache = new ClaraIdentityCache();
  }
  return identityCache;
}
