/**
 * challenge_score - Check Your Score in a Challenge
 *
 * Auth required to look up the user's submission and score by wallet address.
 * Shows current score, rank, and submission version.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { getChallengeByAddress, getChallengeLeaderboard } from '../indexer/index.js';
import {
  formatPrizePool,
  formatChallengeStatus,
  getChallengeSummary,
} from './challenge-helpers.js';
import { formatAddress } from './work-helpers.js';

export const challengeScoreToolDefinition: Tool = {
  name: 'challenge_score',
  description: `Check your current score and rank in a challenge.

Requires wallet connection to look up your submission.

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

export async function handleChallengeScore(
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

  try {
    const challenge = await getChallengeByAddress(challengeAddress);
    if (!challenge) {
      return {
        content: [{
          type: 'text',
          text: `Challenge not found: \`${challengeAddress}\`.`,
        }],
        isError: true,
      };
    }

    const myAddress = ctx.walletAddress.toLowerCase();
    const mySubmission = challenge.submissions[myAddress];

    if (!mySubmission) {
      return {
        content: [{
          type: 'text',
          text: `You haven't submitted to this challenge yet.\n\nUse \`challenge_submit challengeAddress="${challengeAddress}"\` to submit.`,
        }],
      };
    }

    const summary = getChallengeSummary(challenge.challengeURI);
    const statusStr = formatChallengeStatus(challenge.status);

    const lines = [
      `**Your Score: ${summary}**`,
      '',
      `**Status:** ${statusStr}`,
      `**Your Submission:** v${mySubmission.version}`,
      `**Solution:** ${mySubmission.solutionURI.startsWith('http') ? `[Link](${mySubmission.solutionURI})` : mySubmission.solutionURI.slice(0, 80)}`,
    ];

    if (mySubmission.score !== null) {
      lines.push(`**Score:** ${mySubmission.score}`);

      // Calculate rank from leaderboard
      const leaderboard = await getChallengeLeaderboard(challengeAddress, 100);
      const myRank = leaderboard.findIndex((s) => s.submitter === myAddress) + 1;

      if (myRank > 0) {
        lines.push(`**Rank:** ${myRank} of ${leaderboard.length}`);

        // Distance from top
        if (myRank > 1 && leaderboard[0].score !== null) {
          const topScore = leaderboard[0].score!;
          const gap = topScore - (mySubmission.score ?? 0);
          lines.push(`**Gap to #1:** ${gap}`);
        }

        // Check if in winner range
        if (myRank <= challenge.winnerCount) {
          const winnerEntry = challenge.winners.find((w) => w.address === myAddress);
          if (winnerEntry) {
            const prizeStr = formatPrizePool(winnerEntry.prizeAmount, challenge.token);
            const claimedStr = winnerEntry.claimed ? '(already claimed)' : '(unclaimed)';
            lines.push(`**Prize:** ${prizeStr} ${claimedStr}`);
          } else {
            lines.push(`**In prize range!** (${myRank}/${challenge.winnerCount} winners)`);
          }
        }
      }
    } else {
      lines.push('**Score:** Pending — scores will be posted after the deadline.');
    }

    lines.push('');
    if (challenge.status === 'open') {
      lines.push('You can resubmit to improve your score before the deadline.');
    } else if (challenge.status === 'finalized') {
      const winnerEntry = challenge.winners.find((w) => w.address === myAddress);
      if (winnerEntry && !winnerEntry.claimed) {
        lines.push('Use `challenge_claim` to claim your prize!');
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Score check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
