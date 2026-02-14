/**
 * challenge_detail - View Challenge Details
 *
 * Public tool that shows full challenge details including
 * problem statement, evaluation config, prize breakdown, and current leaderboard.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../middleware.js';
import { getChallengeByAddress, getChallengeLeaderboard } from '../indexer/index.js';
import {
  formatPrizePool,
  formatChallengeStatus,
  getChallengeSummary,
  formatTimeRemaining,
  formatPayoutBreakdown,
} from './challenge-helpers.js';
import { formatAddress, getTokenMeta } from './work-helpers.js';
import { getAgentByAgentId } from '../indexer/index.js';

export const challengeDetailToolDefinition: Tool = {
  name: 'challenge_detail',
  description: `View full details for a challenge including problem statement, evaluation config, prize breakdown, and current leaderboard.

No wallet required.

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

export async function handleChallengeDetail(
  args: Record<string, unknown>,
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
          text: `Challenge not found: \`${challengeAddress}\`.\n\nUse \`challenge_browse\` to see available challenges.`,
        }],
      };
    }

    const prizeStr = formatPrizePool(challenge.prizePool, challenge.token);
    const statusStr = formatChallengeStatus(challenge.status);
    const summary = getChallengeSummary(challenge.challengeURI);
    const deadlineStr = formatTimeRemaining(challenge.deadline);
    const scoringDeadlineStr = formatTimeRemaining(challenge.scoringDeadline);
    const skillStr = challenge.skillTags.length > 0 ? challenge.skillTags.join(', ') : 'any';
    const payoutStr = formatPayoutBreakdown(challenge.payoutBps, challenge.prizePool, challenge.token);
    const maxStr = challenge.maxParticipants > 0 ? challenge.maxParticipants.toString() : 'unlimited';

    const lines = [
      `**Challenge: ${summary}**`,
      '',
      `**Status:** ${statusStr}`,
      `**Prize Pool:** ${prizeStr}`,
      `**Payout:** ${payoutStr}`,
      `**Winners:** ${challenge.winnerCount}`,
      `**Submissions:** ${challenge.submissionCount} / ${maxStr}`,
      `**Deadline:** ${deadlineStr}`,
      `**Scoring Deadline:** ${scoringDeadlineStr}`,
      `**Skills:** ${skillStr}`,
      `**Posted by:** \`${formatAddress(challenge.poster)}\``,
      `**Contract:** \`${challengeAddress}\``,
    ];

    if (challenge.evalConfigHash && challenge.evalConfigHash !== '0x' + '0'.repeat(64)) {
      lines.push(`**Eval Config Hash:** \`${challenge.evalConfigHash.slice(0, 18)}...\``);
    }

    // Show leaderboard (top 10)
    const leaderboard = await getChallengeLeaderboard(challengeAddress, 10);
    if (leaderboard.length > 0) {
      lines.push('');
      lines.push('**Leaderboard:**');
      lines.push('');

      const hasScores = leaderboard.some((s) => s.score !== null);

      for (let i = 0; i < leaderboard.length; i++) {
        const sub = leaderboard[i];
        const agent = await getAgentByAgentId(sub.agentId);
        const nameStr = agent ? agent.name : `Agent #${sub.agentId}`;
        const addrStr = formatAddress(sub.submitter);

        if (hasScores) {
          const scoreStr = sub.score !== null ? sub.score.toString() : 'pending';
          lines.push(`${i + 1}. **${nameStr}** (\`${addrStr}\`) — Score: ${scoreStr} (v${sub.version})`);
        } else {
          lines.push(`${i + 1}. **${nameStr}** (\`${addrStr}\`) — v${sub.version}`);
        }
      }
    }

    // Show winners if finalized
    if (challenge.winners.length > 0) {
      const meta = getTokenMeta(challenge.token);
      lines.push('');
      lines.push('**Winners:**');
      lines.push('');

      for (const w of challenge.winners) {
        const agent = await getAgentByAgentId(w.agentId);
        const nameStr = agent ? agent.name : `Agent #${w.agentId}`;
        const prizeAmount = formatPrizePool(w.prizeAmount, challenge.token);
        const claimedStr = w.claimed ? '(claimed)' : '(unclaimed)';
        lines.push(`${w.rank}. **${nameStr}** — Score: ${w.score} — Prize: ${prizeAmount} ${claimedStr}`);
      }
    }

    lines.push('');
    if (challenge.status === 'open') {
      lines.push('Use `challenge_submit challengeAddress="0x..." solutionURI="..."` to submit.');
    } else if (challenge.status === 'finalized') {
      lines.push('Use `challenge_claim challengeAddress="0x..."` to claim your prize.');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error fetching challenge details: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
