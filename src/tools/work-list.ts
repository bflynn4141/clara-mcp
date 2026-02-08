/**
 * work_list - List Your Bounties
 *
 * Shows bounties you've posted and/or claimed.
 * Queries the local bounty indexer by wallet address.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { getBountiesByPoster, getBountiesByClaimer } from '../indexer/index.js';
import type { BountyRecord } from '../indexer/index.js';
import { formatAddress, formatDeadline, formatRawAmount, getTaskSummary } from './work-helpers.js';

export const workListToolDefinition: Tool = {
  name: 'work_list',
  description: `List your bounties — posted, claimed, or both.

**Examples:**
\`\`\`json
{"role": "poster"}
{"role": "claimer"}
{"role": "all"}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      role: {
        type: 'string',
        enum: ['poster', 'claimer', 'all'],
        default: 'all',
        description: 'Filter by role: "poster" (bounties you created), "claimer" (bounties you claimed), or "all"',
      },
    },
  },
};

export async function handleWorkList(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const role = (args.role as string) || 'all';
  const address = ctx.walletAddress;

  try {
    let bounties: BountyRecord[] = [];

    if (role === 'poster' || role === 'all') {
      bounties.push(...getBountiesByPoster(address));
    }
    if (role === 'claimer' || role === 'all') {
      const claimed = getBountiesByClaimer(address);
      // Avoid duplicates if same address is both poster and claimer
      for (const b of claimed) {
        if (!bounties.some((existing) => existing.bountyAddress === b.bountyAddress)) {
          bounties.push(b);
        }
      }
    }

    if (bounties.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No bounties found for role "${role}".\n\nPost a bounty with \`work_post\` or browse available work with \`work_browse\`.`,
        }],
      };
    }

    // Group by status
    const grouped: Record<string, BountyRecord[]> = {};
    for (const b of bounties) {
      const s = b.status || 'unknown';
      if (!grouped[s]) grouped[s] = [];
      grouped[s].push(b);
    }

    const lines = [
      `**Your Bounties** (${bounties.length} total, role: ${role})`,
      '',
    ];

    for (const [status, items] of Object.entries(grouped)) {
      lines.push(`### ${status.charAt(0).toUpperCase() + status.slice(1)} (${items.length})`);
      lines.push('');

      for (const b of items) {
        const deadlineStr = b.deadline ? formatDeadline(b.deadline) : 'N/A';
        const roleLabel = b.poster.toLowerCase() === address.toLowerCase()
          ? 'Posted'
          : 'Claimed';
        const amountStr = formatRawAmount(b.amount, b.token);
        const summary = getTaskSummary(b.taskURI);

        lines.push(`- **${amountStr}** | ${roleLabel} | Deadline: ${deadlineStr}`);
        lines.push(`  ${summary}`);
        lines.push(`  Contract: \`${formatAddress(b.bountyAddress)}\``);
      }

      lines.push('');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ List failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
