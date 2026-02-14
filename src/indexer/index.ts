/**
 * Bounty Indexer — Public API
 *
 * Routes queries to either the shared Ponder indexer (when CLARA_USE_PONDER=true)
 * or the embedded in-memory indexer (legacy fallback).
 *
 * All consumers import from this barrel — the routing is transparent.
 */

import type { BountyRecord, BountyIndex, BountyStatus, AgentRecord, FeedbackRecord, ChallengeRecord, ChallengeStatus, SubmissionRecord, WinnerRecord } from './types.js';
export type { BountyRecord, BountyIndex, BountyStatus, AgentRecord, FeedbackRecord, ChallengeRecord, ChallengeStatus, SubmissionRecord, WinnerRecord } from './types.js';

// ─── Feature Flag ────────────────────────────────────────────────────

const USE_PONDER = process.env.CLARA_USE_PONDER === 'true';

// ─── Ponder Client (lazy import to avoid loading when unused) ────────

let _ponder: typeof import('./client.js') | null = null;

async function getPonderClient() {
  if (!_ponder) {
    _ponder = await import('./client.js');
  }
  return _ponder;
}

// ─── Legacy Embedded Indexer ─────────────────────────────────────────

import {
  syncFromChain as _syncFromChain,
  startPolling as _startPolling,
  stopPolling as _stopPolling,
  getIndex as _getIndex,
} from './sync.js';

import {
  getOpenBounties as _getOpenBounties,
  getBountyByAddress as _getBountyByAddress,
  getBountyByTxHash as _getBountyByTxHash,
  getBountiesByPoster as _getBountiesByPoster,
  getBountiesByClaimer as _getBountiesByClaimer,
  getIndexStats as _getIndexStats,
  getAgentByAddress as _getAgentByAddress,
  getAgentByAgentId as _getAgentByAgentId,
  findAgents as _findAgents,
  getFeedbacksByAgentId as _getFeedbacksByAgentId,
  getFeedbacksByClient as _getFeedbacksByClient,
  getReputationSummary as _getReputationSummary,
} from './queries.js';

import {
  getOpenChallenges as _getOpenChallenges,
  getChallengeByAddress as _getChallengeByAddress,
  getChallengesByPoster as _getChallengesByPoster,
  getChallengeLeaderboard as _getChallengeLeaderboard,
  getAgentChallengeHistory as _getAgentChallengeHistory,
  getAgentChallengeStats as _getAgentChallengeStats,
} from './challenge-queries.js';

export type { BountyFilter, IndexStats, AgentFilter, ReputationSummary } from './queries.js';
export type { ChallengeFilter, ChallengeParticipation, AgentChallengeStats } from './challenge-queries.js';

// ─── Sync / Polling (embedded only) ─────────────────────────────────

export const syncFromChain = _syncFromChain;
export const startPolling = _startPolling;
export const stopPolling = _stopPolling;
export const getIndex = _getIndex;

// ─── Routed Query Functions ──────────────────────────────────────────

export async function getOpenBounties(filters?: { status?: BountyStatus; skill?: string; limit?: number }): Promise<BountyRecord[]> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    return client.ponderGetOpenBounties(filters);
  }
  return _getOpenBounties(filters);
}

export async function getBountyByAddress(address: string): Promise<BountyRecord | null> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    return client.ponderGetBountyByAddress(address);
  }
  return _getBountyByAddress(address);
}

export async function getBountyByTxHash(txHash: string): Promise<BountyRecord | null> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    return client.ponderGetBountyByTxHash(txHash);
  }
  return _getBountyByTxHash(txHash);
}

export async function getBountiesByPoster(poster: string): Promise<BountyRecord[]> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    return client.ponderGetBountiesByPoster(poster);
  }
  return _getBountiesByPoster(poster);
}

export async function getBountiesByClaimer(claimer: string): Promise<BountyRecord[]> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    return client.ponderGetBountiesByClaimer(claimer);
  }
  return _getBountiesByClaimer(claimer);
}

export async function getAgentByAddress(address: string): Promise<AgentRecord | null> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    return client.ponderGetAgentByAddress(address);
  }
  return _getAgentByAddress(address);
}

export async function getAgentByAgentId(agentId: number): Promise<AgentRecord | null> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    return client.ponderGetAgentByAgentId(agentId);
  }
  return _getAgentByAgentId(agentId);
}

export async function findAgents(filters?: { skill?: string; limit?: number }): Promise<AgentRecord[]> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    return client.ponderFindAgents(filters);
  }
  return _findAgents(filters);
}

export async function getFeedbacksByAgentId(agentId: number, includeRevoked = false): Promise<FeedbackRecord[]> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    return client.ponderGetFeedbacksByAgentId(agentId, includeRevoked);
  }
  return _getFeedbacksByAgentId(agentId, includeRevoked);
}

export function getFeedbacksByClient(clientAddress: string): FeedbackRecord[] {
  // Ponder doesn't have a by-client endpoint yet; use embedded indexer
  return _getFeedbacksByClient(clientAddress);
}

export async function getReputationSummary(agentId: number): Promise<{ count: number; averageRating: number; totalValue: number } | null> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    return client.ponderGetReputationSummary(agentId);
  }
  return _getReputationSummary(agentId);
}

export async function getIndexStats(): Promise<{ totalBounties: number; openCount: number; claimedCount: number; submittedCount: number; approvedCount: number; expiredCount: number; cancelledCount: number; rejectedCount: number; resolvedCount: number; lastSyncedBlock: number }> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    return client.ponderGetIndexStats();
  }
  return _getIndexStats();
}

// ─── Challenge Queries ───────────────────────────────────────────────

export async function getOpenChallenges(filters?: { status?: ChallengeStatus; skill?: string; limit?: number }): Promise<ChallengeRecord[]> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    return client.ponderGetOpenChallenges(filters);
  }
  return _getOpenChallenges(filters);
}

export async function getChallengeByAddress(address: string): Promise<ChallengeRecord | null> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    return client.ponderGetChallengeByAddress(address);
  }
  return _getChallengeByAddress(address);
}

export async function getChallengesByPoster(poster: string): Promise<ChallengeRecord[]> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    return client.ponderGetChallengesByPoster(poster);
  }
  return _getChallengesByPoster(poster);
}

export async function getChallengeLeaderboard(address: string, limit?: number): Promise<SubmissionRecord[]> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    return client.ponderGetChallengeLeaderboard(address, limit);
  }
  return _getChallengeLeaderboard(address, limit);
}

export async function getAgentChallengeHistory(agentId: number): Promise<any[]> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    return client.ponderGetAgentChallengeHistory(agentId);
  }
  return _getAgentChallengeHistory(agentId);
}

export async function getAgentChallengeStats(agentId: number): Promise<{ entered: number; won: number; totalPrizeEarned: string; avgRank: number; bestRank: number }> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    return client.ponderGetAgentChallengeStats(agentId);
  }
  return _getAgentChallengeStats(agentId);
}

// ─── Post-Mutation Helper ────────────────────────────────────────────

/**
 * Wait for a transaction to be indexed by the shared indexer.
 * Falls back to syncFromChain() if using embedded indexer.
 */
export async function awaitIndexed(txHash: string): Promise<boolean> {
  if (USE_PONDER) {
    const client = await getPonderClient();
    const result = await client.awaitIndexed(txHash);
    return result?.status === 'indexed';
  }
  // Embedded indexer: just sync to catch the latest block
  await syncFromChain();
  return true;
}

// ─── Init ────────────────────────────────────────────────────────────

/**
 * Initialize the indexer.
 * In Ponder mode: verify connectivity.
 * In embedded mode: sync from chain + start polling.
 */
export async function initIndexer(): Promise<void> {
  if (USE_PONDER) {
    try {
      const client = await getPonderClient();
      const stats = await client.ponderGetIndexStats();
      console.error(`[indexer] Ponder connected (${stats.totalBounties} bounties, ${stats.openCount} open)`);
    } catch (e) {
      console.error(`[indexer] Ponder connection failed, falling back to embedded: ${e}`);
      // Don't throw — tools will retry or return empty
    }
    return;
  }

  // Legacy embedded indexer
  await _syncFromChain();
  _startPolling(15_000);
  console.error('[indexer] Embedded indexer started (polling every 15s)');
}
