/**
 * Bounty Index Queries
 *
 * Read functions that the work_* tools call directly.
 * All reads come from the in-memory index (sub-millisecond).
 * Returns empty results if the indexer hasn't synced yet.
 */

import type { AgentRecord, BountyRecord, BountyStatus } from './types.js';
import { getIndex } from './sync.js';

export interface BountyFilter {
  status?: BountyStatus;
  skill?: string;
  minAmount?: number;
  maxAmount?: number;
  limit?: number;
}

/**
 * Get all bounties from the index as an array.
 * Returns empty array if indexer hasn't initialized.
 */
function allBounties(): BountyRecord[] {
  const index = getIndex();
  if (!index) return [];
  return Object.values(index.bounties);
}

/**
 * Get bounties matching the given filters.
 * Default: open bounties, sorted by deadline ascending (soonest first).
 */
export function getOpenBounties(filters?: BountyFilter): BountyRecord[] {
  const status = filters?.status ?? 'open';
  const limit = filters?.limit ?? 50;

  let results = allBounties().filter((b) => b.status === status);

  if (filters?.skill) {
    const skill = filters.skill.toLowerCase();
    results = results.filter((b) =>
      b.skillTags.some((t) => t.toLowerCase().includes(skill)),
    );
  }

  if (filters?.minAmount !== undefined) {
    const min = BigInt(Math.floor(filters.minAmount));
    results = results.filter((b) => BigInt(b.amount) >= min);
  }

  if (filters?.maxAmount !== undefined) {
    const max = BigInt(Math.floor(filters.maxAmount));
    results = results.filter((b) => BigInt(b.amount) <= max);
  }

  // Sort by deadline ascending (soonest-expiring first)
  results.sort((a, b) => a.deadline - b.deadline);

  return results.slice(0, limit);
}

/**
 * Look up a single bounty by its contract address.
 */
export function getBountyByAddress(address: string): BountyRecord | null {
  const index = getIndex();
  if (!index) return null;
  return index.bounties[address.toLowerCase()] ?? null;
}

/**
 * Get all bounties posted by a specific address.
 */
export function getBountiesByPoster(poster: string): BountyRecord[] {
  const addr = poster.toLowerCase();
  return allBounties().filter((b) => b.poster === addr);
}

/**
 * Get all bounties claimed by a specific address.
 */
export function getBountiesByClaimer(claimer: string): BountyRecord[] {
  const addr = claimer.toLowerCase();
  return allBounties().filter((b) => b.claimer === addr);
}

/**
 * Look up a bounty by its creation transaction hash.
 * Used by work_post to find the newly created bounty address.
 */
export function getBountyByTxHash(txHash: string): BountyRecord | null {
  const hash = txHash.toLowerCase();
  return allBounties().find((b) => b.createdTxHash.toLowerCase() === hash) ?? null;
}

/**
 * Summary stats about the indexed bounties.
 */
export interface IndexStats {
  totalBounties: number;
  openCount: number;
  claimedCount: number;
  submittedCount: number;
  approvedCount: number;
  expiredCount: number;
  cancelledCount: number;
  lastSyncedBlock: number;
}

export function getIndexStats(): IndexStats {
  const index = getIndex();
  const all = allBounties();

  const counts = { open: 0, claimed: 0, submitted: 0, approved: 0, expired: 0, cancelled: 0 };
  for (const b of all) {
    if (b.status in counts) {
      counts[b.status]++;
    }
  }

  return {
    totalBounties: all.length,
    openCount: counts.open,
    claimedCount: counts.claimed,
    submittedCount: counts.submitted,
    approvedCount: counts.approved,
    expiredCount: counts.expired,
    cancelledCount: counts.cancelled,
    lastSyncedBlock: index?.lastBlock ?? 0,
  };
}

// ─── Agent Queries ──────────────────────────────────────────────────

/**
 * Get all agents from the index as an array.
 * Returns empty array if indexer hasn't initialized.
 */
function allAgents(): AgentRecord[] {
  const index = getIndex();
  if (!index) return [];
  return Object.values(index.agents);
}

/**
 * Look up an agent by their wallet address.
 */
export function getAgentByAddress(address: string): AgentRecord | null {
  const index = getIndex();
  if (!index) return null;
  return index.agents[address.toLowerCase()] ?? null;
}

/**
 * Look up an agent by their ERC-8004 agentId.
 */
export function getAgentByAgentId(agentId: number): AgentRecord | null {
  return allAgents().find((a) => a.agentId === agentId) ?? null;
}

export interface AgentFilter {
  skill?: string;
  limit?: number;
}

/**
 * Search agents with optional filters.
 * Default: all agents, sorted by agentId ascending.
 */
export function findAgents(filters?: AgentFilter): AgentRecord[] {
  const limit = filters?.limit ?? 50;
  let results = allAgents();

  if (filters?.skill) {
    const skill = filters.skill.toLowerCase();
    results = results.filter((a) =>
      a.skills.some((s) => s.toLowerCase().includes(skill)),
    );
  }

  // Sort by agentId ascending (oldest first)
  results.sort((a, b) => a.agentId - b.agentId);

  return results.slice(0, limit);
}
