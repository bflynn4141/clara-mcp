/**
 * work_profile - View Full Agent Profile
 *
 * Public tool that reads agent data from on-chain contracts
 * (IdentityRegistry + ReputationRegistry) and enriches with
 * bounty history from the local indexer.
 */

import type { Hex } from 'viem';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../middleware.js';
import {
  formatAddress,
  formatRawAmount,
  parseTaskURI,
  getTaskSummary,
} from './work-helpers.js';
import {
  getClaraPublicClient,
  getBountyContracts,
  IDENTITY_REGISTRY_ABI,
  REPUTATION_REGISTRY_ABI,
} from '../config/clara-contracts.js';
import { getBountiesByPoster, getBountiesByClaimer } from '../indexer/queries.js';

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

/**
 * Resolve an address to an agentId using tokenOfOwnerByIndex.
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
  services: string[];
  description?: string;
  registeredAt?: string;
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
      services: (metadata?.services as string[]) || [],
      description: metadata?.description as string | undefined,
      registeredAt: metadata?.registeredAt as string | undefined,
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
    // Resolve agentId from address if needed
    let resolvedAgentId = agentId ?? null;
    if (resolvedAgentId === null && address) {
      resolvedAgentId = await resolveAgentId(address);
    }

    // If we still don't have an agentId, show bounty-only profile
    if (resolvedAgentId === null && address) {
      return buildBountyOnlyProfile(address);
    }

    if (resolvedAgentId === null) {
      return {
        content: [{
          type: 'text',
          text: '❌ Agent not found. They may not be registered yet.',
        }],
        isError: true,
      };
    }

    // Read agent metadata + reputation from chain in parallel
    const [agent, reputation] = await Promise.all([
      readAgentMetadata(resolvedAgentId),
      readReputation(resolvedAgentId),
    ]);

    const agentName = agent?.name || `Agent #${resolvedAgentId}`;
    const agentAddr = agent?.address || address || 'unknown';

    // Get bounty history from local indexer
    const posted = getBountiesByPoster(agentAddr);
    const claimed = getBountiesByClaimer(agentAddr);
    const completed = claimed.filter((b) => b.status === 'approved');

    // Build profile card
    const lines = [
      '┌──────────────────────────────────────',
      `│ **${agentName}**`,
      `│ Agent #${resolvedAgentId} | \`${formatAddress(agentAddr)}\``,
      '├──────────────────────────────────────',
    ];

    if (agent?.description) {
      lines.push(`│ ${agent.description}`);
      lines.push('│');
    }

    lines.push(`│ **Skills:** ${agent?.skills?.join(', ') || 'none listed'}`);

    if (agent?.services && agent.services.length > 0) {
      lines.push(`│ **Services:** ${agent.services.join(', ')}`);
    }

    if (agent?.registeredAt) {
      const regDate = new Date(agent.registeredAt).toLocaleDateString();
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
function buildBountyOnlyProfile(address: string): ToolResult {
  const posted = getBountiesByPoster(address);
  const claimed = getBountiesByClaimer(address);

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
