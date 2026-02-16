/**
 * Tests for messaging tools (XMTP)
 *
 * Tests wallet_message, wallet_inbox, and wallet_thread MCP tools
 * with mocked XMTP client and identity cache.
 *
 * NOTE: Session validation is handled by middleware (not the handler).
 * The handler receives a pre-validated ToolContext from middleware.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../middleware.js';
import type { Hex } from 'viem';

// ─── Mock Setup ──────────────────────────────────────────────────

// Mock XMTP singleton
const mockClient = {
  inboxId: 'my-inbox-id',
  conversations: {
    sync: vi.fn(),
    listDms: vi.fn(() => []),
    listGroups: vi.fn(() => []),
    getDmByInboxId: vi.fn(),
  },
  fetchInboxIdByIdentifier: vi.fn(),
};

const mockIdentityCache = {
  resolveName: vi.fn(),
  resolveWallet: vi.fn(),
  resolveInboxId: vi.fn(),
  getSenderName: vi.fn((id: string) => id.slice(0, 6) + '...' + id.slice(-4)),
  setInboxId: vi.fn(),
  size: 0,
};

vi.mock('../../xmtp/singleton.js', () => ({
  getOrInitXmtpClient: vi.fn(async () => mockClient),
  getIdentityCache: vi.fn(() => mockIdentityCache),
}));

// Mock group manager
const mockDm = {
  id: 'dm-conversation-1',
  peerInboxId: 'peer-inbox-id',
  sync: vi.fn(),
  sendText: vi.fn(async () => 'msg-id-123'),
  messages: vi.fn(async () => []),
  lastMessage: vi.fn(async () => undefined),
};

const mockFindOrCreateDm = vi.fn(async () => mockDm);

vi.mock('../../xmtp/groups.js', () => {
  // Must use a class (not arrow fn) so `new ClaraGroupManager(...)` works
  class MockClaraGroupManager {
    findOrCreateDm = mockFindOrCreateDm;
  }
  return { ClaraGroupManager: MockClaraGroupManager };
});

// Mock content types (pass-through for testing)
vi.mock('../../xmtp/content-types.js', () => ({
  encodeClaraMessage: vi.fn((payload: { text: string }) => `CLARA_V1:${JSON.stringify({ ...payload, v: 1 })}`),
  extractText: vi.fn((raw: string) => {
    if (typeof raw === 'string' && raw.startsWith('CLARA_V1:')) {
      try {
        return JSON.parse(raw.slice(9)).text || raw;
      } catch { return raw; }
    }
    return raw;
  }),
}));

// Mock fs for read cursor operations (avoid real file system)
vi.mock('fs', async () => {
  const actual: Record<string, unknown> = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import {
  messageToolDefinition,
  inboxToolDefinition,
  threadToolDefinition,
  handleMessageRequest,
  handleInboxRequest,
  handleThreadRequest,
} from '../../tools/messaging.js';

// ─── Test Helpers ───────────────────────────────────────────────────

const TEST_ADDRESS = '0xabcdef1234567890abcdef1234567890abcdef12' as Hex;
const OTHER_ADDRESS = '0x1234567890123456789012345678901234567890' as Hex;
const PEER_INBOX_ID = 'peer-inbox-id';

function makeCtx(address: Hex = TEST_ADDRESS): ToolContext {
  return {
    session: {
      authenticated: true,
      address,
      walletId: 'test-wallet-id',
    } as any,
    walletAddress: address,
    sessionKey: null,
  };
}

function makeMockMessage(overrides: Partial<{
  id: string;
  content: string;
  senderInboxId: string;
  sentAt: Date;
  sentAtNs: bigint;
}> = {}) {
  const sentAt = overrides.sentAt ?? new Date();
  return {
    id: overrides.id ?? 'msg-1',
    content: overrides.content ?? 'hello world',
    senderInboxId: overrides.senderInboxId ?? PEER_INBOX_ID,
    sentAt,
    sentAtNs: overrides.sentAtNs ?? BigInt(sentAt.getTime()) * 1_000_000n,
    kind: 0,
    deliveryStatus: 1,
    contentType: { typeId: 'text', versionMajor: 1, versionMinor: 0, authorityId: 'xmtp.org' },
    conversationId: 'dm-conversation-1',
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Messaging Tool Definitions', () => {
  describe('wallet_message', () => {
    it('has correct name', () => {
      expect(messageToolDefinition.name).toBe('wallet_message');
    });

    it('has required fields: to and message', () => {
      expect(messageToolDefinition.inputSchema.required).toContain('to');
      expect(messageToolDefinition.inputSchema.required).toContain('message');
    });

    it('has optional replyTo field', () => {
      const props = messageToolDefinition.inputSchema.properties as Record<string, any>;
      expect(props).toHaveProperty('replyTo');
    });
  });

  describe('wallet_inbox', () => {
    it('has correct name', () => {
      expect(inboxToolDefinition.name).toBe('wallet_inbox');
    });

    it('has no required fields', () => {
      expect(inboxToolDefinition.inputSchema.required).toBeUndefined();
    });

    it('has optional limit field', () => {
      const props = inboxToolDefinition.inputSchema.properties as Record<string, any>;
      expect(props).toHaveProperty('limit');
    });
  });

  describe('wallet_thread', () => {
    it('has correct name', () => {
      expect(threadToolDefinition.name).toBe('wallet_thread');
    });

    it('has required field: with', () => {
      expect(threadToolDefinition.inputSchema.required).toContain('with');
    });

    it('has optional limit field', () => {
      const props = threadToolDefinition.inputSchema.properties as Record<string, any>;
      expect(props).toHaveProperty('limit');
    });
  });
});

// ─── wallet_message ─────────────────────────────────────────────────

describe('handleMessageRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mock returns
    mockClient.fetchInboxIdByIdentifier.mockResolvedValue(PEER_INBOX_ID);
    mockIdentityCache.resolveName.mockReturnValue({
      claraName: 'brian',
      walletAddress: OTHER_ADDRESS,
    });
    mockIdentityCache.resolveWallet.mockReturnValue(null);
    mockDm.sendText.mockResolvedValue('msg-id-123');
  });

  describe('Input Validation', () => {
    it('rejects missing "to" field', async () => {
      const result = await handleMessageRequest({ message: 'hello' }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required parameter: to');
    });

    it('rejects empty "to" field', async () => {
      const result = await handleMessageRequest({ to: '', message: 'hello' }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required parameter: to');
    });

    it('rejects missing "message" field', async () => {
      const result = await handleMessageRequest({ to: 'brian' }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required parameter: message');
    });

    it('rejects empty "message" field', async () => {
      const result = await handleMessageRequest({ to: 'brian', message: '' }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required parameter: message');
    });

    it('rejects message over 2000 characters', async () => {
      const longMessage = 'a'.repeat(2001);
      const result = await handleMessageRequest({ to: 'brian', message: longMessage }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Message too long');
      expect(result.content[0].text).toContain('2000');
    });

    it('accepts message exactly 2000 characters', async () => {
      const exactMessage = 'a'.repeat(2000);
      const result = await handleMessageRequest({ to: 'brian', message: exactMessage }, makeCtx());
      expect(result.isError).toBeUndefined();
    });
  });

  describe('Recipient Resolution', () => {
    it('resolves bare name via identity cache', async () => {
      const result = await handleMessageRequest({ to: 'brian', message: 'hi' }, makeCtx());

      expect(mockIdentityCache.resolveName).toHaveBeenCalledWith('brian');
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('brian');
    });

    it('resolves raw address directly', async () => {
      mockIdentityCache.resolveWallet.mockReturnValue({
        claraName: 'alice',
        walletAddress: OTHER_ADDRESS,
      });

      const result = await handleMessageRequest(
        { to: OTHER_ADDRESS, message: 'hi' },
        makeCtx(),
      );

      expect(mockClient.fetchInboxIdByIdentifier).toHaveBeenCalledWith({
        identifier: OTHER_ADDRESS,
        identifierKind: expect.anything(),
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('alice');
    });

    it('handles non-existent name', async () => {
      mockIdentityCache.resolveName.mockReturnValue(undefined);

      const result = await handleMessageRequest(
        { to: 'doesnotexist', message: 'hello' },
        makeCtx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Recipient not found');
      expect(result.content[0].text).toContain('doesnotexist');
    });

    it('handles recipient without XMTP identity', async () => {
      mockClient.fetchInboxIdByIdentifier.mockResolvedValue(null);

      const result = await handleMessageRequest(
        { to: 'brian', message: 'hello' },
        makeCtx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("hasn't set up XMTP");
    });
  });

  describe('Successful Send', () => {
    it('sends message and returns confirmation', async () => {
      const result = await handleMessageRequest(
        { to: 'brian', message: 'hey, tx confirmed!' },
        makeCtx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Message sent');
      expect(result.content[0].text).toContain('brian');
      expect(result.content[0].text).toContain('hey, tx confirmed!');
    });

    it('sends encoded CLARA_V1 message via XMTP', async () => {
      await handleMessageRequest(
        { to: 'brian', message: 'test msg' },
        makeCtx(),
      );

      expect(mockDm.sendText).toHaveBeenCalledWith(
        expect.stringContaining('CLARA_V1:'),
      );
    });

    it('truncates long messages in confirmation preview', async () => {
      const longMsg = 'This is a very long message that should get truncated in the preview because it exceeds fifty characters';

      const result = await handleMessageRequest(
        { to: 'brian', message: longMsg },
        makeCtx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('...');
    });

    it('caches inbox ID after successful resolution', async () => {
      await handleMessageRequest({ to: 'brian', message: 'hi' }, makeCtx());

      expect(mockIdentityCache.setInboxId).toHaveBeenCalledWith(
        OTHER_ADDRESS,
        PEER_INBOX_ID,
      );
    });
  });

  describe('Error Handling', () => {
    it('handles XMTP send failure', async () => {
      mockDm.sendText.mockRejectedValue(new Error('XMTP network error'));

      const result = await handleMessageRequest(
        { to: 'brian', message: 'hello' },
        makeCtx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to send message');
      expect(result.content[0].text).toContain('XMTP network error');
    });

    it('handles non-Error failure', async () => {
      mockDm.sendText.mockRejectedValue('something went wrong');

      const result = await handleMessageRequest(
        { to: 'brian', message: 'hello' },
        makeCtx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown error');
    });
  });
});

// ─── wallet_inbox ───────────────────────────────────────────────────

describe('handleInboxRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.conversations.sync.mockResolvedValue(undefined);
    mockClient.conversations.listDms.mockReturnValue([]);
  });

  describe('Empty Inbox', () => {
    it('displays empty inbox message', async () => {
      const result = await handleInboxRequest({}, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Inbox');
      expect(result.content[0].text).toContain('No messages yet');
      expect(result.content[0].text).toContain('wallet_message');
    });
  });

  describe('Inbox with Threads', () => {
    function makeMockDm(overrides: Partial<{
      id: string;
      peerInboxId: string;
      lastMsg: ReturnType<typeof makeMockMessage> | undefined;
    }> = {}) {
      const dm = {
        id: overrides.id ?? 'dm-1',
        peerInboxId: overrides.peerInboxId ?? PEER_INBOX_ID,
        sync: vi.fn(),
        lastMessage: vi.fn(async () => overrides.lastMsg ?? undefined),
        messages: vi.fn(async () => []),
        sendText: vi.fn(),
      };
      return dm;
    }

    it('displays threads with unread indicator', async () => {
      const dm = makeMockDm({
        lastMsg: makeMockMessage({ content: 'hey, are you around?' }),
      });
      mockClient.conversations.listDms.mockReturnValue([dm]);
      mockIdentityCache.resolveInboxId.mockReturnValue({ claraName: 'brian', walletAddress: OTHER_ADDRESS });

      const result = await handleInboxRequest({}, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Inbox');
      expect(result.content[0].text).toContain('brian');
      expect(result.content[0].text).toContain('hey, are you around?');
    });

    it('shows truncated inboxId when peer has no name', async () => {
      const dm = makeMockDm({
        peerInboxId: 'abcdef1234567890abcd',
        lastMsg: makeMockMessage({ content: 'hello' }),
      });
      mockClient.conversations.listDms.mockReturnValue([dm]);
      mockIdentityCache.resolveInboxId.mockReturnValue(undefined);
      mockIdentityCache.getSenderName.mockReturnValue('abcdef...abcd');

      const result = await handleInboxRequest({}, makeCtx());

      expect(result.content[0].text).toContain('abcdef');
    });

    it('skips DMs with no messages', async () => {
      const emptyDm = makeMockDm({ id: 'dm-empty', lastMsg: undefined });
      const activeDm = makeMockDm({
        id: 'dm-active',
        lastMsg: makeMockMessage({ content: 'active' }),
      });
      mockClient.conversations.listDms.mockReturnValue([emptyDm, activeDm]);
      mockIdentityCache.resolveInboxId.mockReturnValue({ claraName: 'alice', walletAddress: OTHER_ADDRESS });

      const result = await handleInboxRequest({}, makeCtx());

      expect(result.content[0].text).toContain('active');
    });

    it('sorts threads by most recent first', async () => {
      const now = Date.now();
      const oldDm = makeMockDm({
        id: 'dm-old',
        peerInboxId: 'peer-old',
        lastMsg: makeMockMessage({ content: 'old message', sentAt: new Date(now - 3600000) }),
      });
      const newDm = makeMockDm({
        id: 'dm-new',
        peerInboxId: 'peer-new',
        lastMsg: makeMockMessage({ content: 'new message', sentAt: new Date(now) }),
      });
      mockClient.conversations.listDms.mockReturnValue([oldDm, newDm]);
      mockIdentityCache.resolveInboxId
        .mockReturnValueOnce({ claraName: 'bob', walletAddress: '0xbob' })
        .mockReturnValueOnce({ claraName: 'alice', walletAddress: '0xalice' });

      const result = await handleInboxRequest({}, makeCtx());
      const text = result.content[0].text;

      // New message should appear before old
      const newIdx = text.indexOf('new message');
      const oldIdx = text.indexOf('old message');
      expect(newIdx).toBeLessThan(oldIdx);
    });

    it('detects unread messages from others', async () => {
      const dm = makeMockDm({
        lastMsg: makeMockMessage({
          content: 'unread msg',
          senderInboxId: PEER_INBOX_ID, // Not from me
        }),
      });
      mockClient.conversations.listDms.mockReturnValue([dm]);
      mockIdentityCache.resolveInboxId.mockReturnValue({ claraName: 'brian', walletAddress: OTHER_ADDRESS });

      const result = await handleInboxRequest({}, makeCtx());

      expect(result.content[0].text).toContain('unread');
      expect(result.content[0].text).toContain('📬'); // mailbox with mail
    });

    it('marks own messages as read', async () => {
      const dm = makeMockDm({
        lastMsg: makeMockMessage({
          content: 'my own msg',
          senderInboxId: 'my-inbox-id', // From me
        }),
      });
      mockClient.conversations.listDms.mockReturnValue([dm]);
      mockIdentityCache.resolveInboxId.mockReturnValue({ claraName: 'brian', walletAddress: OTHER_ADDRESS });

      const result = await handleInboxRequest({}, makeCtx());

      expect(result.content[0].text).not.toContain('unread');
    });
  });

  describe('Auto-open Single Unread Thread', () => {
    it('auto-opens when exactly one unread thread exists', async () => {
      const msg = makeMockMessage({ content: 'check out this PR', senderInboxId: PEER_INBOX_ID });
      const dm = {
        id: 'dm-single',
        peerInboxId: PEER_INBOX_ID,
        sync: vi.fn(),
        lastMessage: vi.fn(async () => msg),
        messages: vi.fn(async () => [msg]),
        sendText: vi.fn(),
      };
      mockClient.conversations.listDms.mockReturnValue([dm]);
      mockIdentityCache.resolveInboxId.mockReturnValue({ claraName: 'seth', walletAddress: OTHER_ADDRESS });
      mockIdentityCache.getSenderName.mockReturnValue('seth');

      const result = await handleInboxRequest({}, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Inbox');
      expect(result.content[0].text).toContain('Thread with seth');
      expect(result.content[0].text).toContain('check out this PR');
    });

    it('does NOT auto-open when multiple unread threads exist', async () => {
      const dm1 = {
        id: 'dm-a',
        peerInboxId: 'peer-a',
        sync: vi.fn(),
        lastMessage: vi.fn(async () => makeMockMessage({ content: 'hello', senderInboxId: 'peer-a' })),
        messages: vi.fn(async () => []),
        sendText: vi.fn(),
      };
      const dm2 = {
        id: 'dm-b',
        peerInboxId: 'peer-b',
        sync: vi.fn(),
        lastMessage: vi.fn(async () => makeMockMessage({ content: 'hey', senderInboxId: 'peer-b' })),
        messages: vi.fn(async () => []),
        sendText: vi.fn(),
      };
      mockClient.conversations.listDms.mockReturnValue([dm1, dm2]);
      mockIdentityCache.resolveInboxId
        .mockReturnValueOnce({ claraName: 'alice', walletAddress: '0xalice' })
        .mockReturnValueOnce({ claraName: 'bob', walletAddress: '0xbob' });

      const result = await handleInboxRequest({}, makeCtx());

      expect(result.content[0].text).toContain('Inbox');
      expect(result.content[0].text).not.toContain('Thread with');
    });
  });

  describe('Error Handling', () => {
    it('handles XMTP client initialization failure', async () => {
      const { getOrInitXmtpClient } = await import('../../xmtp/singleton.js');
      (getOrInitXmtpClient as any).mockRejectedValueOnce(new Error('XMTP init failed'));

      const result = await handleInboxRequest({}, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to load inbox');
    });

    it('handles conversation sync failure', async () => {
      mockClient.conversations.sync.mockRejectedValue(new Error('Network error'));

      const result = await handleInboxRequest({}, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network error');
    });
  });
});

// ─── wallet_thread ──────────────────────────────────────────────────

describe('handleThreadRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.fetchInboxIdByIdentifier.mockResolvedValue(PEER_INBOX_ID);
    mockClient.conversations.sync.mockResolvedValue(undefined);
    mockIdentityCache.resolveName.mockReturnValue({
      claraName: 'brian',
      walletAddress: OTHER_ADDRESS,
    });
  });

  describe('Input Validation', () => {
    it('rejects missing "with" field', async () => {
      const result = await handleThreadRequest({}, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required parameter: with');
    });

    it('rejects empty "with" field', async () => {
      const result = await handleThreadRequest({ with: '' }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required parameter: with');
    });
  });

  describe('Thread Display', () => {
    it('displays thread with messages', async () => {
      const now = Date.now();
      const messages = [
        makeMockMessage({ id: 'msg-1', content: 'hey, whats up?', senderInboxId: PEER_INBOX_ID, sentAt: new Date(now - 120000) }),
        makeMockMessage({ id: 'msg-2', content: 'can you review my PR?', senderInboxId: 'my-inbox-id', sentAt: new Date(now - 60000) }),
        makeMockMessage({ id: 'msg-3', content: 'sounds good', senderInboxId: PEER_INBOX_ID, sentAt: new Date(now - 10000) }),
      ];

      const dm = {
        id: 'dm-thread',
        peerInboxId: PEER_INBOX_ID,
        sync: vi.fn(),
        messages: vi.fn(async () => messages),
        lastMessage: vi.fn(),
        sendText: vi.fn(),
      };
      mockClient.conversations.getDmByInboxId.mockReturnValue(dm);
      mockIdentityCache.getSenderName.mockReturnValue('brian');

      const result = await handleThreadRequest({ with: 'brian' }, makeCtx());

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;

      expect(text).toContain('Thread with brian');
      expect(text).toContain('hey, whats up?');
      expect(text).toContain('can you review my PR?');
      expect(text).toContain('sounds good');

      // Own messages labeled as "you"
      expect(text).toContain('you');
    });

    it('shows no conversation message when DM not found', async () => {
      mockClient.conversations.getDmByInboxId.mockReturnValue(undefined);

      const result = await handleThreadRequest({ with: 'brian' }, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('No conversation with');
      expect(result.content[0].text).toContain('brian');
      expect(result.content[0].text).toContain('wallet_message');
    });

    it('shows no conversation when recipient not in identity cache', async () => {
      mockIdentityCache.resolveName.mockReturnValue(undefined);
      // No XMTP identity either
      mockClient.fetchInboxIdByIdentifier.mockResolvedValue(null);

      const result = await handleThreadRequest({ with: 'alice' }, makeCtx());

      expect(result.content[0].text).toContain('No conversation with');
      expect(result.content[0].text).toContain('alice');
    });

    it('resolves raw address for thread lookup', async () => {
      mockIdentityCache.resolveWallet.mockReturnValue({
        claraName: 'alice',
        walletAddress: OTHER_ADDRESS,
      });

      const dm = {
        id: 'dm-addr',
        peerInboxId: PEER_INBOX_ID,
        sync: vi.fn(),
        messages: vi.fn(async () => []),
        lastMessage: vi.fn(),
        sendText: vi.fn(),
      };
      mockClient.conversations.getDmByInboxId.mockReturnValue(dm);

      const result = await handleThreadRequest({ with: OTHER_ADDRESS }, makeCtx());

      expect(mockClient.fetchInboxIdByIdentifier).toHaveBeenCalledWith({
        identifier: OTHER_ADDRESS,
        identifierKind: expect.anything(),
      });
      expect(result.content[0].text).toContain('Thread with alice');
    });

    it('displays empty thread message', async () => {
      const dm = {
        id: 'dm-empty',
        peerInboxId: PEER_INBOX_ID,
        sync: vi.fn(),
        messages: vi.fn(async () => []),
        lastMessage: vi.fn(),
        sendText: vi.fn(),
      };
      mockClient.conversations.getDmByInboxId.mockReturnValue(dm);

      const result = await handleThreadRequest({ with: 'brian' }, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('No messages yet');
    });
  });

  describe('Error Handling', () => {
    it('handles XMTP client failure', async () => {
      const { getOrInitXmtpClient } = await import('../../xmtp/singleton.js');
      (getOrInitXmtpClient as any).mockRejectedValueOnce(new Error('Connection refused'));

      const result = await handleThreadRequest({ with: 'brian' }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to open thread');
      expect(result.content[0].text).toContain('Connection refused');
    });

    it('handles non-Error failure', async () => {
      const { getOrInitXmtpClient } = await import('../../xmtp/singleton.js');
      (getOrInitXmtpClient as any).mockRejectedValueOnce(undefined);

      const result = await handleThreadRequest({ with: 'brian' }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown error');
    });
  });
});
