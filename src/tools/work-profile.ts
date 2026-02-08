/**
 * work_profile - View Full Agent Profile
 *
 * Public tool that fetches a complete agent profile with reputation
 * and bounty history from the Clara indexer.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../middleware.js';
import { indexerFetch, formatAddress, formatDeadline, formatAmount } from './work-helpers.js';

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

interface AgentProfile {
  agentId: number;
  name: string;
  address: string;
  description: string;
  skills: string[];
  services: string[];
  registeredAt: string;
}

interface ReputationData {
  overallScore: number;
  totalFeedback: number;
  completedBounties: number;
  postedBounties: number;
  completionRate: number;
  topSkills: Array<{ skill: string; score: number }>;
  recentFeedback: Array<{ rating: number; comment: string; from: string; date: string }>;
}

interface BountyHistory {
  bountyAddress: string;
  amount: string;
  tokenSymbol: string;
  taskSummary: string;
  status: string;
  deadline: number;
}

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
    // Fetch agent data
    const agentPath = agentId !== undefined
      ? `/api/agents/${agentId}`
      : `/api/agents/address/${address}`;

    const agentResp = await indexerFetch(agentPath);

    if (!agentResp.ok) {
      return {
        content: [{
          type: 'text',
          text: '❌ Agent not found. They may not be registered yet.',
        }],
        isError: true,
      };
    }

    const agent = await agentResp.json() as AgentProfile;

    // Fetch reputation and bounty history in parallel
    const [repResp, historyResp] = await Promise.all([
      indexerFetch(`/api/reputation/${agent.agentId}`),
      indexerFetch(`/api/bounties?address=${agent.address}&limit=5`),
    ]);

    let reputation: ReputationData | null = null;
    if (repResp.ok) {
      reputation = await repResp.json() as ReputationData;
    }

    let bounties: BountyHistory[] = [];
    if (historyResp.ok) {
      const historyData = await historyResp.json() as { bounties: BountyHistory[] };
      bounties = historyData.bounties || [];
    }

    // Build profile card
    const lines = [
      '┌──────────────────────────────────────',
      `│ **${agent.name}**`,
      `│ Agent #${agent.agentId} | \`${formatAddress(agent.address)}\``,
      '├──────────────────────────────────────',
    ];

    if (agent.description) {
      lines.push(`│ ${agent.description}`);
      lines.push('│');
    }

    lines.push(`│ **Skills:** ${agent.skills?.join(', ') || 'none listed'}`);

    if (agent.services?.length > 0) {
      lines.push(`│ **Services:** ${agent.services.join(', ')}`);
    }

    if (agent.registeredAt) {
      const regDate = new Date(agent.registeredAt).toLocaleDateString();
      lines.push(`│ **Registered:** ${regDate}`);
    }

    // Reputation section
    if (reputation) {
      lines.push('├──────────────────────────────────────');
      lines.push('│ **Reputation**');
      lines.push(`│ Score: ${reputation.overallScore}/100 | Reviews: ${reputation.totalFeedback}`);
      lines.push(`│ Completed: ${reputation.completedBounties} | Posted: ${reputation.postedBounties}`);

      if (reputation.completionRate !== undefined) {
        lines.push(`│ Completion Rate: ${(reputation.completionRate * 100).toFixed(0)}%`);
      }

      if (reputation.topSkills?.length > 0) {
        lines.push('│');
        lines.push('│ **Top Skills:**');
        for (const s of reputation.topSkills.slice(0, 5)) {
          const bar = '█'.repeat(Math.round(s.score / 10)) + '░'.repeat(10 - Math.round(s.score / 10));
          lines.push(`│ ${s.skill}: ${bar} ${s.score}`);
        }
      }

      if (reputation.recentFeedback?.length > 0) {
        lines.push('│');
        lines.push('│ **Recent Feedback:**');
        for (const f of reputation.recentFeedback.slice(0, 3)) {
          const stars = '★'.repeat(f.rating) + '☆'.repeat(5 - f.rating);
          lines.push(`│ ${stars} "${f.comment}" — ${formatAddress(f.from)}`);
        }
      }
    }

    // Recent bounties section
    if (bounties.length > 0) {
      lines.push('├──────────────────────────────────────');
      lines.push('│ **Recent Bounties**');

      for (const b of bounties) {
        const statusIcon = b.status === 'approved' ? '✅' : b.status === 'open' ? '🟢' : '📋';
        lines.push(`│ ${statusIcon} ${formatAmount(b.amount, b.tokenSymbol || 'USDC')} — ${b.taskSummary.slice(0, 50)}`);
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
