/**
 * Clara XMTP Client Factory
 *
 * Creates XMTP clients configured for Clara's architecture:
 * - Para wallet signing via clara-proxy POST /xmtp/sign
 * - Local DB persistence at ~/.clara/xmtp/{address}.db3
 * - Auto-generated encryption keys
 *
 * Ported from Glorp's createGlorpClient() with Clara-specific signing.
 */

import { Client } from '@xmtp/node-sdk';
import type { Signer } from '@xmtp/node-sdk';
import { getOrCreateEncryptionKey, getXmtpPaths } from './keys.js';

// IdentifierKind and LogLevel are const enums from @xmtp/node-bindings.
// const enums are erased at runtime under isolatedModules — hardcode values.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const IDENTIFIER_KIND_ETHEREUM = 0 as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const LOG_LEVEL_WARN = 'Warn' as any;

export interface ClaraXmtpClientOptions {
  walletAddress: string;
  /** Para wallet ID (from session context, needed for proxy signing) */
  walletId: string;
  proxyUrl?: string;
  dbPath?: string;
  env?: 'local' | 'dev' | 'production';
  dbEncryptionKey?: Uint8Array;
  disableAutoRegister?: boolean;
}

/**
 * Create an XMTP client configured for Clara.
 *
 * First call for a new wallet triggers XMTP identity registration
 * (requires Para MPC signing via proxy). Subsequent calls open
 * the existing local DB without signing.
 */
export async function createClaraXmtpClient(opts: ClaraXmtpClientOptions): Promise<Client> {
  const {
    walletAddress,
    walletId,
    proxyUrl = process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn-me.workers.dev',
    env = 'production',
    disableAutoRegister = false,
  } = opts;

  const { dbPath: defaultDbPath } = getXmtpPaths(walletAddress);
  const dbPath = opts.dbPath ?? defaultDbPath;
  const dbEncryptionKey = opts.dbEncryptionKey ?? await getOrCreateEncryptionKey(walletAddress, opts.dbPath);

  const signer: Signer = {
    type: 'EOA',
    getIdentifier: () => ({
      identifier: walletAddress,
      identifierKind: IDENTIFIER_KIND_ETHEREUM,
    }),
    signMessage: async (message: string): Promise<Uint8Array> => {
      // Sign via Clara proxy -> Para MPC (10s timeout)
      const messageHex = '0x' + Buffer.from(message, 'utf-8').toString('hex');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await fetch(`${proxyUrl}/xmtp/sign`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Clara-Address': walletAddress,
          },
          body: JSON.stringify({ walletId, data: messageHex }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`XMTP signing failed: ${response.status} - ${errorText}`);
        }

        const result = await response.json() as { signature: string };
        const sig = result.signature.startsWith('0x')
          ? result.signature.slice(2)
          : result.signature;
        return Buffer.from(sig, 'hex');
      } finally {
        clearTimeout(timeout);
      }
    },
  };

  return Client.create(signer, {
    dbEncryptionKey,
    dbPath,
    env,
    disableAutoRegister,
    loggingLevel: LOG_LEVEL_WARN,
  });
}

export { isXmtpInitialized } from './keys.js';
