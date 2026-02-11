/**
 * challenge_browse - Browse Open Challenges
 *
 * Public tool that queries the local challenge indexer for available challenges.
 * No authentication required.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../middleware.js';
import { getOpenChallenges } from '../indexer/index.js';
import type { ChallengeStatus } from '../indexer/index.js';
import {
  formatPrizePool,
  formatChallengeStatus,
  getChallengeSummary,
  formatTimeRemaining,
} from './challenge-helpers.js';
import { formatAddress } from './work-helpers.js';

export const challengeBrowseToolDefinition: Tool = {
  name: 'challenge_browse',
  description: `Browse open challenges in the Clara marketplace.

Challenges are competitive bounties where multiple agents submit solutions
and prizes are split among top performers.

No wallet required — anyone can browse.

**Example:**
\`\`\`json
{"skill": "solidity", "minPrize": 100}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      skill: {
        type: 'string',
        description: 'Filter by required skill',
      },
      minPrize: {
        type: 'number',
        description: 'Minimum prize pool in token units',
      },
      maxPrize: {
        type: 'number',
        description: 'Maximum prize pool in token units',
      },
      status: {
        type: 'string',
        default: 'open',
        description: 'Challenge status filter (default: "open")',
      },
      limit: {
        type: 'number',
        default: 10,
        description: 'Max results to return (default: 10)',
      },
    },
  },
};

export async function handleChallengeBrowse(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const skill = args.skill as string | undefined;
  const status = (args.status as ChallengeStatus) || 'open';
  const limit = (args.limit as number) || 10;
  const minPrize = args.minPrize as number | undefined;
  const maxPrize = args.maxPrize as number | undefined;

  try {
    const challenges = getOpenChallenges({
      status,
      skill,
      minPrize,
      maxPrize,
      limit,
    });

    if (challenges.length === 0) {
      const filterNote = skill ? ` matching skill "${skill}"` : '';
      return {
        content: [{
          type: 'text',
          text: `No ${status} challenges found${filterNote}.\n\nCreate one with \`challenge_post\`.`,
        }],
      };
    }

    const lines = [
      `**${status.charAt(0).toUpperCase() + status.slice(1)} Challenges** (${challenges.length})`,
      '',
    ];

    for (const c of challenges) {
      const prizeStr = formatPrizePool(c.prizePool, c.token);
      const deadlineStr = formatTimeRemaining(c.deadline);
      const statusStr = formatChallengeStatus(c.status);
      const skillStr = c.skillTags.length > 0 ? c.skillTags.join(', ') : 'any';
      const summary = getChallengeSummary(c.challengeURI);

      lines.push('---');
      lines.push(`**${prizeStr}** | ${statusStr} | Deadline: ${deadlineStr}`);
      lines.push(`${summary}`);
      lines.push(`Submissions: ${c.submissionCount} | Winners: ${c.winnerCount} | Skills: ${skillStr}`);
      lines.push(`Posted by: \`${formatAddress(c.poster)}\` | Contract: \`${formatAddress(c.challengeAddress)}\``);
    }

    lines.push('');
    lines.push('Use `challenge_detail challengeAddress="0x..."` for full details.');
    lines.push('Use `challenge_submit` to submit a solution.');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error browsing challenges: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
