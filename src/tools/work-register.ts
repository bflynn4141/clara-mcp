/**
 * work_register - Register as an ERC-8004 Agent
 *
 * Creates an on-chain agent identity in the IdentityRegistry.
 * Stores agent metadata as a data: URI and indexes via the Clara indexer.
 */

import { encodeFunctionData, type Hex } from 'viem';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { signAndSendTransaction } from '../para/transactions.js';
import { getBountyContracts, IDENTITY_REGISTRY_ABI } from '../config/clara-contracts.js';
import { getChainId, getExplorerTxUrl } from '../config/chains.js';
import {
  toDataUri,
  formatAddress,
  saveLocalAgentId,
} from './work-helpers.js';
import { syncFromChain } from '../indexer/sync.js';
import { getAgentByAddress } from '../indexer/queries.js';

export const workRegisterToolDefinition: Tool = {
  name: 'work_register',
  description: `Register as an agent in the Clara bounty marketplace (ERC-8004).

Creates your on-chain agent identity so you can post and claim bounties.
You only need to register once — your agent ID persists across sessions.

**Example:**
\`\`\`json
{"name": "CodeBot", "skills": ["solidity", "typescript"], "description": "Smart contract auditor"}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: {
        type: 'string',
        description: 'Your agent display name',
      },
      description: {
        type: 'string',
        description: 'Short description of what you do',
      },
      skills: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of skills (e.g., ["solidity", "typescript", "auditing"])',
      },
      services: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of services offered',
      },
    },
    required: ['name', 'skills'],
  },
};

export async function handleWorkRegister(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const name = args.name as string;
  const description = (args.description as string) || '';
  const skills = (args.skills as string[]) || [];
  const services = (args.services as string[]) || [];

  if (!name || name.trim().length === 0) {
    return {
      content: [{ type: 'text', text: '❌ Agent name is required.' }],
      isError: true,
    };
  }

  if (skills.length === 0) {
    return {
      content: [{ type: 'text', text: '❌ At least one skill is required.' }],
      isError: true,
    };
  }

  try {
    const contracts = getBountyContracts();

    // Build agent metadata
    const metadata = {
      name,
      description,
      skills,
      services,
      platform: 'clara',
      registeredAt: new Date().toISOString(),
    };

    const agentURI = toDataUri(metadata);

    // Encode the register(string agentURI) call
    const data = encodeFunctionData({
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'register',
      args: [agentURI],
    });

    // Sign and send the registration transaction
    const result = await signAndSendTransaction(ctx.session.walletId!, {
      to: contracts.identityRegistry,
      value: 0n,
      data,
      chainId: getChainId('base'),
    });

    // Sync the indexer to pick up the Register event and recover agentId
    let agentId: number | null = null;
    try {
      await syncFromChain();
      const agent = getAgentByAddress(ctx.walletAddress);
      if (agent) {
        agentId = agent.agentId;
        saveLocalAgentId(agentId, name);
      }
    } catch {
      // Non-fatal — the registration tx succeeded, agentId can be recovered later
    }

    const explorerUrl = getExplorerTxUrl('base', result.txHash);

    const lines = [
      '✅ **Agent Registered!**',
      '',
      `**Name:** ${name}`,
      `**Skills:** ${skills.join(', ')}`,
      `**Address:** \`${formatAddress(ctx.walletAddress)}\``,
    ];

    if (agentId !== null) {
      lines.push(`**Agent ID:** ${agentId}`);
    }

    lines.push('');
    lines.push(`**Transaction:** [${result.txHash.slice(0, 10)}...](${explorerUrl})`);
    lines.push('');
    lines.push('You can now post bounties with `work_post` or browse available work with `work_browse`.');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Registration failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
