/**
 * work_browse - Browse Open Bounties
 *
 * Public tool that queries the local bounty indexer for available bounties.
 * No authentication required.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../middleware.js';
import { getOpenBounties } from '../indexer/index.js';
import type { BountyStatus } from '../indexer/index.js';
import { formatAddress, formatDeadline, formatRawAmount, getTaskSummary } from './work-helpers.js';

export const workBrowseToolDefinition: Tool = {
  name: 'work_browse',
  description: `Browse open bounties in the Clara marketplace.

No wallet required — anyone can browse available work.

**Example:**
\`\`\`json
{"skill": "solidity", "minAmount": 10}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      skill: {
        type: 'string',
        description: 'Filter by required skill',
      },
      minAmount: {
        type: 'number',
        description: 'Minimum bounty amount (in token units)',
      },
      maxAmount: {
        type: 'number',
        description: 'Maximum bounty amount (in token units)',
      },
      status: {
        type: 'string',
        default: 'open',
        description: 'Bounty status filter (default: "open")',
      },
      limit: {
        type: 'number',
        default: 10,
        description: 'Max results to return (default: 10)',
      },
    },
  },
};

export async function handleWorkBrowse(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const skill = args.skill as string | undefined;
  const status = (args.status as BountyStatus) || 'open';
  const limit = (args.limit as number) || 10;

  const minAmount = args.minAmount as number | undefined;
  const maxAmount = args.maxAmount as number | undefined;

  try {
    let bounties = await getOpenBounties({
      status,
      skill,
      limit,
    });

    // Client-side amount filtering (not supported by Ponder)
    if (minAmount !== undefined || maxAmount !== undefined) {
      bounties = bounties.filter((b) => {
        const amt = parseFloat(b.amount);
        if (minAmount !== undefined && amt < minAmount) return false;
        if (maxAmount !== undefined && amt > maxAmount) return false;
        return true;
      });
    }

    if (bounties.length === 0) {
      const filterNote = skill ? ` matching skill "${skill}"` : '';
      return {
        content: [{
          type: 'text',
          text: `No ${status} bounties found${filterNote}.\n\nCreate one with \`work_post\`.`,
        }],
      };
    }

    const lines = [
      `**${status.charAt(0).toUpperCase() + status.slice(1)} Bounties** (${bounties.length})`,
      '',
    ];

    for (const b of bounties) {
      const deadlineStr = b.deadline ? formatDeadline(b.deadline) : 'N/A';
      const skillStr = b.skillTags.length > 0 ? b.skillTags.join(', ') : 'any';
      const amountStr = formatRawAmount(b.amount, b.token);
      const summary = getTaskSummary(b.taskURI);

      lines.push(`---`);
      lines.push(`**${amountStr}** | Deadline: ${deadlineStr}`);
      lines.push(`${summary}`);
      lines.push(`Skills: ${skillStr} | Posted by: \`${formatAddress(b.poster)}\``);
      lines.push(`Contract: \`${b.bountyAddress}\``);
    }

    lines.push('');
    lines.push('Use `work_claim bountyAddress="0x..."` to claim a bounty.');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Browse failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
