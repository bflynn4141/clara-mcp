/**
 * Tests for sync engine (src/indexer/sync.ts)
 *
 * Covers: getIndex, syncFromChain (event parsing, chunking, incremental sync,
 * edge cases), startPolling, stopPolling.
 *
 * Mocking strategy:
 * - Mock `../config/clara-contracts.js` for public client, factory address, ABIs, deploy block
 * - Mock `./store.js` for loadIndex/saveIndex (no disk I/O)
 * - Use vi.resetModules() between tests to reset module-level `index` and `pollingTimer`
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Hex, Log } from 'viem';
import type { BountyIndex, BountyRecord } from '../../indexer/types.js';

// ─── Mocked dependencies ─────────────────────────────────────────────

const mockGetLogs = vi.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([]);
const mockGetBlockNumber = vi.fn<() => Promise<bigint>>().mockResolvedValue(200n);

/**
 * Mock viem's parseEventLogs. The real function takes raw log objects
 * (with topics/data) and decodes them. Since our mock getLogs returns
 * pre-decoded objects (with eventName and args already set), we mock
 * parseEventLogs to pass them through as-is.
 */
vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
  return {
    ...actual,
    parseEventLogs: ({ logs }: { abi: any; logs: any[] }) => {
      // Our mock logs already have eventName + args — return them directly
      return logs;
    },
  };
});

vi.mock('../../config/clara-contracts.js', () => {
  // Import real ABIs so parseEventLogs works correctly
  const BOUNTY_FACTORY_EVENTS = [
    {
      type: 'event' as const,
      name: 'BountyCreated',
      inputs: [
        { name: 'bountyAddress', type: 'address', indexed: true },
        { name: 'poster', type: 'address', indexed: true },
        { name: 'token', type: 'address', indexed: false },
        { name: 'amount', type: 'uint256', indexed: false },
        { name: 'posterBond', type: 'uint256', indexed: false },
        { name: 'bondRate', type: 'uint256', indexed: false },
        { name: 'deadline', type: 'uint256', indexed: false },
        { name: 'taskURI', type: 'string', indexed: false },
        { name: 'skillTags', type: 'string[]', indexed: false },
      ],
    },
  ] as const;

  const BOUNTY_EVENTS = [
    {
      type: 'event' as const,
      name: 'BountyClaimed',
      inputs: [
        { name: 'claimer', type: 'address', indexed: true },
        { name: 'agentId', type: 'uint256', indexed: false },
      ],
    },
    {
      type: 'event' as const,
      name: 'WorkSubmitted',
      inputs: [
        { name: 'claimer', type: 'address', indexed: true },
        { name: 'proofURI', type: 'string', indexed: false },
      ],
    },
    {
      type: 'event' as const,
      name: 'BountyApproved',
      inputs: [
        { name: 'claimer', type: 'address', indexed: true },
        { name: 'amount', type: 'uint256', indexed: false },
      ],
    },
    {
      type: 'event' as const,
      name: 'BountyExpired',
      inputs: [
        { name: 'poster', type: 'address', indexed: true },
        { name: 'amount', type: 'uint256', indexed: false },
      ],
    },
    {
      type: 'event' as const,
      name: 'BountyCancelled',
      inputs: [
        { name: 'poster', type: 'address', indexed: true },
        { name: 'amount', type: 'uint256', indexed: false },
      ],
    },
    {
      type: 'event' as const,
      name: 'BountyRejected',
      inputs: [
        { name: 'poster', type: 'address', indexed: true },
        { name: 'claimer', type: 'address', indexed: true },
        { name: 'rejectionCount', type: 'uint8', indexed: false },
      ],
    },
    {
      type: 'event' as const,
      name: 'AutoApproved',
      inputs: [
        { name: 'claimer', type: 'address', indexed: true },
        { name: 'amount', type: 'uint256', indexed: false },
      ],
    },
  ] as const;

  const IDENTITY_REGISTRY_EVENTS = [
    {
      type: 'event' as const,
      name: 'Register',
      inputs: [
        { name: 'agentId', type: 'uint256', indexed: true },
        { name: 'owner', type: 'address', indexed: true },
        { name: 'agentURI', type: 'string', indexed: false },
      ],
    },
    {
      type: 'event' as const,
      name: 'URIUpdated',
      inputs: [
        { name: 'agentId', type: 'uint256', indexed: true },
        { name: 'newURI', type: 'string', indexed: false },
        { name: 'updatedBy', type: 'address', indexed: true },
      ],
    },
  ] as const;

  const REPUTATION_REGISTRY_EVENTS = [
    {
      type: 'event' as const,
      name: 'NewFeedback',
      inputs: [
        { name: 'agentId', type: 'uint256', indexed: true },
        { name: 'clientAddress', type: 'address', indexed: true },
        { name: 'feedbackIndex', type: 'uint64', indexed: false },
        { name: 'value', type: 'int128', indexed: false },
        { name: 'valueDecimals', type: 'uint8', indexed: false },
        { name: 'indexedTag1', type: 'bytes32', indexed: true },
        { name: 'tag1', type: 'string', indexed: false },
        { name: 'tag2', type: 'string', indexed: false },
        { name: 'endpoint', type: 'string', indexed: false },
        { name: 'feedbackURI', type: 'string', indexed: false },
        { name: 'feedbackHash', type: 'bytes32', indexed: false },
      ],
    },
    {
      type: 'event' as const,
      name: 'FeedbackRevoked',
      inputs: [
        { name: 'agentId', type: 'uint256', indexed: true },
        { name: 'clientAddress', type: 'address', indexed: true },
        { name: 'feedbackIndex', type: 'uint64', indexed: true },
      ],
    },
  ] as const;

  return {
    getClaraPublicClient: vi.fn(() => ({
      getLogs: mockGetLogs,
      getBlockNumber: mockGetBlockNumber,
    })),
    getBountyContracts: vi.fn(() => ({
      bountyFactory: '0xFactory',
      identityRegistry: '0xIdentity',
      reputationRegistry: '0xReputation',
    })),
    BOUNTY_FACTORY_EVENTS,
    BOUNTY_EVENTS,
    IDENTITY_REGISTRY_EVENTS,
    REPUTATION_REGISTRY_EVENTS,
    FACTORY_DEPLOY_BLOCK: 100n,
  };
});

const mockLoadIndex = vi.fn<() => BountyIndex>();
const mockSaveIndex = vi.fn<(index: BountyIndex) => void>();

vi.mock('../../indexer/store.js', () => ({
  loadIndex: mockLoadIndex,
  saveIndex: mockSaveIndex,
}));

vi.mock('../../tools/work-helpers.js', () => ({
  parseTaskURI: vi.fn((uri: string) => {
    try {
      const b64Prefix = 'data:application/json;base64,';
      if (uri.startsWith(b64Prefix)) {
        const b64 = uri.slice(b64Prefix.length);
        const json = Buffer.from(b64, 'base64').toString('utf-8');
        return JSON.parse(json);
      }
      return JSON.parse(uri);
    } catch {
      return null;
    }
  }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────

/** Build a default empty test index */
function makeDefaultIndex(overrides: Partial<BountyIndex> = {}): BountyIndex {
  return {
    lastBlock: 100,
    factoryAddress: '0xfactory',
    identityRegistryAddress: '0xidentity',
    reputationRegistryAddress: '0xreputation',
    chainId: 84532,
    bounties: {},
    agents: {},
    feedbacks: {},
    agentsById: {},
    ...overrides,
  };
}

/**
 * Build a mock BountyCreated log object that viem's parseEventLogs can decode.
 *
 * viem's parseEventLogs needs: `topics` (with event signature + indexed params)
 * and `data` (ABI-encoded non-indexed params). Since we control the mock client,
 * we return pre-decoded log objects that mimic what getLogs returns when called
 * with `events` param (already decoded).
 */
function makeBountyCreatedLog(opts: {
  bountyAddress: Hex;
  poster: Hex;
  token: Hex;
  amount: bigint;
  deadline: bigint;
  taskURI: string;
  skillTags: readonly string[];
  posterBond?: bigint;
  bondRate?: bigint;
  blockNumber?: bigint;
  transactionHash?: Hex | null;
}): any {
  return {
    eventName: 'BountyCreated',
    args: {
      bountyAddress: opts.bountyAddress,
      poster: opts.poster,
      token: opts.token,
      amount: opts.amount,
      posterBond: opts.posterBond ?? (opts.amount * 1000n / 10000n),
      bondRate: opts.bondRate ?? 1000n,
      deadline: opts.deadline,
      taskURI: opts.taskURI,
      skillTags: opts.skillTags,
    },
    address: '0xFactory' as Hex,
    blockNumber: opts.blockNumber ?? 150n,
    transactionHash: opts.transactionHash === undefined
      ? '0xabc123' as Hex
      : opts.transactionHash,
    blockHash: '0xblockhash' as Hex,
    logIndex: 0,
    transactionIndex: 0,
    removed: false,
    data: '0x',
    topics: [],
  };
}

function makeLifecycleLog(opts: {
  eventName: string;
  address: Hex;
  args: Record<string, unknown>;
  blockNumber?: bigint;
}): any {
  return {
    eventName: opts.eventName,
    args: opts.args,
    address: opts.address,
    blockNumber: opts.blockNumber ?? 160n,
    transactionHash: '0xlifecycleTx' as Hex,
    blockHash: '0xblockhash' as Hex,
    logIndex: 0,
    transactionIndex: 0,
    removed: false,
    data: '0x',
    topics: [],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('sync', () => {
  /**
   * We re-import the sync module for each test to get a fresh `index` and
   * `pollingTimer` (module-level state). vi.resetModules() clears the
   * module cache so the next dynamic import gets a fresh instance.
   */
  let syncModule: typeof import('../../indexer/sync.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Default: loadIndex returns a fresh index starting at block 100
    mockLoadIndex.mockReturnValue(makeDefaultIndex());
    mockGetBlockNumber.mockResolvedValue(200n);
    mockGetLogs.mockResolvedValue([]);
    mockSaveIndex.mockImplementation(() => {});

    // Re-import to get fresh module state
    syncModule = await import('../../indexer/sync.js');
  });

  afterEach(() => {
    // Ensure polling is stopped
    syncModule?.stopPolling?.();
    vi.useRealTimers();
  });

  // ─── getIndex ─────────────────────────────────────────────────────

  describe('getIndex', () => {
    it('returns null before initialization', () => {
      expect(syncModule.getIndex()).toBeNull();
    });

    it('returns the in-memory index after syncFromChain', async () => {
      await syncModule.syncFromChain();

      const idx = syncModule.getIndex();
      expect(idx).not.toBeNull();
      expect(idx!.factoryAddress).toBe('0xfactory');
      expect(idx!.bounties).toEqual({});
    });
  });

  // ─── syncFromChain: Event Parsing ──────────────────────────────────

  describe('syncFromChain - Event Parsing', () => {
    it('creates BountyRecord from BountyCreated event', async () => {
      const log = makeBountyCreatedLog({
        bountyAddress: '0xBounty1' as Hex,
        poster: '0xPoster1' as Hex,
        token: '0xToken1' as Hex,
        amount: 1000000000000000000n,
        deadline: 1700000000n,
        taskURI: 'data:application/json;base64,eyJ0aXRsZSI6InRlc3QifQ==',
        skillTags: ['solidity', 'defi'],
        blockNumber: 150n,
        transactionHash: '0xcreateTxHash' as Hex,
      });
      mockGetLogs.mockResolvedValueOnce([log]);

      await syncModule.syncFromChain();

      const idx = syncModule.getIndex()!;
      const record = idx.bounties['0xbounty1'];
      expect(record).toBeDefined();
      expect(record.bountyAddress).toBe('0xbounty1');
      expect(record.poster).toBe('0xposter1');
      expect(record.token).toBe('0xtoken1');
      expect(record.amount).toBe('1000000000000000000');
      expect(record.deadline).toBe(1700000000);
      expect(record.taskURI).toBe('data:application/json;base64,eyJ0aXRsZSI6InRlc3QifQ==');
      expect(record.skillTags).toEqual(['solidity', 'defi']);
      expect(record.status).toBe('open');
      expect(record.createdBlock).toBe(150);
      expect(record.createdTxHash).toBe('0xcreateTxHash');
    });

    it('lowercases bountyAddress, poster, and token', async () => {
      const log = makeBountyCreatedLog({
        bountyAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12' as Hex,
        poster: '0xPOSTER1234567890POSTER1234567890POSTER12' as Hex,
        token: '0xTOKEN01234567890TOKEN01234567890TOKEN012' as Hex,
        amount: 1n,
        deadline: 999n,
        taskURI: '',
        skillTags: [],
      });
      mockGetLogs.mockResolvedValueOnce([log]);

      await syncModule.syncFromChain();

      const idx = syncModule.getIndex()!;
      const addr = '0xabcdef1234567890abcdef1234567890abcdef12';
      const record = idx.bounties[addr];
      expect(record).toBeDefined();
      expect(record.bountyAddress).toBe(addr);
      expect(record.poster).toBe('0xposter1234567890poster1234567890poster12');
      expect(record.token).toBe('0xtoken01234567890token01234567890token012');
    });

    it('converts bigint amount to string', async () => {
      const log = makeBountyCreatedLog({
        bountyAddress: '0xBountyAmt' as Hex,
        poster: '0xP' as Hex,
        token: '0xT' as Hex,
        amount: 5000000000000000000n,
        deadline: 100n,
        taskURI: '',
        skillTags: [],
      });
      mockGetLogs.mockResolvedValueOnce([log]);

      await syncModule.syncFromChain();

      const record = syncModule.getIndex()!.bounties['0xbountyamt'];
      expect(typeof record.amount).toBe('string');
      expect(record.amount).toBe('5000000000000000000');
    });

    it('converts bigint deadline to number', async () => {
      const log = makeBountyCreatedLog({
        bountyAddress: '0xBountyDeadline' as Hex,
        poster: '0xP' as Hex,
        token: '0xT' as Hex,
        amount: 1n,
        deadline: 1700000000n,
        taskURI: '',
        skillTags: [],
      });
      mockGetLogs.mockResolvedValueOnce([log]);

      await syncModule.syncFromChain();

      const record = syncModule.getIndex()!.bounties['0xbountydeadline'];
      expect(typeof record.deadline).toBe('number');
      expect(record.deadline).toBe(1700000000);
    });

    it('stores posterBond and bondRate from BountyCreated event', async () => {
      const log = makeBountyCreatedLog({
        bountyAddress: '0xBountyBond' as Hex,
        poster: '0xP' as Hex,
        token: '0xT' as Hex,
        amount: 1000000n,
        deadline: 100n,
        taskURI: '',
        skillTags: [],
        posterBond: 100000n,
        bondRate: 1000n,
      });
      mockGetLogs.mockResolvedValueOnce([log]);

      await syncModule.syncFromChain();

      const record = syncModule.getIndex()!.bounties['0xbountybond'];
      expect(record.posterBond).toBe('100000');
      expect(record.bondRate).toBe(1000);
    });

    it('copies skillTags as mutable array', async () => {
      const log = makeBountyCreatedLog({
        bountyAddress: '0xBountySkills' as Hex,
        poster: '0xP' as Hex,
        token: '0xT' as Hex,
        amount: 1n,
        deadline: 100n,
        taskURI: '',
        skillTags: ['rust', 'typescript'] as const,
      });
      mockGetLogs.mockResolvedValueOnce([log]);

      await syncModule.syncFromChain();

      const record = syncModule.getIndex()!.bounties['0xbountyskills'];
      expect(Array.isArray(record.skillTags)).toBe(true);
      // Verify it's mutable (not readonly)
      record.skillTags.push('test');
      expect(record.skillTags).toEqual(['rust', 'typescript', 'test']);
    });

    it('does not overwrite existing bounty on duplicate BountyCreated', async () => {
      // First sync creates the bounty
      const log1 = makeBountyCreatedLog({
        bountyAddress: '0xDuplicate' as Hex,
        poster: '0xOriginalPoster' as Hex,
        token: '0xT' as Hex,
        amount: 100n,
        deadline: 100n,
        taskURI: 'original',
        skillTags: ['original'],
        blockNumber: 110n,
      });
      mockGetLogs.mockResolvedValueOnce([log1]);
      await syncModule.syncFromChain();

      // Second sync sends the same address with different data
      const log2 = makeBountyCreatedLog({
        bountyAddress: '0xDuplicate' as Hex,
        poster: '0xNewPoster' as Hex,
        token: '0xT2' as Hex,
        amount: 999n,
        deadline: 999n,
        taskURI: 'duplicate',
        skillTags: ['duplicate'],
        blockNumber: 190n,
      });
      mockGetBlockNumber.mockResolvedValue(300n);
      mockGetLogs.mockResolvedValueOnce([log2]);

      await syncModule.syncFromChain();

      const record = syncModule.getIndex()!.bounties['0xduplicate'];
      expect(record.poster).toBe('0xoriginalposter');
      expect(record.taskURI).toBe('original');
      expect(record.amount).toBe('100');
    });
  });

  // ─── syncFromChain: Lifecycle Events ───────────────────────────────

  describe('syncFromChain - Lifecycle Events', () => {
    /** Seed index with a bounty so lifecycle events have a target */
    function seedBounty(): void {
      const seeded = makeDefaultIndex({
        bounties: {
          '0xbounty1': {
            bountyAddress: '0xbounty1',
            poster: '0xposter',
            token: '0xtoken',
            amount: '1000000000000000000',
            deadline: 1700000000,
            taskURI: 'data:...',
            skillTags: ['solidity'],
            status: 'open',
            createdBlock: 105,
            createdTxHash: '0xcreate',
          },
        },
      });
      mockLoadIndex.mockReturnValue(seeded);
    }

    it('applies BountyClaimed - sets status, claimer, claimerAgentId', async () => {
      seedBounty();
      // Re-import to pick up seeded index
      vi.resetModules();
      syncModule = await import('../../indexer/sync.js');

      // First getLogs (factory events) returns empty
      mockGetLogs.mockResolvedValueOnce([]);
      // Second getLogs (lifecycle events) returns BountyClaimed
      mockGetLogs.mockResolvedValueOnce([
        makeLifecycleLog({
          eventName: 'BountyClaimed',
          address: '0xBounty1' as Hex,
          args: {
            claimer: '0xClaimer1' as Hex,
            agentId: 42n,
          },
          blockNumber: 160n,
        }),
      ]);

      await syncModule.syncFromChain();

      const record = syncModule.getIndex()!.bounties['0xbounty1'];
      expect(record.status).toBe('claimed');
      expect(record.claimer).toBe('0xclaimer1');
      expect(record.claimerAgentId).toBe(42);
    });

    it('applies WorkSubmitted - sets status, proofURI', async () => {
      seedBounty();
      vi.resetModules();
      syncModule = await import('../../indexer/sync.js');

      mockGetLogs.mockResolvedValueOnce([]);
      mockGetLogs.mockResolvedValueOnce([
        makeLifecycleLog({
          eventName: 'WorkSubmitted',
          address: '0xBounty1' as Hex,
          args: {
            claimer: '0xClaimer1' as Hex,
            proofURI: 'ipfs://Qm123456',
          },
          blockNumber: 165n,
        }),
      ]);

      await syncModule.syncFromChain();

      const record = syncModule.getIndex()!.bounties['0xbounty1'];
      expect(record.status).toBe('submitted');
      expect(record.proofURI).toBe('ipfs://Qm123456');
    });

    it('applies BountyApproved - sets status to approved', async () => {
      seedBounty();
      vi.resetModules();
      syncModule = await import('../../indexer/sync.js');

      mockGetLogs.mockResolvedValueOnce([]);
      mockGetLogs.mockResolvedValueOnce([
        makeLifecycleLog({
          eventName: 'BountyApproved',
          address: '0xBounty1' as Hex,
          args: {
            claimer: '0xClaimer1' as Hex,
            amount: 1000000000000000000n,
          },
          blockNumber: 170n,
        }),
      ]);

      await syncModule.syncFromChain();

      const record = syncModule.getIndex()!.bounties['0xbounty1'];
      expect(record.status).toBe('approved');
    });

    it('applies BountyExpired - sets status to expired', async () => {
      seedBounty();
      vi.resetModules();
      syncModule = await import('../../indexer/sync.js');

      mockGetLogs.mockResolvedValueOnce([]);
      mockGetLogs.mockResolvedValueOnce([
        makeLifecycleLog({
          eventName: 'BountyExpired',
          address: '0xBounty1' as Hex,
          args: {
            poster: '0xPoster' as Hex,
            amount: 1000000000000000000n,
          },
          blockNumber: 175n,
        }),
      ]);

      await syncModule.syncFromChain();

      const record = syncModule.getIndex()!.bounties['0xbounty1'];
      expect(record.status).toBe('expired');
    });

    it('applies BountyCancelled - sets status to cancelled', async () => {
      seedBounty();
      vi.resetModules();
      syncModule = await import('../../indexer/sync.js');

      mockGetLogs.mockResolvedValueOnce([]);
      mockGetLogs.mockResolvedValueOnce([
        makeLifecycleLog({
          eventName: 'BountyCancelled',
          address: '0xBounty1' as Hex,
          args: {
            poster: '0xPoster' as Hex,
            amount: 1000000000000000000n,
          },
          blockNumber: 180n,
        }),
      ]);

      await syncModule.syncFromChain();

      const record = syncModule.getIndex()!.bounties['0xbounty1'];
      expect(record.status).toBe('cancelled');
    });

    it('sets updatedBlock on all lifecycle events', async () => {
      seedBounty();
      vi.resetModules();
      syncModule = await import('../../indexer/sync.js');

      mockGetLogs.mockResolvedValueOnce([]);
      mockGetLogs.mockResolvedValueOnce([
        makeLifecycleLog({
          eventName: 'BountyClaimed',
          address: '0xBounty1' as Hex,
          args: { claimer: '0xC' as Hex, agentId: 1n },
          blockNumber: 155n,
        }),
      ]);

      await syncModule.syncFromChain();

      const record = syncModule.getIndex()!.bounties['0xbounty1'];
      expect(record.updatedBlock).toBe(155);
    });

    it('applies BountyRejected (1st) - sets status to rejected, stores rejectionCount', async () => {
      seedBounty();
      vi.resetModules();
      syncModule = await import('../../indexer/sync.js');

      mockGetLogs.mockResolvedValueOnce([]);
      mockGetLogs.mockResolvedValueOnce([
        makeLifecycleLog({
          eventName: 'BountyRejected',
          address: '0xBounty1' as Hex,
          args: {
            poster: '0xPoster' as Hex,
            claimer: '0xClaimer1' as Hex,
            rejectionCount: 1,
          },
          blockNumber: 170n,
        }),
      ]);

      await syncModule.syncFromChain();

      const record = syncModule.getIndex()!.bounties['0xbounty1'];
      expect(record.status).toBe('rejected');
      expect(record.rejectionCount).toBe(1);
    });

    it('applies BountyRejected (2nd) - sets status to resolved', async () => {
      seedBounty();
      vi.resetModules();
      syncModule = await import('../../indexer/sync.js');

      mockGetLogs.mockResolvedValueOnce([]);
      mockGetLogs.mockResolvedValueOnce([
        makeLifecycleLog({
          eventName: 'BountyRejected',
          address: '0xBounty1' as Hex,
          args: {
            poster: '0xPoster' as Hex,
            claimer: '0xClaimer1' as Hex,
            rejectionCount: 2,
          },
          blockNumber: 175n,
        }),
      ]);

      await syncModule.syncFromChain();

      const record = syncModule.getIndex()!.bounties['0xbounty1'];
      expect(record.status).toBe('resolved');
      expect(record.rejectionCount).toBe(2);
    });

    it('applies AutoApproved - sets status to approved', async () => {
      seedBounty();
      vi.resetModules();
      syncModule = await import('../../indexer/sync.js');

      mockGetLogs.mockResolvedValueOnce([]);
      mockGetLogs.mockResolvedValueOnce([
        makeLifecycleLog({
          eventName: 'AutoApproved',
          address: '0xBounty1' as Hex,
          args: {
            claimer: '0xClaimer1' as Hex,
            amount: 1000000000000000000n,
          },
          blockNumber: 180n,
        }),
      ]);

      await syncModule.syncFromChain();

      const record = syncModule.getIndex()!.bounties['0xbounty1'];
      expect(record.status).toBe('approved');
    });

    it('ignores lifecycle events for unknown bounty addresses', async () => {
      seedBounty();
      vi.resetModules();
      syncModule = await import('../../indexer/sync.js');

      mockGetLogs.mockResolvedValueOnce([]);
      mockGetLogs.mockResolvedValueOnce([
        makeLifecycleLog({
          eventName: 'BountyClaimed',
          address: '0xUnknownBounty' as Hex,
          args: { claimer: '0xC' as Hex, agentId: 1n },
        }),
      ]);

      // Should not crash
      await syncModule.syncFromChain();

      const idx = syncModule.getIndex()!;
      // Unknown address should NOT create a new record
      expect(idx.bounties['0xunknownbounty']).toBeUndefined();
      // Existing bounty should be untouched
      expect(idx.bounties['0xbounty1'].status).toBe('open');
    });
  });

  // ─── syncFromChain: Chunking & Incremental Sync ────────────────────

  describe('syncFromChain - Chunking & Incremental Sync', () => {
    it('skips sync when fromBlock > latestBlock (already up to date)', async () => {
      // lastBlock = 200, latestBlock = 200 → fromBlock (201) > latestBlock
      mockLoadIndex.mockReturnValue(makeDefaultIndex({ lastBlock: 200 }));
      vi.resetModules();
      syncModule = await import('../../indexer/sync.js');

      mockGetBlockNumber.mockResolvedValue(200n);

      await syncModule.syncFromChain();

      expect(mockGetLogs).not.toHaveBeenCalled();
      expect(mockSaveIndex).not.toHaveBeenCalled();
    });

    it('fetches single chunk when range <= MAX_BLOCK_RANGE', async () => {
      // lastBlock = 100, latestBlock = 200 → range = 100 blocks (< 10000)
      mockGetBlockNumber.mockResolvedValue(200n);

      await syncModule.syncFromChain();

      // Should call getLogs once for factory events (range fits in one chunk)
      expect(mockGetLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          fromBlock: 101n,
          toBlock: 200n,
        }),
      );
    });

    it('splits into multiple chunks when range > MAX_BLOCK_RANGE', async () => {
      // lastBlock = 100, latestBlock = 25100 → 25000 blocks → 3 chunks
      mockGetBlockNumber.mockResolvedValue(25100n);

      await syncModule.syncFromChain();

      // With no bounties: 3 getLogs per chunk (factory + identity + reputation)
      // Chunk 1: 101 → 10100
      // Chunk 2: 10101 → 20100
      // Chunk 3: 20101 → 25100
      const calls = mockGetLogs.mock.calls;
      expect(calls.length).toBe(9); // 3 chunks × 3 (factory + identity + reputation)

      // Factory calls at indices 0, 3, 6
      expect(calls[0][0]).toMatchObject({ fromBlock: 101n, toBlock: 10100n });
      expect(calls[3][0]).toMatchObject({ fromBlock: 10101n, toBlock: 20100n });
      expect(calls[6][0]).toMatchObject({ fromBlock: 20101n, toBlock: 25100n });
    });

    it('checkpoints lastBlock after each chunk', async () => {
      mockGetBlockNumber.mockResolvedValue(25100n);

      await syncModule.syncFromChain();

      // After all chunks, lastBlock should be 25100
      const idx = syncModule.getIndex()!;
      expect(idx.lastBlock).toBe(25100);
    });

    it('saves index to disk after full sync', async () => {
      mockGetBlockNumber.mockResolvedValue(200n);

      await syncModule.syncFromChain();

      expect(mockSaveIndex).toHaveBeenCalledTimes(1);
      expect(mockSaveIndex).toHaveBeenCalledWith(
        expect.objectContaining({
          lastBlock: 200,
        }),
      );
    });

    it('loads index from store on first call', async () => {
      // First call loads from store
      await syncModule.syncFromChain();
      expect(mockLoadIndex).toHaveBeenCalledTimes(1);

      // Second call should NOT load again (already in memory)
      await syncModule.syncFromChain();
      expect(mockLoadIndex).toHaveBeenCalledTimes(1);
    });

    it('uses lastBlock + 1 as fromBlock for incremental sync', async () => {
      mockLoadIndex.mockReturnValue(makeDefaultIndex({ lastBlock: 500 }));
      vi.resetModules();
      syncModule = await import('../../indexer/sync.js');

      mockGetBlockNumber.mockResolvedValue(600n);

      await syncModule.syncFromChain();

      expect(mockGetLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          fromBlock: 501n, // lastBlock (500) + 1
          toBlock: 600n,
        }),
      );
    });

    it('only fetches lifecycle logs when bounties exist', async () => {
      // Empty bounties → factory + identity + reputation getLogs, no lifecycle getLogs
      mockGetBlockNumber.mockResolvedValue(200n);

      await syncModule.syncFromChain();

      // 3 getLogs calls: factory events + identity registry + reputation registry (no lifecycle since no bounties)
      expect(mockGetLogs).toHaveBeenCalledTimes(3);
      // Verify factory, identity registry, and reputation registry calls
      expect(mockGetLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          address: '0xFactory',
        }),
      );
      expect(mockGetLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          address: '0xIdentity',
        }),
      );
      expect(mockGetLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          address: '0xReputation',
        }),
      );
    });
  });

  // ─── syncFromChain: Edge Cases ─────────────────────────────────────

  describe('syncFromChain - Edge Cases', () => {
    it('handles empty getLogs response (no events in range)', async () => {
      mockGetLogs.mockResolvedValue([]);
      mockGetBlockNumber.mockResolvedValue(200n);

      await syncModule.syncFromChain();

      const idx = syncModule.getIndex()!;
      expect(idx.bounties).toEqual({});
      expect(idx.lastBlock).toBe(200);
    });

    it('handles mixed creation + lifecycle events in same chunk', async () => {
      // First getLogs call returns creation event
      mockGetLogs.mockResolvedValueOnce([
        makeBountyCreatedLog({
          bountyAddress: '0xMixed1' as Hex,
          poster: '0xP' as Hex,
          token: '0xT' as Hex,
          amount: 500n,
          deadline: 999n,
          taskURI: 'task://mixed',
          skillTags: ['mixed'],
          blockNumber: 110n,
        }),
      ]);
      // Second getLogs call returns lifecycle event for the just-created bounty
      mockGetLogs.mockResolvedValueOnce([
        makeLifecycleLog({
          eventName: 'BountyClaimed',
          address: '0xMixed1' as Hex,
          args: { claimer: '0xClaimMixed' as Hex, agentId: 7n },
          blockNumber: 115n,
        }),
      ]);

      await syncModule.syncFromChain();

      const idx = syncModule.getIndex()!;
      const record = idx.bounties['0xmixed1'];
      expect(record).toBeDefined();
      expect(record.status).toBe('claimed');
      expect(record.claimer).toBe('0xclaimmixed');
      expect(record.claimerAgentId).toBe(7);
    });

    it('handles null transactionHash in log', async () => {
      const log = makeBountyCreatedLog({
        bountyAddress: '0xNullTx' as Hex,
        poster: '0xP' as Hex,
        token: '0xT' as Hex,
        amount: 1n,
        deadline: 100n,
        taskURI: '',
        skillTags: [],
        transactionHash: null,
      });
      mockGetLogs.mockResolvedValueOnce([log]);

      await syncModule.syncFromChain();

      const record = syncModule.getIndex()!.bounties['0xnulltx'];
      expect(record.createdTxHash).toBe('');
    });
  });

  // ─── startPolling / stopPolling ────────────────────────────────────

  describe('startPolling / stopPolling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      syncModule?.stopPolling?.();
      vi.useRealTimers();
    });

    it('starts interval that calls syncFromChain periodically', async () => {
      // Spy on syncFromChain by tracking saveIndex calls (one per sync)
      mockGetBlockNumber.mockResolvedValue(200n);

      syncModule.startPolling(15_000);

      // Advance by one interval
      await vi.advanceTimersByTimeAsync(15_000);

      // syncFromChain should have been called (loadIndex triggers on first call)
      expect(mockLoadIndex).toHaveBeenCalled();

      // Advance by another interval
      await vi.advanceTimersByTimeAsync(15_000);

      // Should have been called again
      expect(mockSaveIndex.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('does not start duplicate polling if already running', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      syncModule.startPolling(15_000);
      syncModule.startPolling(15_000);

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      setIntervalSpy.mockRestore();
    });

    it('stopPolling clears the interval', async () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      syncModule.startPolling(15_000);
      syncModule.stopPolling();

      expect(clearIntervalSpy).toHaveBeenCalled();

      // Advance time — syncFromChain should NOT fire
      mockSaveIndex.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockSaveIndex).not.toHaveBeenCalled();

      clearIntervalSpy.mockRestore();
    });

    it('swallows sync errors during polling without crashing', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Make syncFromChain throw on first tick
      mockGetBlockNumber.mockRejectedValueOnce(new Error('RPC timeout'));

      syncModule.startPolling(10_000);

      // First tick — should throw but be caught
      await vi.advanceTimersByTimeAsync(10_000);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[indexer] Sync error:',
        'RPC timeout',
      );

      // Polling should continue — next tick succeeds
      mockGetBlockNumber.mockResolvedValue(200n);
      mockGetLogs.mockResolvedValue([]);

      await vi.advanceTimersByTimeAsync(10_000);

      // No crash — test passes if we reach here
      consoleErrorSpy.mockRestore();
    });
  });
});
