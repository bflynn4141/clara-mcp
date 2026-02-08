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
  BOUNTY_FACTORY_EVENTS,
  BOUNTY_EVENTS,
  IDENTITY_REGISTRY_EVENTS,
  FACTORY_DEPLOY_BLOCK,
} from '../config/clara-contracts.js';
import { loadIndex, saveIndex } from './store.js';
import type { BountyIndex, BountyRecord, AgentRecord } from './types.js';
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
  const { bountyFactory, identityRegistry } = getBountyContracts();

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

    // 3. Fetch Register events from IdentityRegistry
    const registerLogs = await client.getLogs({
      address: identityRegistry as Hex,
      events: IDENTITY_REGISTRY_EVENTS,
      fromBlock: chunkStart,
      toBlock: chunkEnd,
    });

    for (const log of registerLogs) {
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
            index.agents[owner] = {
              agentId: Number(args.agentId),
              owner,
              agentURI: args.agentURI,
              name: (metadata?.name as string) || `Agent #${Number(args.agentId)}`,
              skills: (metadata?.skills as string[]) || [],
              description: metadata?.description as string | undefined,
              registeredBlock: Number(log.blockNumber),
              registeredTxHash: log.transactionHash ?? '',
            };
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
