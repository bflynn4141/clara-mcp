/**
 * Zerion Provider
 *
 * Implements HistoryProvider using Zerion's transaction indexing API.
 * Zerion excels at fast, paginated transaction listing across multiple chains.
 *
 * @see https://developers.zerion.io/reference/listwallettransactions
 */

import type { SupportedChain } from '../config/chains.js';
import type {
  HistoryProvider,
  HistoryListParams,
  HistoryListResult,
  ProviderResult,
  TransactionSummary,
  TransactionType,
  TransferInfo,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const ZERION_API_KEY = process.env.ZERION_API_KEY;

/**
 * Zerion chain ID mapping
 */
const ZERION_CHAIN_IDS: Record<SupportedChain, string> = {
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum-one',
  optimism: 'optimism',
  polygon: 'polygon',
};

/**
 * Chain IDs for our supported chains
 */
const CHAIN_IDS: Record<SupportedChain, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
};

/**
 * Block explorer URLs
 */
const EXPLORER_URLS: Record<SupportedChain, string> = {
  ethereum: 'https://etherscan.io',
  base: 'https://basescan.org',
  arbitrum: 'https://arbiscan.io',
  optimism: 'https://optimistic.etherscan.io',
  polygon: 'https://polygonscan.com',
};

// ============================================================================
// Zerion API Types
// ============================================================================

interface ZerionTransfer {
  direction: 'in' | 'out' | 'self';
  fungible_info?: {
    symbol: string;
    name: string;
    decimals?: number;
    icon?: { url: string };
  };
  nft_info?: {
    name: string;
  };
  quantity: {
    float: number;
    numeric: string;
  };
  value: number | null;
  sender: string;
  recipient: string;
}

interface ZerionTransaction {
  type: 'transactions';
  id: string;
  attributes: {
    hash: string;
    operation_type: string;
    mined_at: string;
    sent_from: string;
    sent_to: string;
    status: 'confirmed' | 'failed' | 'pending';
    fee?: {
      fungible_info?: { symbol: string };
      value: number;
    };
    transfers?: ZerionTransfer[];
  };
  relationships?: {
    chain?: {
      data?: { id: string };
    };
  };
}

interface ZerionResponse {
  data?: ZerionTransaction[];
  links?: {
    next?: string;
  };
  errors?: Array<{ detail: string }>;
}

// ============================================================================
// Mapping Functions
// ============================================================================

/**
 * Map Zerion operation type to our TransactionType
 */
function mapOperationType(opType: string): TransactionType {
  const mapping: Record<string, TransactionType> = {
    send: 'send',
    receive: 'receive',
    trade: 'swap',
    approve: 'approve',
    mint: 'mint',
    burn: 'burn',
    deposit: 'deposit',
    withdraw: 'withdraw',
    stake: 'stake',
    unstake: 'unstake',
    claim: 'claim',
    bridge: 'bridge',
    deploy: 'deploy',
    execute: 'unknown',
  };
  return mapping[opType] || 'unknown';
}

/**
 * Map Zerion chain ID to our SupportedChain
 */
function mapChainId(zerionChainId: string): SupportedChain {
  const mapping: Record<string, SupportedChain> = {
    'ethereum': 'ethereum',
    'base': 'base',
    'arbitrum-one': 'arbitrum',
    'optimism': 'optimism',
    'polygon': 'polygon',
  };
  return mapping[zerionChainId] || 'ethereum';
}

/**
 * Map Zerion transfer to our TransferInfo
 */
function mapTransfer(transfer: ZerionTransfer): TransferInfo {
  return {
    direction: transfer.direction,
    token: {
      symbol: transfer.fungible_info?.symbol || transfer.nft_info?.name || 'UNKNOWN',
      name: transfer.fungible_info?.name || transfer.nft_info?.name,
      decimals: transfer.fungible_info?.decimals,
    },
    amount: transfer.quantity.float.toString(),
    amountRaw: transfer.quantity.numeric,
    valueUsd: transfer.value?.toFixed(2),
    from: transfer.sender,
    to: transfer.recipient,
  };
}

/**
 * Generate human-readable summary of a transaction
 */
function generateSummary(tx: ZerionTransaction): string {
  const type = mapOperationType(tx.attributes.operation_type);
  const transfers = tx.attributes.transfers || [];

  if (transfers.length === 0) {
    return `${type} transaction`;
  }

  if (type === 'swap' && transfers.length >= 2) {
    const out = transfers.find(t => t.direction === 'out');
    const inTx = transfers.find(t => t.direction === 'in');
    if (out && inTx) {
      return `Swapped ${out.quantity.float.toFixed(4)} ${out.fungible_info?.symbol || 'tokens'} for ${inTx.quantity.float.toFixed(4)} ${inTx.fungible_info?.symbol || 'tokens'}`;
    }
  }

  if (type === 'send' || type === 'receive') {
    const transfer = transfers[0];
    const direction = transfer.direction === 'out' ? 'Sent' : 'Received';
    return `${direction} ${transfer.quantity.float.toFixed(4)} ${transfer.fungible_info?.symbol || 'tokens'}`;
  }

  return `${type}: ${transfers.length} transfer(s)`;
}

/**
 * Map Zerion transaction to our TransactionSummary
 */
function mapTransaction(tx: ZerionTransaction): TransactionSummary {
  const zerionChainId = tx.relationships?.chain?.data?.id || 'ethereum';
  const chain = mapChainId(zerionChainId);

  return {
    hash: tx.attributes.hash,
    chainId: CHAIN_IDS[chain],
    chain,
    timestamp: tx.attributes.mined_at,
    status: tx.attributes.status,
    type: mapOperationType(tx.attributes.operation_type),
    summary: generateSummary(tx),
    transfers: (tx.attributes.transfers || []).map(mapTransfer),
    gasCost: tx.attributes.fee?.value?.toString(),
    gasCostUsd: tx.attributes.fee?.value?.toFixed(4),
    explorerUrl: `${EXPLORER_URLS[chain]}/tx/${tx.attributes.hash}`,
  };
}

// ============================================================================
// Provider Implementation
// ============================================================================

export class ZerionHistoryProvider implements HistoryProvider {
  name = 'zerion';

  private supportedChainsList: SupportedChain[] = [
    'ethereum',
    'base',
    'arbitrum',
    'optimism',
    'polygon',
  ];

  supportedChains(): SupportedChain[] {
    return this.supportedChainsList;
  }

  async listTransactions(params: HistoryListParams): Promise<ProviderResult<HistoryListResult>> {
    if (!ZERION_API_KEY) {
      return {
        success: false,
        error: 'ZERION_API_KEY not configured. Get one at https://zerion.io/api',
        provider: this.name,
        level: 'unavailable',
      };
    }

    try {
      const limit = Math.min(params.limit || 10, 100);

      // Build chain filter
      let chainIds: string[];
      if (params.chain === 'all') {
        chainIds = Object.values(ZERION_CHAIN_IDS);
      } else {
        chainIds = [ZERION_CHAIN_IDS[params.chain]];
      }

      // Build URL
      const queryParams = new URLSearchParams({
        'page[size]': limit.toString(),
        'currency': 'usd',
        'filter[chain_ids]': chainIds.join(','),
      });

      if (params.cursor) {
        queryParams.set('page[after]', params.cursor);
      }

      const url = `https://api.zerion.io/v1/wallets/${params.address}/transactions/?${queryParams}`;

      // Make request with Basic Auth
      const authHeader = 'Basic ' + Buffer.from(`${ZERION_API_KEY}:`).toString('base64');

      const response = await fetch(url, {
        headers: {
          'Authorization': authHeader,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `Zerion API error: ${response.status} - ${errorText}`,
          provider: this.name,
          level: 'unavailable',
        };
      }

      const data: ZerionResponse = await response.json();

      if (data.errors && data.errors.length > 0) {
        return {
          success: false,
          error: data.errors[0].detail || 'Zerion API error',
          provider: this.name,
          level: 'unavailable',
        };
      }

      const transactions = (data.data || []).map(mapTransaction);

      // Extract cursor from next link if present
      let nextCursor: string | undefined;
      if (data.links?.next) {
        const nextUrl = new URL(data.links.next);
        nextCursor = nextUrl.searchParams.get('page[after]') || undefined;
      }

      return {
        success: true,
        data: {
          transactions,
          nextCursor,
          hasMore: !!data.links?.next,
        },
        provider: this.name,
        level: 'full',
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to fetch history: ${error instanceof Error ? error.message : 'Unknown error'}`,
        provider: this.name,
        level: 'unavailable',
      };
    }
  }
}

// Export singleton instance
export const zerionProvider = new ZerionHistoryProvider();
