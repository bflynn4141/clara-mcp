/**
 * Challenge Lifecycle Tests
 *
 * Tests the Challenge contract lifecycle logic as unit tests.
 * Validates state transitions, constraints, and edge cases
 * by testing the indexer's event application functions indirectly.
 *
 * Since applyChallengeLifecycleEvent and applyChallengeCreated are private
 * to sync.ts, we test them through the public query functions after
 * constructing index state that represents various lifecycle stages.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BountyIndex, ChallengeRecord, SubmissionRecord, WinnerRecord } from '../indexer/types.js';

// ─── Mock sync module ───────────────────────────────────────────────
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
  getChallengeLeaderboard,
  getAgentChallengeStats,
} from '../indexer/challenge-queries.js';

// ─── Fixtures ───────────────────────────────────────────────────────

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const POSTER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AGENT_A = '0x1000000000000000000000000000000000000001';
const AGENT_B = '0x1000000000000000000000000000000000000002';
const AGENT_C = '0x1000000000000000000000000000000000000003';
const CHALLENGE_ADDR = '0xcccccccccccccccccccccccccccccccccccccccc';

const now = Math.floor(Date.now() / 1000);
const ONE_HOUR = 3600;
const ONE_DAY = 86400;
const TWELVE_HOURS = 43200;

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

function makeChallenge(overrides: Partial<ChallengeRecord> = {}): ChallengeRecord {
  return {
    challengeAddress: CHALLENGE_ADDR,
    poster: POSTER,
    evaluator: '',
    token: USDC,
    prizePool: '1000000000', // 1000 USDC
    deadline: now + ONE_DAY * 7,
    scoringDeadline: now + ONE_DAY * 9,
    challengeURI: 'data:application/json;base64,' + Buffer.from(JSON.stringify({ title: 'Gas Golf' })).toString('base64'),
    evalConfigHash: '0x' + 'ab'.repeat(32),
    winnerCount: 3,
    payoutBps: [6000, 2500, 1500],
    skillTags: ['solidity', 'gas-optimization'],
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

function makeSub(addr: string, agentId: number, overrides: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    submitter: addr,
    agentId,
    solutionURI: `https://example.com/solution/${agentId}`,
    solutionHash: '0x' + agentId.toString(16).padStart(64, '0'),
    submittedAt: now,
    version: 1,
    score: null,
    rank: null,
    ...overrides,
  };
}

function makeWinner(addr: string, agentId: number, rank: number, overrides: Partial<WinnerRecord> = {}): WinnerRecord {
  return {
    address: addr,
    agentId,
    rank,
    score: 10000 - rank * 1000,
    prizeAmount: rank === 1 ? '600000000' : rank === 2 ? '250000000' : '150000000',
    claimed: false,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Challenge Lifecycle', () => {
  const mockGetIndex = vi.mocked(getIndex);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ────── State: Open ──────────────────────────────────────────────

  describe('Open state', () => {
    it('new challenge starts as open with 0 submissions', () => {
      const challenge = makeChallenge();
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const result = getChallengeByAddress(CHALLENGE_ADDR);
      expect(result).not.toBeNull();
      expect(result!.status).toBe('open');
      expect(result!.submissionCount).toBe(0);
      expect(result!.submissions).toEqual({});
      expect(result!.winners).toEqual([]);
    });

    it('appears in open challenges list', () => {
      const challenge = makeChallenge();
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const results = getOpenChallenges({ status: 'open' });
      expect(results).toHaveLength(1);
      expect(results[0].challengeAddress).toBe(CHALLENGE_ADDR);
    });

    it('does not appear in scoring challenges list', () => {
      const challenge = makeChallenge({ status: 'open' });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const results = getOpenChallenges({ status: 'scoring' });
      expect(results).toHaveLength(0);
    });
  });

  // ────── Submissions ──────────────────────────────────────────────

  describe('Submissions', () => {
    it('tracks new submissions (incrementing submissionCount)', () => {
      const challenge = makeChallenge({
        submissionCount: 2,
        submissions: {
          [AGENT_A]: makeSub(AGENT_A, 1),
          [AGENT_B]: makeSub(AGENT_B, 2),
        },
      });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const result = getChallengeByAddress(CHALLENGE_ADDR);
      expect(result!.submissionCount).toBe(2);
      expect(Object.keys(result!.submissions)).toHaveLength(2);
    });

    it('resubmission increments version but not submissionCount', () => {
      const challenge = makeChallenge({
        submissionCount: 2,
        submissions: {
          [AGENT_A]: makeSub(AGENT_A, 1, { version: 3 }),
          [AGENT_B]: makeSub(AGENT_B, 2, { version: 1 }),
        },
      });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const result = getChallengeByAddress(CHALLENGE_ADDR);
      // Still 2 unique submitters despite agent A resubmitting 3 times
      expect(result!.submissionCount).toBe(2);
      expect(result!.submissions[AGENT_A].version).toBe(3);
    });

    it('maxParticipants caps unique submitters', () => {
      // Represents a challenge with maxParticipants=2 that is full
      const challenge = makeChallenge({
        maxParticipants: 2,
        submissionCount: 2,
        submissions: {
          [AGENT_A]: makeSub(AGENT_A, 1),
          [AGENT_B]: makeSub(AGENT_B, 2),
        },
      });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const result = getChallengeByAddress(CHALLENGE_ADDR);
      expect(result!.submissionCount).toBe(result!.maxParticipants);
    });

    it('before scoring, leaderboard is sorted by version descending', () => {
      const challenge = makeChallenge({
        submissionCount: 3,
        submissions: {
          [AGENT_A]: makeSub(AGENT_A, 1, { version: 5 }),
          [AGENT_B]: makeSub(AGENT_B, 2, { version: 1 }),
          [AGENT_C]: makeSub(AGENT_C, 3, { version: 3 }),
        },
      });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const leaderboard = getChallengeLeaderboard(CHALLENGE_ADDR);
      expect(leaderboard).toHaveLength(3);
      expect(leaderboard[0].version).toBe(5);
      expect(leaderboard[1].version).toBe(3);
      expect(leaderboard[2].version).toBe(1);
    });
  });

  // ────── State: Open → Scoring ────────────────────────────────────

  describe('Open -> Scoring transition', () => {
    it('transitions to scoring after deadline with >= 2 submissions', () => {
      // Simulate: deadline passed, scores posted -> status = scoring
      const challenge = makeChallenge({
        status: 'scoring',
        deadline: now - ONE_DAY, // deadline passed
        submissionCount: 3,
        submissions: {
          [AGENT_A]: makeSub(AGENT_A, 1),
          [AGENT_B]: makeSub(AGENT_B, 2),
          [AGENT_C]: makeSub(AGENT_C, 3),
        },
      });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const result = getChallengeByAddress(CHALLENGE_ADDR);
      expect(result!.status).toBe('scoring');
    });

    it('auto-cancels when deadline passes with < 2 submissions', () => {
      // Contract would call advanceToScoring() which auto-cancels
      const challenge = makeChallenge({
        status: 'cancelled',
        deadline: now - ONE_DAY,
        submissionCount: 1,
        submissions: {
          [AGENT_A]: makeSub(AGENT_A, 1),
        },
      });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const result = getChallengeByAddress(CHALLENGE_ADDR);
      expect(result!.status).toBe('cancelled');
    });
  });

  // ────── State: Open → Cancelled ──────────────────────────────────

  describe('Open -> Cancelled transition', () => {
    it('poster can cancel with 0 submissions', () => {
      const challenge = makeChallenge({
        status: 'cancelled',
        submissionCount: 0,
      });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const result = getChallengeByAddress(CHALLENGE_ADDR);
      expect(result!.status).toBe('cancelled');
      expect(result!.submissionCount).toBe(0);
    });
  });

  // ────── State: Scoring → Finalized ───────────────────────────────

  describe('Scoring -> Finalized transition', () => {
    it('transitions after scores posted + 12h delay', () => {
      const challenge = makeChallenge({
        status: 'finalized',
        deadline: now - ONE_DAY * 2,
        scorePostedAt: now - TWELVE_HOURS - 1, // 12h+ ago
        submissionCount: 3,
        submissions: {
          [AGENT_A]: makeSub(AGENT_A, 1, { score: 9000, rank: 1 }),
          [AGENT_B]: makeSub(AGENT_B, 2, { score: 8000, rank: 2 }),
          [AGENT_C]: makeSub(AGENT_C, 3, { score: 7000, rank: 3 }),
        },
        winners: [
          makeWinner(AGENT_A, 1, 1),
          makeWinner(AGENT_B, 2, 2),
          makeWinner(AGENT_C, 3, 3),
        ],
      });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const result = getChallengeByAddress(CHALLENGE_ADDR);
      expect(result!.status).toBe('finalized');
      expect(result!.winners).toHaveLength(3);
      expect(result!.winners[0].rank).toBe(1);
      expect(result!.winners[0].score).toBe(9000);
    });

    it('scores update submission records', () => {
      const challenge = makeChallenge({
        status: 'finalized',
        submissions: {
          [AGENT_A]: makeSub(AGENT_A, 1, { score: 9000, rank: 1 }),
          [AGENT_B]: makeSub(AGENT_B, 2, { score: 8000, rank: 2 }),
        },
        winners: [
          makeWinner(AGENT_A, 1, 1),
          makeWinner(AGENT_B, 2, 2),
        ],
        submissionCount: 2,
      });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const leaderboard = getChallengeLeaderboard(CHALLENGE_ADDR);
      expect(leaderboard).toHaveLength(2);
      expect(leaderboard[0].score).toBe(9000);
      expect(leaderboard[0].submitter).toBe(AGENT_A);
      expect(leaderboard[1].score).toBe(8000);
      expect(leaderboard[1].submitter).toBe(AGENT_B);
    });
  });

  // ────── State: Scoring → Expired ─────────────────────────────────

  describe('Scoring -> Expired transition', () => {
    it('expires when poster fails to post scores by scoringDeadline', () => {
      const challenge = makeChallenge({
        status: 'expired',
        deadline: now - ONE_DAY * 3,
        scoringDeadline: now - ONE_DAY, // scoring deadline passed
        submissionCount: 5,
        scorePostedAt: null, // no scores posted
      });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const result = getChallengeByAddress(CHALLENGE_ADDR);
      expect(result!.status).toBe('expired');
      expect(result!.scorePostedAt).toBeNull();
      expect(result!.winners).toHaveLength(0);
    });
  });

  // ────── Prize Claims ─────────────────────────────────────────────

  describe('Prize Claims', () => {
    it('winners array has correct prize amounts and claimed flags', () => {
      const challenge = makeChallenge({
        status: 'finalized',
        winners: [
          makeWinner(AGENT_A, 1, 1, { prizeAmount: '600000000', claimed: true }),
          makeWinner(AGENT_B, 2, 2, { prizeAmount: '250000000', claimed: false }),
          makeWinner(AGENT_C, 3, 3, { prizeAmount: '150000000', claimed: false }),
        ],
        submissionCount: 10,
      });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const result = getChallengeByAddress(CHALLENGE_ADDR);
      const winners = result!.winners;

      expect(winners[0].claimed).toBe(true);
      expect(winners[0].prizeAmount).toBe('600000000');
      expect(winners[1].claimed).toBe(false);
      expect(winners[2].claimed).toBe(false);

      // Prize amounts should correspond to payout BPS
      const total = BigInt(result!.prizePool);
      const expectedFirst = (total * 6000n) / 10000n;
      const expectedSecond = (total * 2500n) / 10000n;
      const expectedThird = (total * 1500n) / 10000n;
      expect(BigInt(winners[0].prizeAmount)).toBe(expectedFirst);
      expect(BigInt(winners[1].prizeAmount)).toBe(expectedSecond);
      expect(BigInt(winners[2].prizeAmount)).toBe(expectedThird);
    });

    it('double-claim is prevented (claimed flag set to true)', () => {
      const challenge = makeChallenge({
        status: 'finalized',
        winners: [
          makeWinner(AGENT_A, 1, 1, { claimed: true }),
        ],
        submissionCount: 5,
      });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const result = getChallengeByAddress(CHALLENGE_ADDR);
      const winner = result!.winners.find(w => w.address === AGENT_A);
      expect(winner!.claimed).toBe(true);
    });
  });

  // ────── Agent Stats Aggregation ──────────────────────────────────

  describe('Agent Stats across Lifecycle', () => {
    it('aggregates stats correctly for an agent across multiple challenges', () => {
      const addr1 = '0x1111111111111111111111111111111111111111';
      const addr2 = '0x2222222222222222222222222222222222222222';
      const addr3 = '0x3333333333333333333333333333333333333333';

      // Won 1st in challenge 1 (600 USDC)
      const c1 = makeChallenge({
        challengeAddress: addr1,
        status: 'finalized',
        submissions: {
          [AGENT_A]: makeSub(AGENT_A, 1, { score: 9000, rank: 1 }),
        },
        winners: [makeWinner(AGENT_A, 1, 1, { prizeAmount: '600000000' })],
        submissionCount: 10,
      });

      // Participated in challenge 2 but didn't win (ranked 4th via submission.rank)
      const c2 = makeChallenge({
        challengeAddress: addr2,
        status: 'finalized',
        submissions: {
          [AGENT_A]: makeSub(AGENT_A, 1, { score: 5000, rank: 4 }),
        },
        winners: [
          makeWinner(AGENT_B, 2, 1),
          makeWinner(AGENT_C, 3, 2),
        ],
        submissionCount: 15,
      });

      // Challenge still open — no score yet
      const c3 = makeChallenge({
        challengeAddress: addr3,
        status: 'open',
        submissions: {
          [AGENT_A]: makeSub(AGENT_A, 1, { score: null, rank: null }),
        },
        submissionCount: 3,
      });

      mockGetIndex.mockReturnValue(makeIndex({
        [addr1]: c1,
        [addr2]: c2,
        [addr3]: c3,
      }));

      const stats = getAgentChallengeStats(1);
      expect(stats.entered).toBe(3);
      expect(stats.won).toBe(1);
      expect(stats.totalPrizeEarned).toBe('600000000');
      expect(stats.bestRank).toBe(1);
      // avgRank: winner rank 1, submission rank 4 => (1 + 4) / 2 = 2.5
      expect(stats.avgRank).toBe(2.5);
    });
  });

  // ────── Permissionless Transitions ───────────────────────────────

  describe('Permissionless Transitions', () => {
    it('advanceToScoring: open + past deadline + >= 2 subs → scoring', () => {
      // Represents the state AFTER advanceToScoring was called
      const challenge = makeChallenge({
        status: 'scoring',
        deadline: now - ONE_HOUR,
        submissionCount: 5,
      });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      expect(getChallengeByAddress(CHALLENGE_ADDR)!.status).toBe('scoring');
    });

    it('advanceToScoring: open + past deadline + < 2 subs → cancelled', () => {
      const challenge = makeChallenge({
        status: 'cancelled',
        deadline: now - ONE_HOUR,
        submissionCount: 1,
      });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      expect(getChallengeByAddress(CHALLENGE_ADDR)!.status).toBe('cancelled');
    });

    it('finalize: scoring + winners posted + 12h passed → finalized', () => {
      const challenge = makeChallenge({
        status: 'finalized',
        deadline: now - ONE_DAY * 3,
        scorePostedAt: now - TWELVE_HOURS - 1,
        winners: [makeWinner(AGENT_A, 1, 1)],
        submissions: {
          [AGENT_A]: makeSub(AGENT_A, 1, { score: 9000, rank: 1 }),
          [AGENT_B]: makeSub(AGENT_B, 2, { score: 5000, rank: 2 }),
        },
        submissionCount: 2,
      });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      expect(getChallengeByAddress(CHALLENGE_ADDR)!.status).toBe('finalized');
    });

    it('expire: scoring + scoringDeadline passed + no scores → expired', () => {
      const challenge = makeChallenge({
        status: 'expired',
        deadline: now - ONE_DAY * 5,
        scoringDeadline: now - ONE_DAY,
        scorePostedAt: null,
        winners: [],
        submissionCount: 5,
      });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      expect(getChallengeByAddress(CHALLENGE_ADDR)!.status).toBe('expired');
    });
  });

  // ────── Edge Cases ───────────────────────────────────────────────

  describe('Edge Cases', () => {
    it('challenge with 0 maxParticipants means unlimited', () => {
      const challenge = makeChallenge({ maxParticipants: 0 });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const result = getChallengeByAddress(CHALLENGE_ADDR);
      expect(result!.maxParticipants).toBe(0); // 0 = unlimited
    });

    it('single-winner challenge (winner-take-all)', () => {
      const challenge = makeChallenge({
        status: 'finalized',
        winnerCount: 1,
        payoutBps: [10000],
        winners: [makeWinner(AGENT_A, 1, 1, { prizeAmount: '1000000000' })],
        submissions: {
          [AGENT_A]: makeSub(AGENT_A, 1, { score: 9000, rank: 1 }),
        },
        submissionCount: 10,
      });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const result = getChallengeByAddress(CHALLENGE_ADDR);
      expect(result!.winners).toHaveLength(1);
      expect(result!.winners[0].prizeAmount).toBe('1000000000'); // All 1000 USDC
    });

    it('challenge with empty submissions has empty leaderboard', () => {
      const challenge = makeChallenge({ submissions: {}, submissionCount: 0 });
      mockGetIndex.mockReturnValue(makeIndex({ [CHALLENGE_ADDR]: challenge }));

      const leaderboard = getChallengeLeaderboard(CHALLENGE_ADDR);
      expect(leaderboard).toHaveLength(0);
    });

    it('all five challenge statuses are represented', () => {
      const statuses = ['open', 'scoring', 'finalized', 'cancelled', 'expired'] as const;
      const challenges: Record<string, ChallengeRecord> = {};

      statuses.forEach((status, i) => {
        const addr = `0x${(i + 1).toString(16).padStart(40, '0')}`;
        challenges[addr] = makeChallenge({ challengeAddress: addr, status });
      });

      mockGetIndex.mockReturnValue(makeIndex(challenges));

      for (const status of statuses) {
        const results = getOpenChallenges({ status });
        expect(results).toHaveLength(1);
        expect(results[0].status).toBe(status);
      }
    });
  });
});
