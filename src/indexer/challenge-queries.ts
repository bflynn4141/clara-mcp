/**
 * Challenge Index Queries
 *
 * Read functions that the challenge_* tools call directly.
 * All reads come from the in-memory index (sub-millisecond).
 * Returns empty results if the indexer hasn't synced yet.
 */

import type { ChallengeRecord, ChallengeStatus, SubmissionRecord, WinnerRecord } from './types.js';
import { getIndex } from './sync.js';

export interface ChallengeFilter {
  status?: ChallengeStatus;
  skill?: string;
  minPrize?: number;
  maxPrize?: number;
  limit?: number;
}

/**
 * Get all challenges from the index as an array.
 * Returns empty array if indexer hasn't initialized or no challenges exist.
 */
function allChallenges(): ChallengeRecord[] {
  const index = getIndex();
  if (!index?.challenges) return [];
  return Object.values(index.challenges);
}

/**
 * Get challenges matching the given filters.
 * Default: open challenges, sorted by deadline ascending (soonest first).
 */
export function getOpenChallenges(filters?: ChallengeFilter): ChallengeRecord[] {
  const status = filters?.status ?? 'open';
  const limit = filters?.limit ?? 50;

  let results = allChallenges().filter((c) => c.status === status);

  if (filters?.skill) {
    const skill = filters.skill.toLowerCase();
    results = results.filter((c) =>
      c.skillTags.some((t) => t.toLowerCase().includes(skill)),
    );
  }

  if (filters?.minPrize !== undefined) {
    const min = BigInt(Math.floor(filters.minPrize));
    results = results.filter((c) => BigInt(c.prizePool) >= min);
  }

  if (filters?.maxPrize !== undefined) {
    const max = BigInt(Math.floor(filters.maxPrize));
    results = results.filter((c) => BigInt(c.prizePool) <= max);
  }

  // Sort by deadline ascending (soonest-ending first)
  results.sort((a, b) => a.deadline - b.deadline);

  return results.slice(0, limit);
}

/**
 * Look up a single challenge by its contract address.
 */
export function getChallengeByAddress(address: string): ChallengeRecord | null {
  const index = getIndex();
  if (!index?.challenges) return null;
  return index.challenges[address.toLowerCase()] ?? null;
}

/**
 * Get all challenges created by a specific poster address.
 */
export function getChallengesByPoster(poster: string): ChallengeRecord[] {
  const addr = poster.toLowerCase();
  return allChallenges().filter((c) => c.poster === addr);
}

/**
 * Get the leaderboard for a challenge — submissions sorted by score descending.
 * Only includes submissions that have been scored (score !== null).
 * Falls back to all submissions sorted by version descending if no scores yet.
 */
export function getChallengeLeaderboard(
  address: string,
  limit = 20,
): SubmissionRecord[] {
  const challenge = getChallengeByAddress(address);
  if (!challenge) return [];

  const subs = Object.values(challenge.submissions);

  // If scores are posted, sort by score descending
  const scored = subs.filter((s) => s.score !== null);
  if (scored.length > 0) {
    scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return scored.slice(0, limit);
  }

  // Before scoring: return by version descending (most active first)
  subs.sort((a, b) => b.version - a.version);
  return subs.slice(0, limit);
}

/**
 * Participation summary for an agent in challenges.
 */
export interface ChallengeParticipation {
  challengeAddress: string;
  challengeURI: string;
  status: ChallengeStatus;
  submission: SubmissionRecord;
  winner: WinnerRecord | null;
}

/**
 * Get all challenges an agent (by agentId) has participated in.
 */
export function getAgentChallengeHistory(agentId: number): ChallengeParticipation[] {
  const results: ChallengeParticipation[] = [];

  for (const challenge of allChallenges()) {
    for (const sub of Object.values(challenge.submissions)) {
      if (sub.agentId === agentId) {
        const winner = challenge.winners.find(
          (w) => w.address === sub.submitter,
        ) ?? null;

        results.push({
          challengeAddress: challenge.challengeAddress,
          challengeURI: challenge.challengeURI,
          status: challenge.status,
          submission: sub,
          winner,
        });
        break; // One participation per challenge
      }
    }
  }

  return results;
}

/**
 * Aggregate stats for an agent across all challenges.
 */
export interface AgentChallengeStats {
  entered: number;
  won: number;
  totalPrizeEarned: string;
  avgRank: number;
  bestRank: number;
}

export function getAgentChallengeStats(agentId: number): AgentChallengeStats {
  const history = getAgentChallengeHistory(agentId);

  let won = 0;
  let totalPrize = 0n;
  let rankSum = 0;
  let rankCount = 0;
  let bestRank = Infinity;

  for (const h of history) {
    if (h.winner) {
      won++;
      totalPrize += BigInt(h.winner.prizeAmount);
      rankSum += h.winner.rank;
      rankCount++;
      if (h.winner.rank < bestRank) {
        bestRank = h.winner.rank;
      }
    } else if (h.submission.rank !== null) {
      rankSum += h.submission.rank;
      rankCount++;
      if (h.submission.rank < bestRank) {
        bestRank = h.submission.rank;
      }
    }
  }

  return {
    entered: history.length,
    won,
    totalPrizeEarned: totalPrize.toString(),
    avgRank: rankCount > 0 ? rankSum / rankCount : 0,
    bestRank: bestRank === Infinity ? 0 : bestRank,
  };
}
