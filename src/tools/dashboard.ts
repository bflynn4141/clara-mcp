/**
 * Dashboard Tool
 *
 * Consolidated wallet overview.
 * Aggregates: address, balances, spending limits, recent activity.
 */

import {
  createPublicClient,
  http,
  formatEther,
  formatUnits,
  type Hex,
} from 'viem';
import { getSession, touchSession } from '../storage/session.js';
import { getSpendingLimits, getTodaySpending, getSpendingHistory } from '../storage/spending.js';
import { CHAINS, getRpcUrl, type SupportedChain } from '../config/chains.js';

/**
 * Tool definition for wallet_dashboard
 */
export const dashboardToolDefinition = {
  name: 'wallet_dashboard',
  description: `Get a complete overview of your wallet in one command.

Shows:
- 💳 Wallet address
- 💰 Balances across all chains
- 📊 Spending limits and today's usage
- 📜 Recent spending history

**Usage:**
\`\`\`json
{}
\`\`\`

One command to see everything.`,
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
};

/**
 * USDC addresses per chain
 */
const USDC_ADDRESSES: Record<SupportedChain, Hex> = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
};

/**
 * ERC-20 balanceOf ABI
 */
const BALANCE_OF_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * Fetch balances for a chain
 */
async function fetchChainBalances(
  address: Hex,
  chainName: SupportedChain
): Promise<{ native: bigint; usdc: bigint } | null> {
  try {
    const chainConfig = CHAINS[chainName];
    const client = createPublicClient({
      chain: chainConfig.chain,
      transport: http(getRpcUrl(chainName)),
    });

    // Fetch native and USDC in parallel
    const [native, usdc] = await Promise.all([
      client.getBalance({ address }),
      client.readContract({
        address: USDC_ADDRESSES[chainName],
        abi: BALANCE_OF_ABI,
        functionName: 'balanceOf',
        args: [address],
      }).catch(() => 0n),
    ]);

    return { native, usdc };
  } catch {
    return null;
  }
}

/**
 * Handle wallet_dashboard requests
 */
export async function handleDashboardRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  // Check session
  const session = await getSession();
  if (!session?.authenticated || !session.address) {
    return {
      content: [{ type: 'text', text: '❌ Wallet not configured. Run `wallet_setup` first.' }],
      isError: true,
    };
  }

  await touchSession();

  const address = session.address as Hex;

  const lines: string[] = [];
  lines.push('# 📊 Wallet Dashboard');
  lines.push('');

  // Address section
  lines.push('## 💳 Address');
  lines.push(`\`${address}\``);
  lines.push('');

  // Balances section
  lines.push('## 💰 Balances');
  lines.push('');

  const chainNames: SupportedChain[] = ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'];

  // Fetch all balances in parallel
  const balancePromises = chainNames.map(chain => fetchChainBalances(address, chain));
  const balances = await Promise.all(balancePromises);

  let totalUsdcValue = 0n;
  let hasAnyBalance = false;

  for (let i = 0; i < chainNames.length; i++) {
    const chainName = chainNames[i];
    const balance = balances[i];
    const chainConfig = CHAINS[chainName];

    if (balance) {
      const nativeFormatted = parseFloat(formatEther(balance.native));
      const usdcFormatted = parseFloat(formatUnits(balance.usdc, 6));

      // Only show chains with non-zero balance
      if (nativeFormatted > 0.0001 || usdcFormatted > 0.01) {
        hasAnyBalance = true;
        lines.push(`**${chainConfig.name}:**`);

        if (nativeFormatted > 0.0001) {
          lines.push(`  - ${nativeFormatted.toFixed(4)} ${chainConfig.nativeSymbol}`);
        }
        if (usdcFormatted > 0.01) {
          lines.push(`  - ${usdcFormatted.toFixed(2)} USDC`);
          totalUsdcValue += balance.usdc;
        }
      }
    }
  }

  if (!hasAnyBalance) {
    lines.push('_No significant balances found_');
  }

  // Total USDC
  if (totalUsdcValue > 0n) {
    const totalUsdc = parseFloat(formatUnits(totalUsdcValue, 6));
    lines.push('');
    lines.push(`**Total USDC:** $${totalUsdc.toFixed(2)}`);
  }

  lines.push('');

  // Spending section
  lines.push('## 📊 Spending Controls');
  lines.push('');

  const limits = getSpendingLimits();
  const todaySpent = getTodaySpending();
  const maxPerDay = parseFloat(limits.maxPerDay);
  const remainingToday = Math.max(0, maxPerDay - todaySpent);

  lines.push(`**Daily Limit:** $${limits.maxPerDay}`);
  lines.push(`**Spent Today:** $${todaySpent.toFixed(2)}`);
  lines.push(`**Remaining:** $${remainingToday.toFixed(2)}`);
  lines.push('');
  lines.push(`**Per-Transaction Limit:** $${limits.maxPerTransaction}`);
  lines.push(`**Approval Required Above:** $${limits.requireApprovalAbove}`);
  lines.push('');

  // Recent spending history
  lines.push('## 📜 Recent Spending');
  lines.push('');

  const history = getSpendingHistory(7);

  if (history.length === 0) {
    lines.push('_No recent x402 payments_');
  } else {
    // Show last 5 transactions
    const recent = history.slice(0, 5);
    for (const tx of recent) {
      const date = new Date(tx.timestamp);
      const dateStr = date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
      const desc = tx.description.length > 30
        ? tx.description.slice(0, 30) + '...'
        : tx.description;
      lines.push(`- **${dateStr}:** $${tx.amountUsd} - ${desc}`);
    }

    if (history.length > 5) {
      lines.push(`_... and ${history.length - 5} more_`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('_Run individual tools for more details: `wallet_balance`, `wallet_history`, `wallet_spending_history`_');

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}
