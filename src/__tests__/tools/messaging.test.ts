/**
 * Tests for messaging tools
 *
 * Tests wallet_message, wallet_inbox, and wallet_thread MCP tools
 * with mocked proxy API responses.
 *
 * NOTE: Session validation is handled by middleware (not the handler).
 * The handler receives a pre-validated ToolContext from middleware.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../middleware.js';
import type { Hex } from 'viem';

// Mock session storage (used by middleware, kept for compatibility)
vi.mock('../../storage/session.js', () => ({
  getSession: vi.fn(),
  touchSession: vi.fn(),
}));

// Mock fetch for proxy API calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

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

function makeCtx(address: Hex = TEST_ADDRESS): ToolContext {
  return {
    session: {
      authenticated: true,
      address,
      walletId: 'test-wallet-id',
    } as any,
    walletAddress: address,
  };
}

/**
 * Build a mock Response with JSON body and configurable status.
 */
function mockResponse(body: Record<string, unknown>, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
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
    mockFetch.mockReset();
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
      mockFetch.mockResolvedValue(mockResponse({
        id: 'msg_test123',
        to: { address: OTHER_ADDRESS, name: 'brian' },
      }));

      const result = await handleMessageRequest({ to: 'brian', message: exactMessage }, makeCtx());
      expect(result.isError).toBeUndefined();
    });
  });

  describe('Identity Resolution (via proxy)', () => {
    it('forwards bare name to proxy as-is', async () => {
      mockFetch.mockResolvedValue(mockResponse({
        id: 'msg_name',
        to: { address: OTHER_ADDRESS, name: 'brian' },
      }));

      await handleMessageRequest({ to: 'brian', message: 'hi' }, makeCtx());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.to).toBe('brian');
    });

    it('forwards full ENS name to proxy as-is', async () => {
      mockFetch.mockResolvedValue(mockResponse({
        id: 'msg_ens',
        to: { address: OTHER_ADDRESS, name: 'brian' },
      }));

      await handleMessageRequest({ to: 'brian.claraid.eth', message: 'hi' }, makeCtx());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.to).toBe('brian.claraid.eth');
    });

    it('forwards raw address to proxy as-is', async () => {
      mockFetch.mockResolvedValue(mockResponse({
        id: 'msg_addr',
        to: { address: OTHER_ADDRESS, name: null },
      }));

      await handleMessageRequest({ to: OTHER_ADDRESS, message: 'hi' }, makeCtx());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.to).toBe(OTHER_ADDRESS);
    });

    it('handles non-existent name error from proxy', async () => {
      mockFetch.mockResolvedValue(mockResponse(
        { code: 'INVALID_RECIPIENT', message: 'Name not found: doesnotexist' },
        400,
      ));

      const result = await handleMessageRequest(
        { to: 'doesnotexist', message: 'hello' },
        makeCtx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Recipient not found');
      expect(result.content[0].text).toContain('doesnotexist');
    });

    it('handles self-messaging error from proxy', async () => {
      mockFetch.mockResolvedValue(mockResponse(
        { code: 'SELF_MESSAGE', error: 'Cannot send a message to yourself' },
        400,
      ));

      const result = await handleMessageRequest(
        { to: TEST_ADDRESS, message: 'talking to myself' },
        makeCtx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to send message');
    });
  });

  describe('Successful Send', () => {
    it('sends message and returns confirmation', async () => {
      mockFetch.mockResolvedValue(mockResponse({
        id: 'msg_abc123',
        threadId: 'thread_xyz',
        to: { address: OTHER_ADDRESS, name: 'brian' },
        body: 'hey, tx confirmed!',
        createdAt: new Date().toISOString(),
      }));

      const result = await handleMessageRequest(
        { to: 'brian', message: 'hey, tx confirmed!' },
        makeCtx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Message sent');
      expect(result.content[0].text).toContain('brian');
      expect(result.content[0].text).toContain('hey, tx confirmed!');
    });

    it('sends correct payload to proxy', async () => {
      mockFetch.mockResolvedValue(mockResponse({
        id: 'msg_123',
        to: { address: OTHER_ADDRESS, name: null },
      }));

      await handleMessageRequest(
        { to: OTHER_ADDRESS, message: 'test msg' },
        makeCtx(),
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/messages'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Clara-Address': TEST_ADDRESS,
          }),
        }),
      );

      // Verify body payload
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.to).toBe(OTHER_ADDRESS);
      expect(body.body).toBe('test msg');
    });

    it('includes replyTo when provided', async () => {
      mockFetch.mockResolvedValue(mockResponse({
        id: 'msg_reply',
        to: { address: OTHER_ADDRESS, name: 'brian' },
      }));

      await handleMessageRequest(
        { to: 'brian', message: 'got it', replyTo: 'msg_original' },
        makeCtx(),
      );

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.replyTo).toBe('msg_original');
    });

    it('truncates long messages in confirmation preview', async () => {
      const longMsg = 'This is a very long message that should get truncated in the preview because it exceeds fifty characters';
      mockFetch.mockResolvedValue(mockResponse({
        id: 'msg_long',
        to: { address: OTHER_ADDRESS, name: 'alice' },
      }));

      const result = await handleMessageRequest(
        { to: 'alice', message: longMsg },
        makeCtx(),
      );

      expect(result.isError).toBeUndefined();
      // The confirmation message should contain a truncated preview (truncate function: 50 chars)
      expect(result.content[0].text).toContain('...');
    });

    it('uses recipient name from proxy response when available', async () => {
      mockFetch.mockResolvedValue(mockResponse({
        id: 'msg_named',
        to: { address: OTHER_ADDRESS, name: 'alice' },
      }));

      const result = await handleMessageRequest(
        { to: OTHER_ADDRESS, message: 'hello' },
        makeCtx(),
      );

      // Should display the resolved name "alice", not the raw address
      expect(result.content[0].text).toContain('alice');
    });
  });

  describe('Error Handling', () => {
    it('handles INVALID_RECIPIENT error', async () => {
      mockFetch.mockResolvedValue(mockResponse(
        { code: 'INVALID_RECIPIENT', message: 'Name not found: nonexistent' },
        400,
      ));

      const result = await handleMessageRequest(
        { to: 'nonexistent', message: 'hello' },
        makeCtx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Recipient not found');
      expect(result.content[0].text).toContain('nonexistent');
      expect(result.content[0].text).toContain('wallet_lookup_name');
    });

    it('handles 401 auth error', async () => {
      mockFetch.mockResolvedValue(mockResponse(
        { error: 'Missing or invalid X-Clara-Address header', code: 'AUTH_REQUIRED' },
        401,
      ));

      const result = await handleMessageRequest(
        { to: 'brian', message: 'hello' },
        makeCtx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to send message');
    });

    it('handles generic proxy error with message field', async () => {
      mockFetch.mockResolvedValue(mockResponse(
        { message: 'Internal server error' },
        500,
      ));

      const result = await handleMessageRequest(
        { to: 'brian', message: 'hello' },
        makeCtx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to send message');
      expect(result.content[0].text).toContain('Internal server error');
    });

    it('handles network error gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('fetch failed'));

      const result = await handleMessageRequest(
        { to: 'brian', message: 'hello' },
        makeCtx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to send message');
      expect(result.content[0].text).toContain('fetch failed');
    });

    it('handles non-Error network failure', async () => {
      mockFetch.mockRejectedValue('something went wrong');

      const result = await handleMessageRequest(
        { to: 'brian', message: 'hello' },
        makeCtx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network error');
    });
  });
});

// ─── wallet_inbox ───────────────────────────────────────────────────

describe('handleInboxRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('Empty Inbox', () => {
    it('displays empty inbox message', async () => {
      mockFetch.mockResolvedValue(mockResponse({
        threads: [],
        totalUnread: 0,
      }));

      const result = await handleInboxRequest({}, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Inbox');
      expect(result.content[0].text).toContain('No messages yet');
      expect(result.content[0].text).toContain('wallet_message');
    });

    it('handles null threads as empty', async () => {
      mockFetch.mockResolvedValue(mockResponse({
        threads: null,
        totalUnread: 0,
      }));

      const result = await handleInboxRequest({}, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('No messages yet');
    });
  });

  describe('Inbox with Threads', () => {
    const makeThread = (overrides: Record<string, any> = {}) => ({
      id: 'thread_abc',
      otherParticipant: { address: OTHER_ADDRESS, name: 'brian' },
      lastMessageAt: new Date().toISOString(),
      lastMessagePreview: 'hey, are you around?',
      messageCount: 3,
      unreadCount: 1,
      ...overrides,
    });

    it('displays threads with unread counts', async () => {
      mockFetch.mockResolvedValue(mockResponse({
        threads: [makeThread()],
        totalUnread: 1,
      }));

      const result = await handleInboxRequest({}, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Inbox');
      expect(result.content[0].text).toContain('1 unread');
      expect(result.content[0].text).toContain('brian');
      expect(result.content[0].text).toContain('hey, are you around?');
    });

    it('shows shortened address when participant has no name', async () => {
      mockFetch.mockResolvedValue(mockResponse({
        threads: [makeThread({
          otherParticipant: { address: OTHER_ADDRESS, name: null },
          unreadCount: 0,
        })],
        totalUnread: 0,
      }));

      const result = await handleInboxRequest({}, makeCtx());

      // Should show shortened address: 0x1234...7890
      expect(result.content[0].text).toContain('0x1234');
      expect(result.content[0].text).toContain('7890');
    });

    it('uses totalUnread from response', async () => {
      mockFetch.mockResolvedValue(mockResponse({
        threads: [
          makeThread({ unreadCount: 2 }),
          makeThread({ id: 'thread_def', unreadCount: 3, otherParticipant: { address: '0xaaaa000000000000000000000000000000001111', name: 'alice' } }),
        ],
        totalUnread: 5,
      }));

      const result = await handleInboxRequest({}, makeCtx());

      expect(result.content[0].text).toContain('5 unread');
    });

    it('shows mailbox icon based on unread status', async () => {
      // With unreads
      mockFetch.mockResolvedValue(mockResponse({
        threads: [makeThread({ unreadCount: 1 })],
        totalUnread: 1,
      }));

      const withUnread = await handleInboxRequest({}, makeCtx());
      expect(withUnread.content[0].text).toContain('\u{1F4EC}'); // mailbox with mail emoji

      mockFetch.mockReset();

      // Without unreads
      mockFetch.mockResolvedValue(mockResponse({
        threads: [makeThread({ unreadCount: 0 })],
        totalUnread: 0,
      }));

      const noUnread = await handleInboxRequest({}, makeCtx());
      expect(noUnread.content[0].text).toMatch(/\u{1F4ED}/u); // empty mailbox emoji
    });

    it('passes limit query parameter to proxy', async () => {
      mockFetch.mockResolvedValue(mockResponse({
        threads: [],
        totalUnread: 0,
      }));

      await handleInboxRequest({ limit: 5 }, makeCtx());

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('limit=5');
    });

    it('defaults to limit=10 when not provided', async () => {
      mockFetch.mockResolvedValue(mockResponse({
        threads: [],
        totalUnread: 0,
      }));

      await handleInboxRequest({}, makeCtx());

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('limit=10');
    });

    it('displays multiple threads in order returned by proxy', async () => {
      const now = Date.now();
      mockFetch.mockResolvedValue(mockResponse({
        threads: [
          {
            id: 'thread_newest',
            otherParticipant: { address: OTHER_ADDRESS, name: 'alice' },
            lastMessageAt: new Date(now).toISOString(),
            lastMessagePreview: 'latest message',
            messageCount: 5,
            unreadCount: 2,
          },
          {
            id: 'thread_older',
            otherParticipant: { address: '0xaaaa000000000000000000000000000000001111', name: 'bob' },
            lastMessageAt: new Date(now - 3600000).toISOString(),
            lastMessagePreview: 'older message',
            messageCount: 3,
            unreadCount: 0,
          },
        ],
        totalUnread: 2,
      }));

      const result = await handleInboxRequest({}, makeCtx());
      const text = result.content[0].text;

      // Alice's thread should appear before Bob's (proxy returns sorted by lastMessageAt DESC)
      const aliceIdx = text.indexOf('alice');
      const bobIdx = text.indexOf('bob');
      expect(aliceIdx).toBeGreaterThan(-1);
      expect(bobIdx).toBeGreaterThan(-1);
      expect(aliceIdx).toBeLessThan(bobIdx);
    });

    it('computes totalUnread from threads when response omits it', async () => {
      mockFetch.mockResolvedValue(mockResponse({
        threads: [
          makeThread({ unreadCount: 3 }),
          makeThread({ id: 'thread_2', unreadCount: 2, otherParticipant: { address: '0xbbbb000000000000000000000000000000002222', name: 'carol' } }),
        ],
        // totalUnread intentionally omitted — handler falls back to summing thread unreads
      }));

      const result = await handleInboxRequest({}, makeCtx());

      // Should sum: 3 + 2 = 5
      expect(result.content[0].text).toContain('5 unread');
    });
  });

  describe('Auto-open Single Unread Thread', () => {
    it('auto-opens when exactly one unread thread exists', async () => {
      const thread = {
        id: 'thread_single',
        otherParticipant: { address: OTHER_ADDRESS, name: 'seth' },
        lastMessageAt: new Date().toISOString(),
        lastMessagePreview: 'check out this PR',
        messageCount: 2,
        unreadCount: 1,
      };

      // First call: inbox
      mockFetch.mockResolvedValueOnce(mockResponse({
        threads: [thread],
        totalUnread: 1,
      }));

      // Second call: auto-open thread by ID (fetchThread internal)
      mockFetch.mockResolvedValueOnce(mockResponse({
        thread: {
          id: 'thread_single',
          participants: [
            { address: TEST_ADDRESS, name: null },
            { address: OTHER_ADDRESS, name: 'seth' },
          ],
        },
        messages: [
          {
            id: 'msg_1',
            from: { address: OTHER_ADDRESS, name: 'seth' },
            to: { address: TEST_ADDRESS, name: null },
            body: 'check out this PR',
            createdAt: new Date(Date.now() - 60000).toISOString(),
          },
        ],
      }));

      // Third call: mark-as-read (fire-and-forget from fetchThread)
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));

      const result = await handleInboxRequest({}, makeCtx());

      expect(result.isError).toBeUndefined();
      // Should contain both inbox AND thread content
      expect(result.content[0].text).toContain('Inbox');
      expect(result.content[0].text).toContain('seth');
      expect(result.content[0].text).toContain('Thread with seth');
      expect(result.content[0].text).toContain('check out this PR');
    });

    it('does NOT auto-open when multiple unread threads exist', async () => {
      mockFetch.mockResolvedValue(mockResponse({
        threads: [
          {
            id: 'thread_a',
            otherParticipant: { address: OTHER_ADDRESS, name: 'alice' },
            lastMessageAt: new Date().toISOString(),
            lastMessagePreview: 'hello',
            messageCount: 1,
            unreadCount: 1,
          },
          {
            id: 'thread_b',
            otherParticipant: { address: '0xaaaa000000000000000000000000000000001111', name: 'bob' },
            lastMessageAt: new Date().toISOString(),
            lastMessagePreview: 'hey',
            messageCount: 1,
            unreadCount: 1,
          },
        ],
        totalUnread: 2,
      }));

      const result = await handleInboxRequest({}, makeCtx());

      // Should only show inbox, not auto-open any thread
      expect(result.content[0].text).toContain('Inbox');
      // Should NOT contain "Thread with" since no auto-open
      expect(result.content[0].text).not.toContain('Thread with');
      // Only one fetch call (for inbox), not additional thread fetch
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT auto-open when no unread threads exist', async () => {
      mockFetch.mockResolvedValue(mockResponse({
        threads: [
          {
            id: 'thread_a',
            otherParticipant: { address: OTHER_ADDRESS, name: 'alice' },
            lastMessageAt: new Date().toISOString(),
            lastMessagePreview: 'hello',
            messageCount: 1,
            unreadCount: 0,
          },
        ],
        totalUnread: 0,
      }));

      const result = await handleInboxRequest({}, makeCtx());

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).not.toContain('Thread with');
    });
  });

  describe('Error Handling', () => {
    it('handles proxy error response', async () => {
      mockFetch.mockResolvedValue(mockResponse(
        { error: 'Auth required', code: 'AUTH_REQUIRED' },
        401,
      ));

      const result = await handleInboxRequest({}, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to load inbox');
    });

    it('handles network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await handleInboxRequest({}, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to load inbox');
      expect(result.content[0].text).toContain('Network error');
    });

    it('handles non-Error network failure', async () => {
      mockFetch.mockRejectedValue('connection reset');

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
    mockFetch.mockReset();
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
    it('displays thread with messages in chronological order', async () => {
      const now = Date.now();

      // First call: thread by participant
      mockFetch.mockResolvedValueOnce(mockResponse({
        thread: {
          id: 'thread_abc',
          participants: [
            { address: TEST_ADDRESS, name: 'me' },
            { address: OTHER_ADDRESS, name: 'brian' },
          ],
          messageCount: 3,
        },
        messages: [
          // Proxy returns newest first — handler reverses for display
          {
            id: 'msg_3',
            from: { address: OTHER_ADDRESS, name: 'brian' },
            to: { address: TEST_ADDRESS, name: 'me' },
            body: 'sounds good, shipping now',
            createdAt: new Date(now - 10000).toISOString(),
          },
          {
            id: 'msg_2',
            from: { address: TEST_ADDRESS, name: 'me' },
            to: { address: OTHER_ADDRESS, name: 'brian' },
            body: 'can you review my PR?',
            createdAt: new Date(now - 60000).toISOString(),
          },
          {
            id: 'msg_1',
            from: { address: OTHER_ADDRESS, name: 'brian' },
            to: { address: TEST_ADDRESS, name: 'me' },
            body: 'hey, whats up?',
            createdAt: new Date(now - 120000).toISOString(),
          },
        ],
      }));

      // Second call: mark as read (fire-and-forget)
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));

      const result = await handleThreadRequest({ with: 'brian' }, makeCtx());

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;

      // Header
      expect(text).toContain('Thread with brian');

      // Messages should appear in chronological order (oldest first)
      const msg1Idx = text.indexOf('hey, whats up?');
      const msg2Idx = text.indexOf('can you review my PR?');
      const msg3Idx = text.indexOf('sounds good, shipping now');
      expect(msg1Idx).toBeLessThan(msg2Idx);
      expect(msg2Idx).toBeLessThan(msg3Idx);

      // Own messages labeled as "you"
      expect(text).toContain('you');
      expect(text).toContain('brian');
    });

    it('defaults to limit=20 when not provided', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        thread: {
          id: 'thread_default',
          participants: [
            { address: TEST_ADDRESS, name: null },
            { address: OTHER_ADDRESS, name: 'brian' },
          ],
          messageCount: 0,
        },
        messages: [],
      }));
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));

      await handleThreadRequest({ with: 'brian' }, makeCtx());

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('limit=20');
    });

    it('resolves bare name via proxy by-participant endpoint', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        thread: {
          id: 'thread_byname',
          participants: [
            { address: TEST_ADDRESS, name: null },
            { address: OTHER_ADDRESS, name: 'alice' },
          ],
          messageCount: 0,
        },
        messages: [],
      }));
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));

      await handleThreadRequest({ with: 'alice' }, makeCtx());

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('with=alice');
    });

    it('resolves full ENS name via proxy', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        thread: {
          id: 'thread_byens',
          participants: [
            { address: TEST_ADDRESS, name: null },
            { address: OTHER_ADDRESS, name: 'alice' },
          ],
          messageCount: 0,
        },
        messages: [],
      }));
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));

      await handleThreadRequest({ with: 'alice.claraid.eth' }, makeCtx());

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('with=alice.claraid.eth');
    });

    it('resolves raw address via proxy', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        thread: {
          id: 'thread_byaddr',
          participants: [
            { address: TEST_ADDRESS, name: null },
            { address: OTHER_ADDRESS, name: null },
          ],
          messageCount: 0,
        },
        messages: [],
      }));
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));

      await handleThreadRequest({ with: OTHER_ADDRESS }, makeCtx());

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain(`with=${encodeURIComponent(OTHER_ADDRESS)}`);
    });

    it('sends correct query to proxy', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        thread: {
          id: 'thread_test',
          participants: [
            { address: TEST_ADDRESS, name: null },
            { address: OTHER_ADDRESS, name: 'brian' },
          ],
          messageCount: 0,
        },
        messages: [],
      }));

      // mark-as-read fire-and-forget
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));

      await handleThreadRequest({ with: 'brian', limit: 30 }, makeCtx());

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/api/v1/threads/by-participant');
      expect(url).toContain('with=brian');
      expect(url).toContain('limit=30');

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['X-Clara-Address']).toBe(TEST_ADDRESS);
    });

    it('marks thread as read after opening', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        thread: {
          id: 'thread_toread',
          participants: [
            { address: TEST_ADDRESS, name: null },
            { address: OTHER_ADDRESS, name: 'brian' },
          ],
          messageCount: 1,
        },
        messages: [{
          id: 'msg_1',
          from: { address: OTHER_ADDRESS, name: 'brian' },
          to: { address: TEST_ADDRESS, name: null },
          body: 'hello',
          createdAt: new Date().toISOString(),
        }],
      }));

      // This is the mark-as-read call
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));

      await handleThreadRequest({ with: 'brian' }, makeCtx());

      // Wait for fire-and-forget mark-as-read call
      await new Promise((r) => setTimeout(r, 10));

      // Should have made a POST to /threads/:id/read
      const markReadCall = mockFetch.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('/read'),
      );
      expect(markReadCall).toBeDefined();
      expect(markReadCall![1].method).toBe('POST');
      expect(markReadCall![0]).toContain('thread_toread');
    });

    it('displays empty thread message', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        thread: {
          id: 'thread_empty',
          participants: [
            { address: TEST_ADDRESS, name: null },
            { address: OTHER_ADDRESS, name: 'brian' },
          ],
          messageCount: 0,
        },
        messages: [],
      }));

      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));

      const result = await handleThreadRequest({ with: 'brian' }, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('No messages yet');
    });

    it('shows shortened address when sender has no name', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        thread: {
          id: 'thread_noname',
          participants: [
            { address: TEST_ADDRESS, name: null },
            { address: OTHER_ADDRESS, name: null },
          ],
          messageCount: 1,
        },
        messages: [{
          id: 'msg_anon',
          from: { address: OTHER_ADDRESS, name: null },
          to: { address: TEST_ADDRESS, name: null },
          body: 'anon message',
          createdAt: new Date().toISOString(),
        }],
      }));

      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));

      const result = await handleThreadRequest({ with: OTHER_ADDRESS }, makeCtx());

      // Should use shortened address for the unnamed other participant
      expect(result.content[0].text).toContain('0x1234');
      expect(result.content[0].text).toContain('7890');
    });
  });

  describe('Error Handling', () => {
    it('handles 404 with helpful message', async () => {
      mockFetch.mockResolvedValue(mockResponse(
        { error: 'No conversation found', code: 'NOT_FOUND' },
        404,
      ));

      const result = await handleThreadRequest({ with: 'alice' }, makeCtx());

      // 404 is NOT isError — it's a helpful info message
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('No conversation with');
      expect(result.content[0].text).toContain('alice');
      expect(result.content[0].text).toContain('wallet_message');
    });

    it('handles 403 not-a-participant error', async () => {
      mockFetch.mockResolvedValue(mockResponse(
        { error: 'Not a participant in this thread', code: 'FORBIDDEN' },
        403,
      ));

      const result = await handleThreadRequest({ with: 'brian' }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to open thread');
    });

    it('handles generic proxy error', async () => {
      mockFetch.mockResolvedValue(mockResponse(
        { error: 'Server error', code: 'INTERNAL' },
        500,
      ));

      const result = await handleThreadRequest({ with: 'brian' }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to open thread');
    });

    it('handles 401 auth error', async () => {
      mockFetch.mockResolvedValue(mockResponse(
        { error: 'Missing or invalid X-Clara-Address header', code: 'AUTH_REQUIRED' },
        401,
      ));

      const result = await handleThreadRequest({ with: 'brian' }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to open thread');
    });

    it('handles network error', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const result = await handleThreadRequest({ with: 'brian' }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to open thread');
      expect(result.content[0].text).toContain('Connection refused');
    });

    it('handles non-Error network failure', async () => {
      mockFetch.mockRejectedValue(undefined);

      const result = await handleThreadRequest({ with: 'brian' }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network error');
    });
  });
});
