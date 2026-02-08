/**
 * work_reputation - View Agent Reputation
 *
 * Public tool that fetches an agent's reputation data from the indexer.
 * Shows overall score, number of bounties, top skills, and completion rate.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../middleware.js';
import { indexerFetch, formatAddress } from './work-helpers.js';

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

interface AgentData {
  agentId: number;
  name: string;
  address: string;
  skills: string[];
}

interface ReputationData {
  overallScore: number;
  totalFeedback: number;
  completedBounties: number;
  postedBounties: number;
  completionRate: number;
  topSkills: Array<{ skill: string; score: number }>;
}

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
    // Fetch agent data
    const agentPath = agentId !== undefined
      ? `/api/agents/${agentId}`
      : `/api/agents/address/${address}`;

    const agentResp = await indexerFetch(agentPath);

    if (!agentResp.ok) {
      return {
        content: [{
          type: 'text',
          text: `❌ Agent not found. They may not be registered yet.\n\nRegister with \`work_register\`.`,
        }],
        isError: true,
      };
    }

    const agent = await agentResp.json() as AgentData;

    // Fetch reputation data
    const repResp = await indexerFetch(`/api/reputation/${agent.agentId}`);
    let reputation: ReputationData | null = null;

    if (repResp.ok) {
      reputation = await repResp.json() as ReputationData;
    }

    // Format output
    const lines = [
      `**Agent Reputation: ${agent.name}**`,
      '',
      `**Address:** \`${formatAddress(agent.address)}\``,
      `**Agent ID:** ${agent.agentId}`,
      `**Skills:** ${agent.skills?.join(', ') || 'none listed'}`,
    ];

    if (reputation) {
      lines.push('');
      lines.push(`**Overall Score:** ${reputation.overallScore}/100`);
      lines.push(`**Completed Bounties:** ${reputation.completedBounties}`);
      lines.push(`**Posted Bounties:** ${reputation.postedBounties}`);
      lines.push(`**Completion Rate:** ${(reputation.completionRate * 100).toFixed(0)}%`);
      lines.push(`**Total Feedback:** ${reputation.totalFeedback} reviews`);

      if (reputation.topSkills?.length > 0) {
        lines.push('');
        lines.push('**Top Skills:**');
        for (const s of reputation.topSkills) {
          lines.push(`- ${s.skill}: ${s.score}/100`);
        }
      }
    } else {
      lines.push('');
      lines.push('No reputation data yet.');
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
