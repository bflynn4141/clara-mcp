/**
 * challenge_claim - Claim Prize from a Finalized Challenge
 *
 * Calls Challenge.claimPrize() to withdraw the user's prize
 * after the challenge has been scored and finalized.
 */

import { encodeFunctionData, type Hex } from 'viem';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { signAndSendTransaction } from '../para/transactions.js';
import { CHALLENGE_ABI } from '../config/clara-contracts.js';
import { getChainId, getExplorerTxUrl } from '../config/chains.js';
import { formatAddress } from './work-helpers.js';
import { formatPrizePool } from './challenge-helpers.js';
import { requireContract } from '../gas-preflight.js';
import { syncFromChain } from '../indexer/sync.js';
import { getChallengeByAddress } from '../indexer/challenge-queries.js';

export const challengeClaimToolDefinition: Tool = {
  name: 'challenge_claim',
  description: `Claim your prize from a finalized challenge.

The challenge must be finalized (scores posted) and you must be in the winner list.
No Merkle proof needed — winners are stored on-chain.

**Example:**
\`\`\`json
{"challengeAddress": "0x1234..."}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      challengeAddress: {
        type: 'string',
        description: 'The challenge contract address',
      },
    },
    required: ['challengeAddress'],
  },
};

export async function handleChallengeClaim(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const challengeAddress = args.challengeAddress as string;

  if (!challengeAddress || !challengeAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
    return {
      content: [{ type: 'text', text: 'Invalid challenge address.' }],
      isError: true,
    };
  }

  // Pre-flight: check challenge is finalized and user is a winner
  const challenge = getChallengeByAddress(challengeAddress);
  if (challenge) {
    if (challenge.status !== 'finalized') {
      return {
        content: [{
          type: 'text',
          text: `Challenge is ${challenge.status}. Prizes can only be claimed after finalization.`,
        }],
        isError: true,
      };
    }

    const myAddress = ctx.walletAddress.toLowerCase();
    const winner = challenge.winners.find((w) => w.address === myAddress);

    if (!winner) {
      return {
        content: [{
          type: 'text',
          text: 'You are not in the winner list for this challenge.',
        }],
        isError: true,
      };
    }

    if (winner.claimed) {
      return {
        content: [{
          type: 'text',
          text: `Prize already claimed (${formatPrizePool(winner.prizeAmount, challenge.token)}).`,
        }],
      };
    }
  }

  try {
    await requireContract('base', challengeAddress as Hex, 'challenge contract');

    const data = encodeFunctionData({
      abi: CHALLENGE_ABI,
      functionName: 'claimPrize',
    });

    const result = await signAndSendTransaction(ctx.session.walletId!, {
      to: challengeAddress as Hex,
      value: 0n,
      data,
      chainId: getChainId('base'),
    });

    // Sync indexer to pick up PrizeClaimed event
    try {
      await syncFromChain();
    } catch (e) {
      console.error(`[challenge] Local indexer sync failed (non-fatal): ${e}`);
    }

    const explorerUrl = getExplorerTxUrl('base', result.txHash);

    const lines = [
      '**Prize Claimed!**',
      '',
      `**Challenge:** \`${formatAddress(challengeAddress)}\``,
    ];

    // Show prize details if we have them from pre-flight
    if (challenge) {
      const myAddress = ctx.walletAddress.toLowerCase();
      const winner = challenge.winners.find((w) => w.address === myAddress);
      if (winner) {
        lines.push(`**Rank:** ${winner.rank}`);
        lines.push(`**Prize:** ${formatPrizePool(winner.prizeAmount, challenge.token)}`);
        lines.push(`**Score:** ${winner.score}`);
      }
    }

    lines.push('');
    lines.push(`**Transaction:** [${result.txHash.slice(0, 10)}...](${explorerUrl})`);

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Claim failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
