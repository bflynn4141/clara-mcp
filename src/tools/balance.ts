/**
 * Wallet Balance Tool
 *
 * MCP tool for checking wallet balances using Zerion API.
 *
 * Shows all token positions across chains, not just ETH and USDC.
 * Essential for AI agents to know their available funds before
 * attempting x402 payments or other transactions.
 */

import { type Hex } from 'viem';

/**
 * Zerion API configuration
 */
const ZERION_API_BASE = 'https://api.zerion.io/v1';

/**
 * Tool definition for wallet_balance
 */
export const balanceToolDefinition = {
  name: 'wallet_balance',
  description: `Check the wallet's token balances across all chains.

**Returns:**
- All token balances with USD values
- Total portfolio value
- Wallet address

**Essential for:**
- Knowing available funds before x402 payments
- Checking if you need to fund the wallet
- Monitoring your full portfolio

**Example:**
\`\`\`json
{}
\`\`\`

No parameters required - uses the configured wallet.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      showAddress: {
        type: 'boolean',
        default: true,
        description: 'Show the wallet address in the response',
      },
      chain: {
        type: 'string',
        description: 'Filter by chain (e.g., "base", "ethereum"). Shows all chains if omitted.',
      },
      minValueUsd: {
        type: 'number',
        default: 0.01,
        description: 'Minimum USD value to show (hides dust)',
      },
    },
  },
};

/**
 * Zerion position data structure
 */
interface ZerionPosition {
  type: string;
  id: string;
  attributes: {
    parent: null | string;
    protocol: null | string;
    name: string;
    position_type: string;
    quantity: {
      int: string;
      decimals: number;
      float: number;
      numeric: string;
    };
    value: number | null;
    price: number;
    changes: {
      absolute_1d: number | null;
      percent_1d: number | null;
    } | null;
    fungible_info: {
      name: string;
      symbol: string;
      icon: { url: string } | null;
      flags: {
        verified: boolean;
      };
      implementations: Array<{
        chain_id: string;
        address: string | null;
        decimals: number;
      }>;
    };
    flags: {
      displayable: boolean;
      is_trash: boolean;
    };
  };
  relationships: {
    chain: {
      data: {
        type: string;
        id: string;
      };
    };
    fungible: {
      data: {
        type: string;
        id: string;
      };
    };
  };
}

interface ZerionResponse {
  links: {
    self: string;
  };
  data: ZerionPosition[];
}

/**
 * Token balance for display
 */
interface TokenBalance {
  symbol: string;
  name: string;
  amount: number;
  valueUsd: number | null;
  price: number;
  chain: string;
  verified: boolean;
  change24h: number | null;
}

/**
 * Get all token positions from Zerion
 */
export async function getWalletPositions(
  address: string,
  chain?: string
): Promise<TokenBalance[]> {
  const apiKey = process.env.ZERION_API_KEY;
  
  if (!apiKey) {
    throw new Error(
      'ZERION_API_KEY not configured. Get one at https://developers.zerion.io'
    );
  }

  // Build URL with optional chain filter
  let url = `${ZERION_API_BASE}/wallets/${address.toLowerCase()}/positions/`;
  const params = new URLSearchParams({
    'filter[position_types]': 'wallet',
    'currency': 'usd',
    'sort': 'value',
  });
  
  if (chain) {
    params.set('filter[chain_ids]', chain);
  }
  
  url += `?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      'accept': 'application/json',
      'authorization': `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 401) {
      throw new Error('Invalid ZERION_API_KEY. Check your API key at https://developers.zerion.io');
    }
    throw new Error(`Zerion API error (${response.status}): ${errorText}`);
  }

  const data: ZerionResponse = await response.json();

  // Transform to our TokenBalance format
  return data.data
    .filter(pos => pos.attributes.flags.displayable && !pos.attributes.flags.is_trash)
    .map(pos => ({
      symbol: pos.attributes.fungible_info.symbol,
      name: pos.attributes.fungible_info.name,
      amount: pos.attributes.quantity.float,
      valueUsd: pos.attributes.value,
      price: pos.attributes.price,
      chain: pos.relationships.chain.data.id,
      verified: pos.attributes.fungible_info.flags.verified,
      change24h: pos.attributes.changes?.percent_1d ?? null,
    }));
}

/**
 * Format chain name for display
 */
function formatChainName(chainId: string): string {
  const chainNames: Record<string, string> = {
    'ethereum': 'Ethereum',
    'base': 'Base',
    'optimism': 'Optimism',
    'arbitrum': 'Arbitrum',
    'polygon': 'Polygon',
    'avalanche': 'Avalanche',
    'bsc': 'BSC',
    'gnosis': 'Gnosis',
    'fantom': 'Fantom',
    'zksync-era': 'zkSync Era',
    'linea': 'Linea',
    'scroll': 'Scroll',
    'blast': 'Blast',
    'solana': 'Solana',
  };
  return chainNames[chainId] || chainId.charAt(0).toUpperCase() + chainId.slice(1);
}

/**
 * Format USD value
 */
function formatUsd(value: number | null): string {
  if (value === null) return '—';
  if (value < 0.01 && value > 0) return '<$0.01';
  if (value >= 1000000) return `$${(value / 1000000).toFixed(2)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

/**
 * Format token amount
 */
function formatAmount(amount: number, symbol: string): string {
  if (amount === 0) return '0';
  if (amount < 0.0001) return '<0.0001';
  if (amount >= 1000000) return `${(amount / 1000000).toFixed(4)}M`;
  if (amount >= 1000) return `${(amount / 1000).toFixed(4)}K`;
  if (amount >= 1) return amount.toFixed(4);
  // For small amounts, show more precision
  return amount.toPrecision(4);
}

/**
 * Format 24h change
 */
function formatChange(change: number | null): string {
  if (change === null) return '';
  const sign = change >= 0 ? '+' : '';
  return ` (${sign}${change.toFixed(1)}%)`;
}

/**
 * Handle wallet_balance requests
 */
export async function handleBalanceRequest(
  args: Record<string, unknown>,
  getAddress: () => Promise<Hex>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const showAddress = args.showAddress !== false;
  const chain = args.chain as string | undefined;
  const minValueUsd = (args.minValueUsd as number) ?? 0.01;

  try {
    const address = await getAddress();
    const positions = await getWalletPositions(address, chain);

    // Filter by minimum value
    const filteredPositions = positions.filter(
      p => (p.valueUsd ?? 0) >= minValueUsd
    );

    // Calculate total portfolio value
    const totalValue = positions.reduce((sum, p) => sum + (p.valueUsd ?? 0), 0);

    // Group by chain for better readability
    const byChain = new Map<string, TokenBalance[]>();
    for (const pos of filteredPositions) {
      const chainTokens = byChain.get(pos.chain) || [];
      chainTokens.push(pos);
      byChain.set(pos.chain, chainTokens);
    }

    // Build output
    const lines: string[] = [
      '💰 Wallet Portfolio',
      '═══════════════════════════════════════',
      '',
      `**Total Value:** ${formatUsd(totalValue)}`,
      '',
    ];

    if (byChain.size === 0) {
      lines.push('No tokens found with value ≥ ' + formatUsd(minValueUsd));
    } else {
      // Sort chains by total value
      const chainOrder = Array.from(byChain.entries())
        .map(([chainId, tokens]) => ({
          chainId,
          tokens,
          totalValue: tokens.reduce((sum, t) => sum + (t.valueUsd ?? 0), 0),
        }))
        .sort((a, b) => b.totalValue - a.totalValue);

      for (const { chainId, tokens } of chainOrder) {
        lines.push(`**${formatChainName(chainId)}**`);
        lines.push('───────────────────────────────────────');
        
        for (const token of tokens) {
          const amountStr = formatAmount(token.amount, token.symbol);
          const valueStr = formatUsd(token.valueUsd);
          const changeStr = formatChange(token.change24h);
          const verifiedBadge = token.verified ? '' : ' ⚠️';
          
          // Format: SYMBOL: amount ($value) +change%
          lines.push(
            `${token.symbol}${verifiedBadge}: ${amountStr} (${valueStr})${changeStr}`
          );
        }
        lines.push('');
      }
    }

    // Show hidden dust count if applicable
    const hiddenCount = positions.length - filteredPositions.length;
    if (hiddenCount > 0) {
      lines.push(`_${hiddenCount} tokens hidden (value < ${formatUsd(minValueUsd)})_`);
      lines.push('');
    }

    if (showAddress) {
      lines.push(`**Address:** \`${address}\``);
    }

    // Add funding note for low USDC balance (important for x402)
    const usdcPosition = positions.find(
      p => p.symbol === 'USDC' && p.chain === 'base'
    );
    const usdcBalance = usdcPosition?.amount ?? 0;
    
    if (usdcBalance < 0.10) {
      lines.push('');
      lines.push('⚠️ Low USDC (Base) balance! Fund your wallet for x402 payments.');
      lines.push(`   Send USDC to: \`${address}\` (Base network)`);
    }

    // Check for low ETH for gas
    const ethPosition = positions.find(
      p => p.symbol === 'ETH' && p.chain === 'base'
    );
    const ethBalance = ethPosition?.amount ?? 0;
    
    if (ethBalance < 0.0001) {
      lines.push('');
      lines.push('⚠️ Low ETH (Base) balance! You may need ETH for gas fees.');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    // Check for common configuration errors
    if (errorMsg.includes('ZERION_API_KEY')) {
      return {
        content: [{
          type: 'text',
          text: `❌ Zerion API not configured.\n\nSet environment variable:\n- ZERION_API_KEY\n\nGet your API key at: https://developers.zerion.io`,
        }],
        isError: true,
      };
    }

    if (errorMsg.includes('CLARA_PROXY_URL') || errorMsg.includes('PARA_WALLET_ID')) {
      return {
        content: [{
          type: 'text',
          text: `❌ Wallet not configured.\n\nSet environment variables:\n- CLARA_PROXY_URL\n- PARA_WALLET_ID\n\nOr run \`wallet_setup\` first.`,
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: `❌ Failed to get balance: ${errorMsg}`,
      }],
      isError: true,
    };
  }
}
