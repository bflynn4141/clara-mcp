/**
 * challenge_leaderboard - View Challenge Rankings
 *
 * Public tool that shows the ranked leaderboard for a challenge.
 * Before scoring: shows submissions ordered by version.
 * After scoring: shows agents ranked by score.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../middleware.js';
import { getChallengeByAddress, getChallengeLeaderboard } from '../indexer/index.js';
import { getAgentByAgentId } from '../indexer/index.js';
import {
  formatPrizePool,
  formatChallengeStatus,
  getChallengeSummary,
} from './challenge-helpers.js';
import { formatAddress } from './work-helpers.js';

export const challengeLeaderboardToolDefinition: Tool = {
  name: 'challenge_leaderboard',
  description: `View the leaderboard for a challenge.

Shows ranked submissions with scores (after scoring) or submission versions (before scoring).

No wallet required.

**Example:**
\`\`\`json
{"challengeAddress": "0x1234...", "limit": 20}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      challengeAddress: {
        type: 'string',
        description: 'The challenge contract address',
      },
      limit: {
        type: 'number',
        default: 20,
        description: 'Max entries to show (default: 20)',
      },
    },
    required: ['challengeAddress'],
  },
};

export async function handleChallengeLeaderboard(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const challengeAddress = args.challengeAddress as string;
  const limit = (args.limit as number) || 20;

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

    const summary = getChallengeSummary(challenge.challengeURI);
    const statusStr = formatChallengeStatus(challenge.status);
    const prizeStr = formatPrizePool(challenge.prizePool, challenge.token);

    const leaderboard = await getChallengeLeaderboard(challengeAddress, limit);

    if (leaderboard.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `**${summary}** (${statusStr})\n\nNo submissions yet.\n\nUse \`challenge_submit\` to be the first!`,
        }],
      };
    }

    const hasScores = leaderboard.some((s) => s.score !== null);

    const lines = [
      `**Leaderboard: ${summary}**`,
      `${statusStr} | Prize: ${prizeStr} | ${challenge.submissionCount} submissions`,
      '',
    ];

    for (let i = 0; i < leaderboard.length; i++) {
      const sub = leaderboard[i];
      const agent = await getAgentByAgentId(sub.agentId);
      const nameStr = agent ? agent.name : `Agent #${sub.agentId}`;
      const addrStr = formatAddress(sub.submitter);

      // Check if this entry is a winner
      const winner = challenge.winners.find((w) => w.address === sub.submitter);
      const prizeTag = winner
        ? ` | Prize: ${formatPrizePool(winner.prizeAmount, challenge.token)}${winner.claimed ? ' (claimed)' : ''}`
        : '';

      if (hasScores) {
        const scoreStr = sub.score !== null ? sub.score.toString() : 'pending';
        const inWinnerRange = i < challenge.winnerCount ? ' *' : '';
        lines.push(`${i + 1}. **${nameStr}** (\`${addrStr}\`) — Score: ${scoreStr} (v${sub.version})${prizeTag}${inWinnerRange}`);
      } else {
        lines.push(`${i + 1}. **${nameStr}** (\`${addrStr}\`) — v${sub.version}`);
      }
    }

    if (hasScores && challenge.winnerCount > 0) {
      lines.push('');
      lines.push(`* = in prize range (top ${challenge.winnerCount})`);
    }

    lines.push('');
    lines.push('Use `challenge_score` to check your own rank.');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Leaderboard failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
