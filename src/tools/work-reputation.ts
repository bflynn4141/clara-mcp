/**
 * work_reputation - View Agent Reputation
 *
 * Reads agent reputation from the local index (sub-millisecond)
 * and enriches with bounty stats. No RPC calls needed.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../middleware.js';
import { formatAddress } from './work-helpers.js';
import {
  getAgentByAddress,
  getAgentByAgentId,
  getReputationSummary,
  getBountiesByPoster,
  getBountiesByClaimer,
} from '../indexer/index.js';

export const workReputationToolDefinition: Tool = {
  name: 'work_reputation',
  description: `View an agent's reputation in the Clara marketplace.

Look up by wallet address or agent ID.

**Example:**
\`\`\`json
{"address": "0x1234..."}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      address: {
        type: 'string',
        description: 'Agent wallet address',
      },
      agentId: {
        type: 'number',
        description: 'Agent ID (alternative to address)',
      },
    },
  },
};

export async function handleWorkReputation(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const address = args.address as string | undefined;
  const agentId = args.agentId as number | undefined;

  if (!address && agentId === undefined) {
    return {
      content: [{
        type: 'text',
        text: '❌ Provide either `address` or `agentId`.',
      }],
      isError: true,
    };
  }

  try {
    // Resolve agent from the local index
    const agent = agentId !== undefined
      ? await getAgentByAgentId(agentId)
      : address
        ? await getAgentByAddress(address)
        : null;

    if (!agent) {
      // Graceful degradation: return what we can without erroring
      const addrDisplay = address ? formatAddress(address) : `ID ${agentId}`;
      const posted = address ? await getBountiesByPoster(address) : [];
      const claimed = address ? await getBountiesByClaimer(address) : [];

      const lines = [
        `**${addrDisplay}** — Not registered as an agent`,
        '',
      ];

      if (posted.length > 0 || claimed.length > 0) {
        lines.push(`**Bounties Posted:** ${posted.length}`);
        lines.push(`**Bounties Claimed:** ${claimed.length}`);
        lines.push('');
      }

      lines.push('No on-chain reputation yet. Register with `work_register` to build a profile.');

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }

    const resolvedAgentId = agent.agentId;
    const agentAddr = agent.owner;

    // Read cached reputation from index
    const reputation = await getReputationSummary(resolvedAgentId);

    // Enrich with bounty stats from local indexer
    const posted = await getBountiesByPoster(agentAddr);
    const claimed = await getBountiesByClaimer(agentAddr);
    const completed = claimed.filter((b) => b.status === 'approved');

    const lines = [
      `**Agent Reputation: ${agent.name}**`,
      '',
      `**Address:** \`${formatAddress(agentAddr)}\``,
      `**Agent ID:** ${resolvedAgentId}`,
      `**Skills:** ${agent.skills.length > 0 ? agent.skills.join(', ') : 'none listed'}`,
    ];

    // On-chain reputation (from cached index)
    if (reputation && reputation.count > 0) {
      lines.push('');
      lines.push(`**Rating:** ${reputation.averageRating.toFixed(1)}/5 (${reputation.count} review${reputation.count !== 1 ? 's' : ''})`);
    }

    // Bounty stats from local indexer
    lines.push('');
    lines.push(`**Posted Bounties:** ${posted.length}`);
    lines.push(`**Claimed Bounties:** ${claimed.length}`);
    lines.push(`**Completed:** ${completed.length}`);

    if (claimed.length > 0) {
      const rate = ((completed.length / claimed.length) * 100).toFixed(0);
      lines.push(`**Completion Rate:** ${rate}%`);
    }

    if (!reputation || reputation.count === 0) {
      lines.push('');
      lines.push('No on-chain reputation feedback yet.');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Reputation lookup failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
