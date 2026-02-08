/**
 * Tests for work_profile tool
 *
 * Tests agent profile lookup via on-chain reads (IdentityRegistry +
 * ReputationRegistry) and local indexer bounty enrichment.
 * All viem readContract calls and indexer queries are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Hex } from 'viem';
import { workProfileToolDefinition, handleWorkProfile } from '../../tools/work-profile.js';

// ─── Mocks ──────────────────────────────────────────────────────────

// Mock the clara-contracts module (getClaraPublicClient + getBountyContracts)
const mockReadContract = vi.fn();

vi.mock('../../config/clara-contracts.js', () => ({
  getClaraPublicClient: vi.fn(() => ({
    readContract: mockReadContract,
  })),
  getBountyContracts: vi.fn(() => ({
    identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    bountyFactory: '0x4fDd9E7014959503B91e4C21c0B25f1955413C75',
  })),
  IDENTITY_REGISTRY_ABI: [],
  REPUTATION_REGISTRY_ABI: [],
}));

// Mock indexer queries
vi.mock('../../indexer/queries.js', () => ({
  getBountiesByPoster: vi.fn(() => []),
  getBountiesByClaimer: vi.fn(() => []),
}));

import { getBountiesByPoster, getBountiesByClaimer } from '../../indexer/queries.js';

// ─── Test Data ──────────────────────────────────────────────────────

const TEST_ADDRESS = '0xabcdef1234567890abcdef1234567890abcdef12';
const TEST_OWNER = '0x1111111111111111111111111111111111111111';

/** Build a base64 data URI from a JSON object */
function makeDataUri(obj: Record<string, unknown>): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(obj)).toString('base64')}`;
}

const AGENT_METADATA = {
  name: 'TestBot',
  skills: ['solidity', 'typescript'],
  services: ['code-review', 'audits'],
  description: 'A test agent for unit tests',
  registeredAt: '2026-01-15T12:00:00Z',
};

const AGENT_URI = makeDataUri(AGENT_METADATA);

function makeBountyRecord(overrides: Record<string, unknown> = {}) {
  return {
    bountyAddress: '0xbounty0001',
    poster: TEST_OWNER.toLowerCase(),
    token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    amount: '1000000', // 1 USDC
    deadline: Math.floor(Date.now() / 1000) + 86400,
    taskURI: makeDataUri({ title: 'Fix bug in auth module' }),
    skillTags: ['solidity'],
    status: 'approved' as const,
    claimer: TEST_ADDRESS.toLowerCase(),
    createdBlock: 100,
    createdTxHash: '0xtx001',
    ...overrides,
  };
}

// ─── Mock Helpers ───────────────────────────────────────────────────

/**
 * Set up readContract to return the expected values for a full agent profile.
 * readContract is called multiple times with different functionNames.
 */
function setupAgentMocks(agentId: number = 42) {
  mockReadContract.mockImplementation(async (params: any) => {
    const fn = params.functionName;
    switch (fn) {
      case 'balanceOf':
        return 1n;
      case 'tokenOfOwnerByIndex':
        return BigInt(agentId);
      case 'ownerOf':
        return TEST_OWNER;
      case 'tokenURI':
        return AGENT_URI;
      case 'getSummary':
        // Returns [count, summaryValue, summaryValueDecimals]
        return [3n, 13n, 0n]; // 3 reviews, total 13, 0 decimals → avg 4.33
      default:
        throw new Error(`Unexpected readContract call: ${fn}`);
    }
  });
}

/** Set up mocks for an address with no registered agent */
function setupNoAgentMocks() {
  mockReadContract.mockImplementation(async (params: any) => {
    if (params.functionName === 'balanceOf') return 0n;
    throw new Error('Should not be called');
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('work_profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('has correct name', () => {
      expect(workProfileToolDefinition.name).toBe('work_profile');
    });

    it('accepts address or agentId', () => {
      const props = workProfileToolDefinition.inputSchema.properties as any;
      expect(props).toHaveProperty('address');
      expect(props).toHaveProperty('agentId');
    });
  });

  describe('Input Validation', () => {
    it('rejects when neither address nor agentId provided', async () => {
      const result = await handleWorkProfile({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Provide either');
    });
  });

  describe('Lookup by agentId', () => {
    it('reads tokenURI + ownerOf + getSummary for a given agentId', async () => {
      setupAgentMocks(42);

      const result = await handleWorkProfile({ agentId: 42 });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('TestBot');
      expect(text).toContain('Agent #42');
      expect(text).toContain('solidity, typescript');
    });

    it('shows reputation stars when reviews exist', async () => {
      setupAgentMocks(42);

      const result = await handleWorkProfile({ agentId: 42 });
      const text = result.content[0].text;

      // 3 reviews, avg 4.33 → rounds to 4 stars
      expect(text).toContain('4.3');
      expect(text).toContain('3 review');
    });

    it('shows services in profile', async () => {
      setupAgentMocks(42);

      const result = await handleWorkProfile({ agentId: 42 });
      expect(result.content[0].text).toContain('code-review, audits');
    });

    it('shows registration date', async () => {
      setupAgentMocks(42);

      const result = await handleWorkProfile({ agentId: 42 });
      // registeredAt: '2026-01-15T12:00:00Z' → formatted date
      expect(result.content[0].text).toContain('Registered');
    });

    it('shows description', async () => {
      setupAgentMocks(42);

      const result = await handleWorkProfile({ agentId: 42 });
      expect(result.content[0].text).toContain('A test agent for unit tests');
    });
  });

  describe('Lookup by address', () => {
    it('resolves agentId via balanceOf + tokenOfOwnerByIndex', async () => {
      setupAgentMocks(99);

      const result = await handleWorkProfile({ address: TEST_ADDRESS });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Agent #99');
      expect(result.content[0].text).toContain('TestBot');

      // Verify readContract was called with balanceOf first
      expect(mockReadContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: 'balanceOf' }),
      );
      expect(mockReadContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: 'tokenOfOwnerByIndex' }),
      );
    });
  });

  describe('Bounty-Only Fallback', () => {
    it('shows bounty-only profile when address has no agent but has bounties', async () => {
      setupNoAgentMocks();

      vi.mocked(getBountiesByPoster).mockReturnValue([makeBountyRecord() as any]);
      vi.mocked(getBountiesByClaimer).mockReturnValue([]);

      const result = await handleWorkProfile({ address: TEST_ADDRESS });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('Not registered as an agent');
      expect(text).toContain('Bounties Posted');
      expect(text).toContain('work_register');
    });

    it('shows claimed bounties in fallback profile', async () => {
      setupNoAgentMocks();

      vi.mocked(getBountiesByPoster).mockReturnValue([]);
      vi.mocked(getBountiesByClaimer).mockReturnValue([
        makeBountyRecord({ claimer: TEST_ADDRESS.toLowerCase() }) as any,
      ]);

      const result = await handleWorkProfile({ address: TEST_ADDRESS });
      expect(result.content[0].text).toContain('Bounties Claimed');
    });

    it('shows recent bounties in fallback', async () => {
      setupNoAgentMocks();

      const bounty = makeBountyRecord({
        status: 'approved',
        claimer: TEST_ADDRESS.toLowerCase(),
      });
      vi.mocked(getBountiesByPoster).mockReturnValue([]);
      vi.mocked(getBountiesByClaimer).mockReturnValue([bounty as any]);

      const result = await handleWorkProfile({ address: TEST_ADDRESS });
      expect(result.content[0].text).toContain('Recent Bounties');
    });
  });

  describe('No Profile Found', () => {
    it('returns no profile message when no agent and no bounties', async () => {
      setupNoAgentMocks();

      vi.mocked(getBountiesByPoster).mockReturnValue([]);
      vi.mocked(getBountiesByClaimer).mockReturnValue([]);

      const result = await handleWorkProfile({ address: TEST_ADDRESS });

      const text = result.content[0].text;
      expect(text).toContain('No profile found');
      expect(text).toContain('no registered agent');
      expect(text).toContain('work_register');
    });
  });

  describe('Full Profile with Bounty Enrichment', () => {
    it('shows completion rate from indexer data', async () => {
      setupAgentMocks(42);

      // Agent has claimed 4, completed 3
      const bounties = [
        makeBountyRecord({ status: 'approved', bountyAddress: '0xb1' }),
        makeBountyRecord({ status: 'approved', bountyAddress: '0xb2' }),
        makeBountyRecord({ status: 'approved', bountyAddress: '0xb3' }),
        makeBountyRecord({ status: 'claimed', bountyAddress: '0xb4' }),
      ];
      vi.mocked(getBountiesByClaimer).mockReturnValue(bounties as any);
      vi.mocked(getBountiesByPoster).mockReturnValue([]);

      const result = await handleWorkProfile({ agentId: 42 });
      const text = result.content[0].text;

      expect(text).toContain('Completed: 3');
      expect(text).toContain('Claimed: 4');
      expect(text).toContain('Completion Rate: 75%');
    });

    it('shows "No on-chain reviews yet" when reputation count is 0', async () => {
      mockReadContract.mockImplementation(async (params: any) => {
        const fn = params.functionName;
        switch (fn) {
          case 'balanceOf': return 1n;
          case 'tokenOfOwnerByIndex': return 10n;
          case 'ownerOf': return TEST_OWNER;
          case 'tokenURI': return AGENT_URI;
          case 'getSummary': return [0n, 0n, 0n]; // 0 reviews
          default: throw new Error(`Unexpected: ${fn}`);
        }
      });

      const result = await handleWorkProfile({ agentId: 10 });
      expect(result.content[0].text).toContain('No on-chain reviews yet');
    });

    it('shows recent bounties sorted by block descending, limited to 5', async () => {
      setupAgentMocks(42);

      const bounties = Array.from({ length: 8 }, (_, i) =>
        makeBountyRecord({
          bountyAddress: `0xbounty${i}`,
          poster: TEST_OWNER.toLowerCase(),
          createdBlock: 100 + i,
        }),
      );
      vi.mocked(getBountiesByPoster).mockReturnValue(bounties as any);
      vi.mocked(getBountiesByClaimer).mockReturnValue([]);

      const result = await handleWorkProfile({ agentId: 42 });
      const text = result.content[0].text;

      expect(text).toContain('Recent Bounties');
      // Count status icons — should be at most 5
      const iconMatches = text.match(/[✅🟢🔵📋⚪]/g) || [];
      expect(iconMatches.length).toBeLessThanOrEqual(5);
    });

    it('deduplicates bounties that appear in both posted and claimed', async () => {
      setupAgentMocks(42);

      const sharedBounty = makeBountyRecord({
        bountyAddress: '0xshared',
        poster: TEST_OWNER.toLowerCase(),
        claimer: TEST_OWNER.toLowerCase(),
      });
      vi.mocked(getBountiesByPoster).mockReturnValue([sharedBounty as any]);
      vi.mocked(getBountiesByClaimer).mockReturnValue([sharedBounty as any]);

      const result = await handleWorkProfile({ agentId: 42 });
      const text = result.content[0].text;

      // Should only show once
      const matches = text.match(/Fix bug in auth module/g) || [];
      expect(matches.length).toBe(1);
    });
  });

  describe('Error Handling', () => {
    it('renders profile with fallback name when readAgentMetadata fails', async () => {
      // When agentId is provided, readAgentMetadata and readReputation catch
      // errors internally and return null. The handler still renders a profile
      // with fallback name "Agent #42" and no reputation.
      mockReadContract.mockRejectedValue(new Error('RPC timeout'));

      const result = await handleWorkProfile({ agentId: 42 });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('Agent #42');
      expect(text).toContain('No on-chain reviews yet');
    });

    it('falls back to "Agent #999" when metadata not found', async () => {
      // readAgentMetadata catches and returns null → fallback name
      // readReputation catches and returns null → "No on-chain reviews"
      mockReadContract.mockRejectedValue(new Error('token does not exist'));

      const result = await handleWorkProfile({ agentId: 999 });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('Agent #999');
    });
  });
});
