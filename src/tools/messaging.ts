/**
 * Messaging Tools (XMTP)
 *
 * Send and receive E2E encrypted messages between Clara users via XMTP.
 * Messages are transported peer-to-peer over the XMTP network (MLS/RFC 9420).
 * Users are addressed by claraid.eth name or wallet address.
 *
 * Migration: Replaces D1-backed proxy messaging with peer-to-peer XMTP.
 * Tool names and schemas are unchanged for backwards compatibility.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult, ToolContext } from '../middleware.js';
import { getOrInitXmtpClient, getIdentityCache } from '../xmtp/singleton.js';
import { ClaraGroupManager } from '../xmtp/groups.js';
import { encodeClaraMessage, extractText } from '../xmtp/content-types.js';
import { isAddress } from 'viem';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Tool Definitions ───────────────────────────────────
// Identical to the D1 version — only handlers changed.

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

function relativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();

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

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

// ─── Read Cursor Storage ───────────────────────────────
// Tracks last-read timestamp per conversation for unread detection.

const CURSORS_PATH = join(homedir(), '.clara', 'xmtp', 'read-cursors.json');

async function loadCursors(): Promise<Record<string, number>> {
  try {
    if (existsSync(CURSORS_PATH)) {
      const data = await readFile(CURSORS_PATH, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Corrupt file — start fresh
  }
  return {};
}

async function saveCursor(conversationId: string, timestampMs: number): Promise<void> {
  const cursors = await loadCursors();
  cursors[conversationId] = timestampMs;
  const dir = join(homedir(), '.clara', 'xmtp');
  await mkdir(dir, { recursive: true });
  // Atomic write: write to temp file then rename to prevent partial reads
  const tmpPath = CURSORS_PATH + '.tmp';
  await writeFile(tmpPath, JSON.stringify(cursors), { mode: 0o600 });
  const { rename } = await import('fs/promises');
  await rename(tmpPath, CURSORS_PATH);
}

// ─── Recipient Resolution ────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const IDENTIFIER_KIND_ETHEREUM = 0 as any;

async function resolveRecipient(
  ctx: ToolContext,
  to: string,
): Promise<{ inboxId: string; displayName: string } | { error: string }> {
  const client = await getOrInitXmtpClient(ctx);
  const cache = getIdentityCache();

  let walletAddress: string | undefined;
  let displayName = to;

  if (to.startsWith('0x')) {
    if (!isAddress(to)) {
      return { error: `Invalid address: "${to}". Must be a valid 0x EVM address (42 hex chars).` };
    }
    walletAddress = to;
    const entry = cache.resolveWallet(to);
    if (entry?.claraName) displayName = entry.claraName;
  } else {
    // Name-based lookup via identity cache (seeded from ENS directory)
    const entry = cache.resolveName(to);
    if (!entry) {
      return {
        error: `Recipient not found: "${to}". Make sure the name is registered or use a wallet address.\nUse \`wallet_lookup_name\` to check if a name exists.`,
      };
    }
    walletAddress = entry.walletAddress;
    displayName = entry.claraName || to;
  }

  // Resolve wallet address → XMTP inbox ID
  const inboxId = await client.fetchInboxIdByIdentifier({
    identifier: walletAddress,
    identifierKind: IDENTIFIER_KIND_ETHEREUM,
  });

  if (!inboxId) {
    return {
      error: `"${displayName}" hasn't set up XMTP messaging yet. They need to send or receive a message first.`,
    };
  }

  // Cache the wallet → inboxId mapping for display name resolution
  cache.setInboxId(walletAddress, inboxId);
  return { inboxId, displayName };
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
    // Resolve recipient name/address → XMTP inbox ID
    const resolved = await resolveRecipient(ctx, to);
    if ('error' in resolved) {
      return {
        content: [{ type: 'text', text: `❌ ${resolved.error}` }],
        isError: true,
      };
    }

    // Find or create DM conversation
    const client = await getOrInitXmtpClient(ctx);
    const groupManager = new ClaraGroupManager(client);
    const dm = await groupManager.findOrCreateDm(resolved.inboxId);

    // Encode and send
    const encoded = encodeClaraMessage({
      text: message,
      context: { action: 'general' },
      replyTo,
    });
    await dm.sendText(encoded);

    const preview = truncate(message, 50);
    return {
      content: [{
        type: 'text',
        text: [
          `✅ Message sent to **${resolved.displayName}**`,
          '',
          `> ${preview}`,
        ].join('\n'),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
    const client = await getOrInitXmtpClient(ctx);
    const cache = getIdentityCache();
    const cursors = await loadCursors();

    // Sync conversations from network, then list DMs
    await client.conversations.sync();
    const dms = client.conversations.listDms();

    if (dms.length === 0) {
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

    // Gather last message and unread status for each DM
    const threadSummaries: Array<{
      dm: typeof dms[0];
      peerInboxId: string;
      peerName: string;
      lastMessageText: string;
      lastMessageTime: Date;
      lastMessageIsFromMe: boolean;
      hasUnread: boolean;
    }> = [];

    for (const dm of dms) {
      await dm.sync();
      const lastMsg = await dm.lastMessage();
      if (!lastMsg) continue; // Skip empty conversations

      const peerInboxId = dm.peerInboxId;
      const peerEntry = cache.resolveInboxId(peerInboxId);
      const peerName = peerEntry?.claraName || cache.getSenderName(peerInboxId);

      const text = typeof lastMsg.content === 'string'
        ? extractText(lastMsg.content)
        : '[non-text message]';

      const isFromMe = lastMsg.senderInboxId === client.inboxId;
      const cursor = cursors[dm.id] || 0;
      const hasUnread = !isFromMe && lastMsg.sentAt.getTime() > cursor;

      threadSummaries.push({
        dm,
        peerInboxId,
        peerName,
        lastMessageText: text,
        lastMessageTime: lastMsg.sentAt,
        lastMessageIsFromMe: isFromMe,
        hasUnread,
      });
    }

    // Sort by most recent first
    threadSummaries.sort((a, b) => b.lastMessageTime.getTime() - a.lastMessageTime.getTime());
    const visible = threadSummaries.slice(0, limit);

    const totalUnread = threadSummaries.filter((t) => t.hasUnread).length;
    const inboxIcon = totalUnread > 0 ? '📬' : '📭';

    const lines = [
      `── ${inboxIcon} Inbox${totalUnread > 0 ? ` (${totalUnread} unread)` : ''} ─────────────────────────────`,
      '',
    ];

    for (const thread of visible) {
      const unreadLabel = thread.hasUnread ? ' (unread)' : '';
      const threadIcon = thread.hasUnread ? '💬' : '📭';
      const preview = truncate(thread.lastMessageText, 40);
      const time = relativeTime(thread.lastMessageTime);

      lines.push(`  ${threadIcon} ${thread.peerName}${unreadLabel}`);
      lines.push(`     "${preview}" — ${time}`);
      lines.push('');
    }

    lines.push('──────────────────────────────────────────────────');

    // Auto-open single unread thread inline
    const unreadThreads = visible.filter((t) => t.hasUnread);
    if (unreadThreads.length === 1) {
      const auto = unreadThreads[0];
      const threadLines = await formatThread(client, auto.dm, auto.peerName, 20);
      if (threadLines) {
        // Mark as read
        await saveCursor(auto.dm.id, Date.now());
        lines.push('');
        lines.push(threadLines);
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Failed to load inbox: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
    // Resolve recipient
    const resolved = await resolveRecipient(ctx, withUser);
    if ('error' in resolved) {
      // Not found — might just not have a conversation yet
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

    const client = await getOrInitXmtpClient(ctx);

    // Find existing DM or return empty
    await client.conversations.sync();
    const dm = client.conversations.getDmByInboxId(resolved.inboxId);

    if (!dm) {
      return {
        content: [{
          type: 'text',
          text: [
            `No conversation with **${resolved.displayName}** yet.`,
            '',
            `Start one with: \`wallet_message {"to": "${withUser}", "message": "..."}\``,
          ].join('\n'),
        }],
      };
    }

    const threadText = await formatThread(client, dm, resolved.displayName, limit);

    // Mark as read
    await saveCursor(dm.id, Date.now());

    return {
      content: [{ type: 'text', text: threadText || `── 💬 Thread with ${resolved.displayName} ──\n\n  No messages yet.\n\n──────────────────────────────────────────────────` }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Failed to open thread: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

// ─── Internal Helpers ───────────────────────────────────

/**
 * Format a DM conversation thread for display.
 * Used by both handleThreadRequest and inbox auto-open.
 */
async function formatThread(
  client: import('@xmtp/node-sdk').Client,
  dm: import('@xmtp/node-sdk').Dm,
  participantName: string,
  limit: number,
): Promise<string | null> {
  try {
    const cache = getIdentityCache();

    await dm.sync();
    const messages = await dm.messages({ limit });

    const lines = [
      `── 💬 Thread with ${participantName} ──────────────`,
      '',
    ];

    if (messages.length === 0) {
      lines.push('  No messages yet.');
    } else {
      for (const msg of messages) {
        const isMe = msg.senderInboxId === client.inboxId;
        const sender = isMe
          ? 'you'
          : cache.getSenderName(msg.senderInboxId);
        const time = relativeTime(msg.sentAt);
        const text = typeof msg.content === 'string'
          ? extractText(msg.content)
          : '[non-text message]';

        lines.push(`  ${sender} (${time}):`);
        lines.push(`    ${text}`);
        lines.push('');
      }
    }

    lines.push('──────────────────────────────────────────────────');
    return lines.join('\n');
  } catch (err) {
    // Log failure without leaking message content — only the error type
    console.error('[messaging] Thread render failed:', err instanceof Error ? err.constructor.name : 'unknown');
    return null;
  }
}
