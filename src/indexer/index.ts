/**
 * Bounty Indexer — Public API
 *
 * Initializes the embedded event indexer and exports query functions
 * for use by work_* tools.
 */

export { syncFromChain, startPolling, stopPolling, getIndex } from './sync.js';
export {
  getOpenBounties,
  getBountyByAddress,
  getBountyByTxHash,
  getBountiesByPoster,
  getBountiesByClaimer,
  getIndexStats,
  getAgentByAddress,
  getAgentByAgentId,
  findAgents,
  getFeedbacksByAgentId,
  getFeedbacksByClient,
  getReputationSummary,
} from './queries.js';
export type { BountyFilter, IndexStats, AgentFilter, ReputationSummary } from './queries.js';
export type { BountyRecord, BountyIndex, BountyStatus, AgentRecord, FeedbackRecord, ChallengeRecord, ChallengeStatus, SubmissionRecord, WinnerRecord } from './types.js';
export {
  getOpenChallenges,
  getChallengeByAddress,
  getChallengesByPoster,
  getChallengeLeaderboard,
  getAgentChallengeHistory,
  getAgentChallengeStats,
} from './challenge-queries.js';
export type { ChallengeFilter, ChallengeParticipation, AgentChallengeStats } from './challenge-queries.js';

import { syncFromChain, startPolling } from './sync.js';

/**
 * Initialize the bounty indexer:
 * 1. Catch-up sync from last checkpoint to latest block
 * 2. Start background polling every 15 seconds
 *
 * Non-blocking on failure — tools return empty results if sync fails.
 */
export async function initIndexer(): Promise<void> {
  await syncFromChain();
  startPolling(15_000);
  console.error('[indexer] Bounty indexer started (polling every 15s)');
}
