/**
 * wallet_dashboard - Unified Wallet Overview
 *
 * Combines session info, multi-chain balances, and activity summary
 * into a single dashboard view. Simplified version without yield positions
 * (since wallet_earn is not yet migrated).
 *
 * Returns both human-readable display and structured data for programmatic use.
 */

import { createPublicClient, formatUnits, http, type Hex } from 'viem';
import { getWalletStatus } from '../para/client.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { formatSpendingSummary, getSpendingHistory } from '../storage/spending.js';
import { CHAINS, getRpcUrl, type SupportedChain } from '../config/chains.js';
import { getProviderRegistry } from '../providers/index.js';

/**
 * Known token addresses by chain (same as balance.ts)
 */
const TOKENS: Record<string, Record<string, { address: Hex; decimals: number; symbol: string }>> = {
  base: {
    USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, symbol: 'USDC' },
    USDT: { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6, symbol: 'USDT' },
    DAI: { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, symbol: 'DAI' },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18, symbol: 'WETH' },
  },
  ethereum: {
    USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, symbol: 'USDC' },
    USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, symbol: 'USDT' },
    DAI: { address: '0x6B175474E89094C44Da98b954EescdeCB5BE3830', decimals: 18, symbol: 'DAI' },
    WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, symbol: 'WETH' },
  },
  arbitrum: {
    USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, symbol: 'USDC' },
    USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, symbol: 'USDT' },
    DAI: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, symbol: 'DAI' },
    WETH: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18, symbol: 'WETH' },
  },
  optimism: {
    USDC: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6, symbol: 'USDC' },
    USDT: { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6, symbol: 'USDT' },
    DAI: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, symbol: 'DAI' },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18, symbol: 'WETH' },
  },
  polygon: {
    USDC: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, symbol: 'USDC' },
    USDT: { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6, symbol: 'USDT' },
    DAI: { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18, symbol: 'DAI' },
    WETH: { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18, symbol: 'WETH' },
  },
};

// ERC-20 balanceOf ABI
const ERC20_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// Supported chains for dashboard (ordered by priority)
const DASHBOARD_CHAINS: SupportedChain[] = ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'];

/**
 * Tool definition for wallet_dashboard
 */
export const dashboardToolDefinition = {
  name: 'wallet_dashboard',
  description: `Get a comprehensive overview of your wallet.

Shows:
- Session status and wallet address
- Multi-chain balances (ETH + stablecoins across all supported chains)
- Total portfolio value estimate (for stablecoins)
- Recent spending activity
- Suggested actions

**Example:**
\`\`\`json
{}
\`\`\`

Returns a unified view combining wallet status, balances, and activity.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      includeZeroBalances: {
        type: 'boolean',
        default: false,
        description: 'Include chains/tokens with zero balance (default: false)',
      },
    },
  },
};

/**
 * Balance data for a single chain
 */
interface ChainBalance {
  chain: SupportedChain;
  nativeSymbol: string;
  nativeBalance: string;
  nativeBalanceRaw: bigint;
  tokens: Array<{
    symbol: string;
    balance: string;
    balanceRaw: bigint;
    usdValue: number;
  }>;
  totalUsdValue: number;
}

/**
 * Fetch balances for a single chain using Herd token discovery (with fallback to RPC)
 */
async function fetchChainBalances(
  chain: SupportedChain,
  address: Hex,
  includeZero: boolean
): Promise<ChainBalance | null> {
  const chainConfig = CHAINS[chain];
  const registry = getProviderRegistry();

  // Try Herd token discovery first (only for ethereum/base)
  if (chain === 'ethereum' || chain === 'base') {
    try {
      const discovery = await registry.discoverTokens(address, chain);

      if (discovery.success && discovery.data && discovery.data.balances.length > 0) {
        // Extract native token and ERC-20 tokens
        const nativeToken = discovery.data.balances.find(b => b.address === 'native');
        const erc20Tokens = discovery.data.balances.filter(b => b.address !== 'native');

        // Filter tokens by minimum balance
        const filteredTokens = erc20Tokens.filter(
          t => parseFloat(t.amount) > 0.0001 || includeZero
        );

        const nativeBalance = nativeToken?.amount || '0';
        const hasNative = parseFloat(nativeBalance) > 0.00001;
        const hasTokens = filteredTokens.length > 0;

        if (!hasNative && !hasTokens && !includeZero) {
          return null;
        }

        return {
          chain,
          nativeSymbol: nativeToken?.symbol || chainConfig.nativeSymbol,
          nativeBalance,
          nativeBalanceRaw: 0n, // Not available from Herd, but not needed for display
          tokens: filteredTokens.map(t => ({
            symbol: t.symbol,
            balance: t.amount,
            balanceRaw: 0n, // Not available from Herd
            usdValue: t.valueUsd,
          })),
          totalUsdValue: discovery.data.totalValueUsd,
        };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[dashboard] Herd discovery failed for ${chain}, falling back to RPC: ${msg}`);
    }
  }

  // Fallback to legacy RPC-based method
  return fetchChainBalancesLegacy(chain, address, includeZero);
}

/**
 * Legacy RPC-based balance fetching (fallback when Herd unavailable)
 */
async function fetchChainBalancesLegacy(
  chain: SupportedChain,
  address: Hex,
  includeZero: boolean
): Promise<ChainBalance | null> {
  const chainConfig = CHAINS[chain];
  const tokens = TOKENS[chain] || {};

  try {
    const client = createPublicClient({
      chain: chainConfig.chain,
      transport: http(getRpcUrl(chain)),
    });

    // Fetch native balance
    const nativeBalance = await client.getBalance({ address });
    const nativeFormatted = formatUnits(nativeBalance, chainConfig.nativeDecimals);

    // Fetch token balances in parallel
    const tokenResults = await Promise.allSettled(
      Object.entries(tokens).map(async ([symbol, token]) => {
        const balance = await client.readContract({
          address: token.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address],
        });
        return { symbol, balance, decimals: token.decimals };
      })
    );

    // Process token results
    const tokenBalances: ChainBalance['tokens'] = [];
    let totalUsd = 0;

    for (const result of tokenResults) {
      if (result.status === 'fulfilled') {
        const { symbol, balance, decimals } = result.value;
        const formatted = formatUnits(balance, decimals);
        const balanceNum = parseFloat(formatted);

        if (balanceNum > 0.0001 || includeZero) {
          // Stablecoins are ~$1 USD
          const isStable = ['USDC', 'USDT', 'DAI'].includes(symbol);
          const usdValue = isStable ? balanceNum : 0;
          totalUsd += usdValue;

          tokenBalances.push({
            symbol,
            balance: formatted,
            balanceRaw: balance,
            usdValue,
          });
        }
      }
    }

    // Skip chain if no meaningful balances (unless includeZero)
    const hasNative = parseFloat(nativeFormatted) > 0.00001;
    const hasTokens = tokenBalances.length > 0;

    if (!hasNative && !hasTokens && !includeZero) {
      return null;
    }

    return {
      chain,
      nativeSymbol: chainConfig.nativeSymbol,
      nativeBalance: nativeFormatted,
      nativeBalanceRaw: nativeBalance,
      tokens: tokenBalances,
      totalUsdValue: totalUsd,
    };
  } catch (error) {
    const code = (error as any)?.code;
    const msg = error instanceof Error ? error.message : String(error);
    const detail = code ? `RPC error (${code})` : msg;
    console.error(`[dashboard] Skipping ${chain}: ${detail}`);
    return null;
  }
}

/**
 * Handle wallet_dashboard requests
 */
export async function handleDashboardRequest(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const includeZero = (args.includeZeroBalances as boolean) || false;

  try {
    const address = ctx.walletAddress;

    // Fetch wallet status and balances in parallel
    const [status, ...chainBalances] = await Promise.all([
      getWalletStatus(),
      ...DASHBOARD_CHAINS.map((chain) => fetchChainBalances(chain, address, includeZero)),
    ]);

    // Filter out null results
    const balances = chainBalances.filter((b): b is ChainBalance => b !== null);

    // Calculate totals
    const totalUsd = balances.reduce((sum, b) => sum + b.totalUsdValue, 0);

    // Get recent spending
    const spendingHistory = getSpendingHistory();
    const recentSpending = spendingHistory.slice(0, 3);

    // Build display
    const lines: string[] = [
      '# 📊 Wallet Dashboard',
      '',
      '## Account',
      `**Address:** \`${address}\``,
    ];

    if (status.email) {
      lines.push(`**Email:** ${status.email}`);
    }

    lines.push(`**Session:** ${status.sessionAge || 'Active'}`);
    lines.push('');

    // Portfolio summary
    lines.push('## 💰 Portfolio');

    if (totalUsd > 0) {
      lines.push(`**Total Stablecoins:** $${totalUsd.toFixed(2)}`);
      lines.push('');
    }

    if (balances.length === 0) {
      lines.push('_No balances found on any chain_');
      lines.push('');
    } else {
      for (const chainBal of balances) {
        const nativeNum = parseFloat(chainBal.nativeBalance);
        lines.push(`### ${chainBal.chain.charAt(0).toUpperCase() + chainBal.chain.slice(1)}`);

        // Native token
        if (nativeNum > 0.00001) {
          lines.push(`- **${chainBal.nativeSymbol}:** ${nativeNum.toFixed(6)}`);
        }

        // Tokens
        for (const token of chainBal.tokens) {
          const bal = parseFloat(token.balance).toFixed(6);
          const usd = token.usdValue > 0 ? ` ($${token.usdValue.toFixed(2)})` : '';
          lines.push(`- **${token.symbol}:** ${bal}${usd}`);
        }

        lines.push('');
      }
    }

    // Spending limits
    lines.push('## 🔒 Spending Limits');
    lines.push(formatSpendingSummary());
    lines.push('');

    // Recent activity
    if (recentSpending.length > 0) {
      lines.push('## 📜 Recent Payments');
      for (const payment of recentSpending) {
        const date = new Date(payment.timestamp).toLocaleDateString();
        lines.push(`- ${date}: $${payment.amountUsd} to ${payment.description || payment.url}`);
      }
      lines.push('');
    }

    // Suggested actions
    lines.push('## 💡 Actions');
    lines.push('- `wallet_send` - Send tokens');
    lines.push('- `wallet_call` - Call any contract');

    // Build structured data for programmatic use
    const structuredData = {
      address,
      email: status.email,
      sessionAge: status.sessionAge,
      portfolio: {
        totalStablecoinsUsd: totalUsd,
        chains: balances.map((b) => ({
          chain: b.chain,
          native: {
            symbol: b.nativeSymbol,
            balance: b.nativeBalance,
          },
          tokens: b.tokens.map((t) => ({
            symbol: t.symbol,
            balance: t.balance,
            usdValue: t.usdValue,
          })),
        })),
      },
      recentPayments: recentSpending.length,
    };

    // Include structured data as JSON block at the end
    lines.push('');
    lines.push('---');
    lines.push('```json');
    lines.push(JSON.stringify(structuredData, null, 2));
    lines.push('```');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Dashboard failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
