/**
 * work_profile - View Full Agent Profile
 *
 * Reads agent data from the local index (sub-millisecond) and
 * enriches with bounty history. No RPC calls needed.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../middleware.js';
import {
  formatAddress,
  formatRawAmount,
  getTaskSummary,
} from './work-helpers.js';
import {
  getAgentByAddress,
  getAgentByAgentId,
  getReputationSummary,
  getBountiesByPoster,
  getBountiesByClaimer,
} from '../indexer/index.js';

export const workProfileToolDefinition: Tool = {
  name: 'work_profile',
  description: `View a full agent profile with reputation and bounty history.

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

export async function handleWorkProfile(
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

    // If we still don't have an agent, show bounty-only profile
    if (!agent && address) {
      return await buildBountyOnlyProfile(address);
    }

    if (!agent) {
      return {
        content: [{
          type: 'text',
          text: '❌ Agent not found. They may not be registered yet.',
        }],
        isError: true,
      };
    }

    const resolvedAgentId = agent.agentId;
    const agentAddr = agent.owner;

    // Parse extra metadata from the agentURI for services/registeredAt
    let services: string[] = [];
    let registeredAt: string | undefined;
    try {
      const b64Prefix = 'data:application/json;base64,';
      if (agent.agentURI.startsWith(b64Prefix)) {
        const json = Buffer.from(agent.agentURI.slice(b64Prefix.length), 'base64').toString('utf-8');
        const metadata = JSON.parse(json);
        services = (metadata.services as string[]) || [];
        registeredAt = metadata.registeredAt as string | undefined;
      }
    } catch (err) {
      console.warn('[work_profile] Failed to parse agent URI metadata:', err instanceof Error ? err.message : err);
    }

    // Read cached reputation from index
    const reputation = await getReputationSummary(resolvedAgentId);

    // Get bounty history from local indexer
    const posted = await getBountiesByPoster(agentAddr);
    const claimed = await getBountiesByClaimer(agentAddr);
    const completed = claimed.filter((b) => b.status === 'approved');

    // Build profile card
    const lines = [
      '┌──────────────────────────────────────',
      `│ **${agent.name}**`,
      `│ Agent #${resolvedAgentId} | \`${formatAddress(agentAddr)}\``,
      '├──────────────────────────────────────',
    ];

    if (agent.description) {
      lines.push(`│ ${agent.description}`);
      lines.push('│');
    }

    lines.push(`│ **Skills:** ${agent.skills.join(', ') || 'none listed'}`);

    if (services.length > 0) {
      lines.push(`│ **Services:** ${services.join(', ')}`);
    }

    if (registeredAt) {
      const regDate = new Date(registeredAt).toLocaleDateString();
      lines.push(`│ **Registered:** ${regDate}`);
    }

    // Reputation section
    lines.push('├──────────────────────────────────────');
    lines.push('│ **Reputation**');

    if (reputation && reputation.count > 0) {
      const stars = '★'.repeat(Math.round(reputation.averageRating)) +
        '☆'.repeat(5 - Math.round(reputation.averageRating));
      lines.push(`│ ${stars} ${reputation.averageRating.toFixed(1)}/5 (${reputation.count} review${reputation.count !== 1 ? 's' : ''})`);
    } else {
      lines.push('│ No on-chain reviews yet');
    }

    lines.push(`│ Completed: ${completed.length} | Posted: ${posted.length} | Claimed: ${claimed.length}`);

    if (claimed.length > 0) {
      const rate = ((completed.length / claimed.length) * 100).toFixed(0);
      lines.push(`│ Completion Rate: ${rate}%`);
    }

    // Recent bounties section
    const allBounties = [...posted, ...claimed]
      .filter((b, i, arr) => arr.findIndex((x) => x.bountyAddress === b.bountyAddress) === i)
      .sort((a, b) => b.createdBlock - a.createdBlock)
      .slice(0, 5);

    if (allBounties.length > 0) {
      lines.push('├──────────────────────────────────────');
      lines.push('│ **Recent Bounties**');

      for (const b of allBounties) {
        const statusIcon = b.status === 'approved' ? '✅' :
          b.status === 'open' ? '🟢' :
          b.status === 'claimed' ? '🔵' :
          b.status === 'submitted' ? '📋' : '⚪';
        const amount = formatRawAmount(b.amount, b.token);
        const summary = getTaskSummary(b.taskURI);
        lines.push(`│ ${statusIcon} ${amount} — ${summary.slice(0, 50)}`);
      }
    }

    lines.push('└──────────────────────────────────────');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Profile lookup failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

/**
 * Fallback when we have an address but no agentId (not registered).
 * Shows bounty history from local indexer only.
 */
async function buildBountyOnlyProfile(address: string): Promise<ToolResult> {
  const posted = await getBountiesByPoster(address);
  const claimed = await getBountiesByClaimer(address);

  if (posted.length === 0 && claimed.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No profile found for \`${formatAddress(address)}\`.\n\nThis address has no registered agent and no bounty activity.\nRegister with \`work_register\`.`,
      }],
    };
  }

  const lines = [
    '┌──────────────────────────────────────',
    `│ \`${formatAddress(address)}\``,
    `│ (Not registered as an agent)`,
    '├──────────────────────────────────────',
    `│ **Bounties Posted:** ${posted.length}`,
    `│ **Bounties Claimed:** ${claimed.length}`,
  ];

  const allBounties = [...posted, ...claimed]
    .filter((b, i, arr) => arr.findIndex((x) => x.bountyAddress === b.bountyAddress) === i)
    .sort((a, b) => b.createdBlock - a.createdBlock)
    .slice(0, 5);

  if (allBounties.length > 0) {
    lines.push('├──────────────────────────────────────');
    lines.push('│ **Recent Bounties**');
    for (const b of allBounties) {
      const statusIcon = b.status === 'approved' ? '✅' :
        b.status === 'open' ? '🟢' : '📋';
      const amount = formatRawAmount(b.amount, b.token);
      const summary = getTaskSummary(b.taskURI);
      lines.push(`│ ${statusIcon} ${amount} — ${summary.slice(0, 50)}`);
    }
  }

  lines.push('└──────────────────────────────────────');
  lines.push('');
  lines.push('Register as an agent with `work_register` for a full profile.');

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}
