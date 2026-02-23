/**
 * Wallet Reauth Tool
 *
 * Refreshes an expired wallet session using existing credentials.
 * Minimal MCP surface — full wallet setup is handled by the CLI wizard.
 *
 * Previously this file contained wallet_setup + wallet_session (437 lines).
 * Those are now CLI commands:
 *   clara-mcp setup   → interactive wallet creation/recovery
 *   clara-mcp status  → session status check
 *   clara-mcp logout  → clear session
 */

import { reauthWallet } from '../para/client.js';

/**
 * wallet_reauth tool definition
 *
 * Zero parameters — it refreshes whatever session exists.
 * If no wallet is configured, directs user to `clara-mcp setup`.
 */
export const reauthToolDefinition = {
  name: 'wallet_reauth',
  description: `Refresh an expired wallet session.

If your wallet session has expired (24h TTL), this re-authenticates
using your existing credentials. No setup or email input required.

If no wallet exists, run \`clara-mcp setup\` in your terminal first.

**Example:**
\`\`\`json
{}
\`\`\`

Returns wallet address and session status.`,
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

/**
 * Handle wallet_reauth
 */
export async function handleReauthRequest(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  try {
    const result = await reauthWallet();

    const lines = [
      '✅ Wallet ready!',
      '',
      `**Address:** \`${result.address}\``,
    ];

    if (result.email) {
      lines.push(`**Email:** ${result.email}`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';

    // If no wallet configured, guide to CLI setup
    const isNoWallet = msg.includes('No wallet configured');

    return {
      content: [
        {
          type: 'text',
          text: isNoWallet
            ? `❌ ${msg}\n\nRun in your terminal:\n\`\`\`\nclara-mcp setup\n\`\`\``
            : `❌ Re-auth failed: ${msg}`,
        },
      ],
      isError: true,
    };
  }
}
