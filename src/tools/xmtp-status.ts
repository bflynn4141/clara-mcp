/**
 * XMTP Status Tool
 *
 * Check XMTP messaging initialization status, inbox ID,
 * and conversation count. Useful for debugging messaging issues.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult, ToolContext } from '../middleware.js';
import { isXmtpInitialized } from '../xmtp/keys.js';
import { getOrInitXmtpClient, getIdentityCache } from '../xmtp/singleton.js';

export const xmtpStatusToolDefinition: Tool = {
  name: 'wallet_xmtp_status',
  description: `Check XMTP messaging status. Shows initialization state, inbox ID, and conversation count.

**Examples:**
- \`{}\` — show XMTP status
- \`{"initialize": true}\` — initialize XMTP if not already set up`,
  inputSchema: {
    type: 'object',
    properties: {
      initialize: {
        type: 'boolean',
        description: 'If true, initialize XMTP client (triggers identity registration if needed)',
      },
    },
  },
};

export async function handleXmtpStatus(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const shouldInit = args.initialize as boolean | undefined;
  const initialized = isXmtpInitialized(ctx.walletAddress);

  if (!initialized && !shouldInit) {
    return {
      content: [{
        type: 'text',
        text: [
          '── 📡 XMTP Status ────────────────────────────────',
          '',
          '  Status:  Not initialized',
          `  Wallet:  ${ctx.walletAddress}`,
          '',
          '  XMTP identity has not been registered yet.',
          '  Send a message or call with `{"initialize": true}`',
          '  to trigger identity registration.',
          '',
          '──────────────────────────────────────────────────',
        ].join('\n'),
      }],
    };
  }

  try {
    const client = await getOrInitXmtpClient(ctx);
    const cache = getIdentityCache();

    await client.conversations.sync();
    const dms = client.conversations.listDms();
    const groups = client.conversations.listGroups();

    const lines = [
      '── 📡 XMTP Status ────────────────────────────────',
      '',
      '  Status:    ✅ Connected',
      `  Inbox ID:  ${client.inboxId}`,
      `  Wallet:    ${ctx.walletAddress}`,
      `  Network:   production`,
      '',
      `  DMs:       ${dms.length}`,
      `  Groups:    ${groups.length}`,
      `  Directory: ${cache.size} known users`,
      '',
      '──────────────────────────────────────────────────',
    ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ XMTP initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
