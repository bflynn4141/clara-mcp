/**
 * Bounty Indexer Types
 *
 * Data structures for the embedded event indexer that tracks
 * on-chain bounty lifecycle from BountyFactory + Bounty clone events.
 */

/** Mirrors the Solidity Bounty.Status enum (0-5) */
export type BountyStatus = 'open' | 'claimed' | 'submitted' | 'approved' | 'expired' | 'cancelled';

/** Maps Solidity enum index → string status */
export const STATUS_MAP: Record<number, BountyStatus> = {
  0: 'open',
  1: 'claimed',
  2: 'submitted',
  3: 'approved',
  4: 'expired',
  5: 'cancelled',
};

/**
 * A single bounty tracked by the indexer.
 *
 * Created from BountyCreated event, updated by lifecycle events
 * (BountyClaimed, WorkSubmitted, BountyApproved, BountyExpired, BountyCancelled).
 */
export interface BountyRecord {
  /** Clone proxy address (lowercase) */
  bountyAddress: string;
  /** Address that posted and funded the bounty */
  poster: string;
  /** ERC-20 token used for payment */
  token: string;
  /** Raw amount as string (bigint serialization) */
  amount: string;
  /** Unix timestamp (seconds) — bounty expires after this */
  deadline: number;
  /** data:application/json;base64,... or IPFS hash */
  taskURI: string;
  /** Skill tags for discoverability */
  skillTags: string[];
  /** Current lifecycle status */
  status: BountyStatus;
  /** Address that claimed the bounty (set on BountyClaimed) */
  claimer?: string;
  /** ERC-8004 agent token ID of claimer */
  claimerAgentId?: number;
  /** Proof of work URI (set on WorkSubmitted) */
  proofURI?: string;
  /** Block number where BountyCreated was emitted */
  createdBlock: number;
  /** Transaction hash of the creation */
  createdTxHash: string;
  /** Block number of the most recent status change */
  updatedBlock?: number;
}

/**
 * Persisted index state — checkpoint + all tracked bounties.
 */
export interface BountyIndex {
  /** Last synced block number (for incremental sync) */
  lastBlock: number;
  /** Factory address this index was built from */
  factoryAddress: string;
  /** Chain ID (84532 = Base Sepolia, 8453 = Base) */
  chainId: number;
  /** All bounties keyed by lowercase bountyAddress */
  bounties: Record<string, BountyRecord>;
}
