/**
 * History Tool
 *
 * View recent transaction history across chains.
 * Uses Zerion API for multi-chain indexing.
 *
 * @see https://developers.zerion.io/reference/listwallettransactions
 */

import { type Hex } from 'viem';
import { getSession, touchSession } from '../storage/session.js';

// Zerion API - get key at https://zerion.io/api
const ZERION_API_KEY = process.env.ZERION_API_KEY;

/**
 * Supported chains
 */
type SupportedChain = 'base' | 'ethereum' | 'arbitrum' | 'optimism' | 'polygon';

/**
 * Zerion chain IDs
 * @see https://developers.zerion.io/reference/endpoints-and-schema-details
 */
const ZERION_CHAINS: Record<SupportedChain, string> = {
  base: 'base',
  ethereum: 'ethereum',
  arbitrum: 'arbitrum-one',
  optimism: 'optimism',
  polygon: 'polygon',
};

function isSupportedChain(chain: string): chain is SupportedChain {
  return ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'].includes(chain);
}

/**
 * Tool definition for wallet_history
 */
export const historyToolDefinition = {
  name: 'wallet_history',
  description: `View recent transaction history.

**View recent transactions:**
\`\`\`json
{"chain": "base", "limit": 10}
\`\`\`

**View all chains:**
\`\`\`json
{"chain": "all", "limit": 5}
\`\`\`

Shows: timestamp, type, amount, status, and transaction hash.

Note: Requires ZERION_API_KEY environment variable.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      chain: {
        type: 'string',
        enum: ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon', 'all'],
        default: 'base',
        description: 'Chain to query (or "all" for all chains)',
      },
      limit: {
        type: 'number',
        default: 10,
        description: 'Number of transactions to return (max 50)',
      },
    },
    required: [],
  },
};

/**
 * Zerion transaction response
 */
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
    operation_type: string; // 'trade' | 'send' | 'receive' | 'approve' | 'mint' | 'burn' | etc.
    mined_at: string; // ISO 8601
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

/**
 * Fetch transaction history from Zerion
 *
 * Zerion uses Basic Auth with the API key as username, empty password.
 */
async function fetchZerionHistory(
  address: string,
  chainIds: string[] | null, // null = all chains
  limit: number
): Promise<ZerionTransaction[]> {
  if (!ZERION_API_KEY) {
    throw new Error('ZERION_API_KEY not configured');
  }

  // Build URL with query params
  const params = new URLSearchParams({
    'page[size]': Math.min(limit, 100).toString(),
    'currency': 'usd',
  });

  // Add chain filter if specified
  if (chainIds && chainIds.length > 0) {
    params.set('filter[chain_ids]', chainIds.join(','));
  }

  const url = `https://api.zerion.io/v1/wallets/${address}/transactions/?${params}`;

  // Zerion uses Basic Auth: API key as username, empty password
  const authHeader = 'Basic ' + Buffer.from(`${ZERION_API_KEY}:`).toString('base64');

  const response = await fetch(url, {
    headers: {
      'Authorization': authHeader,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Zerion API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as {
    data?: ZerionTransaction[];
    errors?: Array<{ detail: string }>;
  };

  if (data.errors && data.errors.length > 0) {
    throw new Error(data.errors[0].detail || 'Zerion API error');
  }

  return data.data || [];
}

/**
 * Get operation type emoji and label
 */
function getOperationDisplay(opType: string): { emoji: string; label: string } {
  const ops: Record<string, { emoji: string; label: string }> = {
    send: { emoji: '📤', label: 'Sent' },
    receive: { emoji: '📥', label: 'Received' },
    trade: { emoji: '🔄', label: 'Swap' },
    approve: { emoji: '✅', label: 'Approve' },
    mint: { emoji: '🪙', label: 'Mint' },
    burn: { emoji: '🔥', label: 'Burn' },
    deposit: { emoji: '📥', label: 'Deposit' },
    withdraw: { emoji: '📤', label: 'Withdraw' },
    claim: { emoji: '🎁', label: 'Claim' },
    stake: { emoji: '🔒', label: 'Stake' },
    unstake: { emoji: '🔓', label: 'Unstake' },
    execute: { emoji: '⚡', label: 'Execute' },
    deploy: { emoji: '🚀', label: 'Deploy' },
  };
  return ops[opType] || { emoji: '📋', label: opType };
}

/**
 * Get explorer URL for a chain
 */
function getExplorerUrl(chainId: string, txHash: string): string {
  const explorers: Record<string, string> = {
    'ethereum': 'https://etherscan.io',
    'base': 'https://basescan.org',
    'arbitrum-one': 'https://arbiscan.io',
    'optimism': 'https://optimistic.etherscan.io',
    'polygon': 'https://polygonscan.com',
  };
  const baseUrl = explorers[chainId] || 'https://etherscan.io';
  return `${baseUrl}/tx/${txHash}`;
}

/**
 * Format transaction for display
 */
function formatTransaction(tx: ZerionTransaction): string {
  const { attributes, relationships } = tx;

  // Get operation display
  const { emoji, label } = getOperationDisplay(attributes.operation_type);

  // Format timestamp
  const date = new Date(attributes.mined_at);
  const timestamp = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  // Build transfer summary from Zerion's pre-decoded transfers
  let transferInfo = '';
  if (attributes.transfers && attributes.transfers.length > 0) {
    const parts: string[] = [];
    for (const transfer of attributes.transfers.slice(0, 2)) { // Max 2 for readability
      const symbol = transfer.fungible_info?.symbol || transfer.nft_info?.name || 'TOKEN';
      const amount = transfer.quantity.float;
      const direction = transfer.direction === 'out' ? '-' : '+';
      const value = transfer.value ? ` ($${transfer.value.toFixed(2)})` : '';
      parts.push(`${direction}${amount.toFixed(4)} ${symbol}${value}`);
    }
    transferInfo = parts.join(' ');
  }

  // Status emoji
  const status = attributes.status === 'confirmed' ? '✅' :
                 attributes.status === 'failed' ? '❌' : '⏳';

  // Chain and explorer link
  const chainId = relationships?.chain?.data?.id || 'ethereum';
  const explorerUrl = getExplorerUrl(chainId, attributes.hash);
  const shortHash = attributes.hash.slice(0, 10);

  // Build final line
  const transferDisplay = transferInfo ? ` | ${transferInfo}` : '';
  return `${status} **${timestamp}** | ${emoji} ${label}${transferDisplay} | [\`${shortHash}...\`](${explorerUrl})`;
}

/**
 * Handle wallet_history requests
 */
export async function handleHistoryRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const chainInput = (args.chain as string) || 'base';
  const limit = Math.min((args.limit as number) || 10, 50);

  // Check session
  const session = await getSession();
  if (!session?.authenticated || !session.address) {
    return {
      content: [{ type: 'text', text: '❌ Wallet not configured. Run `wallet_setup` first.' }],
      isError: true,
    };
  }

  await touchSession();

  const address = session.address;

  // Check for Zerion API key
  if (!ZERION_API_KEY) {
    return {
      content: [{
        type: 'text',
        text: [
          '❌ **ZERION_API_KEY not configured**',
          '',
          'Transaction history requires a Zerion API key.',
          '',
          '1. Get an API key at [zerion.io/api](https://zerion.io/api)',
          '2. Set `ZERION_API_KEY` environment variable',
          '',
          'Zerion provides decoded transactions across 38+ chains.',
        ].join('\n'),
      }],
      isError: true,
    };
  }

  try {
    const lines: string[] = [];
    lines.push('## 📜 Transaction History');
    lines.push('');

    // Zerion can fetch all chains in one call - much more efficient!
    let chainFilter: string[] | null = null;

    if (chainInput !== 'all') {
      // Single chain filter
      if (!isSupportedChain(chainInput)) {
        return {
          content: [{
            type: 'text',
            text: `❌ Unsupported chain: ${chainInput}\n\nSupported: base, ethereum, arbitrum, optimism, polygon, all`,
          }],
          isError: true,
        };
      }
      chainFilter = [ZERION_CHAINS[chainInput]];
      lines.push(`**Chain:** ${chainInput} | **Address:** \`${address.slice(0, 10)}...\``);
    } else {
      // All supported chains
      chainFilter = Object.values(ZERION_CHAINS);
      lines.push(`**Chains:** all | **Address:** \`${address.slice(0, 10)}...\``);
    }

    lines.push('');

    // Fetch transactions (Zerion handles multi-chain in one request!)
    const transactions = await fetchZerionHistory(address, chainFilter, limit);

    if (transactions.length === 0) {
      lines.push('_No transactions found_');
    } else {
      for (const tx of transactions) {
        lines.push(formatTransaction(tx));
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Failed to fetch history: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
