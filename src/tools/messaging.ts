/**
 * Messaging Tools
 *
 * Send and receive direct messages between Clara users.
 * Messages are stored in the Clara proxy's D1 database.
 * Users are addressed by claraid.eth name or wallet address.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult, ToolContext } from '../middleware.js';
import { proxyFetch } from '../auth/proxy-fetch.js';
import { getCurrentSessionKey } from '../auth/session-key.js';

// ─── Config ──────────────────────────────────────────────

const PROXY_URL =
  process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn-me.workers.dev';

// ─── Tool Definitions ───────────────────────────────────

export const messageToolDefinition: Tool = {
  name: 'wallet_message',
  description: `Send a direct message to another Clara user. Address by claraid.eth name or wallet address.

**Examples:**
- \`{"to": "brian", "message": "hey, tx confirmed!"}\` — send to brian.claraid.eth
- \`{"to": "0xABCD...1234", "message": "done"}\` — send to address
- \`{"to": "brian", "message": "got it", "replyTo": "msg_abc123"}\` — reply to a message`,
  inputSchema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description:
          'Recipient: name (e.g. "brian"), full name (e.g. "brian.claraid.eth"), or address (0x...)',
      },
      message: {
        type: 'string',
        description: 'Message to send (max 2000 chars)',
      },
      replyTo: {
        type: 'string',
        description: 'Optional message ID to reply to',
      },
    },
    required: ['to', 'message'],
  },
};

export const inboxToolDefinition: Tool = {
  name: 'wallet_inbox',
  description: `Check your message inbox. Shows recent conversations with unread counts.

**Examples:**
- \`{}\` — show all threads (default 10)
- \`{"limit": 5}\` — show 5 most recent threads`,
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Number of threads to show (default: 10)',
      },
    },
  },
};

export const threadToolDefinition: Tool = {
  name: 'wallet_thread',
  description: `Open a conversation thread with someone. Shows message history and marks as read.

**Examples:**
- \`{"with": "brian"}\` — open thread with brian.claraid.eth
- \`{"with": "0xABCD...1234", "limit": 50}\` — open thread with address, show 50 messages`,
  inputSchema: {
    type: 'object',
    properties: {
      with: {
        type: 'string',
        description: 'Who to open thread with: name or address',
      },
      limit: {
        type: 'number',
        description: 'Number of messages to show (default: 20)',
      },
    },
    required: ['with'],
  },
};

// ─── Helpers ────────────────────────────────────────────

/**
 * Format a relative time string (e.g. "5m ago", "2h ago", "1d ago")
 */
function relativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

/**
 * Truncate a string with ellipsis
 */
function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

// ─── Handlers ───────────────────────────────────────────

/**
 * Send a direct message (auth required)
 */
export async function handleMessageRequest(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const to = args.to as string;
  const message = args.message as string;
  const replyTo = args.replyTo as string | undefined;

  if (!to) {
    return {
      content: [{ type: 'text', text: '❌ Missing required parameter: to' }],
      isError: true,
    };
  }

  if (!message) {
    return {
      content: [{ type: 'text', text: '❌ Missing required parameter: message' }],
      isError: true,
    };
  }

  if (message.length > 2000) {
    return {
      content: [{ type: 'text', text: '❌ Message too long (max 2000 characters)' }],
      isError: true,
    };
  }

  try {
    const payload: Record<string, unknown> = { to, body: message };
    if (replyTo) payload.replyTo = replyTo;

    const response = await proxyFetch(
      `${PROXY_URL}/api/v1/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      { walletAddress: ctx.walletAddress, sessionKey: ctx.sessionKey },
    );

    const result = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      if (result.code === 'INVALID_RECIPIENT') {
        return {
          content: [{
            type: 'text',
            text: [
              `❌ Recipient not found: **${to}**`,
              '',
              'Make sure the name is registered or the address is correct.',
              'Use `wallet_lookup_name` to check if a name exists.',
            ].join('\n'),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `❌ Failed to send message: ${result.message || result.error || response.statusText}`,
        }],
        isError: true,
      };
    }

    const toInfo = result.to as { address?: string; name?: string } | undefined;
    const recipientDisplay = toInfo?.name || to;
    const preview = truncate(message, 50);

    return {
      content: [{
        type: 'text',
        text: [
          `✅ Message sent to **${recipientDisplay}**`,
          '',
          `> ${preview}`,
        ].join('\n'),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Failed to send message: ${error instanceof Error ? error.message : 'Network error'}`,
      }],
      isError: true,
    };
  }
}

/**
 * Check inbox (auth required)
 */
export async function handleInboxRequest(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const limit = (args.limit as number) || 10;

  try {
    const url = new URL(`${PROXY_URL}/api/v1/inbox`);
    url.searchParams.set('limit', String(limit));

    const response = await proxyFetch(
      url.toString(),
      {},
      { walletAddress: ctx.walletAddress, sessionKey: ctx.sessionKey },
    );

    const result = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      return {
        content: [{
          type: 'text',
          text: `❌ Failed to load inbox: ${result.message || result.error || response.statusText}`,
        }],
        isError: true,
      };
    }

    const threads = result.threads as Array<{
      id: string;
      otherParticipant: { address: string; name: string | null };
      lastMessageAt: string;
      lastMessagePreview: string;
      messageCount: number;
      unreadCount: number;
    }>;

    if (!threads || threads.length === 0) {
      return {
        content: [{
          type: 'text',
          text: [
            '── 📭 Inbox ─────────────────────────────────────',
            '',
            '  No messages yet.',
            '',
            '  Send your first message with `wallet_message`.',
            '',
            '──────────────────────────────────────────────────',
          ].join('\n'),
        }],
      };
    }

    const totalUnread = (result.totalUnread as number) || threads.reduce((sum, t) => sum + t.unreadCount, 0);
    const inboxIcon = totalUnread > 0 ? '📬' : '📭';

    const lines = [
      `── ${inboxIcon} Inbox${totalUnread > 0 ? ` (${totalUnread} unread)` : ''} ─────────────────────────────`,
      '',
    ];

    for (const thread of threads) {
      const name = thread.otherParticipant.name || shortenAddress(thread.otherParticipant.address);
      const unread = thread.unreadCount > 0 ? ` (${thread.unreadCount} unread)` : '';
      const threadIcon = thread.unreadCount > 0 ? '💬' : '📭';
      const preview = truncate(thread.lastMessagePreview || '', 40);
      const time = relativeTime(thread.lastMessageAt);

      lines.push(`  ${threadIcon} ${name}${unread}`);
      lines.push(`     "${preview}" — ${time}`);
      lines.push('');
    }

    lines.push('──────────────────────────────────────────────────');

    // If exactly one unread thread, auto-open it inline
    const unreadThreads = threads.filter((t) => t.unreadCount > 0);
    if (unreadThreads.length === 1) {
      const autoThread = unreadThreads[0];
      const threadResult = await fetchThread(
        ctx.walletAddress,
        autoThread.id,
        20,
      );
      if (threadResult) {
        lines.push('');
        lines.push(threadResult);
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Failed to load inbox: ${error instanceof Error ? error.message : 'Network error'}`,
      }],
      isError: true,
    };
  }
}

/**
 * Open a thread (auth required)
 */
export async function handleThreadRequest(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const withUser = args.with as string;
  const limit = (args.limit as number) || 20;

  if (!withUser) {
    return {
      content: [{ type: 'text', text: '❌ Missing required parameter: with' }],
      isError: true,
    };
  }

  try {
    // Get thread by participant — proxy resolves names and finds the thread
    const url = new URL(`${PROXY_URL}/api/v1/threads/by-participant`);
    url.searchParams.set('with', withUser);
    url.searchParams.set('limit', String(limit));

    const response = await proxyFetch(
      url.toString(),
      {},
      { walletAddress: ctx.walletAddress, sessionKey: ctx.sessionKey },
    );

    const result = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      if (response.status === 404) {
        return {
          content: [{
            type: 'text',
            text: [
              `No conversation with **${withUser}** yet.`,
              '',
              `Start one with: \`wallet_message {"to": "${withUser}", "message": "..."}\``,
            ].join('\n'),
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `❌ Failed to open thread: ${result.message || result.error || response.statusText}`,
        }],
        isError: true,
      };
    }

    const thread = result.thread as { id: string; participants: Array<{ address: string; name: string | null }>; messageCount: number };
    const messages = result.messages as Array<{
      id: string;
      from: { address: string; name: string | null };
      to: { address: string; name: string | null };
      body: string;
      createdAt: string;
    }>;

    // Find the other participant's display name
    const otherParticipant = thread?.participants?.find(
      (p) => p.address.toLowerCase() !== ctx.walletAddress.toLowerCase(),
    );
    const participantName = otherParticipant?.name || withUser;

    // Mark thread as read (fire-and-forget)
    if (thread?.id) {
      proxyFetch(
        `${PROXY_URL}/api/v1/threads/${encodeURIComponent(thread.id)}/read`,
        { method: 'POST' },
        { walletAddress: ctx.walletAddress, sessionKey: ctx.sessionKey },
      ).catch(() => {
        // Non-fatal — thread display still works
      });
    }

    // Format conversation
    const lines = [
      `── 💬 Thread with ${participantName} ──────────────`,
      '',
    ];

    if (!messages || messages.length === 0) {
      lines.push('  No messages yet.');
    } else {
      // Reverse to show oldest first (proxy returns newest first)
      const chronological = [...messages].reverse();
      for (const msg of chronological) {
        const isMe = msg.from.address.toLowerCase() === ctx.walletAddress.toLowerCase();
        const sender = isMe ? 'you' : (msg.from.name || shortenAddress(msg.from.address));
        const time = relativeTime(msg.createdAt);

        lines.push(`  ${sender} (${time}):`);
        lines.push(`    ${msg.body}`);
        lines.push('');
      }
    }

    lines.push('──────────────────────────────────────────────────');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Failed to open thread: ${error instanceof Error ? error.message : 'Network error'}`,
      }],
      isError: true,
    };
  }
}

// ─── Internal Helpers ───────────────────────────────────

/**
 * Fetch and format a thread by ID (used for inline auto-open in inbox)
 */
async function fetchThread(
  walletAddress: string,
  threadId: string,
  limit: number,
): Promise<string | null> {
  try {
    const url = new URL(`${PROXY_URL}/api/v1/threads/${encodeURIComponent(threadId)}`);
    url.searchParams.set('limit', String(limit));

    const response = await proxyFetch(
      url.toString(),
      {},
      { walletAddress, sessionKey: getCurrentSessionKey() },
    );

    if (!response.ok) return null;

    const result = (await response.json()) as Record<string, unknown>;
    const thread = result.thread as { id: string; participants: Array<{ address: string; name: string | null }> } | undefined;
    const messages = result.messages as Array<{
      id: string;
      from: { address: string; name: string | null };
      to: { address: string; name: string | null };
      body: string;
      createdAt: string;
    }>;

    // Find the other participant's display name
    const otherP = thread?.participants?.find(
      (p) => p.address.toLowerCase() !== walletAddress.toLowerCase(),
    );
    const participantName = otherP?.name || 'Unknown';

    // Mark as read (fire-and-forget)
    proxyFetch(
      `${PROXY_URL}/api/v1/threads/${encodeURIComponent(threadId)}/read`,
      { method: 'POST' },
      { walletAddress, sessionKey: getCurrentSessionKey() },
    ).catch(() => {});

    const lines = [
      `── 💬 Thread with ${participantName} ──────────────`,
      '',
    ];

    if (!messages || messages.length === 0) {
      lines.push('  No messages yet.');
    } else {
      // Reverse to show oldest first
      const chronological = [...messages].reverse();
      for (const msg of chronological) {
        const isMe = msg.from.address.toLowerCase() === walletAddress.toLowerCase();
        const sender = isMe ? 'you' : (msg.from.name || shortenAddress(msg.from.address));
        const time = relativeTime(msg.createdAt);

        lines.push(`  ${sender} (${time}):`);
        lines.push(`    ${msg.body}`);
        lines.push('');
      }
    }

    lines.push('──────────────────────────────────────────────────');

    return lines.join('\n');
  } catch (err) {
    console.error('[messaging] Failed to render thread:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Shorten an address: 0xABCD...1234
 */
function shortenAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
