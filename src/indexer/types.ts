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

// ─── Challenge Types ────────────────────────────────────────────────

/** Mirrors the Solidity Challenge.ChallengeStatus enum (0-4) */
export type ChallengeStatus = 'open' | 'scoring' | 'finalized' | 'cancelled' | 'expired';

/** Maps Solidity enum index → string status */
export const CHALLENGE_STATUS_MAP: Record<number, ChallengeStatus> = {
  0: 'open',
  1: 'scoring',
  2: 'finalized',
  3: 'cancelled',
  4: 'expired',
};

/**
 * A single challenge tracked by the indexer.
 *
 * Created from ChallengeCreated event, updated by lifecycle events
 * (SubmissionReceived, ScoresPosted, ChallengeFinalized, ChallengeExpired, ChallengeCancelled).
 */
export interface ChallengeRecord {
  /** Challenge proxy address (lowercase) */
  challengeAddress: string;
  /** Address that created and funded the challenge */
  poster: string;
  /** ERC-20 token used for prize pool */
  token: string;
  /** Total prize pool as string (bigint serialization) */
  prizePool: string;
  /** Unix timestamp (seconds) — submission deadline */
  deadline: number;
  /** Unix timestamp (seconds) — poster must post scores by this time */
  scoringDeadline: number;
  /** Problem statement (data URI or IPFS hash) */
  challengeURI: string;
  /** keccak256 of evaluation config */
  evalConfigHash: string;
  /** Number of winners that get paid (1-25) */
  winnerCount: number;
  /** Basis points per rank (e.g. [6000, 2500, 1500]) */
  payoutBps: number[];
  /** Skill tags for discoverability */
  skillTags: string[];
  /** Current lifecycle status */
  status: ChallengeStatus;
  /** Total number of unique submitters */
  submissionCount: number;
  /** keccak256 of private evaluation parameters */
  privateSetHash: string;
  /** Maximum number of unique submitters (0 = unlimited) */
  maxParticipants: number;
  /** Unix timestamp when scores were posted (null if not yet) */
  scorePostedAt: number | null;

  /** Submissions keyed by submitter address (lowercase) */
  submissions: Record<string, SubmissionRecord>;
  /** Winners populated after finalization */
  winners: WinnerRecord[];

  /** Block number where ChallengeCreated was emitted */
  createdBlock: number;
  /** Transaction hash of the creation */
  createdTxHash: string;
  /** Block number of the most recent status change */
  updatedBlock: number;
  /** Poster bond amount (raw bigint string) */
  posterBond?: string;
}

/**
 * A submission to a challenge tracked by the indexer.
 *
 * Created/updated from SubmissionReceived events.
 * Scores populated from ScoresPosted events.
 */
export interface SubmissionRecord {
  /** Address that submitted (lowercase) */
  submitter: string;
  /** ERC-8004 agent token ID */
  agentId: number;
  /** Pointer to solution (URL, data URI, IPFS) */
  solutionURI: string;
  /** keccak256 of solution content */
  solutionHash: string;
  /** Unix timestamp of latest submission */
  submittedAt: number;
  /** Submission version (increments on resubmit) */
  version: number;
  /** Score from evaluation (null until scoring) */
  score: number | null;
  /** Rank in final results (null until scoring) */
  rank: number | null;
}

/**
 * A winner of a challenge.
 *
 * Populated from ScoresPosted event data.
 */
export interface WinnerRecord {
  /** Winner's address (lowercase) */
  address: string;
  /** ERC-8004 agent token ID */
  agentId: number;
  /** Rank (1-based: 1st, 2nd, 3rd...) */
  rank: number;
  /** Final score on private evaluation set */
  score: number;
  /** Prize amount as string (bigint serialization) */
  prizeAmount: string;
  /** Whether the prize has been claimed */
  claimed: boolean;
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
  /** All challenges keyed by lowercase challengeAddress */
  challenges?: Record<string, ChallengeRecord>;
}
