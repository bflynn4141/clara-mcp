/**
 * work_post - Create a Bounty
 *
 * Posts a new bounty on-chain via BountyFactory.createBounty().
 * Handles ERC-20 approval + bounty creation in sequence.
 */

import { encodeFunctionData, parseUnits, createPublicClient, http, type Hex } from 'viem';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { signAndSendTransaction } from '../para/transactions.js';
import {
  getBountyContracts,
  BOUNTY_FACTORY_ABI,
  ERC20_APPROVE_ABI,
} from '../config/clara-contracts.js';
import { getChainId, getExplorerTxUrl, getRpcUrl } from '../config/chains.js';
import { resolveToken } from '../config/tokens.js';
import {
  toDataUri,
  formatAddress,
  formatAmount,
  parseDeadline,
  formatDeadline,
} from './work-helpers.js';
import { checkSpendingLimits, recordSpending } from '../storage/spending.js';
import { requireContract } from '../gas-preflight.js';
import { awaitIndexed, getBountyByTxHash } from '../indexer/index.js';

export const workPostToolDefinition: Tool = {
  name: 'work_post',
  description: `Create a bounty in the Clara marketplace.

Funds are locked in escrow on-chain until the bounty is completed or cancelled.
Requires an ERC-20 token approval followed by the bounty creation transaction.

**Example:**
\`\`\`json
{"amount": "50", "token": "USDC", "deadline": "3 days", "taskSummary": "Write unit tests for the auth module", "skills": ["typescript", "testing"]}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      amount: {
        type: 'string',
        description: 'Bounty amount in human units (e.g., "50" for 50 USDC)',
      },
      token: {
        type: 'string',
        default: 'USDC',
        description: 'Token to pay with (default: USDC)',
      },
      deadline: {
        type: 'string',
        description: 'Deadline as ISO date ("2025-03-01") or relative ("3 days", "1 week")',
      },
      taskSummary: {
        type: 'string',
        description: 'Description of the work to be done',
      },
      skills: {
        type: 'array',
        items: { type: 'string' },
        description: 'Skills needed (e.g., ["solidity", "security"])',
      },
    },
    required: ['amount', 'deadline', 'taskSummary'],
  },
};

export async function handleWorkPost(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const amount = args.amount as string;
  const tokenInput = (args.token as string) || 'USDC';
  const deadlineInput = args.deadline as string;
  const taskSummary = args.taskSummary as string;
  const skills = (args.skills as string[]) || [];

  // Validate inputs
  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return {
      content: [{ type: 'text', text: '❌ Invalid amount. Must be a positive number.' }],
      isError: true,
    };
  }

  if (!taskSummary || taskSummary.trim().length === 0) {
    return {
      content: [{ type: 'text', text: '❌ Task summary is required.' }],
      isError: true,
    };
  }

  // Resolve token
  const token = resolveToken(tokenInput, 'base');
  if (!token) {
    return {
      content: [{
        type: 'text',
        text: `❌ Unknown token: ${tokenInput}. Supported: USDC, USDT, DAI, WETH.`,
      }],
      isError: true,
    };
  }

  // Parse deadline
  let deadlineTimestamp: number;
  try {
    deadlineTimestamp = parseDeadline(deadlineInput);
  } catch (e) {
    return {
      content: [{
        type: 'text',
        text: `❌ ${e instanceof Error ? e.message : 'Invalid deadline format'}`,
      }],
      isError: true,
    };
  }

  try {
    const contracts = getBountyContracts();
    const amountWei = parseUnits(amount, token.decimals);
    const chainId = getChainId('base');

    // Verify factory contract exists on-chain (AUDIT-001 prevention)
    await requireContract('base', contracts.bountyFactory as Hex, 'bounty factory');

    // Get actual bond rate from factory (don't assume 10%)
    const publicClient = createPublicClient({
      chain: (await import('viem/chains')).base,
      transport: http(getRpcUrl('base')),
    });

    let bondRateBps: bigint;
    try {
      bondRateBps = await publicClient.readContract({
        address: contracts.bountyFactory,
        abi: BOUNTY_FACTORY_ABI,
        functionName: 'bondRate',
      }) as bigint;
    } catch (err) {
      console.error('[work_post] Failed to read bondRate from factory, using 10% fallback:', err instanceof Error ? err.message : err);
      bondRateBps = 1000n; // Fallback to 10%
    }

    // Check spending limits (stablecoins have 1:1 USD value)
    const STABLECOINS = ['USDC', 'USDT', 'DAI'];
    const posterBondAmount = (parseFloat(amount) * Number(bondRateBps)) / 10000;
    const totalCostFloat = parseFloat(amount) + posterBondAmount;
    if (STABLECOINS.includes(token.symbol.toUpperCase())) {
      const spendCheck = checkSpendingLimits(totalCostFloat.toFixed(2));
      if (!spendCheck.allowed) {
        return {
          content: [{
            type: 'text',
            text: `🛑 **Bounty blocked by spending limits**\n\n${spendCheck.reason}\n\nTotal cost: ${totalCostFloat.toFixed(2)} ${token.symbol} (${amount} escrow + ${posterBondAmount.toFixed(2)} bond)\n\nUse \`wallet_spending_limits\` to view or adjust your limits.`,
          }],
          isError: true,
        };
      }
    }

    // Step 1: ERC-20 approve (escrow + poster bond)
    // The factory calculates posterBond = amount * bondRate / 10000
    // We approve amount + posterBond so the factory can pull both in createBounty
    const posterBondWei = (amountWei * bondRateBps) / 10000n;
    const totalApproval = amountWei + posterBondWei;
    const approveData = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [contracts.bountyFactory, totalApproval],
    });

    const approveResult = await signAndSendTransaction(ctx.session.walletId!, {
      to: token.address,
      value: 0n,
      data: approveData,
      chainId,
    });

    // Wait for approval tx to be mined so on-chain nonce advances
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveResult.txHash });

    if (approveReceipt.status !== 'success') {
      return {
        content: [{
          type: 'text',
          text: `❌ Token approval failed. Transaction reverted.`,
        }],
        isError: true,
      };
    }

    // Step 2: Create bounty
    const taskMetadata = {
      summary: taskSummary,
      skills,
      postedBy: ctx.walletAddress,
      timestamp: new Date().toISOString(),
    };
    const taskURI = toDataUri(taskMetadata);

    const createData = encodeFunctionData({
      abi: BOUNTY_FACTORY_ABI,
      functionName: 'createBounty',
      args: [
        token.address,
        amountWei,
        BigInt(deadlineTimestamp),
        taskURI,
        skills,
      ],
    });

    const result = await signAndSendTransaction(ctx.session.walletId!, {
      to: contracts.bountyFactory,
      value: 0n,
      data: createData,
      chainId,
    });

    // Sync local indexer to pick up the BountyCreated event
    let bountyAddress: string | null = null;
    try {
      await awaitIndexed(result.txHash);
      const bounty = await getBountyByTxHash(result.txHash);
      bountyAddress = bounty?.bountyAddress ?? null;
    } catch (e) {
      console.error(`[work] Local indexer sync failed (non-fatal): ${e}`);
    }

    const explorerUrl = getExplorerTxUrl('base', result.txHash);

    // Bond rate display (variables already computed above for spending check)
    const bondRatePercent = Number(bondRateBps) / 100;
    const totalCost = totalCostFloat;

    const lines = [
      '✅ **Bounty Created!**',
      '',
      `**Task:** ${taskSummary}`,
      `**Escrow:** ${formatAmount(amount, token.symbol)}`,
      `**Poster Bond:** ${formatAmount(posterBondAmount.toString(), token.symbol)} (${bondRatePercent}% anti-griefing bond)`,
      `**Total Cost:** ${formatAmount(totalCost.toString(), token.symbol)}`,
      `**Deadline:** ${formatDeadline(deadlineTimestamp)}`,
      `**Skills:** ${skills.length > 0 ? skills.join(', ') : 'any'}`,
      `**Posted by:** \`${formatAddress(ctx.walletAddress)}\``,
    ];

    if (bountyAddress) {
      lines.push(`**Bounty Contract:** \`${formatAddress(bountyAddress)}\``);
    }

    lines.push('');
    lines.push(`**Transaction:** [${result.txHash.slice(0, 10)}...](${explorerUrl})`);
    lines.push('');
    lines.push('Funds + bond are locked in escrow. Bond is returned on approval/cancellation. Use `work_cancel` to refund if unclaimed.');

    // Record spending for limit tracking (stablecoins only)
    if (STABLECOINS.includes(token.symbol.toUpperCase())) {
      recordSpending({
        timestamp: new Date().toISOString(),
        amountUsd: totalCost.toFixed(2),
        recipient: bountyAddress || contracts.bountyFactory,
        description: `Bounty: ${taskSummary.slice(0, 60)} (${amount} + ${posterBondAmount.toFixed(2)} bond ${token.symbol})`,
        url: '',
        chainId,
        txHash: result.txHash,
        paymentId: `bounty-${result.txHash.slice(0, 10)}`,
      });
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Bounty creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
