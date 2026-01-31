/**
 * Earn Tool
 *
 * Earn yield on tokens by depositing into lending protocols (Aave v3).
 * Uses DeFiLlama for yield discovery.
 */

import { type Hex, parseUnits, formatUnits } from 'viem';
import { getSession, touchSession } from '../storage/session.js';
import {
  getYieldOpportunities,
  createYieldPlan,
  encodeAaveSupply,
  encodeAaveWithdraw,
  encodeApprove,
  MAX_UINT256,
  getChainId,
  getAavePool,
  getToken,
  type YieldChain,
  type YieldOpportunity,
  type YieldPlan,
} from '../services/yield.js';
import { signAndSendTransaction } from '../para/transactions.js';

/**
 * Chain explorer URLs
 */
const EXPLORERS: Record<YieldChain, string> = {
  base: 'https://basescan.org',
  ethereum: 'https://etherscan.io',
  arbitrum: 'https://arbiscan.io',
  optimism: 'https://optimistic.etherscan.io',
};

/**
 * Tool definition for wallet_earn
 */
export const earnToolDefinition = {
  name: 'wallet_earn',
  description: `Earn yield on your tokens by depositing into lending protocols (Aave v3).

Clara finds the best yield across chains automatically.

**Find opportunities:**
\`\`\`json
{"action": "plan", "asset": "USDC"}
\`\`\`

**Deposit to earn yield:**
\`\`\`json
{"action": "deposit", "asset": "USDC", "amount": "100", "chain": "base"}
\`\`\`

**Withdraw:**
\`\`\`json
{"action": "withdraw", "asset": "USDC", "amount": "100", "chain": "base"}
\`\`\`

Supported assets: USDC, USDT, DAI, WETH
Supported chains: base, ethereum, arbitrum, optimism`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['plan', 'deposit', 'withdraw'],
        description: 'plan = find best yield, deposit = earn yield, withdraw = exit position',
      },
      asset: {
        type: 'string',
        description: 'Token to deposit/withdraw (USDC, USDT, DAI, WETH)',
      },
      amount: {
        type: 'string',
        description: 'Amount to deposit/withdraw (required for deposit/withdraw)',
      },
      chain: {
        type: 'string',
        enum: ['base', 'ethereum', 'arbitrum', 'optimism'],
        description: 'Chain for deposit/withdraw (optional for plan - finds best)',
      },
    },
    required: ['action', 'asset'],
  },
};

function isYieldChain(chain: string): chain is YieldChain {
  return ['base', 'ethereum', 'arbitrum', 'optimism'].includes(chain);
}

/**
 * Format opportunities for display
 */
function formatOpportunities(opportunities: YieldOpportunity[]): string {
  if (opportunities.length === 0) {
    return 'No yield opportunities found for this asset.';
  }

  const lines = [
    '## 💰 Yield Opportunities',
    '',
  ];

  for (const opp of opportunities.slice(0, 5)) {
    const tvl = opp.tvlUsd >= 1_000_000
      ? `$${(opp.tvlUsd / 1_000_000).toFixed(1)}M`
      : `$${(opp.tvlUsd / 1_000).toFixed(0)}K`;

    lines.push(`### ${opp.project} on ${opp.chain}`);
    lines.push(`- **APY:** ${opp.apy.toFixed(2)}%`);
    lines.push(`- **TVL:** ${tvl}`);
    lines.push(`- **Asset:** ${opp.symbol}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format plan for display
 */
function formatPlan(plan: YieldPlan): string {
  return [
    `## 📋 Yield Plan: ${plan.action}`,
    '',
    `**Asset:** ${plan.amount} ${plan.asset}`,
    `**Chain:** ${plan.chain}`,
    `**Protocol:** ${plan.protocol}`,
    `**APY:** ${plan.apy.toFixed(2)}%`,
    '',
    `_Run with action="${plan.action}" to execute_`,
  ].join('\n');
}

/**
 * Handle wallet_earn requests
 */
export async function handleEarnRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const action = args.action as string;
  const asset = args.asset as string;
  const amount = args.amount as string | undefined;
  const chainName = args.chain as string | undefined;

  // Validate inputs
  if (!action || !asset) {
    return {
      content: [{ type: 'text', text: '❌ Missing required parameters: action, asset' }],
      isError: true,
    };
  }

  if (chainName && !isYieldChain(chainName)) {
    return {
      content: [{
        type: 'text',
        text: `❌ Unsupported chain: ${chainName}\n\nSupported: base, ethereum, arbitrum, optimism`,
      }],
      isError: true,
    };
  }

  // Check session
  const session = await getSession();
  if (!session?.authenticated || !session.walletId || !session.address) {
    return {
      content: [{ type: 'text', text: '❌ Wallet not configured. Run `wallet_setup` first.' }],
      isError: true,
    };
  }

  await touchSession();

  const fromAddress = session.address as Hex;
  const chain = chainName as YieldChain | undefined;

  try {
    // Action: plan - find best yield opportunities
    if (action === 'plan') {
      const opportunities = await getYieldOpportunities(asset, {
        chains: chain ? [chain] : undefined,
      });

      if (opportunities.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No yield opportunities found for ${asset.toUpperCase()}.\n\nSupported assets: USDC, USDT, DAI, WETH`,
          }],
        };
      }

      // If amount provided, show a specific plan
      if (amount) {
        const plan = await createYieldPlan(asset, amount, chain);
        if (plan) {
          return {
            content: [{ type: 'text', text: formatPlan(plan) }],
          };
        }
      }

      return {
        content: [{ type: 'text', text: formatOpportunities(opportunities) }],
      };
    }

    // Action: deposit or withdraw
    if (action === 'deposit' || action === 'withdraw') {
      if (!amount) {
        return {
          content: [{ type: 'text', text: '❌ Amount is required for deposit/withdraw' }],
          isError: true,
        };
      }

      if (!chain) {
        // Find best chain if not specified
        const plan = await createYieldPlan(asset, amount);
        if (!plan) {
          return {
            content: [{
              type: 'text',
              text: `No yield opportunities found for ${asset}. Specify a chain to continue.`,
            }],
            isError: true,
          };
        }
        return {
          content: [{
            type: 'text',
            text: formatPlan(plan) + `\n\n_Add chain="${plan.chain}" to execute_`,
          }],
        };
      }

      // Get token info
      const token = getToken(asset, chain);
      if (!token) {
        return {
          content: [{
            type: 'text',
            text: `❌ Token ${asset} not supported on ${chain}`,
          }],
          isError: true,
        };
      }

      const amountWei = parseUnits(amount, token.decimals);
      const poolAddress = getAavePool(chain);
      const chainId = getChainId(chain);

      if (action === 'deposit') {
        // Step 1: Approve token spend
        console.error(`[clara] Approving ${asset} for Aave deposit...`);

        const approvalData = encodeApprove(poolAddress, MAX_UINT256);

        const approvalResult = await signAndSendTransaction(session.walletId, {
          to: token.address,
          value: 0n,
          data: approvalData,
          chainId,
        });

        // Step 2: Deposit to Aave
        console.error(`[clara] Depositing ${amount} ${asset} to Aave on ${chain}...`);

        const supplyData = encodeAaveSupply(token.address, amountWei, fromAddress);

        const depositResult = await signAndSendTransaction(session.walletId, {
          to: poolAddress,
          value: 0n,
          data: supplyData,
          chainId,
        });

        const explorerUrl = `${EXPLORERS[chain]}/tx/${depositResult.txHash}`;

        // Get APY for display
        const opportunities = await getYieldOpportunities(asset, { chains: [chain] });
        const apy = opportunities[0]?.apy || 0;

        return {
          content: [{
            type: 'text',
            text: [
              '✅ **Deposit Submitted!**',
              '',
              `**Deposited:** ${amount} ${asset.toUpperCase()}`,
              `**Chain:** ${chain}`,
              `**Protocol:** Aave v3`,
              `**APY:** ~${apy.toFixed(2)}%`,
              '',
              `**Transaction:** [${depositResult.txHash.slice(0, 10)}...](${explorerUrl})`,
              '',
              'Your deposit will start earning yield immediately.',
            ].join('\n'),
          }],
        };
      } else {
        // Withdraw from Aave
        console.error(`[clara] Withdrawing ${amount} ${asset} from Aave on ${chain}...`);

        const withdrawData = encodeAaveWithdraw(token.address, amountWei, fromAddress);

        const withdrawResult = await signAndSendTransaction(session.walletId, {
          to: poolAddress,
          value: 0n,
          data: withdrawData,
          chainId,
        });

        const explorerUrl = `${EXPLORERS[chain]}/tx/${withdrawResult.txHash}`;

        return {
          content: [{
            type: 'text',
            text: [
              '✅ **Withdrawal Submitted!**',
              '',
              `**Withdrew:** ${amount} ${asset.toUpperCase()}`,
              `**Chain:** ${chain}`,
              `**Protocol:** Aave v3`,
              '',
              `**Transaction:** [${withdrawResult.txHash.slice(0, 10)}...](${explorerUrl})`,
              '',
              'Your tokens will be in your wallet shortly.',
            ].join('\n'),
          }],
        };
      }
    }

    return {
      content: [{
        type: 'text',
        text: `❌ Unknown action: ${action}\n\nValid actions: plan, deposit, withdraw`,
      }],
      isError: true,
    };

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Earn failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
