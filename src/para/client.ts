/**
 * Para Wallet Client
 *
 * Wraps the Para wallet API for signing operations.
 * Para is a non-custodial wallet infrastructure that enables
 * server-side signing with user-controlled keys.
 *
 * The client communicates with clara-proxy which forwards
 * authenticated requests to the Para API.
 */

import { type Hex, hashTypedData, recoverAddress } from 'viem';

export interface ParaConfig {
  /** Clara proxy URL (e.g., https://clara-proxy.your-domain.workers.dev) */
  proxyUrl: string;
  /** Wallet ID from Para */
  walletId: string;
  /** User ID for Para authentication */
  userId?: string;
}

export interface SignedTypedData {
  signature: Hex;
  hash: Hex;
}

/**
 * Para Wallet Client
 *
 * Provides wallet operations through the Para API:
 * - EIP-712 typed data signing (for x402 payments)
 * - Raw transaction signing (for direct on-chain operations)
 * - Address retrieval
 */
export class ParaClient {
  private config: ParaConfig;
  private cachedAddress?: Hex;

  constructor(config: ParaConfig) {
    this.config = config;
  }

  /**
   * Get the wallet address
   *
   * Caches the address after first retrieval since it doesn't change.
   */
  async getAddress(): Promise<Hex> {
    if (this.cachedAddress) {
      return this.cachedAddress;
    }

    const response = await fetch(`${this.config.proxyUrl}/api/v1/wallets`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get wallet: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { wallets: Array<{ id: string; address: string }> };
    const wallet = data.wallets.find((w) => w.id === this.config.walletId);

    if (!wallet) {
      throw new Error(`Wallet ${this.config.walletId} not found`);
    }

    this.cachedAddress = wallet.address as Hex;
    return this.cachedAddress;
  }

  /**
   * Sign typed data (EIP-712)
   *
   * Used for x402 payment authorization and other typed signatures.
   * EIP-712 provides structured, human-readable signing that wallets
   * can display clearly to users.
   *
   * @see https://eips.ethereum.org/EIPS/eip-712
   */
  async signTypedData(
    domain: {
      name: string;
      version: string;
      chainId?: number;
      verifyingContract?: Hex;
    },
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>
  ): Promise<Hex> {
    // Compute the typed data hash (for verification)
    const hash = hashTypedData({
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId,
        verifyingContract: domain.verifyingContract,
      },
      types,
      primaryType: Object.keys(types)[0],
      message: value,
    });

    // Create the sign request payload
    const signPayload = {
      typedData: {
        domain,
        types,
        primaryType: Object.keys(types)[0],
        message: value,
      },
    };

    const response = await fetch(
      `${this.config.proxyUrl}/api/v1/wallets/${this.config.walletId}/sign-typed-data`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(signPayload),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to sign typed data: ${response.status} - ${errorText}`);
    }

    const result = await response.json() as { signature: string };
    return result.signature as Hex;
  }

  /**
   * Sign a raw transaction
   *
   * Used for direct on-chain operations when typed data isn't appropriate.
   */
  async signRaw(messageHash: Hex): Promise<Hex> {
    const response = await fetch(
      `${this.config.proxyUrl}/api/v1/wallets/${this.config.walletId}/sign-raw`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messageHash }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to sign: ${response.status} - ${errorText}`);
    }

    const result = await response.json() as { signature: string };
    return result.signature as Hex;
  }
}

/**
 * Load Para configuration from environment/config file
 */
export function loadParaConfig(): ParaConfig {
  const proxyUrl = process.env.CLARA_PROXY_URL;
  const walletId = process.env.PARA_WALLET_ID;

  if (!proxyUrl) {
    throw new Error('CLARA_PROXY_URL environment variable is required');
  }

  if (!walletId) {
    throw new Error('PARA_WALLET_ID environment variable is required');
  }

  return {
    proxyUrl,
    walletId,
    userId: process.env.PARA_USER_ID,
  };
}
