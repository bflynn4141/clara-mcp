/**
 * work_register - Register as an ERC-8004 Agent
 *
 * Creates an on-chain agent identity in the IdentityRegistry.
 * Builds an ERC-8004 registration file with services, skills, and x402 support.
 * After on-chain registration, uploads the file to clara-proxy for web access.
 *
 * Two-phase approach:
 * 1. Register on-chain with a data: URI (immediate, self-contained)
 * 2. Upload to clara-proxy after getting agentId (rich, web-accessible)
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

// ─── ERC-8004 Registration File Types ────────────────────────────────

interface AgentService {
  type: string;
  endpoint: string;
}

interface AgentRegistration {
  agentRegistry: string;
  agentId: string;
}

export interface AgentRegistrationFile {
  type: 'AgentRegistration';
  name: string;
  description: string;
  image: string;
  services: AgentService[];
  skills: string[];
  x402Support: boolean;
  active: boolean;
  registrations: AgentRegistration[];
}

/**
 * Build an ERC-8004 registration file.
 *
 * Exported for unit testing the file structure independently
 * of the full on-chain registration flow.
 */
export function buildRegistrationFile(params: {
  name: string;
  description: string;
  skills: string[];
  services?: string[];
  walletAddress: string;
  ensName?: string;
  agentId?: number;
  registryAddress?: string;
}): AgentRegistrationFile {
  const agentServices: AgentService[] = [];

  // ENS service (if subname provided)
  if (params.ensName) {
    const endpoint = params.ensName.includes('.')
      ? params.ensName
      : `${params.ensName}.claraid.eth`;
    agentServices.push({ type: 'ENS', endpoint });
  }

  // Wallet service (always present, CAIP-10 format)
  agentServices.push({
    type: 'agentWallet',
    endpoint: `eip155:8453:${params.walletAddress}`,
  });

  // Custom services
  if (params.services) {
    for (const svc of params.services) {
      agentServices.push({ type: 'custom', endpoint: svc });
    }
  }

  const registrations: AgentRegistration[] = [];
  if (params.agentId !== undefined && params.registryAddress) {
    registrations.push({
      agentRegistry: params.registryAddress,
      agentId: String(params.agentId),
    });
  }

  return {
    type: 'AgentRegistration',
    name: params.name,
    description: params.description,
    image: '',
    services: agentServices,
    skills: params.skills,
    x402Support: true,
    active: true,
    registrations,
  };
}

export const workRegisterToolDefinition: Tool = {
  name: 'work_register',
  description: `Register as an agent in the Clara bounty marketplace (ERC-8004).

Creates your on-chain agent identity so you can post and claim bounties.
You only need to register once — your agent ID persists across sessions.

Optionally links your Clara name (e.g., "brian" → brian.claraid.eth) to your agent profile.

**Example:**
\`\`\`json
{"name": "CodeBot", "skills": ["solidity", "typescript"], "description": "Smart contract auditor"}
\`\`\`

**With ENS name:**
\`\`\`json
{"name": "Brian", "skills": ["solidity", "auditing"], "ensName": "brian"}
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
      ensName: {
        type: 'string',
        description: 'Optional Clara name to link (e.g., "brian" for brian.claraid.eth)',
      },
    },
    required: ['name', 'skills'],
  },
};

/**
 * Upload agent registration file to clara-proxy.
 * Returns the public URL on success, null on failure (non-fatal).
 */
async function uploadToProxy(
  agentId: number,
  registrationFile: AgentRegistrationFile,
  walletAddress: string,
): Promise<string | null> {
  const proxyUrl = process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn-me.workers.dev';
  const endpoint = `${proxyUrl}/agents/${agentId}.json`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Clara-Address': walletAddress,
      },
      body: JSON.stringify(registrationFile),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[work_register] Proxy upload failed (${response.status}): ${errorBody}`);
      return null;
    }

    const result = await response.json() as { ok: boolean; url: string };
    return result.ok ? result.url : null;
  } catch (error) {
    console.error(`[work_register] Proxy upload error: ${error}`);
    return null;
  }
}

export async function handleWorkRegister(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const name = args.name as string;
  const description = (args.description as string) || '';
  const skills = (args.skills as string[]) || [];
  const services = (args.services as string[]) || [];
  const ensName = args.ensName as string | undefined;

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

    // ─── Build ERC-8004 Registration File ───────────────────────────
    const registrationFile = buildRegistrationFile({
      name,
      description,
      skills,
      services,
      walletAddress: ctx.walletAddress,
      ensName,
    });

    // ─── Phase 1: On-chain registration with data URI ───────────────
    const agentURI = toDataUri(registrationFile as unknown as Record<string, unknown>);

    const data = encodeFunctionData({
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'register',
      args: [agentURI],
    });

    const result = await signAndSendTransaction(ctx.session.walletId!, {
      to: contracts.identityRegistry,
      value: 0n,
      data,
      chainId: getChainId('base'),
    });

    // ─── Phase 2: Sync indexer + upload to proxy ────────────────────
    let agentId: number | null = null;
    let proxyUrl: string | null = null;

    try {
      await syncFromChain();
      const agent = getAgentByAddress(ctx.walletAddress);
      if (agent) {
        agentId = agent.agentId;
        saveLocalAgentId(agentId, name);

        // Now that we have agentId, rebuild with registrations back-link
        const finalRegFile = buildRegistrationFile({
          name,
          description,
          skills,
          services,
          walletAddress: ctx.walletAddress,
          ensName,
          agentId,
          registryAddress: contracts.identityRegistry,
        });

        // Upload the complete file to clara-proxy
        proxyUrl = await uploadToProxy(agentId, finalRegFile, ctx.walletAddress);

        // ─── Phase 3: Update on-chain URI to proxy URL ──────────────
        if (proxyUrl) {
          try {
            const updateData = encodeFunctionData({
              abi: IDENTITY_REGISTRY_ABI,
              functionName: 'updateURI',
              args: [BigInt(agentId), proxyUrl],
            });

            await signAndSendTransaction(ctx.session.walletId!, {
              to: contracts.identityRegistry,
              value: 0n,
              data: updateData,
              chainId: getChainId('base'),
            });
          } catch (updateErr) {
            // Non-fatal — the data URI registration already succeeded.
            // The proxy URL is supplementary for web browsers.
            console.error(
              `[work_register] URI update failed (data URI still valid): ${
                updateErr instanceof Error ? updateErr.message : updateErr
              }`,
            );
            proxyUrl = null;
          }
        }
      }
    } catch {
      // Non-fatal — the registration tx succeeded, agentId can be recovered later
    }

    // ─── Build success response ─────────────────────────────────────
    const explorerUrl = getExplorerTxUrl('base', result.txHash);

    const lines = [
      '✅ **Agent Registered!**',
      '',
      `**Name:** ${name}`,
      `**Skills:** ${skills.join(', ')}`,
      `**Address:** \`${formatAddress(ctx.walletAddress)}\``,
    ];

    if (ensName) {
      const fullName = ensName.includes('.') ? ensName : `${ensName}.claraid.eth`;
      lines.push(`**ENS:** ${fullName}`);
    }

    if (agentId !== null) {
      lines.push(`**Agent ID:** ${agentId}`);
    }

    if (proxyUrl) {
      lines.push(`**Profile:** [${proxyUrl}](${proxyUrl})`);
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
