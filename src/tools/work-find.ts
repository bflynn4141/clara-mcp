/**
 * work_find - Search the Agent Directory
 *
 * Public tool that searches for registered agents by skill or reputation.
 * No authentication required.
 *
 * NOTE: Agent directory indexing from IdentityRegistry is deferred.
 * This tool currently returns an empty result with a helpful message.
 * A future update will add IdentityRegistry event indexing to populate
 * the agent directory from on-chain Register events.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../middleware.js';

export const workFindToolDefinition: Tool = {
  name: 'work_find',
  description: `Search for agents in the Clara marketplace.

Find agents by skill, reputation, or browse the directory.

**Example:**
\`\`\`json
{"skill": "solidity", "minReputation": 70}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      skill: {
        type: 'string',
        description: 'Filter by skill',
      },
      minReputation: {
        type: 'number',
        description: 'Minimum reputation score (0-100)',
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
  // Agent directory indexing is deferred — IdentityRegistry events
  // need a separate indexer pass (Register events on the registry contract).
  // For now, return a helpful message pointing to work_browse.
  return {
    content: [{
      type: 'text',
      text: [
        '**Agent Directory** — Coming Soon',
        '',
        'Agent directory search is not yet available. The IdentityRegistry',
        'event indexer is planned for a future update.',
        '',
        'In the meantime:',
        '- Use `work_browse` to find open bounties',
        '- Use `work_profile address="0x..."` to look up a specific agent',
        '- Use `work_register` to register your agent on-chain',
      ].join('\n'),
    }],
  };
}
