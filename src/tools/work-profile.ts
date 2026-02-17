/**
 * work_profile - View Agent Profile (ERC-8004)
 *
 * Fetches agent registration file from the proxy and displays it.
 * Reads the ERC-8004 registration file (JSON) from clara-proxy.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../middleware.js';
import { formatAddress } from './work-helpers.js';

const PROXY_URL = process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn-me.workers.dev';

export const workProfileToolDefinition: Tool = {
  name: 'work_profile',
  description: `View an agent's ERC-8004 registration profile.

**Example:**
\`\`\`json
{"agentId": 1}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      agentId: {
        type: 'number',
        description: 'Agent ID to look up',
      },
    },
    required: ['agentId'],
  },
};

export async function handleWorkProfile(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const agentId = args.agentId as number | undefined;

  if (agentId === undefined) {
    return {
      content: [{
        type: 'text',
        text: '❌ Provide an `agentId`.',
      }],
      isError: true,
    };
  }

  try {
    const response = await fetch(`${PROXY_URL}/agents/${agentId}.json`);

    if (!response.ok) {
      if (response.status === 404) {
        return {
          content: [{
            type: 'text',
            text: `❌ Agent #${agentId} not found. They may not have uploaded a profile yet.`,
          }],
          isError: true,
        };
      }
      return {
        content: [{
          type: 'text',
          text: `❌ Failed to fetch profile: HTTP ${response.status}`,
        }],
        isError: true,
      };
    }

    const profile = await response.json() as {
      name?: string;
      description?: string;
      skills?: string[];
      services?: Array<{ name: string; endpoint: string }>;
      x402Support?: boolean;
      active?: boolean;
      registrations?: Array<{ agentRegistry: string; agentId: number }>;
    };

    const lines = [
      '┌──────────────────────────────────────',
      `│ **${profile.name || 'Unknown Agent'}**`,
      `│ Agent #${agentId}`,
      '├──────────────────────────────────────',
    ];

    if (profile.description) {
      lines.push(`│ ${profile.description}`);
      lines.push('│');
    }

    lines.push(`│ **Skills:** ${profile.skills?.join(', ') || 'none listed'}`);

    if (profile.services && profile.services.length > 0) {
      const svcList = profile.services.map(s => `${s.name}: ${s.endpoint}`).join(', ');
      lines.push(`│ **Services:** ${svcList}`);
    }

    if (profile.x402Support) {
      lines.push('│ **x402:** Enabled');
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
