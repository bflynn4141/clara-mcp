/**
 * Challenge MCP Tool Handler Tests
 *
 * Tests the challenge_* tool handlers with mocked indexer data.
 * These test the handler logic and output formatting, not on-chain interactions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChallengeRecord, SubmissionRecord, WinnerRecord } from '../indexer/types.js';

// ─── Mock the indexer ───────────────────────────────────────────────
vi.mock('../indexer/index.js', () => ({
  getOpenChallenges: vi.fn(() => []),
  getChallengeByAddress: vi.fn(() => null),
  getChallengeLeaderboard: vi.fn(() => []),
  getAgentByAgentId: vi.fn(() => null),
}));

// Mock work-helpers to avoid filesystem reads
vi.mock('../tools/work-helpers.js', () => ({
  formatAddress: (addr: string) => addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr,
  getTokenMeta: (addr: string) => {
    if (addr === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913') {
      return { symbol: 'USDC', decimals: 6 };
    }
    return { symbol: 'TOKEN', decimals: 18 };
  },
  parseTaskURI: (uri: string) => {
    try {
      const prefix = 'data:application/json;base64,';
      if (uri.startsWith(prefix)) {
        return JSON.parse(Buffer.from(uri.slice(prefix.length), 'base64').toString());
      }
    } catch { /* ignore */ }
    return null;
  },
  getLocalAgentId: () => 42,
  toDataUri: (obj: Record<string, unknown>) => {
    const json = JSON.stringify(obj);
    return `data:application/json;base64,${Buffer.from(json).toString('base64')}`;
  },
  formatAmount: (amount: string, symbol: string) => `${amount} ${symbol}`,
  parseDeadline: (input: string) => Math.floor(Date.now() / 1000) + 86400 * 7,
  formatDeadline: (ts: number) => new Date(ts * 1000).toISOString(),
}));

// Mock para transactions (for submit/claim which we test input validation only)
vi.mock('../para/transactions.js', () => ({
  signAndSendTransaction: vi.fn(),
}));

// Mock config modules
vi.mock('../config/clara-contracts.js', () => ({
  CHALLENGE_ABI: [],
  CHALLENGE_FACTORY_ABI: [],
  ERC20_APPROVE_ABI: [],
  getChallengeContracts: () => ({
    challengeFactory: '0x0000000000000000000000000000000000001234',
  }),
}));

vi.mock('../config/chains.js', () => ({
  getChainId: () => 8453,
  getExplorerTxUrl: (chain: string, hash: string) => `https://basescan.org/tx/${hash}`,
  getRpcUrl: () => 'https://mainnet.base.org',
}));

vi.mock('../config/tokens.js', () => ({
  resolveToken: (symbol: string) => {
    if (symbol.toUpperCase() === 'USDC') {
      return { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, symbol: 'USDC' };
    }
    return null;
  },
}));

vi.mock('../indexer/sync.js', () => ({
  syncFromChain: vi.fn(),
  getIndex: vi.fn(),
}));

// Mock challenge-queries for tools that import directly
vi.mock('../indexer/challenge-queries.js', () => ({
  getChallengeByAddress: vi.fn(() => null),
  getChallengeLeaderboard: vi.fn(() => []),
}));

import {
  getOpenChallenges,
  getChallengeByAddress as getChallengeByAddressIndexer,
  getChallengeLeaderboard as getChallengeLeaderboardIndexer,
  getAgentByAgentId,
} from '../indexer/index.js';
import {
  getChallengeByAddress as getChallengeByAddressQueries,
  getChallengeLeaderboard as getChallengeLeaderboardQueries,
} from '../indexer/challenge-queries.js';
import { handleChallengeBrowse } from '../tools/challenge-browse.js';
import { handleChallengeDetail } from '../tools/challenge-detail.js';
import { handleChallengeLeaderboard } from '../tools/challenge-leaderboard.js';
import { handleChallengeScore } from '../tools/challenge-score.js';
import { handleChallengeSubmit } from '../tools/challenge-submit.js';
import { handleChallengeClaim } from '../tools/challenge-claim.js';

// ─── Test Fixtures ──────────────────────────────────────────────────

const USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function makeChallengeRecord(overrides: Partial<ChallengeRecord> = {}): ChallengeRecord {
  return {
    challengeAddress: '0x1111111111111111111111111111111111111111',
    poster: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    token: USDC_ADDRESS,
    prizePool: '500000000',
    deadline: Math.floor(Date.now() / 1000) + 86400 * 7,
    scoringDeadline: Math.floor(Date.now() / 1000) + 86400 * 9,
    challengeURI: 'data:application/json;base64,' + Buffer.from(JSON.stringify({ title: 'Optimize AMM Fees' })).toString('base64'),
    evalConfigHash: '0x' + 'ab'.repeat(32),
    winnerCount: 3,
    payoutBps: [6000, 2500, 1500],
    skillTags: ['solidity', 'defi'],
    status: 'open',
    submissionCount: 5,
    privateSetHash: '0x' + 'cd'.repeat(32),
    maxParticipants: 100,
    scorePostedAt: null,
    submissions: {},
    winners: [],
    createdBlock: 1000,
    createdTxHash: '0x' + 'ff'.repeat(32),
    updatedBlock: 1000,
    ...overrides,
  };
}

function makeSubmissionRecord(overrides: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    submitter: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    agentId: 1,
    solutionURI: 'https://example.com/solution',
    solutionHash: '0x' + 'ee'.repeat(32),
    submittedAt: Math.floor(Date.now() / 1000),
    version: 1,
    score: null,
    rank: null,
    ...overrides,
  };
}

const mockToolContext = {
  session: { walletId: 'test-wallet-id' },
  walletAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`,
};

// ─── Tests ──────────────────────────────────────────────────────────

describe('Challenge Tool Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ────── challenge_browse ─────────────────────────────────────────

  describe('handleChallengeBrowse', () => {
    it('returns "no challenges found" message when empty', async () => {
      vi.mocked(getOpenChallenges).mockReturnValue([]);

      const result = await handleChallengeBrowse({});
      expect(result.content[0].text).toContain('No open challenges found');
    });

    it('returns "no challenges found" with skill filter note', async () => {
      vi.mocked(getOpenChallenges).mockReturnValue([]);

      const result = await handleChallengeBrowse({ skill: 'solidity' });
      expect(result.content[0].text).toContain('matching skill "solidity"');
    });

    it('returns formatted challenge list', async () => {
      const challenge = makeChallengeRecord();
      vi.mocked(getOpenChallenges).mockReturnValue([challenge]);

      const result = await handleChallengeBrowse({});
      const text = result.content[0].text;

      expect(text).toContain('Open Challenges');
      expect(text).toContain('Submissions: 5');
      expect(text).toContain('Winners: 3');
      expect(text).toContain('solidity, defi');
    });

    it('passes filters to getOpenChallenges', async () => {
      vi.mocked(getOpenChallenges).mockReturnValue([]);

      await handleChallengeBrowse({
        skill: 'security',
        status: 'scoring',
        minPrize: 100,
        maxPrize: 1000,
        limit: 5,
      });

      expect(getOpenChallenges).toHaveBeenCalledWith({
        status: 'scoring',
        skill: 'security',
        minPrize: 100,
        maxPrize: 1000,
        limit: 5,
      });
    });
  });

  // ────── challenge_detail ─────────────────────────────────────────

  describe('handleChallengeDetail', () => {
    it('returns error for invalid address', async () => {
      const result = await handleChallengeDetail({ challengeAddress: 'not-an-address' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid challenge address');
    });

    it('returns "not found" for missing challenge', async () => {
      vi.mocked(getChallengeByAddressIndexer).mockReturnValue(null);

      const result = await handleChallengeDetail({
        challengeAddress: '0x1111111111111111111111111111111111111111',
      });
      expect(result.content[0].text).toContain('Challenge not found');
    });

    it('returns full details for existing challenge', async () => {
      const challenge = makeChallengeRecord();
      vi.mocked(getChallengeByAddressIndexer).mockReturnValue(challenge);
      vi.mocked(getChallengeLeaderboardIndexer).mockReturnValue([]);

      const result = await handleChallengeDetail({
        challengeAddress: challenge.challengeAddress,
      });
      const text = result.content[0].text;

      expect(text).toContain('Optimize AMM Fees');
      expect(text).toContain('Open');
      expect(text).toContain('500');
      expect(text).toContain('solidity, defi');
      expect(text).toContain('challenge_submit');
    });

    it('shows leaderboard entries when available', async () => {
      const challenge = makeChallengeRecord();
      vi.mocked(getChallengeByAddressIndexer).mockReturnValue(challenge);
      vi.mocked(getChallengeLeaderboardIndexer).mockReturnValue([
        makeSubmissionRecord({ submitter: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', agentId: 1, score: 9500 }),
        makeSubmissionRecord({ submitter: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', agentId: 2, score: 8000 }),
      ]);
      vi.mocked(getAgentByAgentId).mockReturnValue(null);

      const result = await handleChallengeDetail({
        challengeAddress: challenge.challengeAddress,
      });
      const text = result.content[0].text;

      expect(text).toContain('Leaderboard');
      expect(text).toContain('9500');
      expect(text).toContain('8000');
    });

    it('shows winners section for finalized challenge', async () => {
      const challenge = makeChallengeRecord({
        status: 'finalized',
        winners: [
          {
            address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            agentId: 1,
            rank: 1,
            score: 9500,
            prizeAmount: '300000000',
            claimed: true,
          },
        ],
      });
      vi.mocked(getChallengeByAddressIndexer).mockReturnValue(challenge);
      vi.mocked(getChallengeLeaderboardIndexer).mockReturnValue([]);
      vi.mocked(getAgentByAgentId).mockReturnValue(null);

      const result = await handleChallengeDetail({
        challengeAddress: challenge.challengeAddress,
      });
      const text = result.content[0].text;

      expect(text).toContain('Winners');
      expect(text).toContain('claimed');
      expect(text).toContain('challenge_claim');
    });
  });

  // ────── challenge_leaderboard ────────────────────────────────────

  describe('handleChallengeLeaderboard', () => {
    it('returns error for invalid address', async () => {
      const result = await handleChallengeLeaderboard({ challengeAddress: 'bad' });
      expect(result.isError).toBe(true);
    });

    it('returns "not found" for missing challenge', async () => {
      vi.mocked(getChallengeByAddressIndexer).mockReturnValue(null);

      const result = await handleChallengeLeaderboard({
        challengeAddress: '0x1111111111111111111111111111111111111111',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Challenge not found');
    });

    it('returns "no submissions" for empty leaderboard', async () => {
      vi.mocked(getChallengeByAddressIndexer).mockReturnValue(makeChallengeRecord());
      vi.mocked(getChallengeLeaderboardIndexer).mockReturnValue([]);

      const result = await handleChallengeLeaderboard({
        challengeAddress: '0x1111111111111111111111111111111111111111',
      });
      expect(result.content[0].text).toContain('No submissions yet');
    });

    it('renders ranked list with scores', async () => {
      vi.mocked(getChallengeByAddressIndexer).mockReturnValue(makeChallengeRecord());
      vi.mocked(getChallengeLeaderboardIndexer).mockReturnValue([
        makeSubmissionRecord({ submitter: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', agentId: 1, score: 9500, version: 3 }),
        makeSubmissionRecord({ submitter: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', agentId: 2, score: 8000, version: 2 }),
      ]);
      vi.mocked(getAgentByAgentId).mockReturnValue(null);

      const result = await handleChallengeLeaderboard({
        challengeAddress: '0x1111111111111111111111111111111111111111',
      });
      const text = result.content[0].text;

      expect(text).toContain('Leaderboard');
      expect(text).toContain('9500');
      expect(text).toContain('v3');
    });
  });

  // ────── challenge_score ──────────────────────────────────────────

  describe('handleChallengeScore', () => {
    it('returns error for invalid address', async () => {
      const result = await handleChallengeScore({ challengeAddress: 'bad' }, mockToolContext as any);
      expect(result.isError).toBe(true);
    });

    it('returns "not found" for missing challenge', async () => {
      vi.mocked(getChallengeByAddressQueries).mockReturnValue(null);

      const result = await handleChallengeScore(
        { challengeAddress: '0x1111111111111111111111111111111111111111' },
        mockToolContext as any,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Challenge not found');
    });

    it('returns "not submitted" when user has no submission', async () => {
      vi.mocked(getChallengeByAddressQueries).mockReturnValue(makeChallengeRecord());

      const result = await handleChallengeScore(
        { challengeAddress: '0x1111111111111111111111111111111111111111' },
        mockToolContext as any,
      );
      expect(result.content[0].text).toContain("haven't submitted");
    });

    it('shows score and rank when available', async () => {
      const myAddr = mockToolContext.walletAddress.toLowerCase();
      const challenge = makeChallengeRecord({
        submissions: {
          [myAddr]: makeSubmissionRecord({ submitter: myAddr, agentId: 42, score: 8500, version: 2 }),
        },
      });
      vi.mocked(getChallengeByAddressQueries).mockReturnValue(challenge);
      vi.mocked(getChallengeLeaderboardQueries).mockReturnValue([
        makeSubmissionRecord({ submitter: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', score: 9500 }),
        makeSubmissionRecord({ submitter: myAddr, score: 8500 }),
      ]);

      const result = await handleChallengeScore(
        { challengeAddress: '0x1111111111111111111111111111111111111111' },
        mockToolContext as any,
      );
      const text = result.content[0].text;

      expect(text).toContain('8500');
      expect(text).toContain('v2');
      expect(text).toContain('Rank');
    });

    it('shows "pending" when score is null', async () => {
      const myAddr = mockToolContext.walletAddress.toLowerCase();
      const challenge = makeChallengeRecord({
        submissions: {
          [myAddr]: makeSubmissionRecord({ submitter: myAddr, agentId: 42, score: null }),
        },
      });
      vi.mocked(getChallengeByAddressQueries).mockReturnValue(challenge);

      const result = await handleChallengeScore(
        { challengeAddress: '0x1111111111111111111111111111111111111111' },
        mockToolContext as any,
      );
      expect(result.content[0].text).toContain('Pending');
    });
  });

  // ────── challenge_submit (validation only) ───────────────────────

  describe('handleChallengeSubmit', () => {
    it('returns error for invalid challenge address', async () => {
      const result = await handleChallengeSubmit(
        { challengeAddress: 'invalid', solutionURI: 'https://example.com' },
        mockToolContext as any,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid challenge address');
    });

    it('returns error for empty solutionURI', async () => {
      const result = await handleChallengeSubmit(
        { challengeAddress: '0x1111111111111111111111111111111111111111', solutionURI: '' },
        mockToolContext as any,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Solution URI is required');
    });

    it('returns error when challenge is not open', async () => {
      vi.mocked(getChallengeByAddressQueries).mockReturnValue(
        makeChallengeRecord({ status: 'finalized' }),
      );

      const result = await handleChallengeSubmit(
        {
          challengeAddress: '0x1111111111111111111111111111111111111111',
          solutionURI: 'https://example.com/solution',
        },
        mockToolContext as any,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('finalized');
    });
  });

  // ────── challenge_claim (validation only) ────────────────────────

  describe('handleChallengeClaim', () => {
    it('returns error for invalid challenge address', async () => {
      const result = await handleChallengeClaim(
        { challengeAddress: 'bad' },
        mockToolContext as any,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid challenge address');
    });

    it('returns error when challenge is not finalized', async () => {
      vi.mocked(getChallengeByAddressQueries).mockReturnValue(
        makeChallengeRecord({ status: 'open' }),
      );

      const result = await handleChallengeClaim(
        { challengeAddress: '0x1111111111111111111111111111111111111111' },
        mockToolContext as any,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Prizes can only be claimed after finalization');
    });

    it('returns error when user is not a winner', async () => {
      vi.mocked(getChallengeByAddressQueries).mockReturnValue(
        makeChallengeRecord({
          status: 'finalized',
          winners: [
            {
              address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              agentId: 1,
              rank: 1,
              score: 9500,
              prizeAmount: '300000000',
              claimed: false,
            },
          ],
        }),
      );

      const result = await handleChallengeClaim(
        { challengeAddress: '0x1111111111111111111111111111111111111111' },
        mockToolContext as any,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not in the winner list');
    });

    it('returns message when prize already claimed', async () => {
      const myAddr = mockToolContext.walletAddress.toLowerCase();
      vi.mocked(getChallengeByAddressQueries).mockReturnValue(
        makeChallengeRecord({
          status: 'finalized',
          winners: [
            {
              address: myAddr,
              agentId: 42,
              rank: 1,
              score: 9500,
              prizeAmount: '300000000',
              claimed: true,
            },
          ],
        }),
      );

      const result = await handleChallengeClaim(
        { challengeAddress: '0x1111111111111111111111111111111111111111' },
        mockToolContext as any,
      );
      // Not an error — just informational
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('already claimed');
    });
  });
});
