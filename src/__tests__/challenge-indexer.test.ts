/**
 * Challenge Indexer Tests
 *
 * Tests the indexer query functions for the Challenge Bounties system.
 * Mocks the in-memory index (getIndex) to return controlled data.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BountyIndex, ChallengeRecord, SubmissionRecord, WinnerRecord } from '../indexer/types.js';

// ─── Mock the sync module to control getIndex() ─────────────────────
// The query functions all call getIndex() from ./sync.js internally.
vi.mock('../indexer/sync.js', () => ({
  getIndex: vi.fn(() => null),
  syncFromChain: vi.fn(),
  startPolling: vi.fn(),
  stopPolling: vi.fn(),
}));

import { getIndex } from '../indexer/sync.js';
import {
  getOpenChallenges,
  getChallengeByAddress,
  getChallengesByPoster,
  getChallengeLeaderboard,
  getAgentChallengeHistory,
  getAgentChallengeStats,
} from '../indexer/challenge-queries.js';

// ─── Test Fixtures ──────────────────────────────────────────────────

const USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';

function makeChallengeRecord(overrides: Partial<ChallengeRecord> = {}): ChallengeRecord {
  return {
    challengeAddress: '0x1111111111111111111111111111111111111111',
    poster: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    evaluator: '',
    token: USDC_ADDRESS,
    prizePool: '500000000', // 500 USDC (6 decimals)
    deadline: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 days from now
    scoringDeadline: Math.floor(Date.now() / 1000) + 86400 * 9,
    challengeURI: 'data:application/json;base64,' + Buffer.from(JSON.stringify({ title: 'Test Challenge' })).toString('base64'),
    evalConfigHash: '0x' + 'ab'.repeat(32),
    winnerCount: 3,
    payoutBps: [6000, 2500, 1500],
    skillTags: ['solidity', 'defi'],
    status: 'open',
    submissionCount: 0,
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

function makeWinnerRecord(overrides: Partial<WinnerRecord> = {}): WinnerRecord {
  return {
    address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    agentId: 1,
    rank: 1,
    score: 9500,
    prizeAmount: '300000000', // 300 USDC
    claimed: false,
    ...overrides,
  };
}

function makeIndex(challenges: Record<string, ChallengeRecord> = {}): BountyIndex {
  return {
    lastBlock: 5000,
    factoryAddress: '0x639a05560cf089187494f9ee357d7d1c69b7558e',
    identityRegistryAddress: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
    chainId: 8453,
    bounties: {},
    agents: {},
    challenges,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Challenge Indexer Queries', () => {
  const mockGetIndex = vi.mocked(getIndex);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ────── getOpenChallenges ────────────────────────────────────────

  describe('getOpenChallenges', () => {
    it('returns empty array when index is null', () => {
      mockGetIndex.mockReturnValue(null);
      expect(getOpenChallenges()).toEqual([]);
    });

    it('returns empty array when no challenges exist', () => {
      mockGetIndex.mockReturnValue(makeIndex());
      expect(getOpenChallenges()).toEqual([]);
    });

    it('returns only open challenges by default', () => {
      const open = makeChallengeRecord({ challengeAddress: '0x1111111111111111111111111111111111111111', status: 'open' });
      const scoring = makeChallengeRecord({ challengeAddress: '0x2222222222222222222222222222222222222222', status: 'scoring' });
      const finalized = makeChallengeRecord({ challengeAddress: '0x3333333333333333333333333333333333333333', status: 'finalized' });

      mockGetIndex.mockReturnValue(makeIndex({
        [open.challengeAddress]: open,
        [scoring.challengeAddress]: scoring,
        [finalized.challengeAddress]: finalized,
      }));

      const results = getOpenChallenges();
      expect(results).toHaveLength(1);
      expect(results[0].challengeAddress).toBe(open.challengeAddress);
    });

    it('filters by status when specified', () => {
      const open = makeChallengeRecord({ challengeAddress: '0x1111111111111111111111111111111111111111', status: 'open' });
      const scoring = makeChallengeRecord({ challengeAddress: '0x2222222222222222222222222222222222222222', status: 'scoring' });

      mockGetIndex.mockReturnValue(makeIndex({
        [open.challengeAddress]: open,
        [scoring.challengeAddress]: scoring,
      }));

      const results = getOpenChallenges({ status: 'scoring' });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('scoring');
    });

    it('filters by skill (case-insensitive, partial match)', () => {
      const solidityChallenge = makeChallengeRecord({
        challengeAddress: '0x1111111111111111111111111111111111111111',
        skillTags: ['solidity', 'gas-optimization'],
      });
      const reactChallenge = makeChallengeRecord({
        challengeAddress: '0x2222222222222222222222222222222222222222',
        skillTags: ['react', 'typescript'],
      });

      mockGetIndex.mockReturnValue(makeIndex({
        [solidityChallenge.challengeAddress]: solidityChallenge,
        [reactChallenge.challengeAddress]: reactChallenge,
      }));

      const results = getOpenChallenges({ skill: 'SOLIDITY' });
      expect(results).toHaveLength(1);
      expect(results[0].challengeAddress).toBe(solidityChallenge.challengeAddress);
    });

    it('filters by minPrize', () => {
      const smallPrize = makeChallengeRecord({
        challengeAddress: '0x1111111111111111111111111111111111111111',
        prizePool: '100000000', // 100 USDC
      });
      const bigPrize = makeChallengeRecord({
        challengeAddress: '0x2222222222222222222222222222222222222222',
        prizePool: '1000000000', // 1000 USDC
      });

      mockGetIndex.mockReturnValue(makeIndex({
        [smallPrize.challengeAddress]: smallPrize,
        [bigPrize.challengeAddress]: bigPrize,
      }));

      const results = getOpenChallenges({ minPrize: 500000000 });
      expect(results).toHaveLength(1);
      expect(results[0].challengeAddress).toBe(bigPrize.challengeAddress);
    });

    it('filters by maxPrize', () => {
      const smallPrize = makeChallengeRecord({
        challengeAddress: '0x1111111111111111111111111111111111111111',
        prizePool: '100000000',
      });
      const bigPrize = makeChallengeRecord({
        challengeAddress: '0x2222222222222222222222222222222222222222',
        prizePool: '1000000000',
      });

      mockGetIndex.mockReturnValue(makeIndex({
        [smallPrize.challengeAddress]: smallPrize,
        [bigPrize.challengeAddress]: bigPrize,
      }));

      const results = getOpenChallenges({ maxPrize: 500000000 });
      expect(results).toHaveLength(1);
      expect(results[0].challengeAddress).toBe(smallPrize.challengeAddress);
    });

    it('sorts by deadline ascending (soonest first)', () => {
      const now = Math.floor(Date.now() / 1000);
      const soonDeadline = makeChallengeRecord({
        challengeAddress: '0x1111111111111111111111111111111111111111',
        deadline: now + 3600,
      });
      const farDeadline = makeChallengeRecord({
        challengeAddress: '0x2222222222222222222222222222222222222222',
        deadline: now + 86400 * 30,
      });
      const midDeadline = makeChallengeRecord({
        challengeAddress: '0x3333333333333333333333333333333333333333',
        deadline: now + 86400 * 7,
      });

      mockGetIndex.mockReturnValue(makeIndex({
        [farDeadline.challengeAddress]: farDeadline,
        [soonDeadline.challengeAddress]: soonDeadline,
        [midDeadline.challengeAddress]: midDeadline,
      }));

      const results = getOpenChallenges();
      expect(results[0].challengeAddress).toBe(soonDeadline.challengeAddress);
      expect(results[1].challengeAddress).toBe(midDeadline.challengeAddress);
      expect(results[2].challengeAddress).toBe(farDeadline.challengeAddress);
    });

    it('respects limit parameter', () => {
      const challenges: Record<string, ChallengeRecord> = {};
      for (let i = 0; i < 20; i++) {
        const addr = `0x${i.toString(16).padStart(40, '0')}`;
        challenges[addr] = makeChallengeRecord({
          challengeAddress: addr,
          deadline: Math.floor(Date.now() / 1000) + 3600 * (i + 1),
        });
      }

      mockGetIndex.mockReturnValue(makeIndex(challenges));

      const results = getOpenChallenges({ limit: 5 });
      expect(results).toHaveLength(5);
    });
  });

  // ────── getChallengeByAddress ────────────────────────────────────

  describe('getChallengeByAddress', () => {
    it('returns null when index is null', () => {
      mockGetIndex.mockReturnValue(null);
      expect(getChallengeByAddress('0x1234')).toBeNull();
    });

    it('returns null for non-existent address', () => {
      mockGetIndex.mockReturnValue(makeIndex());
      expect(getChallengeByAddress('0x1234567890123456789012345678901234567890')).toBeNull();
    });

    it('returns challenge for valid address (case-insensitive)', () => {
      const challenge = makeChallengeRecord();
      mockGetIndex.mockReturnValue(makeIndex({
        [challenge.challengeAddress]: challenge,
      }));

      // Query with uppercase — function lowercases internally
      const result = getChallengeByAddress('0x1111111111111111111111111111111111111111');
      expect(result).not.toBeNull();
      expect(result!.challengeAddress).toBe(challenge.challengeAddress);
    });
  });

  // ────── getChallengesByPoster ────────────────────────────────────

  describe('getChallengesByPoster', () => {
    it('returns empty when no challenges by poster', () => {
      const challenge = makeChallengeRecord({ poster: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
      mockGetIndex.mockReturnValue(makeIndex({
        [challenge.challengeAddress]: challenge,
      }));

      const results = getChallengesByPoster('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      expect(results).toHaveLength(0);
    });

    it('returns challenges by a specific poster', () => {
      const poster = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const c1 = makeChallengeRecord({ challengeAddress: '0x1111111111111111111111111111111111111111', poster });
      const c2 = makeChallengeRecord({ challengeAddress: '0x2222222222222222222222222222222222222222', poster });
      const c3 = makeChallengeRecord({
        challengeAddress: '0x3333333333333333333333333333333333333333',
        poster: '0xcccccccccccccccccccccccccccccccccccccccc',
      });

      mockGetIndex.mockReturnValue(makeIndex({
        [c1.challengeAddress]: c1,
        [c2.challengeAddress]: c2,
        [c3.challengeAddress]: c3,
      }));

      const results = getChallengesByPoster(poster);
      expect(results).toHaveLength(2);
    });
  });

  // ────── getChallengeLeaderboard ──────────────────────────────────

  describe('getChallengeLeaderboard', () => {
    it('returns empty for non-existent challenge', () => {
      mockGetIndex.mockReturnValue(makeIndex());
      const results = getChallengeLeaderboard('0x0000000000000000000000000000000000000000');
      expect(results).toEqual([]);
    });

    it('returns submissions sorted by score descending when scored', () => {
      const addr = '0x1111111111111111111111111111111111111111';
      const sub1 = makeSubmissionRecord({ submitter: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', agentId: 1, score: 8000 });
      const sub2 = makeSubmissionRecord({ submitter: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', agentId: 2, score: 9500 });
      const sub3 = makeSubmissionRecord({ submitter: '0xcccccccccccccccccccccccccccccccccccccccc', agentId: 3, score: 7000 });

      const challenge = makeChallengeRecord({
        challengeAddress: addr,
        submissions: {
          [sub1.submitter]: sub1,
          [sub2.submitter]: sub2,
          [sub3.submitter]: sub3,
        },
        submissionCount: 3,
      });

      mockGetIndex.mockReturnValue(makeIndex({ [addr]: challenge }));

      const results = getChallengeLeaderboard(addr);
      expect(results).toHaveLength(3);
      expect(results[0].score).toBe(9500);
      expect(results[1].score).toBe(8000);
      expect(results[2].score).toBe(7000);
    });

    it('returns submissions sorted by version descending when unscored', () => {
      const addr = '0x1111111111111111111111111111111111111111';
      const sub1 = makeSubmissionRecord({ submitter: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', version: 3 });
      const sub2 = makeSubmissionRecord({ submitter: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', version: 1 });
      const sub3 = makeSubmissionRecord({ submitter: '0xcccccccccccccccccccccccccccccccccccccccc', version: 5 });

      const challenge = makeChallengeRecord({
        challengeAddress: addr,
        submissions: {
          [sub1.submitter]: sub1,
          [sub2.submitter]: sub2,
          [sub3.submitter]: sub3,
        },
        submissionCount: 3,
      });

      mockGetIndex.mockReturnValue(makeIndex({ [addr]: challenge }));

      const results = getChallengeLeaderboard(addr);
      expect(results).toHaveLength(3);
      expect(results[0].version).toBe(5);
      expect(results[1].version).toBe(3);
      expect(results[2].version).toBe(1);
    });

    it('respects limit parameter', () => {
      const addr = '0x1111111111111111111111111111111111111111';
      const submissions: Record<string, SubmissionRecord> = {};
      for (let i = 0; i < 10; i++) {
        const subAddr = `0x${i.toString(16).padStart(40, '0')}`;
        submissions[subAddr] = makeSubmissionRecord({
          submitter: subAddr,
          agentId: i,
          score: 1000 * (10 - i),
        });
      }

      const challenge = makeChallengeRecord({
        challengeAddress: addr,
        submissions,
        submissionCount: 10,
      });

      mockGetIndex.mockReturnValue(makeIndex({ [addr]: challenge }));

      const results = getChallengeLeaderboard(addr, 3);
      expect(results).toHaveLength(3);
    });
  });

  // ────── getAgentChallengeHistory ─────────────────────────────────

  describe('getAgentChallengeHistory', () => {
    it('returns empty for agent with no challenge participation', () => {
      const challenge = makeChallengeRecord();
      mockGetIndex.mockReturnValue(makeIndex({
        [challenge.challengeAddress]: challenge,
      }));

      const results = getAgentChallengeHistory(999);
      expect(results).toHaveLength(0);
    });

    it('returns all challenges agent participated in', () => {
      const addr1 = '0x1111111111111111111111111111111111111111';
      const addr2 = '0x2222222222222222222222222222222222222222';
      const sub = makeSubmissionRecord({ agentId: 42 });

      const c1 = makeChallengeRecord({
        challengeAddress: addr1,
        submissions: { [sub.submitter]: sub },
        submissionCount: 1,
      });
      const c2 = makeChallengeRecord({
        challengeAddress: addr2,
        submissions: { [sub.submitter]: { ...sub, version: 3 } },
        submissionCount: 1,
      });

      mockGetIndex.mockReturnValue(makeIndex({
        [addr1]: c1,
        [addr2]: c2,
      }));

      const results = getAgentChallengeHistory(42);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.challengeAddress).sort()).toEqual([addr1, addr2].sort());
    });

    it('includes winner info when agent is a winner', () => {
      const addr = '0x1111111111111111111111111111111111111111';
      const submitter = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const sub = makeSubmissionRecord({ submitter, agentId: 42 });
      const winner = makeWinnerRecord({ address: submitter, agentId: 42, rank: 1 });

      const challenge = makeChallengeRecord({
        challengeAddress: addr,
        status: 'finalized',
        submissions: { [submitter]: sub },
        winners: [winner],
        submissionCount: 1,
      });

      mockGetIndex.mockReturnValue(makeIndex({ [addr]: challenge }));

      const results = getAgentChallengeHistory(42);
      expect(results).toHaveLength(1);
      expect(results[0].winner).not.toBeNull();
      expect(results[0].winner!.rank).toBe(1);
    });
  });

  // ────── getAgentChallengeStats ───────────────────────────────────

  describe('getAgentChallengeStats', () => {
    it('returns zeroes for agent with no participation', () => {
      mockGetIndex.mockReturnValue(makeIndex());

      const stats = getAgentChallengeStats(999);
      expect(stats.entered).toBe(0);
      expect(stats.won).toBe(0);
      expect(stats.totalPrizeEarned).toBe('0');
      expect(stats.avgRank).toBe(0);
      expect(stats.bestRank).toBe(0);
    });

    it('aggregates stats across multiple challenges', () => {
      const submitter = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const agentId = 42;

      // Challenge 1: won 1st place, 300 USDC
      const c1 = makeChallengeRecord({
        challengeAddress: '0x1111111111111111111111111111111111111111',
        status: 'finalized',
        submissions: {
          [submitter]: makeSubmissionRecord({ submitter, agentId, score: 9500, rank: 1 }),
        },
        winners: [makeWinnerRecord({ address: submitter, agentId, rank: 1, prizeAmount: '300000000' })],
        submissionCount: 5,
      });

      // Challenge 2: won 3rd place, 75 USDC
      const c2 = makeChallengeRecord({
        challengeAddress: '0x2222222222222222222222222222222222222222',
        status: 'finalized',
        submissions: {
          [submitter]: makeSubmissionRecord({ submitter, agentId, score: 7000, rank: 3 }),
        },
        winners: [
          makeWinnerRecord({ address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', rank: 1, prizeAmount: '300000000' }),
          makeWinnerRecord({ address: '0xcccccccccccccccccccccccccccccccccccccccc', rank: 2, prizeAmount: '125000000' }),
          makeWinnerRecord({ address: submitter, agentId, rank: 3, prizeAmount: '75000000' }),
        ],
        submissionCount: 10,
      });

      // Challenge 3: participated but didn't win, ranked 5th (from submission.rank)
      const c3 = makeChallengeRecord({
        challengeAddress: '0x3333333333333333333333333333333333333333',
        status: 'finalized',
        submissions: {
          [submitter]: makeSubmissionRecord({ submitter, agentId, score: 3000, rank: 5 }),
        },
        winners: [
          makeWinnerRecord({ address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', rank: 1 }),
          makeWinnerRecord({ address: '0xcccccccccccccccccccccccccccccccccccccccc', rank: 2 }),
          makeWinnerRecord({ address: '0xdddddddddddddddddddddddddddddddddddddddd', rank: 3 }),
        ],
        submissionCount: 20,
      });

      mockGetIndex.mockReturnValue(makeIndex({
        [c1.challengeAddress]: c1,
        [c2.challengeAddress]: c2,
        [c3.challengeAddress]: c3,
      }));

      const stats = getAgentChallengeStats(agentId);
      expect(stats.entered).toBe(3);
      expect(stats.won).toBe(2);
      expect(stats.totalPrizeEarned).toBe('375000000'); // 300 + 75
      expect(stats.bestRank).toBe(1);
      // avgRank: winner ranks 1 and 3, plus submission rank 5 => (1+3+5)/3 = 3
      expect(stats.avgRank).toBe(3);
    });

    it('handles agent with no ranked submissions', () => {
      const submitter = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const agentId = 42;

      // Challenge where scores haven't been posted yet
      const c1 = makeChallengeRecord({
        challengeAddress: '0x1111111111111111111111111111111111111111',
        status: 'open',
        submissions: {
          [submitter]: makeSubmissionRecord({ submitter, agentId, score: null, rank: null }),
        },
        submissionCount: 3,
      });

      mockGetIndex.mockReturnValue(makeIndex({
        [c1.challengeAddress]: c1,
      }));

      const stats = getAgentChallengeStats(agentId);
      expect(stats.entered).toBe(1);
      expect(stats.won).toBe(0);
      expect(stats.avgRank).toBe(0);
      expect(stats.bestRank).toBe(0);
    });
  });
});
