/**
 * Bounty Indexer Types
 *
 * Data structures for the embedded event indexer that tracks
 * on-chain bounty lifecycle from BountyFactory + Bounty clone events.
 */

/** Mirrors the Solidity Bounty.Status enum (0-7) */
export type BountyStatus = 'open' | 'claimed' | 'submitted' | 'approved' | 'expired' | 'cancelled' | 'rejected' | 'resolved';

/** Maps Solidity enum index → string status */
export const STATUS_MAP: Record<number, BountyStatus> = {
  0: 'open',
  1: 'claimed',
  2: 'submitted',
  3: 'approved',
  4: 'expired',
  5: 'cancelled',
  6: 'rejected',
  7: 'resolved',
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
  /** Poster bond amount (raw bigint string) */
  posterBond?: string;
  /** Worker bond amount (raw bigint string) */
  workerBond?: string;
  /** Bond rate in basis points (1000 = 10%) */
  bondRate?: number;
  /** Number of times the submission has been rejected (0, 1, or 2) */
  rejectionCount?: number;
  /** Unix timestamp of the most recent work submission */
  submittedAt?: number;
}

/**
 * A registered agent tracked by the indexer.
 *
 * Created from IdentityRegistry Register events.
 * The agentURI is parsed to extract name, skills, description.
 */
export interface AgentRecord {
  /** ERC-8004 token ID */
  agentId: number;
  /** Wallet address that owns this agent NFT (lowercase) */
  owner: string;
  /** Raw agentURI (data: URI with metadata) */
  agentURI: string;
  /** Parsed from agentURI */
  name: string;
  /** Parsed from agentURI */
  skills: string[];
  /** Parsed from agentURI */
  description?: string;
  /** Block number where Register was emitted */
  registeredBlock: number;
  /** Transaction hash of the registration */
  registeredTxHash: string;
  /** Cached reputation: number of non-revoked feedbacks */
  reputationCount?: number;
  /** Cached reputation: sum of rating values */
  reputationSum?: number;
  /** Cached reputation: average rating (reputationSum / reputationCount) */
  reputationAvg?: number;
  /** Block number of the most recent URIUpdated event */
  uriUpdatedBlock?: number;
}

/**
 * A feedback record from the ReputationRegistry.
 *
 * Created from NewFeedback events, marked revoked on FeedbackRevoked.
 * Keyed by "{agentId}-{feedbackIndex}" in the index.
 */
export interface FeedbackRecord {
  /** ERC-8004 agent token ID that received the feedback */
  agentId: number;
  /** Address of the client who gave the feedback (lowercase) */
  clientAddress: string;
  /** Sequential index within this agent's feedback history */
  feedbackIndex: number;
  /** Rating value (e.g. 5 for 5-star) */
  value: number;
  /** Decimal places for the value (e.g. 0 means integer, 1 means /10) */
  valueDecimals: number;
  /** Primary category tag (e.g. "bounty") */
  tag1: string;
  /** Secondary tag (e.g. "completed") */
  tag2: string;
  /** Feedback content URI (IPFS hash or data URI) */
  feedbackURI: string;
  /** Hash of the feedback content */
  feedbackHash: string;
  /** Block number where NewFeedback was emitted */
  block: number;
  /** Transaction hash */
  txHash: string;
  /** Whether this feedback was revoked */
  revoked: boolean;
}

/**
 * Persisted index state — checkpoint + all tracked bounties and agents.
 */
export interface BountyIndex {
  /** Last synced block number (for incremental sync) */
  lastBlock: number;
  /** Factory address this index was built from */
  factoryAddress: string;
  /** IdentityRegistry address this index was built from */
  identityRegistryAddress: string;
  /** ReputationRegistry address this index was built from */
  reputationRegistryAddress?: string;
  /** Chain ID (84532 = Base Sepolia, 8453 = Base) */
  chainId: number;
  /** All bounties keyed by lowercase bountyAddress */
  bounties: Record<string, BountyRecord>;
  /** All agents keyed by lowercase owner address */
  agents: Record<string, AgentRecord>;
  /** All feedbacks keyed by "{agentId}-{feedbackIndex}" */
  feedbacks?: Record<string, FeedbackRecord>;
  /** Secondary index: agents keyed by agentId (string). Same object refs as `agents`. */
  agentsById?: Record<string, AgentRecord>;
}
