/**
 * work_find - Search the Agent Directory
 *
 * Public tool that searches for registered agents by skill.
 * No authentication required. Reads from the local event index
 * populated by IdentityRegistry Register events.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../middleware.js';
import { findAgents, getAgentByAddress, getAgentByAgentId } from '../indexer/queries.js';
import { syncFromChain } from '../indexer/sync.js';
import { formatAddress } from './work-helpers.js';

export const workFindToolDefinition: Tool = {
  name: 'work_find',
  description: `Search for agents in the Clara marketplace.

Find agents by skill, or browse the full directory.

**Examples:**
\`\`\`json
{"skill": "solidity"}
\`\`\`
\`\`\`json
{"address": "0x1234..."}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      skill: {
        type: 'string',
        description: 'Filter by skill (partial match)',
      },
      address: {
        type: 'string',
        description: 'Look up a specific agent by wallet address',
      },
      agentId: {
        type: 'number',
        description: 'Look up a specific agent by ID',
      },
      limit: {
        type: 'number',
        default: 10,
        description: 'Max results to return (default: 10)',
      },
    },
  },
};

export async function handleWorkFind(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // Ensure index is up to date
  try {
    await syncFromChain();
  } catch (err) {
    console.warn('[work_find] Index sync failed, using potentially stale data:', err instanceof Error ? err.message : err);
  }

  const skill = args.skill as string | undefined;
  const address = args.address as string | undefined;
  const agentId = args.agentId as number | undefined;
  const limit = (args.limit as number) || 10;

  // Single agent lookup by address
  if (address) {
    const agent = getAgentByAddress(address);
    if (!agent) {
      return {
        content: [{
          type: 'text',
          text: `No registered agent found for \`${formatAddress(address)}\`.\n\nUse \`work_profile\` for a full profile view, or \`work_register\` to register.`,
        }],
      };
    }
    return {
      content: [{
        type: 'text',
        text: formatAgentCard(agent),
      }],
    };
  }

  // Single agent lookup by agentId
  if (agentId !== undefined) {
    const agent = getAgentByAgentId(agentId);
    if (!agent) {
      return {
        content: [{
          type: 'text',
          text: `No agent found with ID #${agentId}.`,
        }],
      };
    }
    return {
      content: [{
        type: 'text',
        text: formatAgentCard(agent),
      }],
    };
  }

  // Directory search
  const agents = findAgents({ skill, limit });

  if (agents.length === 0) {
    const msg = skill
      ? `No agents found with skill "${skill}".`
      : 'No registered agents found yet.';
    return {
      content: [{
        type: 'text',
        text: `${msg}\n\nUse \`work_register\` to be the first!`,
      }],
    };
  }

  const header = skill
    ? `**Agent Directory** — "${skill}" (${agents.length} result${agents.length !== 1 ? 's' : ''})`
    : `**Agent Directory** — ${agents.length} registered agent${agents.length !== 1 ? 's' : ''}`;

  const lines = [header, ''];

  for (const agent of agents) {
    const skills = agent.skills.length > 0 ? agent.skills.join(', ') : 'none';
    lines.push(`**#${agent.agentId} ${agent.name}** | \`${formatAddress(agent.owner)}\``);
    lines.push(`  Skills: ${skills}`);
    if (agent.description) {
      lines.push(`  ${agent.description.slice(0, 80)}`);
    }
    lines.push('');
  }

  lines.push('Use `work_profile address="0x..."` for full agent details.');

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function formatAgentCard(agent: { agentId: number; owner: string; name: string; skills: string[]; description?: string }): string {
  const skills = agent.skills.length > 0 ? agent.skills.join(', ') : 'none listed';
  const lines = [
    `**#${agent.agentId} ${agent.name}**`,
    `Address: \`${formatAddress(agent.owner)}\``,
    `Skills: ${skills}`,
  ];
  if (agent.description) {
    lines.push(`${agent.description}`);
  }
  lines.push('');
  lines.push('Use `work_profile` for full details with reputation and bounty history.');
  return lines.join('\n');
}
