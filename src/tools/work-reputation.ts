/**
 * work_reputation - View Agent Reputation
 *
 * Public tool that reads agent reputation directly from on-chain contracts
 * (IdentityRegistry + ReputationRegistry) and enriches with local bounty data.
 */

import type { Hex } from 'viem';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../middleware.js';
import { formatAddress } from './work-helpers.js';
import {
  getClaraPublicClient,
  getBountyContracts,
  IDENTITY_REGISTRY_ABI,
  REPUTATION_REGISTRY_ABI,
} from '../config/clara-contracts.js';
import { parseTaskURI } from './work-helpers.js';
import { getBountiesByPoster, getBountiesByClaimer } from '../indexer/queries.js';

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

/**
 * Resolve an address to an agentId using tokenOfOwnerByIndex.
 * Returns null if the address has no registered agent.
 */
async function resolveAgentId(address: string): Promise<number | null> {
  const client = getClaraPublicClient();
  const { identityRegistry } = getBountyContracts();

  try {
    const balance = await client.readContract({
      address: identityRegistry as Hex,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'balanceOf',
      args: [address as Hex],
    });

    if (balance === 0n) return null;

    // Get the first token (most agents have exactly one)
    const tokenId = await client.readContract({
      address: identityRegistry as Hex,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'tokenOfOwnerByIndex',
      args: [address as Hex, 0n],
    });

    return Number(tokenId);
  } catch {
    return null;
  }
}

/**
 * Read agent metadata from on-chain tokenURI.
 */
async function readAgentMetadata(agentId: number): Promise<{
  name: string;
  address: string;
  skills: string[];
  description?: string;
} | null> {
  const client = getClaraPublicClient();
  const { identityRegistry } = getBountyContracts();

  try {
    const [owner, tokenURI] = await Promise.all([
      client.readContract({
        address: identityRegistry as Hex,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'ownerOf',
        args: [BigInt(agentId)],
      }),
      client.readContract({
        address: identityRegistry as Hex,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'tokenURI',
        args: [BigInt(agentId)],
      }),
    ]);

    const metadata = parseTaskURI(tokenURI);
    return {
      name: (metadata?.name as string) || `Agent #${agentId}`,
      address: owner as string,
      skills: (metadata?.skills as string[]) || [],
      description: metadata?.description as string | undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Read reputation summary from on-chain ReputationRegistry.
 */
async function readReputation(agentId: number): Promise<{
  count: number;
  averageRating: number;
} | null> {
  const client = getClaraPublicClient();
  const { reputationRegistry } = getBountyContracts();

  try {
    const [count, summaryValue, summaryValueDecimals] = await client.readContract({
      address: reputationRegistry as Hex,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: 'getSummary',
      args: [BigInt(agentId), [], 'bounty', 'completed'],
    });

    const divisor = 10 ** Number(summaryValueDecimals);
    const avg = Number(count) > 0 ? Number(summaryValue) / divisor / Number(count) : 0;

    return {
      count: Number(count),
      averageRating: avg,
    };
  } catch {
    return null;
  }
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
    // Resolve agentId from address if needed
    let resolvedAgentId = agentId ?? null;
    if (resolvedAgentId === null && address) {
      resolvedAgentId = await resolveAgentId(address);
    }

    if (resolvedAgentId === null) {
      return {
        content: [{
          type: 'text',
          text: `❌ Agent not found${address ? ` for address \`${formatAddress(address)}\`` : ''}. They may not be registered yet.\n\nRegister with \`work_register\`.`,
        }],
        isError: true,
      };
    }

    // Read agent metadata + reputation from chain
    const [agent, reputation] = await Promise.all([
      readAgentMetadata(resolvedAgentId),
      readReputation(resolvedAgentId),
    ]);

    const agentName = agent?.name || `Agent #${resolvedAgentId}`;
    const agentAddr = agent?.address || address || 'unknown';
    const skills = agent?.skills || [];

    // Enrich with bounty stats from local indexer
    const posted = getBountiesByPoster(agentAddr);
    const claimed = getBountiesByClaimer(agentAddr);
    const completed = claimed.filter((b) => b.status === 'approved');

    const lines = [
      `**Agent Reputation: ${agentName}**`,
      '',
      `**Address:** \`${formatAddress(agentAddr)}\``,
      `**Agent ID:** ${resolvedAgentId}`,
      `**Skills:** ${skills.length > 0 ? skills.join(', ') : 'none listed'}`,
    ];

    // On-chain reputation
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
