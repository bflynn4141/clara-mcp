/**
 * ENS Name Tool
 *
 * Register, lookup, and reverse-lookup *.claraid.eth subnames.
 * These are FREE offchain names resolved via CCIP-Read —
 * no gas needed, just an HTTP call to the Clara gateway.
 *
 * Merged from wallet_register_name + wallet_lookup_name.
 * Dispatches on `action` param: "register", "lookup" (default), "reverseLookup".
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../middleware.js';
import { proxyFetch } from '../auth/proxy-fetch.js';
import { getSession } from '../storage/session.js';
import { getCurrentSessionKey } from '../auth/session-key.js';

// ─── Config ──────────────────────────────────────────────

const GATEWAY_BASE =
  process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn4141.workers.dev';

const PARENT_DOMAIN = 'claraid.eth';

// ─── Tool Definition ────────────────────────────────────

export const nameToolDefinition: Tool = {
  name: 'wallet_name',
  description: `Manage ${PARENT_DOMAIN} ENS subnames.

**Actions:**
- \`"lookup"\` (default): Look up a subname → address
- \`"reverseLookup"\`: Look up an address → subname
- \`"register"\`: Claim a free subname (requires wallet setup)

**Examples:**
- \`{"name": "brian"}\` → looks up brian.${PARENT_DOMAIN}
- \`{"action": "reverseLookup", "address": "0x8744..."}\` → finds the name for that address
- \`{"action": "register", "name": "brian"}\` → claims brian.${PARENT_DOMAIN}

Names are 3-20 chars, alphanumeric + hyphens. One per wallet. No gas required.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['lookup', 'reverseLookup', 'register'],
        description: 'Action to perform. Defaults to "lookup".',
      },
      name: {
        type: 'string',
        description: `Subname label (e.g., "brian" for brian.${PARENT_DOMAIN})`,
      },
      address: {
        type: 'string',
        description: 'Wallet address (for reverseLookup)',
      },
      agentId: {
        type: 'number',
        description: 'Optional ERC-8004 agent token ID to link (for register)',
      },
    },
  },
};

// ─── Handler ────────────────────────────────────────────

/**
 * Handle wallet_name — dispatches on action param.
 *
 * NOTE: This is a PublicToolHandler (no ctx param) because requiresAuth is false.
 * The register action handles auth internally via getSession() + getCurrentSessionKey().
 */
export async function handleNameRequest(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const action = (args.action as string) || 'lookup';

  switch (action) {
    case 'register':
      return handleRegister(args);
    case 'lookup':
      return handleLookup(args);
    case 'reverseLookup':
      return handleReverseLookup(args);
    default:
      return {
        content: [{
          type: 'text',
          text: `❌ Unknown action: "${action}". Use "lookup", "reverseLookup", or "register".`,
        }],
        isError: true,
      };
  }
}

// ─── Register (auth required — handled internally) ──────

async function handleRegister(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const name = args.name as string;
  const agentId = args.agentId as number | undefined;

  if (!name) {
    return {
      content: [{ type: 'text', text: '❌ Missing required parameter: name' }],
      isError: true,
    };
  }

  // Manual auth — requiresAuth is false so middleware doesn't check
  const session = await getSession();
  if (!session?.authenticated || !session.address) {
    return {
      content: [{
        type: 'text',
        text: '❌ No wallet configured. Run `wallet_setup` first to register a name.',
      }],
      isError: true,
    };
  }

  const walletAddress = session.address;
  const sessionKey = getCurrentSessionKey();

  try {
    const response = await proxyFetch(
      `${GATEWAY_BASE}/ens/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          address: walletAddress,
          agentId: agentId || null,
        }),
      },
      { walletAddress, sessionKey },
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

// ─── Lookup (public — no auth) ─────────────────────────

async function handleLookup(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const name = args.name as string | undefined;

  if (!name) {
    return {
      content: [{
        type: 'text',
        text: '❌ Missing required parameter: name',
      }],
      isError: true,
    };
  }

  try {
    const url = `${GATEWAY_BASE}/ens/lookup/${encodeURIComponent(name)}`;
    const response = await fetch(url);
    const result = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      if (response.status === 404) {
        return {
          content: [{
            type: 'text',
            text: `**${name}.${PARENT_DOMAIN}** is not registered. It's available to claim with \`wallet_name action:"register"\`.`,
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

    return formatLookupResult(result);
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

// ─── Reverse Lookup (public — no auth) ─────────────────

async function handleReverseLookup(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const address = args.address as string | undefined;

  if (!address) {
    return {
      content: [{
        type: 'text',
        text: '❌ Missing required parameter: address',
      }],
      isError: true,
    };
  }

  try {
    const url = `${GATEWAY_BASE}/ens/reverse/${encodeURIComponent(address)}`;
    const response = await fetch(url);
    const result = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      if (response.status === 404) {
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
          text: `❌ Reverse lookup failed: ${result.error || response.statusText}`,
        }],
        isError: true,
      };
    }

    return formatLookupResult(result);
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Reverse lookup failed: ${error instanceof Error ? error.message : 'Network error'}`,
      }],
      isError: true,
    };
  }
}

// ─── Shared formatter ───────────────────────────────────

function formatLookupResult(result: Record<string, unknown>): ToolResult {
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
}
