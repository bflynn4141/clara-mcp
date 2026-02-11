/**
 * Bounty Event Sync Engine
 *
 * Fetches on-chain events from BountyFactory (BountyCreated) and
 * individual Bounty clones (lifecycle events) using viem getLogs.
 *
 * Runs as a background poller inside the MCP process:
 *   1. Initial catch-up from lastBlock → latest
 *   2. Background polling every 15 seconds
 *
 * Block range is chunked to stay within RPC limits (~10k blocks/request).
 */

import type { Hex, Log } from 'viem';
import { parseEventLogs } from 'viem';
import {
  getClaraPublicClient,
  getBountyContracts,
  getChallengeContracts,
  BOUNTY_FACTORY_EVENTS,
  BOUNTY_EVENTS,
  IDENTITY_REGISTRY_EVENTS,
  REPUTATION_REGISTRY_EVENTS,
  CHALLENGE_FACTORY_EVENTS,
  CHALLENGE_EVENTS,
  FACTORY_DEPLOY_BLOCK,
} from '../config/clara-contracts.js';
import { loadIndex, saveIndex } from './store.js';
import type { BountyIndex, BountyRecord, AgentRecord, FeedbackRecord, ChallengeRecord, WinnerRecord } from './types.js';
import { parseTaskURI } from '../tools/work-helpers.js';

/** Maximum block range per getLogs call (Base Sepolia safe limit) */
const MAX_BLOCK_RANGE = 10_000n;

/** In-memory index — loaded once, kept in sync */
let index: BountyIndex | null = null;

/** Polling interval handle */
let pollingTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Get the current in-memory index (readonly).
 * Returns null if indexer hasn't been initialized yet.
 */
export function getIndex(): BountyIndex | null {
  return index;
}

/**
 * Sync events from chain, updating the in-memory index and persisting to disk.
 *
 * Steps:
 * 1. Get current block number
 * 2. Fetch BountyCreated events from factory → create new BountyRecords
 * 3. Fetch lifecycle events from all known bounty clones → update status
 * 4. Checkpoint lastBlock and save
 */
export async function syncFromChain(): Promise<void> {
  const client = getClaraPublicClient();
  const { bountyFactory, identityRegistry, reputationRegistry } = getBountyContracts();
  const { challengeFactory } = getChallengeContracts();

  // Load from disk on first call
  if (!index) {
    index = loadIndex();
  }

  const latestBlock = await client.getBlockNumber();
  const fromBlock = BigInt(index.lastBlock) + 1n;

  // Nothing new
  if (fromBlock > latestBlock) return;

  // Process in chunks to respect RPC limits
  for (let chunkStart = fromBlock; chunkStart <= latestBlock; chunkStart += MAX_BLOCK_RANGE) {
    const chunkEnd = chunkStart + MAX_BLOCK_RANGE - 1n > latestBlock
      ? latestBlock
      : chunkStart + MAX_BLOCK_RANGE - 1n;

    // 1. Fetch BountyCreated events from factory
    const creationLogs = await client.getLogs({
      address: bountyFactory as Hex,
      events: BOUNTY_FACTORY_EVENTS,
      fromBlock: chunkStart,
      toBlock: chunkEnd,
    });

    for (const log of creationLogs) {
      const parsed = parseEventLogs({
        abi: BOUNTY_FACTORY_EVENTS,
        logs: [log],
      });

      for (const event of parsed) {
        if (event.eventName === 'BountyCreated') {
          const args = event.args as {
            bountyAddress: Hex;
            poster: Hex;
            token: Hex;
            amount: bigint;
            posterBond: bigint;
            bondRate: bigint;
            deadline: bigint;
            taskURI: string;
            skillTags: readonly string[];
          };

          const addr = args.bountyAddress.toLowerCase();
          if (!index.bounties[addr]) {
            index.bounties[addr] = {
              bountyAddress: addr,
              poster: args.poster.toLowerCase(),
              token: args.token.toLowerCase(),
              amount: args.amount.toString(),
              deadline: Number(args.deadline),
              taskURI: args.taskURI,
              skillTags: [...args.skillTags],
              status: 'open',
              createdBlock: Number(log.blockNumber),
              createdTxHash: log.transactionHash ?? '',
              posterBond: args.posterBond.toString(),
              bondRate: Number(args.bondRate),
            };
          }
        }
      }
    }

    // 2. Fetch lifecycle events from known bounty clones
    const bountyAddresses = Object.keys(index.bounties) as Hex[];
    if (bountyAddresses.length > 0) {
      const lifecycleLogs = await client.getLogs({
        address: bountyAddresses,
        events: BOUNTY_EVENTS,
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });

      for (const log of lifecycleLogs) {
        const bountyAddr = log.address.toLowerCase();
        const record = index.bounties[bountyAddr];
        if (!record) continue;

        const parsed = parseEventLogs({
          abi: BOUNTY_EVENTS,
          logs: [log],
        });

        for (const event of parsed) {
          applyLifecycleEvent(record, event, log);
        }
      }
    }

    // 3. Fetch Register + URIUpdated events from IdentityRegistry
    const identityLogs = await client.getLogs({
      address: identityRegistry as Hex,
      events: IDENTITY_REGISTRY_EVENTS,
      fromBlock: chunkStart,
      toBlock: chunkEnd,
    });

    for (const log of identityLogs) {
      const parsed = parseEventLogs({
        abi: IDENTITY_REGISTRY_EVENTS,
        logs: [log],
      });

      for (const event of parsed) {
        if (event.eventName === 'Register') {
          const args = event.args as {
            agentId: bigint;
            owner: Hex;
            agentURI: string;
          };

          const owner = args.owner.toLowerCase();
          if (!index.agents[owner]) {
            const metadata = parseTaskURI(args.agentURI);
            const record: AgentRecord = {
              agentId: Number(args.agentId),
              owner,
              agentURI: args.agentURI,
              name: (metadata?.name as string) || `Agent #${Number(args.agentId)}`,
              skills: (metadata?.skills as string[]) || [],
              description: metadata?.description as string | undefined,
              registeredBlock: Number(log.blockNumber),
              registeredTxHash: log.transactionHash ?? '',
            };
            index.agents[owner] = record;
            // Maintain secondary index by agentId
            if (!index.agentsById) index.agentsById = {};
            index.agentsById[String(args.agentId)] = record;
          }
        } else if (event.eventName === 'URIUpdated') {
          applyURIUpdated(index, event, log);
        }
      }
    }

    // 4. Fetch NewFeedback + FeedbackRevoked events from ReputationRegistry
    const reputationLogs = await client.getLogs({
      address: reputationRegistry as Hex,
      events: REPUTATION_REGISTRY_EVENTS,
      fromBlock: chunkStart,
      toBlock: chunkEnd,
    });

    for (const log of reputationLogs) {
      const parsed = parseEventLogs({
        abi: REPUTATION_REGISTRY_EVENTS,
        logs: [log],
      });

      for (const event of parsed) {
        if (event.eventName === 'NewFeedback') {
          applyNewFeedback(index, event, log);
        } else if (event.eventName === 'FeedbackRevoked') {
          applyFeedbackRevoked(index, event, log);
        }
      }
    }

    // 5. Fetch ChallengeCreated events from ChallengeFactory
    //    Skip if factory address is zero (not yet deployed)
    if (challengeFactory !== '0x0000000000000000000000000000000000000000') {
      if (!index.challenges) index.challenges = {};

      const challengeCreationLogs = await client.getLogs({
        address: challengeFactory as Hex,
        events: CHALLENGE_FACTORY_EVENTS,
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });

      for (const log of challengeCreationLogs) {
        const parsed = parseEventLogs({
          abi: CHALLENGE_FACTORY_EVENTS,
          logs: [log],
        });

        for (const event of parsed) {
          if (event.eventName === 'ChallengeCreated') {
            applyChallengeCreated(index, event, log);
          }
        }
      }

      // 6. Fetch lifecycle events from known challenge proxies
      const challengeAddresses = Object.keys(index.challenges) as Hex[];
      if (challengeAddresses.length > 0) {
        const challengeLifecycleLogs = await client.getLogs({
          address: challengeAddresses,
          events: CHALLENGE_EVENTS,
          fromBlock: chunkStart,
          toBlock: chunkEnd,
        });

        for (const log of challengeLifecycleLogs) {
          const challengeAddr = log.address.toLowerCase();
          const record = index.challenges[challengeAddr];
          if (!record) continue;

          const parsed = parseEventLogs({
            abi: CHALLENGE_EVENTS,
            logs: [log],
          });

          for (const event of parsed) {
            applyChallengeLifecycleEvent(record, event, log);
          }
        }
      }
    }

    // Checkpoint after each chunk
    index.lastBlock = Number(chunkEnd);
  }

  saveIndex(index);
}

/**
 * Apply a lifecycle event to a bounty record.
 */
function applyLifecycleEvent(
  record: BountyRecord,
  event: { eventName: string; args: Record<string, unknown> },
  log: Log,
): void {
  const blockNum = Number(log.blockNumber);
  record.updatedBlock = blockNum;

  switch (event.eventName) {
    case 'BountyClaimed': {
      const args = event.args as { claimer: Hex; agentId: bigint };
      record.status = 'claimed';
      record.claimer = args.claimer.toLowerCase();
      record.claimerAgentId = Number(args.agentId);
      break;
    }
    case 'WorkSubmitted': {
      const args = event.args as { claimer: Hex; proofURI: string };
      record.status = 'submitted';
      record.proofURI = args.proofURI;
      break;
    }
    case 'BountyApproved': {
      record.status = 'approved';
      break;
    }
    case 'BountyExpired': {
      record.status = 'expired';
      break;
    }
    case 'BountyCancelled': {
      record.status = 'cancelled';
      break;
    }
    case 'BountyRejected': {
      const args = event.args as { poster: Hex; claimer: Hex; rejectionCount: number };
      const count = Number(args.rejectionCount);
      record.rejectionCount = count;
      record.status = count >= 2 ? 'resolved' : 'rejected';
      break;
    }
    case 'AutoApproved': {
      record.status = 'approved';
      break;
    }
  }
}

/**
 * Apply a URIUpdated event — re-parse agentURI and update the AgentRecord.
 */
function applyURIUpdated(
  idx: BountyIndex,
  event: { eventName: string; args: Record<string, unknown> },
  log: Log,
): void {
  const args = event.args as {
    agentId: bigint;
    newURI: string;
    updatedBy: Hex;
  };

  const agentIdStr = String(args.agentId);
  const agent = idx.agentsById?.[agentIdStr];
  if (!agent) return; // Agent not yet indexed (registered before our start block)

  const metadata = parseTaskURI(args.newURI);
  agent.agentURI = args.newURI;
  agent.name = (metadata?.name as string) || agent.name;
  agent.skills = (metadata?.skills as string[]) || agent.skills;
  agent.description = (metadata?.description as string | undefined) ?? agent.description;
  agent.uriUpdatedBlock = Number(log.blockNumber);
}

/**
 * Apply a NewFeedback event — create FeedbackRecord and recalculate reputation.
 */
function applyNewFeedback(
  idx: BountyIndex,
  event: { eventName: string; args: Record<string, unknown> },
  log: Log,
): void {
  const args = event.args as {
    agentId: bigint;
    clientAddress: Hex;
    feedbackIndex: bigint;
    value: bigint;
    valueDecimals: number;
    tag1: string;
    tag2: string;
    endpoint: string;
    feedbackURI: string;
    feedbackHash: Hex;
  };

  if (!idx.feedbacks) idx.feedbacks = {};

  const key = `${args.agentId}-${args.feedbackIndex}`;
  if (idx.feedbacks[key]) return; // Already indexed

  idx.feedbacks[key] = {
    agentId: Number(args.agentId),
    clientAddress: args.clientAddress.toLowerCase(),
    feedbackIndex: Number(args.feedbackIndex),
    value: Number(args.value),
    valueDecimals: Number(args.valueDecimals),
    tag1: args.tag1,
    tag2: args.tag2,
    feedbackURI: args.feedbackURI,
    feedbackHash: args.feedbackHash,
    block: Number(log.blockNumber),
    txHash: log.transactionHash ?? '',
    revoked: false,
  };

  recalcAgentReputation(idx, Number(args.agentId));
}

/**
 * Apply a FeedbackRevoked event — mark feedback as revoked and recalculate reputation.
 */
function applyFeedbackRevoked(
  idx: BountyIndex,
  event: { eventName: string; args: Record<string, unknown> },
  _log: Log,
): void {
  const args = event.args as {
    agentId: bigint;
    clientAddress: Hex;
    feedbackIndex: bigint;
  };

  if (!idx.feedbacks) return;

  const key = `${args.agentId}-${args.feedbackIndex}`;
  const feedback = idx.feedbacks[key];
  if (feedback && !feedback.revoked) {
    feedback.revoked = true;
    recalcAgentReputation(idx, Number(args.agentId));
  }
}

/**
 * Recalculate cached reputation fields on the AgentRecord
 * by scanning all non-revoked feedbacks for the given agentId.
 */
function recalcAgentReputation(idx: BountyIndex, agentId: number): void {
  const agent = idx.agentsById?.[String(agentId)];
  if (!agent) return;

  const feedbacks = idx.feedbacks ?? {};
  let count = 0;
  let sum = 0;

  for (const fb of Object.values(feedbacks)) {
    if (fb.agentId === agentId && !fb.revoked) {
      const divisor = 10 ** fb.valueDecimals;
      sum += fb.value / divisor;
      count++;
    }
  }

  agent.reputationCount = count;
  agent.reputationSum = sum;
  agent.reputationAvg = count > 0 ? sum / count : 0;
}

// ─── Challenge Event Application Functions ──────────────────────────

/**
 * Apply a ChallengeCreated event — create a new ChallengeRecord.
 */
function applyChallengeCreated(
  idx: BountyIndex,
  event: { eventName: string; args: Record<string, unknown> },
  log: Log,
): void {
  const args = event.args as {
    challenge: Hex;
    poster: Hex;
    token: Hex;
    prizePool: bigint;
    posterBond: bigint;
    deadline: bigint;
    scoringDeadline: bigint;
    challengeURI: string;
    skillTags: readonly string[];
  };

  if (!idx.challenges) idx.challenges = {};

  const addr = args.challenge.toLowerCase();
  if (!idx.challenges[addr]) {
    idx.challenges[addr] = {
      challengeAddress: addr,
      poster: args.poster.toLowerCase(),
      evaluator: '',  // Not in event — readable from contract getter
      token: args.token.toLowerCase(),
      prizePool: args.prizePool.toString(),
      deadline: Number(args.deadline),
      scoringDeadline: Number(args.scoringDeadline),
      challengeURI: args.challengeURI,
      evalConfigHash: '',   // Not in event — readable from contract getter
      winnerCount: 0,       // Not in event — readable from contract getter
      payoutBps: [],        // Not in event — readable from contract getter
      skillTags: [...args.skillTags],
      status: 'open',
      submissionCount: 0,
      privateSetHash: '',
      maxParticipants: 0,
      scorePostedAt: null,
      submissions: {},
      winners: [],
      createdBlock: Number(log.blockNumber),
      createdTxHash: log.transactionHash ?? '',
      updatedBlock: Number(log.blockNumber),
      posterBond: args.posterBond.toString(),
    };
  }
}

/**
 * Apply a lifecycle event to a challenge record.
 */
function applyChallengeLifecycleEvent(
  record: ChallengeRecord,
  event: { eventName: string; args: Record<string, unknown> },
  log: Log,
): void {
  const blockNum = Number(log.blockNumber);
  record.updatedBlock = blockNum;

  switch (event.eventName) {
    case 'SubmissionReceived': {
      const args = event.args as {
        submitter: Hex;
        agentId: bigint;
        version: bigint;
        solutionHash: Hex;
      };
      const submitter = args.submitter.toLowerCase();
      const isNew = !record.submissions[submitter];

      record.submissions[submitter] = {
        submitter,
        agentId: Number(args.agentId),
        solutionURI: '',  // Not in event — agent fetches from contract if needed
        solutionHash: args.solutionHash,
        submittedAt: 0,   // Approximate from block; exact from contract
        version: Number(args.version),
        score: null,
        rank: null,
      };

      if (isNew) {
        record.submissionCount++;
      }
      break;
    }
    case 'ScoresPosted': {
      // Event only emits (address indexed challenge, uint256 winnerCountPosted).
      // Winner details (accounts, scores, prizeAmounts) are stored on-chain via
      // Challenge.winners(index) — we don't have them from the event alone.
      // Mark status and scorePostedAt; winner data is populated lazily by
      // challenge_detail/challenge_leaderboard tools reading the contract directly.
      record.status = 'scoring';
      record.scorePostedAt = blockNum; // Block number as proxy for timestamp
      break;
    }
    case 'PrizeClaimed': {
      const args = event.args as {
        winner: Hex;
        rank: bigint;
        amount: bigint;
      };
      const winnerAddr = args.winner.toLowerCase();
      const winner = record.winners.find(w => w.address === winnerAddr);
      if (winner) {
        winner.claimed = true;
      }
      break;
    }
    case 'ChallengeFinalized': {
      record.status = 'finalized';
      break;
    }
    case 'ChallengeExpired': {
      record.status = 'expired';
      break;
    }
    case 'ChallengeCancelled': {
      record.status = 'cancelled';
      break;
    }
  }
}

/**
 * Start background polling at the given interval.
 */
export function startPolling(intervalMs: number): void {
  if (pollingTimer) return; // Already running

  pollingTimer = setInterval(async () => {
    try {
      await syncFromChain();
    } catch (error) {
      console.error('[indexer] Sync error:', error instanceof Error ? error.message : error);
    }
  }, intervalMs);
}

/**
 * Stop background polling (for cleanup/testing).
 */
export function stopPolling(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}
