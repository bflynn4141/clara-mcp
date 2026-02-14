/**
 * Tests for work tool helpers + work_browse / work_list integration
 *
 * Covers:
 * - work-helpers.ts: formatRawAmount, parseTaskURI, getTaskSummary, getTokenMeta,
 *   formatAddress, formatDeadline, parseDeadline, formatAmount, toDataUri,
 *   getLocalAgentId, saveLocalAgentId
 * - work-browse.ts: handleWorkBrowse integration with local indexer
 * - work-list.ts: handleWorkList integration with local indexer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks (must be declared before imports) ────────────────────────

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

// Mock the indexer module for work-browse and work-list tests
vi.mock('../../indexer/index.js', () => ({
  getOpenBounties: vi.fn(),
  getBountiesByPoster: vi.fn(),
  getBountiesByClaimer: vi.fn(),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from 'fs';

import {
  getLocalAgentId,
  saveLocalAgentId,
  toDataUri,
  formatAddress,
  formatDeadline,
  parseDeadline,
  formatAmount,
  getTokenMeta,
  formatRawAmount,
  parseTaskURI,
  getTaskSummary,
} from '../../tools/work-helpers.js';

import { handleWorkBrowse } from '../../tools/work-browse.js';
import { handleWorkList } from '../../tools/work-list.js';
import { getOpenBounties, getBountiesByPoster, getBountiesByClaimer } from '../../indexer/index.js';

import type { ToolContext } from '../../middleware.js';
import type { BountyRecord } from '../../indexer/types.js';
import type { Hex } from 'viem';

// ─── Test Fixtures ──────────────────────────────────────────────────

const CLARA_TOKEN = '0x514228d83ab8dcf1c0370fca88444f2f85c6ef55';
const UNKNOWN_TOKEN = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const WALLET_ADDRESS = '0xabcdef1234567890abcdef1234567890abcdef12' as Hex;

const nowSec = Math.floor(Date.now() / 1000);

function makeBounty(overrides: Partial<BountyRecord> = {}): BountyRecord {
  return {
    bountyAddress: '0xbounty1',
    poster: '0xposter1',
    token: CLARA_TOKEN,
    amount: '1000000000000000000', // 1 CLARA
    deadline: nowSec + 86400 * 3, // 3 days from now
    taskURI: toDataUri({ title: 'Test Task', description: 'A test bounty' }),
    skillTags: ['solidity', 'defi'],
    status: 'open',
    createdBlock: 100,
    createdTxHash: '0xtx1',
    ...overrides,
  };
}

function makeCtx(address: Hex = WALLET_ADDRESS): ToolContext {
  return {
    session: {
      authenticated: true,
      address,
      walletId: 'test-wallet-id',
    } as any,
    walletAddress: address,
  };
}

// =====================================================================
// Section 5: work-helpers.test.ts
// =====================================================================

describe('work-helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── getLocalAgentId / saveLocalAgentId ──────────────────────────

  describe('getLocalAgentId / saveLocalAgentId', () => {
    it('returns null when agent.json does not exist', () => {
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(getLocalAgentId()).toBeNull();
    });

    it('returns agentId from valid agent.json', () => {
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ agentId: 42, name: 'test', registeredAt: '2025-01-01' }),
      );
      expect(getLocalAgentId()).toBe(42);
    });

    it('returns null when agent.json is corrupt', () => {
      vi.mocked(readFileSync).mockReturnValue('{');
      expect(getLocalAgentId()).toBeNull();
    });

    it('saveLocalAgentId creates dir and writes file', () => {
      saveLocalAgentId(42, 'test-agent');
      expect(mkdirSync).toHaveBeenCalledWith(
        '/mock/home/.clara',
        { recursive: true },
      );
      expect(writeFileSync).toHaveBeenCalledWith(
        '/mock/home/.clara/agent.json',
        expect.stringContaining('"agentId": 42'),
      );
    });
  });

  // ─── toDataUri ──────────────────────────────────────────────────

  describe('toDataUri', () => {
    it('encodes JSON object to base64 data URI', () => {
      const result = toDataUri({ title: 'Test' });
      expect(result).toMatch(/^data:application\/json;base64,/);
    });

    it('round-trips through parseTaskURI', () => {
      const obj = { title: 'My Task', description: 'Details here' };
      const uri = toDataUri(obj);
      const parsed = parseTaskURI(uri);
      expect(parsed).toEqual(obj);
    });
  });

  // ─── formatAddress ──────────────────────────────────────────────

  describe('formatAddress', () => {
    it('truncates standard 42-char address to 0x1234...5678', () => {
      expect(formatAddress('0x1234567890abcdef1234567890abcdef12345678'))
        .toBe('0x1234...5678');
    });

    it('returns short strings unchanged', () => {
      expect(formatAddress('0x12')).toBe('0x12');
    });

    it('returns empty string unchanged', () => {
      expect(formatAddress('')).toBe('');
    });
  });

  // ─── formatDeadline ─────────────────────────────────────────────

  describe('formatDeadline', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // Fix time to a known point
      vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns "expired" for past timestamps', () => {
      const past = Math.floor(Date.now() / 1000) - 3600;
      expect(formatDeadline(past)).toBe('expired');
    });

    it('returns days and hours for multi-day deadlines', () => {
      const future = Math.floor(Date.now() / 1000) + 86400 * 2 + 3600 * 5;
      expect(formatDeadline(future)).toBe('2d 5h');
    });

    it('returns hours only when < 1 day', () => {
      const future = Math.floor(Date.now() / 1000) + 3600 * 5;
      expect(formatDeadline(future)).toBe('5h');
    });

    it('returns minutes when < 1 hour', () => {
      const future = Math.floor(Date.now() / 1000) + 60 * 30;
      expect(formatDeadline(future)).toBe('30m');
    });
  });

  // ─── parseDeadline ──────────────────────────────────────────────

  describe('parseDeadline', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const nowSec = () => Math.floor(Date.now() / 1000);

    it('parses ISO date string', () => {
      const result = parseDeadline('2025-03-01');
      expect(result).toBe(Math.floor(Date.parse('2025-03-01') / 1000));
    });

    it('parses "3 days" relative', () => {
      expect(parseDeadline('3 days')).toBe(nowSec() + 3 * 86400);
    });

    it('parses "24 hours" relative', () => {
      expect(parseDeadline('24 hours')).toBe(nowSec() + 24 * 3600);
    });

    it('parses "1 week" relative', () => {
      expect(parseDeadline('1 week')).toBe(nowSec() + 604800);
    });

    it('parses "30 min" relative', () => {
      expect(parseDeadline('30 min')).toBe(nowSec() + 30 * 60);
    });

    it('accepts variant unit names: d, h, w, m', () => {
      expect(parseDeadline('3 d')).toBe(nowSec() + 3 * 86400);
      expect(parseDeadline('5 h')).toBe(nowSec() + 5 * 3600);
      expect(parseDeadline('2 w')).toBe(nowSec() + 2 * 604800);
      expect(parseDeadline('10 m')).toBe(nowSec() + 10 * 60);
    });

    it('throws on invalid format', () => {
      expect(() => parseDeadline('next tuesday')).toThrow('Invalid deadline format');
    });
  });

  // ─── formatAmount ───────────────────────────────────────────────

  describe('formatAmount', () => {
    it('formats stablecoins with 2 decimal places', () => {
      expect(formatAmount('100.5', 'USDC')).toBe('100.50 USDC');
      expect(formatAmount('50.123', 'USDT')).toBe('50.12 USDT');
      expect(formatAmount('1.1', 'DAI')).toBe('1.10 DAI');
    });

    it('formats other tokens with 4 decimal places', () => {
      expect(formatAmount('1.23456', 'ETH')).toBe('1.2346 ETH');
    });

    it('handles NaN amount gracefully', () => {
      expect(formatAmount('abc', 'TOKEN')).toBe('abc TOKEN');
    });
  });

  // ─── getTokenMeta ───────────────────────────────────────────────

  describe('getTokenMeta', () => {
    it('returns CLARA meta for known CLARA token address', () => {
      expect(getTokenMeta(CLARA_TOKEN)).toEqual({ symbol: 'CLARA', decimals: 18 });
    });

    it('normalizes address to lowercase for lookup', () => {
      const mixedCase = '0x514228D83AB8DCF1C0370FCA88444F2F85C6EF55';
      expect(getTokenMeta(mixedCase)).toEqual({ symbol: 'CLARA', decimals: 18 });
    });

    it('returns fallback { symbol: TOKEN, decimals: 18 } for unknown address', () => {
      expect(getTokenMeta(UNKNOWN_TOKEN)).toEqual({ symbol: 'TOKEN', decimals: 18 });
    });
  });

  // ─── formatRawAmount ────────────────────────────────────────────

  describe('formatRawAmount', () => {
    it('converts raw bigint string to formatted amount with symbol', () => {
      // 1e18 = 1 CLARA
      const result = formatRawAmount('1000000000000000000', CLARA_TOKEN);
      expect(result).toBe('1.0000 CLARA');
    });

    it('uses token decimals from getTokenMeta', () => {
      // Unknown token falls back to 18 decimals, symbol "TOKEN"
      const result = formatRawAmount('5000000000000000000', UNKNOWN_TOKEN);
      expect(result).toBe('5.0000 TOKEN');
    });

    it('handles zero amount', () => {
      const result = formatRawAmount('0', UNKNOWN_TOKEN);
      expect(result).toBe('0.0000 TOKEN');
    });
  });

  // ─── parseTaskURI ───────────────────────────────────────────────

  describe('parseTaskURI', () => {
    it('parses data:application/json;base64,... URI', () => {
      const obj = { title: 'Hello', description: 'World' };
      const b64 = Buffer.from(JSON.stringify(obj)).toString('base64');
      const uri = `data:application/json;base64,${b64}`;
      expect(parseTaskURI(uri)).toEqual(obj);
    });

    it('parses plain JSON string', () => {
      expect(parseTaskURI('{"title":"test"}')).toEqual({ title: 'test' });
    });

    it('returns null for invalid base64', () => {
      expect(parseTaskURI('data:application/json;base64,!!!')).toBeNull();
    });

    it('returns null for non-JSON string', () => {
      expect(parseTaskURI('just text')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseTaskURI('')).toBeNull();
    });
  });

  // ─── getTaskSummary ─────────────────────────────────────────────

  describe('getTaskSummary', () => {
    it('returns title field when present', () => {
      const uri = toDataUri({ title: 'My Task' });
      expect(getTaskSummary(uri)).toBe('My Task');
    });

    it('returns summary field when no title', () => {
      const uri = toDataUri({ summary: 'Do this' });
      expect(getTaskSummary(uri)).toBe('Do this');
    });

    it('returns truncated description (100 chars) when no title or summary', () => {
      const longDesc = 'A'.repeat(200);
      const uri = toDataUri({ description: longDesc });
      expect(getTaskSummary(uri)).toBe('A'.repeat(100));
    });

    it('returns "(no title)" when data has none of the fields', () => {
      const uri = toDataUri({});
      expect(getTaskSummary(uri)).toBe('(no title)');
    });

    it('returns "(unable to parse task)" for unparseable URI', () => {
      expect(getTaskSummary('not valid at all')).toBe('(unable to parse task)');
    });
  });
});

// =====================================================================
// Section 6: work-browse.test.ts
// =====================================================================

describe('handleWorkBrowse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns formatted bounty list for default open status', async () => {
    const bounties = [
      makeBounty({ bountyAddress: '0xbounty1' }),
      makeBounty({ bountyAddress: '0xbounty2', amount: '2000000000000000000' }),
    ];
    vi.mocked(getOpenBounties).mockReturnValue(bounties);

    const result = await handleWorkBrowse({});
    const text = result.content[0].text;

    expect(text).toContain('Open Bounties');
    expect(text).toContain('(2)');
    expect(text).toContain('CLARA');
    expect(text).toContain('0xbounty1');
    expect(text).toContain('0xbounty2');
  });

  it('passes all filter args to getOpenBounties', async () => {
    vi.mocked(getOpenBounties).mockReturnValue([]);

    await handleWorkBrowse({
      status: 'claimed',
      skill: 'rust',
      minAmount: 5,
      maxAmount: 100,
      limit: 3,
    });

    expect(getOpenBounties).toHaveBeenCalledWith({
      status: 'claimed',
      skill: 'rust',
      limit: 3,
    });
  });

  it('defaults status to "open" and limit to 10', async () => {
    vi.mocked(getOpenBounties).mockReturnValue([]);

    await handleWorkBrowse({});

    expect(getOpenBounties).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'open',
        limit: 10,
      }),
    );
  });

  it('returns "no bounties found" message when list is empty', async () => {
    vi.mocked(getOpenBounties).mockReturnValue([]);

    const result = await handleWorkBrowse({});
    const text = result.content[0].text;

    expect(text).toContain('No open bounties found');
    expect(text).toContain('work_post');
  });

  it('includes skill filter in "no bounties" message', async () => {
    vi.mocked(getOpenBounties).mockReturnValue([]);

    const result = await handleWorkBrowse({ skill: 'rust' });
    const text = result.content[0].text;

    expect(text).toContain('matching skill "rust"');
  });

  it('formats each bounty with separator, amount, deadline, skills, poster, contract', async () => {
    const bounties = [makeBounty({
      bountyAddress: '0xbountycontract123456789012345678901234567890',
      poster: '0xposter1234567890abcdef1234567890abcdef123456',
      skillTags: ['solidity', 'defi'],
    })];
    vi.mocked(getOpenBounties).mockReturnValue(bounties);

    const result = await handleWorkBrowse({});
    const text = result.content[0].text;

    expect(text).toContain('---');
    expect(text).toContain('CLARA');
    expect(text).toContain('Deadline:');
    expect(text).toContain('Skills: solidity, defi');
    expect(text).toContain('Posted by:');
    expect(text).toContain('Contract:');
  });

  it('shows "any" when bounty has no skillTags', async () => {
    const bounties = [makeBounty({ skillTags: [] })];
    vi.mocked(getOpenBounties).mockReturnValue(bounties);

    const result = await handleWorkBrowse({});
    const text = result.content[0].text;

    expect(text).toContain('Skills: any');
  });

  it('returns error result on exception', async () => {
    vi.mocked(getOpenBounties).mockImplementation(() => {
      throw new Error('Indexer offline');
    });

    const result = await handleWorkBrowse({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Indexer offline');
  });

  it('includes CTA to work_claim at the end', async () => {
    vi.mocked(getOpenBounties).mockReturnValue([makeBounty()]);

    const result = await handleWorkBrowse({});
    const text = result.content[0].text;

    expect(text).toContain('work_claim');
    expect(text).toContain('bountyAddress="0x..."');
  });
});

// =====================================================================
// Section 7: work-list.test.ts
// =====================================================================

describe('handleWorkList', () => {
  const ctx = makeCtx(WALLET_ADDRESS);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns bounties posted by wallet when role=poster', async () => {
    vi.mocked(getBountiesByPoster).mockReturnValue([
      makeBounty({ poster: WALLET_ADDRESS }),
    ]);
    vi.mocked(getBountiesByClaimer).mockReturnValue([]);

    await handleWorkList({ role: 'poster' }, ctx);

    expect(getBountiesByPoster).toHaveBeenCalledWith(WALLET_ADDRESS);
    expect(getBountiesByClaimer).not.toHaveBeenCalled();
  });

  it('returns bounties claimed by wallet when role=claimer', async () => {
    vi.mocked(getBountiesByPoster).mockReturnValue([]);
    vi.mocked(getBountiesByClaimer).mockReturnValue([
      makeBounty({ claimer: WALLET_ADDRESS }),
    ]);

    await handleWorkList({ role: 'claimer' }, ctx);

    expect(getBountiesByClaimer).toHaveBeenCalledWith(WALLET_ADDRESS);
    expect(getBountiesByPoster).not.toHaveBeenCalled();
  });

  it('returns both posted and claimed when role=all', async () => {
    vi.mocked(getBountiesByPoster).mockReturnValue([
      makeBounty({ bountyAddress: '0xposted1', poster: WALLET_ADDRESS }),
    ]);
    vi.mocked(getBountiesByClaimer).mockReturnValue([
      makeBounty({ bountyAddress: '0xclaimed1', claimer: WALLET_ADDRESS }),
    ]);

    const result = await handleWorkList({ role: 'all' }, ctx);

    expect(getBountiesByPoster).toHaveBeenCalled();
    expect(getBountiesByClaimer).toHaveBeenCalled();
    // Both bounties appear in output
    const text = result.content[0].text;
    expect(text).toContain('2 total');
  });

  it('defaults role to "all"', async () => {
    vi.mocked(getBountiesByPoster).mockReturnValue([]);
    vi.mocked(getBountiesByClaimer).mockReturnValue([]);

    await handleWorkList({}, ctx);

    expect(getBountiesByPoster).toHaveBeenCalled();
    expect(getBountiesByClaimer).toHaveBeenCalled();
  });

  it('deduplicates when same address is both poster and claimer', async () => {
    const sharedBounty = makeBounty({
      bountyAddress: '0xshared',
      poster: WALLET_ADDRESS,
      claimer: WALLET_ADDRESS,
    });
    vi.mocked(getBountiesByPoster).mockReturnValue([sharedBounty]);
    vi.mocked(getBountiesByClaimer).mockReturnValue([sharedBounty]);

    const result = await handleWorkList({ role: 'all' }, ctx);
    const text = result.content[0].text;

    // The bounty should appear exactly once. The total count should be 1, not 2.
    expect(text).toContain('1 total');
  });

  it('groups results by status', async () => {
    vi.mocked(getBountiesByPoster).mockReturnValue([
      makeBounty({ bountyAddress: '0xopen1', status: 'open', poster: WALLET_ADDRESS }),
      makeBounty({ bountyAddress: '0xopen2', status: 'open', poster: WALLET_ADDRESS }),
      makeBounty({ bountyAddress: '0xclaimed1', status: 'claimed', poster: WALLET_ADDRESS }),
    ]);
    vi.mocked(getBountiesByClaimer).mockReturnValue([]);

    const result = await handleWorkList({ role: 'poster' }, ctx);
    const text = result.content[0].text;

    expect(text).toContain('### Open (2)');
    expect(text).toContain('### Claimed (1)');
  });

  it('labels bounties as "Posted" or "Claimed" based on role', async () => {
    const posterAddr = WALLET_ADDRESS.toLowerCase();
    vi.mocked(getBountiesByPoster).mockReturnValue([
      makeBounty({ bountyAddress: '0xposted1', poster: posterAddr }),
    ]);
    vi.mocked(getBountiesByClaimer).mockReturnValue([
      makeBounty({ bountyAddress: '0xclaimed1', poster: '0xotherposter', claimer: posterAddr }),
    ]);

    const result = await handleWorkList({ role: 'all' }, ctx);
    const text = result.content[0].text;

    expect(text).toContain('Posted');
    expect(text).toContain('Claimed');
  });

  it('returns "no bounties found" when both queries return empty', async () => {
    vi.mocked(getBountiesByPoster).mockReturnValue([]);
    vi.mocked(getBountiesByClaimer).mockReturnValue([]);

    const result = await handleWorkList({ role: 'all' }, ctx);
    const text = result.content[0].text;

    expect(text).toContain('No bounties found');
    expect(text).toContain('work_post');
    expect(text).toContain('work_browse');
  });

  it('returns error result on exception', async () => {
    vi.mocked(getBountiesByPoster).mockImplementation(() => {
      throw new Error('DB corruption');
    });

    const result = await handleWorkList({ role: 'poster' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('DB corruption');
  });
});
