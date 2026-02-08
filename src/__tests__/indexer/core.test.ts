/**
 * Core Indexer Unit Tests
 *
 * Covers:
 *   1. types.ts — STATUS_MAP completeness and correctness
 *   2. store.ts — loadIndex, saveIndex, corrupt file handling, network switch detection
 *   3. queries.ts — getOpenBounties, getBountyByAddress, getBountiesByPoster,
 *                   getBountiesByClaimer, getIndexStats
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BountyRecord, BountyIndex, BountyStatus } from '../../indexer/types.js';

// ─── Mock fs, os, and config modules (must be before imports) ────────────

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

vi.mock('../../config/clara-contracts.js', () => ({
  getBountyContracts: vi.fn(() => ({
    bountyFactory: '0xFactoryAddr',
    identityRegistry: '0xIdentity',
    reputationRegistry: '0xReputation',
  })),
  getClaraContracts: vi.fn(() => ({
    claraToken: '0xToken',
    claraStaking: '0xStaking',
    merkleDrop: '0xMerkle',
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
  })),
  FACTORY_DEPLOY_BLOCK: 37897669n,
}));

// Mock the sync module for queries tests
vi.mock('../../indexer/sync.js', () => ({
  getIndex: vi.fn(() => null),
}));

// ─── Import subjects under test ─────────────────────────────────────────

import { STATUS_MAP } from '../../indexer/types.js';
import { loadIndex, saveIndex } from '../../indexer/store.js';
import {
  getOpenBounties,
  getBountyByAddress,
  getBountiesByPoster,
  getBountiesByClaimer,
  getIndexStats,
} from '../../indexer/queries.js';

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { getIndex } from '../../indexer/sync.js';

// ─── Helpers ────────────────────────────────────────────────────────────

/** Build a mock BountyRecord with sensible defaults. */
function makeBounty(overrides: Partial<BountyRecord> & { bountyAddress: string }): BountyRecord {
  return {
    poster: '0xposter1',
    token: '0xtoken1',
    amount: '1000000000000000000',
    deadline: Math.floor(Date.now() / 1000) + 86400 * 3, // 3 days from now
    taskURI: 'data:application/json;base64,eyJ0aXRsZSI6IlRlc3QifQ==',
    skillTags: ['solidity'],
    status: 'open',
    createdBlock: 37900000,
    createdTxHash: '0xtxhash1',
    ...overrides,
  };
}

/** Shorthand to build an index with specific bounties. */
function makeIndex(bounties: Record<string, BountyRecord>, lastBlock = 37900000): BountyIndex {
  return {
    lastBlock,
    factoryAddress: '0xfactoryaddr',
    identityRegistryAddress: '0xidentity',
    chainId: 84532,
    bounties,
    agents: {},
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. TYPES TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('types', () => {
  describe('STATUS_MAP', () => {
    it('maps all 8 Solidity enum indices (0-7) to string statuses', () => {
      expect(Object.keys(STATUS_MAP).length).toBe(8);
      const keys = Object.keys(STATUS_MAP).map(Number);
      expect(keys).toEqual(expect.arrayContaining([0, 1, 2, 3, 4, 5, 6, 7]));
    });

    it('maps index 0 to open', () => {
      expect(STATUS_MAP[0]).toBe('open');
    });

    it('maps index 1 to claimed', () => {
      expect(STATUS_MAP[1]).toBe('claimed');
    });

    it('maps index 2 to submitted', () => {
      expect(STATUS_MAP[2]).toBe('submitted');
    });

    it('maps index 3 to approved', () => {
      expect(STATUS_MAP[3]).toBe('approved');
    });

    it('maps index 4 to expired', () => {
      expect(STATUS_MAP[4]).toBe('expired');
    });

    it('maps index 5 to cancelled', () => {
      expect(STATUS_MAP[5]).toBe('cancelled');
    });

    it('maps index 6 to rejected', () => {
      expect(STATUS_MAP[6]).toBe('rejected');
    });

    it('maps index 7 to resolved', () => {
      expect(STATUS_MAP[7]).toBe('resolved');
    });

    it('returns undefined for out-of-range indices', () => {
      expect(STATUS_MAP[8]).toBeUndefined();
      expect(STATUS_MAP[-1]).toBeUndefined();
    });

    it('all values are valid BountyStatus strings', () => {
      const validStatuses: BountyStatus[] = [
        'open', 'claimed', 'submitted', 'approved', 'expired', 'cancelled', 'rejected', 'resolved',
      ];
      for (const value of Object.values(STATUS_MAP)) {
        expect(validStatuses).toContain(value);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. STORE TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: directory exists
    vi.mocked(existsSync).mockReturnValue(true);
  });

  describe('loadIndex', () => {
    it('creates .clara dir if missing', () => {
      vi.mocked(existsSync).mockImplementation((p) => {
        // First call checks dir existence (ensureDir), second checks file
        if (String(p).endsWith('.clara')) return false;
        return false; // file doesn't exist either
      });

      loadIndex();

      expect(mkdirSync).toHaveBeenCalledWith('/mock/home/.clara', { recursive: true });
    });

    it('returns default index when file does not exist', () => {
      vi.mocked(existsSync).mockImplementation((p) => {
        if (String(p).endsWith('bounties.json')) return false;
        return true; // dir exists
      });

      const result = loadIndex();

      expect(result.lastBlock).toBe(37897669);
      expect(result.factoryAddress).toBe('0xfactoryaddr');
      expect(result.chainId).toBe(84532);
      expect(result.bounties).toEqual({});
    });

    it('loads valid index from disk', () => {
      const storedIndex: BountyIndex = {
        lastBlock: 38000000,
        factoryAddress: '0xfactoryaddr',
        identityRegistryAddress: '0xidentity',
        chainId: 84532,
        bounties: {
          '0xbounty1': makeBounty({ bountyAddress: '0xbounty1' }),
        },
        agents: {},
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(storedIndex));

      const result = loadIndex();

      expect(result.lastBlock).toBe(38000000);
      expect(result.factoryAddress).toBe('0xfactoryaddr');
      expect(result.bounties['0xbounty1']).toBeDefined();
      expect(result.bounties['0xbounty1'].bountyAddress).toBe('0xbounty1');
    });

    it('returns default index when JSON is corrupt', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('{broken');

      const result = loadIndex();

      expect(result.lastBlock).toBe(37897669);
      expect(result.factoryAddress).toBe('0xfactoryaddr');
      expect(result.bounties).toEqual({});
    });

    it('returns default index when factory address changed (network switch)', () => {
      const storedIndex: BountyIndex = {
        lastBlock: 38000000,
        factoryAddress: '0xold_factory', // different from mocked '0xfactoryaddr'
        identityRegistryAddress: '0xidentity',
        chainId: 84532,
        bounties: {
          '0xbounty1': makeBounty({ bountyAddress: '0xbounty1' }),
        },
        agents: {},
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(storedIndex));

      const result = loadIndex();

      // Should reset to default because factory address mismatch
      expect(result.lastBlock).toBe(37897669);
      expect(result.factoryAddress).toBe('0xfactoryaddr');
      expect(result.bounties).toEqual({});
    });

    it('fills in missing lastBlock with FACTORY_DEPLOY_BLOCK', () => {
      const storedIndex = {
        factoryAddress: '0xfactoryaddr',
        identityRegistryAddress: '0xidentity',
        chainId: 84532,
        bounties: {},
        agents: {},
        // lastBlock intentionally missing
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(storedIndex));

      const result = loadIndex();

      expect(result.lastBlock).toBe(37897669);
    });

    it('fills in missing bounties with empty object', () => {
      const storedIndex = {
        lastBlock: 38000000,
        factoryAddress: '0xfactoryaddr',
        identityRegistryAddress: '0xidentity',
        chainId: 84532,
        // bounties intentionally missing
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(storedIndex));

      const result = loadIndex();

      expect(result.bounties).toEqual({});
    });

    it('preserves existing bounties on load', () => {
      const bounty1 = makeBounty({ bountyAddress: '0xbounty1', status: 'open' });
      const bounty2 = makeBounty({ bountyAddress: '0xbounty2', status: 'claimed', claimer: '0xclaimer' });
      const storedIndex: BountyIndex = {
        lastBlock: 38000000,
        factoryAddress: '0xfactoryaddr',
        identityRegistryAddress: '0xidentity',
        chainId: 84532,
        bounties: { '0xbounty1': bounty1, '0xbounty2': bounty2 },
        agents: {},
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(storedIndex));

      const result = loadIndex();

      expect(Object.keys(result.bounties)).toHaveLength(2);
      expect(result.bounties['0xbounty1'].status).toBe('open');
      expect(result.bounties['0xbounty2'].status).toBe('claimed');
      expect(result.bounties['0xbounty2'].claimer).toBe('0xclaimer');
    });
  });

  describe('saveIndex', () => {
    it('creates .clara dir before writing', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const index = makeIndex({});
      saveIndex(index);

      expect(mkdirSync).toHaveBeenCalledWith('/mock/home/.clara', { recursive: true });
      // mkdirSync should be called before writeFileSync
      const mkdirOrder = vi.mocked(mkdirSync).mock.invocationCallOrder[0];
      const writeOrder = vi.mocked(writeFileSync).mock.invocationCallOrder[0];
      expect(mkdirOrder).toBeLessThan(writeOrder);
    });

    it('writes JSON with 2-space indentation', () => {
      const index = makeIndex({});
      saveIndex(index);

      expect(writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        JSON.stringify(index, null, 2),
        'utf-8',
      );
    });

    it('writes to ~/.clara/bounties.json', () => {
      const index = makeIndex({});
      saveIndex(index);

      expect(writeFileSync).toHaveBeenCalledWith(
        '/mock/home/.clara/bounties.json',
        expect.any(String),
        'utf-8',
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. QUERIES TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('queries', () => {
  const now = Math.floor(Date.now() / 1000);

  // Diverse fixture set: 6 bounties (one per status), varied skills/amounts/deadlines
  const FIXTURES: Record<string, BountyRecord> = {
    '0xopen1': makeBounty({
      bountyAddress: '0xopen1',
      status: 'open',
      poster: '0xposter1',
      skillTags: ['solidity', 'defi'],
      amount: '1000000000000000000', // 1 ETH
      deadline: now + 86400 * 3, // 3 days
    }),
    '0xopen2': makeBounty({
      bountyAddress: '0xopen2',
      status: 'open',
      poster: '0xposter2',
      skillTags: ['typescript'],
      amount: '5000000000000000000', // 5 ETH
      deadline: now + 86400 * 1, // 1 day (sooner)
    }),
    '0xclaimed': makeBounty({
      bountyAddress: '0xclaimed',
      status: 'claimed',
      poster: '0xposter1',
      claimer: '0xclaimer1',
      skillTags: ['rust'],
      amount: '2000000000000000000', // 2 ETH
      deadline: now + 86400 * 5,
    }),
    '0xsubmitted': makeBounty({
      bountyAddress: '0xsubmitted',
      status: 'submitted',
      poster: '0xposter1',
      claimer: '0xclaimer1',
      proofURI: 'ipfs://proof123',
      skillTags: ['python'],
      amount: '3000000000000000000', // 3 ETH
      deadline: now + 86400 * 7,
    }),
    '0xapproved': makeBounty({
      bountyAddress: '0xapproved',
      status: 'approved',
      poster: '0xposter2',
      claimer: '0xclaimer2',
      skillTags: ['solidity'],
      amount: '4000000000000000000', // 4 ETH
      deadline: now - 86400, // past
    }),
    '0xexpired': makeBounty({
      bountyAddress: '0xexpired',
      status: 'expired',
      poster: '0xposter1',
      skillTags: ['go', 'defi'],
      amount: '500000000000000000', // 0.5 ETH
      deadline: now - 86400 * 2, // past
    }),
  };

  const fixtureIndex = makeIndex(FIXTURES, 38000000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Set the mock getIndex return value. */
  function setIndex(index: BountyIndex | null) {
    vi.mocked(getIndex).mockReturnValue(index);
  }

  describe('getOpenBounties', () => {
    it('returns open bounties by default when no filters given', () => {
      setIndex(fixtureIndex);

      const result = getOpenBounties();

      expect(result.length).toBe(2);
      for (const b of result) {
        expect(b.status).toBe('open');
      }
    });

    it('filters by explicit status', () => {
      setIndex(fixtureIndex);

      const result = getOpenBounties({ status: 'claimed' });

      expect(result.length).toBe(1);
      expect(result[0].status).toBe('claimed');
      expect(result[0].bountyAddress).toBe('0xclaimed');
    });

    it('filters by skill (case-insensitive partial match)', () => {
      setIndex(fixtureIndex);

      const result = getOpenBounties({ skill: 'SOLID' });

      // Should match 'solidity' in open bounties
      expect(result.length).toBe(1);
      expect(result[0].bountyAddress).toBe('0xopen1');
    });

    it('filters by minAmount', () => {
      setIndex(fixtureIndex);

      // Only open bounties with amount >= 2 ETH
      const result = getOpenBounties({ minAmount: 2000000000000000000 });

      expect(result.length).toBe(1);
      expect(result[0].bountyAddress).toBe('0xopen2'); // 5 ETH
    });

    it('filters by maxAmount', () => {
      setIndex(fixtureIndex);

      // Only open bounties with amount <= 2 ETH
      const result = getOpenBounties({ maxAmount: 2000000000000000000 });

      expect(result.length).toBe(1);
      expect(result[0].bountyAddress).toBe('0xopen1'); // 1 ETH
    });

    it('combines skill + minAmount + maxAmount filters', () => {
      setIndex(fixtureIndex);

      // Looking for open bounties with 'solidity' skill, amount between 0.5 and 2 ETH
      const result = getOpenBounties({
        skill: 'solidity',
        minAmount: 500000000000000000,
        maxAmount: 2000000000000000000,
      });

      expect(result.length).toBe(1);
      expect(result[0].bountyAddress).toBe('0xopen1');
    });

    it('sorts by deadline ascending (soonest first)', () => {
      setIndex(fixtureIndex);

      const result = getOpenBounties();

      expect(result.length).toBe(2);
      // 0xopen2 has deadline 1 day from now, 0xopen1 has 3 days
      expect(result[0].bountyAddress).toBe('0xopen2');
      expect(result[1].bountyAddress).toBe('0xopen1');
      expect(result[0].deadline).toBeLessThan(result[1].deadline);
    });

    it('respects limit parameter', () => {
      setIndex(fixtureIndex);

      const result = getOpenBounties({ limit: 1 });

      expect(result.length).toBe(1);
    });

    it('defaults limit to 50', () => {
      // Create an index with 60 open bounties
      const manyBounties: Record<string, BountyRecord> = {};
      for (let i = 0; i < 60; i++) {
        const addr = `0xopen_${String(i).padStart(3, '0')}`;
        manyBounties[addr] = makeBounty({
          bountyAddress: addr,
          status: 'open',
          deadline: now + i * 100,
        });
      }
      setIndex(makeIndex(manyBounties));

      const result = getOpenBounties();

      expect(result.length).toBe(50);
    });

    it('returns empty array when no bounties match', () => {
      setIndex(fixtureIndex);

      const result = getOpenBounties({ skill: 'nonexistent' });

      expect(result).toEqual([]);
    });

    it('returns empty array when index is null (not initialized)', () => {
      setIndex(null);

      const result = getOpenBounties();

      expect(result).toEqual([]);
    });
  });

  describe('getBountyByAddress', () => {
    it('returns bounty by exact lowercase address', () => {
      setIndex(fixtureIndex);

      const result = getBountyByAddress('0xopen1');

      expect(result).not.toBeNull();
      expect(result!.bountyAddress).toBe('0xopen1');
      expect(result!.status).toBe('open');
    });

    it('normalizes address to lowercase before lookup', () => {
      setIndex(fixtureIndex);

      const result = getBountyByAddress('0xOPEN1');

      expect(result).not.toBeNull();
      expect(result!.bountyAddress).toBe('0xopen1');
    });

    it('returns null for unknown address', () => {
      setIndex(fixtureIndex);

      const result = getBountyByAddress('0xunknown');

      expect(result).toBeNull();
    });

    it('returns null when index is null', () => {
      setIndex(null);

      const result = getBountyByAddress('0xopen1');

      expect(result).toBeNull();
    });
  });

  describe('getBountiesByPoster', () => {
    it('returns all bounties posted by the given address', () => {
      setIndex(fixtureIndex);

      const result = getBountiesByPoster('0xposter1');

      // poster1 posted: 0xopen1, 0xclaimed, 0xsubmitted, 0xexpired
      expect(result.length).toBe(4);
      for (const b of result) {
        expect(b.poster).toBe('0xposter1');
      }
    });

    it('normalizes poster address to lowercase', () => {
      setIndex(fixtureIndex);

      const result = getBountiesByPoster('0xPOSTER1');

      expect(result.length).toBe(4);
    });

    it('returns empty array for unknown poster', () => {
      setIndex(fixtureIndex);

      const result = getBountiesByPoster('0xunknown');

      expect(result).toEqual([]);
    });
  });

  describe('getBountiesByClaimer', () => {
    it('returns bounties claimed by the given address', () => {
      setIndex(fixtureIndex);

      const result = getBountiesByClaimer('0xclaimer1');

      // claimer1 claimed: 0xclaimed, 0xsubmitted
      expect(result.length).toBe(2);
      for (const b of result) {
        expect(b.claimer).toBe('0xclaimer1');
      }
    });

    it('returns empty array when no bounties have been claimed', () => {
      // Index with only open bounties (no claimer set)
      const openOnly: Record<string, BountyRecord> = {
        '0xopen': makeBounty({ bountyAddress: '0xopen', status: 'open' }),
      };
      setIndex(makeIndex(openOnly));

      const result = getBountiesByClaimer('0xanyone');

      expect(result).toEqual([]);
    });

    it('normalizes claimer address', () => {
      setIndex(fixtureIndex);

      const result = getBountiesByClaimer('0xCLAIMER1');

      expect(result.length).toBe(2);
    });
  });

  describe('getIndexStats', () => {
    it('returns correct counts for each status', () => {
      setIndex(fixtureIndex);

      const stats = getIndexStats();

      expect(stats.openCount).toBe(2);
      expect(stats.claimedCount).toBe(1);
      expect(stats.submittedCount).toBe(1);
      expect(stats.approvedCount).toBe(1);
      expect(stats.expiredCount).toBe(1);
      expect(stats.cancelledCount).toBe(0); // no cancelled in fixtures
    });

    it('returns totalBounties as sum of all', () => {
      setIndex(fixtureIndex);

      const stats = getIndexStats();

      expect(stats.totalBounties).toBe(6);
    });

    it('returns lastSyncedBlock from index', () => {
      setIndex(fixtureIndex);

      const stats = getIndexStats();

      expect(stats.lastSyncedBlock).toBe(38000000);
    });

    it('returns zero counts when index is null', () => {
      setIndex(null);

      const stats = getIndexStats();

      expect(stats.totalBounties).toBe(0);
      expect(stats.openCount).toBe(0);
      expect(stats.claimedCount).toBe(0);
      expect(stats.submittedCount).toBe(0);
      expect(stats.approvedCount).toBe(0);
      expect(stats.expiredCount).toBe(0);
      expect(stats.cancelledCount).toBe(0);
      expect(stats.lastSyncedBlock).toBe(0);
    });

    it('returns zero counts when bounties is empty', () => {
      setIndex(makeIndex({}, 38000000));

      const stats = getIndexStats();

      expect(stats.totalBounties).toBe(0);
      expect(stats.openCount).toBe(0);
      expect(stats.lastSyncedBlock).toBe(38000000);
    });
  });
});
