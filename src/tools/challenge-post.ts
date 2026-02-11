/**
 * challenge_post - Create a Challenge
 *
 * Posts a new challenge on-chain via ChallengeFactory.createChallenge().
 * Handles ERC-20 approval + challenge creation in sequence (two-tx pattern).
 */

import { encodeFunctionData, parseUnits, keccak256, toBytes, createPublicClient, http, type Hex } from 'viem';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { signAndSendTransaction } from '../para/transactions.js';
import {
  getChallengeContracts,
  CHALLENGE_FACTORY_ABI,
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
import { parsePayoutSplit, formatPayoutBreakdown } from './challenge-helpers.js';
import { syncFromChain } from '../indexer/sync.js';

export const challengePostToolDefinition: Tool = {
  name: 'challenge_post',
  description: `Create a new challenge with prize pool escrow.

Funds are locked on-chain until the challenge is scored and finalized.
Requires ERC-20 token approval followed by challenge creation.

**Example:**
\`\`\`json
{"prizePool": "500", "token": "USDC", "deadline": "7 days", "problemStatement": "Optimize this AMM fee curve for max volume", "winnerCount": 3, "skills": ["solidity", "defi"]}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      prizePool: {
        type: 'string',
        description: 'Total prize amount in human units (e.g., "500" for 500 USDC)',
      },
      token: {
        type: 'string',
        default: 'USDC',
        description: 'Token to pay with (default: USDC)',
      },
      deadline: {
        type: 'string',
        description: 'Submission deadline as ISO date or relative ("7 days", "2 weeks")',
      },
      scoringWindow: {
        type: 'string',
        default: '48 hours',
        description: 'Time after deadline for poster to post scores (default: "48 hours")',
      },
      problemStatement: {
        type: 'string',
        description: 'Description of the challenge problem',
      },
      evalConfigJSON: {
        type: 'string',
        description: 'Evaluation config JSON (will be hashed). Optional.',
      },
      winnerCount: {
        type: 'number',
        default: 3,
        description: 'Number of winners (1-20, default: 3)',
      },
      payoutSplit: {
        type: 'string',
        description: 'Split format: "top3" (60/25/15), "top5", "equal", or BPS array "[6000,2500,1500]"',
      },
      maxParticipants: {
        type: 'number',
        default: 0,
        description: 'Max submitters (0 = unlimited, default: 0)',
      },
      skills: {
        type: 'array',
        items: { type: 'string' },
        description: 'Skills needed (e.g., ["solidity", "optimization"])',
      },
    },
    required: ['prizePool', 'deadline', 'problemStatement', 'winnerCount'],
  },
};

export async function handleChallengePost(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const prizePool = args.prizePool as string;
  const tokenInput = (args.token as string) || 'USDC';
  const deadlineInput = args.deadline as string;
  const scoringWindow = (args.scoringWindow as string) || '48 hours';
  const problemStatement = args.problemStatement as string;
  const evalConfigJSON = args.evalConfigJSON as string | undefined;
  const winnerCount = Math.min(Math.max((args.winnerCount as number) || 3, 1), 20);
  const payoutSplitInput = args.payoutSplit as string | undefined;
  const maxParticipants = (args.maxParticipants as number) || 0;
  const skills = (args.skills as string[]) || [];

  // Validate inputs
  if (!prizePool || isNaN(parseFloat(prizePool)) || parseFloat(prizePool) <= 0) {
    return {
      content: [{ type: 'text', text: 'Invalid prize pool. Must be a positive number.' }],
      isError: true,
    };
  }

  if (!problemStatement || problemStatement.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Problem statement is required.' }],
      isError: true,
    };
  }

  // Resolve token
  const token = resolveToken(tokenInput, 'base');
  if (!token) {
    return {
      content: [{
        type: 'text',
        text: `Unknown token: ${tokenInput}. Supported: USDC, USDT, DAI, WETH.`,
      }],
      isError: true,
    };
  }

  // Parse deadlines
  let deadlineTimestamp: number;
  let scoringDeadlineTimestamp: number;
  try {
    deadlineTimestamp = parseDeadline(deadlineInput);
    scoringDeadlineTimestamp = deadlineTimestamp + parseDurationSeconds(scoringWindow);
  } catch (e) {
    return {
      content: [{
        type: 'text',
        text: `${e instanceof Error ? e.message : 'Invalid deadline format'}`,
      }],
      isError: true,
    };
  }

  // Build payout BPS
  const payoutBps = parsePayoutSplit(payoutSplitInput, winnerCount);
  const bpsSum = payoutBps.reduce((a, b) => a + b, 0);
  if (bpsSum !== 10000) {
    return {
      content: [{
        type: 'text',
        text: `Payout BPS must sum to 10000 (got ${bpsSum}). Adjust payoutSplit or winnerCount.`,
      }],
      isError: true,
    };
  }

  try {
    const contracts = getChallengeContracts();
    const prizeWei = parseUnits(prizePool, token.decimals);
    const chainId = getChainId('base');

    // Compute hashes
    const evalConfigHash = evalConfigJSON
      ? keccak256(toBytes(evalConfigJSON))
      : ('0x' + '0'.repeat(64)) as Hex;
    const privateSetHash = ('0x' + '0'.repeat(64)) as Hex; // No private set by default

    // Build challengeURI
    const challengeMetadata = {
      title: problemStatement.slice(0, 100),
      problemStatement,
      skills,
      postedBy: ctx.walletAddress,
      timestamp: new Date().toISOString(),
      ...(evalConfigJSON ? { evalConfig: evalConfigJSON } : {}),
    };
    const challengeURI = toDataUri(challengeMetadata);

    // Step 1: ERC-20 approve (prize pool + poster bond)
    // Bond = prizePool * posterBondRate / 10000 (default 5%)
    const posterBondWei = (prizeWei * 500n) / 10000n;
    const totalApproval = prizeWei + posterBondWei;

    const approveData = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [contracts.challengeFactory, totalApproval],
    });

    const approveResult = await signAndSendTransaction(ctx.session.walletId!, {
      to: token.address,
      value: 0n,
      data: approveData,
      chainId,
    });

    // Wait for approval tx to be mined
    const publicClient = createPublicClient({
      chain: (await import('viem/chains')).base,
      transport: http(getRpcUrl('base')),
    });
    await publicClient.waitForTransactionReceipt({ hash: approveResult.txHash });

    // Step 2: Create challenge (struct-based ABI — single CreateParams tuple)
    const createData = encodeFunctionData({
      abi: CHALLENGE_FACTORY_ABI,
      functionName: 'createChallenge',
      args: [
        {
          token: token.address,
          evaluator: '0x0000000000000000000000000000000000000000' as Hex, // poster-only mode (AI eval will set Clara's address)
          prizePool: prizeWei,
          deadline: BigInt(deadlineTimestamp),
          scoringDeadline: BigInt(scoringDeadlineTimestamp),
          challengeURI,
          evalConfigHash,
          privateSetHash,
          winnerCount,
          payoutBps: payoutBps.map((b) => b),
          maxParticipants: BigInt(maxParticipants),
          skillTags: skills,
        },
      ],
    });

    const result = await signAndSendTransaction(ctx.session.walletId!, {
      to: contracts.challengeFactory,
      value: 0n,
      data: createData,
      chainId,
    });

    // Sync indexer
    try {
      await syncFromChain();
    } catch (e) {
      console.error(`[challenge] Local indexer sync failed (non-fatal): ${e}`);
    }

    const explorerUrl = getExplorerTxUrl('base', result.txHash);

    const posterBondAmount = (parseFloat(prizePool) * 500) / 10000;
    const totalCost = parseFloat(prizePool) + posterBondAmount;
    const payoutStr = formatPayoutBreakdown(payoutBps, prizeWei.toString(), token.address);

    const lines = [
      '**Challenge Created!**',
      '',
      `**Problem:** ${problemStatement.slice(0, 120)}`,
      `**Prize Pool:** ${formatAmount(prizePool, token.symbol)}`,
      `**Poster Bond:** ${formatAmount(posterBondAmount.toString(), token.symbol)} (5%)`,
      `**Total Cost:** ${formatAmount(totalCost.toString(), token.symbol)}`,
      `**Deadline:** ${formatDeadline(deadlineTimestamp)}`,
      `**Scoring Window:** ${scoringWindow}`,
      `**Winners:** ${winnerCount}`,
      `**Payout:** ${payoutStr}`,
      `**Skills:** ${skills.length > 0 ? skills.join(', ') : 'any'}`,
      `**Max Participants:** ${maxParticipants > 0 ? maxParticipants : 'unlimited'}`,
      '',
      `**Transaction:** [${result.txHash.slice(0, 10)}...](${explorerUrl})`,
      '',
      'Prize pool + bond are locked in escrow. Post scores before the scoring deadline.',
    ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Challenge creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

/**
 * Parse a duration string like "48 hours" or "7 days" into seconds.
 */
function parseDurationSeconds(input: string): number {
  const match = input.match(/^(\d+)\s*(day|days|d|hour|hours|h|week|weeks|w|min|minutes|m)$/i);
  if (!match) return 48 * 3600; // Default 48 hours

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (unit.startsWith('d')) return value * 86400;
  if (unit.startsWith('h')) return value * 3600;
  if (unit.startsWith('w')) return value * 604800;
  if (unit.startsWith('m')) return value * 60;

  return 48 * 3600;
}
