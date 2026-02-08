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
} from './queries.js';
export type { BountyFilter, IndexStats } from './queries.js';
export type { BountyRecord, BountyIndex, BountyStatus } from './types.js';

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
