/**
 * ENS Subname Tools
 *
 * Register, lookup, and manage *.claraid.eth subnames.
 * These are FREE offchain names resolved via CCIP-Read —
 * no gas needed, just an HTTP call to the Clara gateway.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult, ToolContext } from '../middleware.js';
import { proxyFetch } from '../auth/proxy-fetch.js';

// ─── Config ──────────────────────────────────────────────

const GATEWAY_BASE =
  process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn-me.workers.dev';

const PARENT_DOMAIN = 'claraid.eth';

// ─── Tool Definitions ───────────────────────────────────

export const registerNameToolDefinition: Tool = {
  name: 'wallet_register_name',
  description: `Claim a free ENS subname under ${PARENT_DOMAIN}.

Registers a human-readable name like "brian.${PARENT_DOMAIN}" that resolves
to your wallet address from any ENS-compatible app (MetaMask, Rainbow, etc.).
No gas required — names are resolved offchain via CCIP-Read.

**Rules:**
- Names must be 3-20 characters, alphanumeric + hyphens
- One name per wallet address
- First come, first served

**Examples:**
- \`{"name": "brian"}\` → registers brian.${PARENT_DOMAIN}
- \`{"name": "my-agent", "agentId": 42}\` → registers with agent link`,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: `Subname label (e.g., "brian" for brian.${PARENT_DOMAIN})`,
      },
      agentId: {
        type: 'number',
        description: 'Optional ERC-8004 agent token ID to link to this name',
      },
    },
    required: ['name'],
  },
};

export const lookupNameToolDefinition: Tool = {
  name: 'wallet_lookup_name',
  description: `Look up a ${PARENT_DOMAIN} subname to find the linked wallet address.

**Examples:**
- \`{"name": "brian"}\` → shows who owns brian.${PARENT_DOMAIN}
- \`{"address": "0x8744..."}\` → reverse lookup (address → name)`,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Subname to look up (e.g., "brian")',
      },
      address: {
        type: 'string',
        description: 'Wallet address for reverse lookup (alternative to name)',
      },
    },
  },
};

// ─── Handlers ───────────────────────────────────────────

/**
 * Register a subname (auth required — uses wallet address)
 */
export async function handleRegisterNameRequest(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const name = args.name as string;
  const agentId = args.agentId as number | undefined;

  if (!name) {
    return {
      content: [{ type: 'text', text: '❌ Missing required parameter: name' }],
      isError: true,
    };
  }

  try {
    const response = await proxyFetch(
      `${GATEWAY_BASE}/ens/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          address: ctx.walletAddress,
          agentId: agentId || null,
        }),
      },
      { walletAddress: ctx.walletAddress, sessionKey: ctx.sessionKey },
    );

    const result = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      // Handle specific error cases with helpful messages
      if (result.error === 'name_taken') {
        return {
          content: [{
            type: 'text',
            text: [
              `❌ **${name}.${PARENT_DOMAIN}** is already taken.`,
              '',
              `Owner: \`${result.owner}\``,
              '',
              'Try a different name.',
            ].join('\n'),
          }],
          isError: true,
        };
      }

      if (result.error === 'address_has_name') {
        return {
          content: [{
            type: 'text',
            text: [
              `❌ Your wallet already has a name: **${result.existingName}.${PARENT_DOMAIN}**`,
              '',
              'Each wallet can only have one subname.',
              'To change it, unregister the current name first.',
            ].join('\n'),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `❌ Registration failed: ${result.error || result.message || response.statusText}`,
        }],
        isError: true,
      };
    }

    const lines = [
      `✅ **${result.fullName}** registered!`,
      '',
      `**Address:** \`${result.address}\``,
      `**Name:** ${result.fullName}`,
    ];

    if (agentId) {
      lines.push(`**Agent ID:** ${agentId}`);
    }

    lines.push(
      '',
      '💡 This name resolves in any ENS-compatible app (MetaMask, Rainbow, etc.)',
    );

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Failed to register name: ${error instanceof Error ? error.message : 'Network error'}`,
      }],
      isError: true,
    };
  }
}

/**
 * Look up a subname or reverse-resolve an address (public — no auth)
 */
export async function handleLookupNameRequest(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const name = args.name as string | undefined;
  const address = args.address as string | undefined;

  if (!name && !address) {
    return {
      content: [{
        type: 'text',
        text: '❌ Provide either `name` (forward lookup) or `address` (reverse lookup)',
      }],
      isError: true,
    };
  }

  try {
    let url: string;
    if (name) {
      url = `${GATEWAY_BASE}/ens/lookup/${encodeURIComponent(name)}`;
    } else {
      url = `${GATEWAY_BASE}/ens/reverse/${encodeURIComponent(address!)}`;
    }

    const response = await fetch(url);
    const result = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      if (response.status === 404) {
        if (name) {
          return {
            content: [{
              type: 'text',
              text: `**${name}.${PARENT_DOMAIN}** is not registered. It's available to claim with \`wallet_register_name\`.`,
            }],
          };
        }
        return {
          content: [{
            type: 'text',
            text: `No ${PARENT_DOMAIN} subname found for \`${address}\`.`,
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `❌ Lookup failed: ${result.error || response.statusText}`,
        }],
        isError: true,
      };
    }

    const lines = [
      `**${result.fullName}**`,
      '',
      `**Address:** \`${result.address}\``,
    ];

    if (result.agentId) {
      lines.push(`**Agent ID:** ${result.agentId}`);
    }

    if (result.registeredAt) {
      lines.push(`**Registered:** ${result.registeredAt}`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Lookup failed: ${error instanceof Error ? error.message : 'Network error'}`,
      }],
      isError: true,
    };
  }
}
