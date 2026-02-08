/**
 * Tests for work_reputation tool
 *
 * Tests reputation lookup from on-chain contracts (IdentityRegistry +
 * ReputationRegistry) enriched with local indexer bounty stats.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workReputationToolDefinition, handleWorkReputation } from '../../tools/work-reputation.js';

// ─── Mocks ──────────────────────────────────────────────────────────

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

vi.mock('../../indexer/queries.js', () => ({
  getBountiesByPoster: vi.fn(() => []),
  getBountiesByClaimer: vi.fn(() => []),
}));

import { getBountiesByPoster, getBountiesByClaimer } from '../../indexer/queries.js';

// ─── Test Data ──────────────────────────────────────────────────────

const TEST_ADDRESS = '0xabcdef1234567890abcdef1234567890abcdef12';
const TEST_OWNER = '0x1111111111111111111111111111111111111111';

function makeDataUri(obj: Record<string, unknown>): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(obj)).toString('base64')}`;
}

const AGENT_URI = makeDataUri({
  name: 'ReputationBot',
  skills: ['solidity', 'auditing'],
  description: 'Reputation test agent',
});

function makeBountyRecord(overrides: Record<string, unknown> = {}) {
  return {
    bountyAddress: '0xbounty0001',
    poster: TEST_OWNER.toLowerCase(),
    token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    amount: '1000000',
    deadline: Math.floor(Date.now() / 1000) + 86400,
    taskURI: makeDataUri({ title: 'Test bounty' }),
    skillTags: ['solidity'],
    status: 'approved' as const,
    createdBlock: 100,
    createdTxHash: '0xtx001',
    ...overrides,
  };
}

// ─── Mock Setup Helpers ─────────────────────────────────────────────

function setupFullAgentMocks(agentId: number = 42, reviewCount: number = 5, totalValue: number = 22) {
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
        return [BigInt(reviewCount), BigInt(totalValue), 0n];
      default:
        throw new Error(`Unexpected readContract call: ${fn}`);
    }
  });
}

function setupNoAgentMocks() {
  mockReadContract.mockImplementation(async (params: any) => {
    if (params.functionName === 'balanceOf') return 0n;
    throw new Error('Should not be called');
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('work_reputation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('has correct name', () => {
      expect(workReputationToolDefinition.name).toBe('work_reputation');
    });

    it('accepts address or agentId', () => {
      const props = workReputationToolDefinition.inputSchema.properties as any;
      expect(props).toHaveProperty('address');
      expect(props).toHaveProperty('agentId');
    });
  });

  describe('Input Validation', () => {
    it('rejects when neither address nor agentId provided', async () => {
      const result = await handleWorkReputation({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Provide either');
    });
  });

  describe('Reputation Display with On-Chain Data', () => {
    it('shows agent name and ID', async () => {
      setupFullAgentMocks(42, 5, 22);

      const result = await handleWorkReputation({ agentId: 42 });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('ReputationBot');
      expect(text).toContain('42');
    });

    it('shows rating from on-chain reputation', async () => {
      // 5 reviews, total 22, 0 decimals → avg 4.4
      setupFullAgentMocks(42, 5, 22);

      const result = await handleWorkReputation({ agentId: 42 });
      const text = result.content[0].text;

      expect(text).toContain('4.4');
      expect(text).toContain('5 review');
    });

    it('shows skills from agent metadata', async () => {
      setupFullAgentMocks(42);

      const result = await handleWorkReputation({ agentId: 42 });
      expect(result.content[0].text).toContain('solidity, auditing');
    });

    it('shows formatted address', async () => {
      setupFullAgentMocks(42);

      const result = await handleWorkReputation({ agentId: 42 });
      // formatAddress truncates to 0x1111...1111
      expect(result.content[0].text).toContain('0x1111...1111');
    });

    it('enriches with bounty stats from local indexer', async () => {
      setupFullAgentMocks(42, 3, 12);

      vi.mocked(getBountiesByPoster).mockReturnValue([
        makeBountyRecord({ bountyAddress: '0xp1' }) as any,
        makeBountyRecord({ bountyAddress: '0xp2' }) as any,
      ]);
      vi.mocked(getBountiesByClaimer).mockReturnValue([
        makeBountyRecord({ status: 'approved', bountyAddress: '0xc1' }) as any,
        makeBountyRecord({ status: 'approved', bountyAddress: '0xc2' }) as any,
        makeBountyRecord({ status: 'claimed', bountyAddress: '0xc3' }) as any,
      ]);

      const result = await handleWorkReputation({ agentId: 42 });
      const text = result.content[0].text;

      expect(text).toContain('Posted Bounties:** 2');
      expect(text).toContain('Claimed Bounties:** 3');
      expect(text).toContain('Completed:** 2');
      expect(text).toContain('Completion Rate:** 67%');
    });

    it('shows single review (no plural s)', async () => {
      setupFullAgentMocks(42, 1, 5);

      const result = await handleWorkReputation({ agentId: 42 });
      // Should say "1 review" not "1 reviews"
      expect(result.content[0].text).toMatch(/1 review(?!s)/);
    });
  });

  describe('Address Resolution', () => {
    it('resolves agentId from address via balanceOf + tokenOfOwnerByIndex', async () => {
      setupFullAgentMocks(77);

      const result = await handleWorkReputation({ address: TEST_ADDRESS });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('77');
      expect(mockReadContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: 'balanceOf' }),
      );
    });
  });

  describe('No On-Chain Reputation', () => {
    it('shows "no on-chain reputation yet" when getSummary count is 0', async () => {
      setupFullAgentMocks(42, 0, 0);

      const result = await handleWorkReputation({ agentId: 42 });
      const text = result.content[0].text;

      expect(text).toContain('No on-chain reputation feedback yet');
      // Should NOT show a rating line
      expect(text).not.toContain('/5');
    });

    it('still shows bounty stats when no reputation', async () => {
      setupFullAgentMocks(42, 0, 0);
      vi.mocked(getBountiesByPoster).mockReturnValue([
        makeBountyRecord() as any,
      ]);

      const result = await handleWorkReputation({ agentId: 42 });
      const text = result.content[0].text;

      expect(text).toContain('Posted Bounties:** 1');
      expect(text).toContain('No on-chain reputation feedback yet');
    });
  });

  describe('Agent Not Found', () => {
    it('returns error when address has no registered agent', async () => {
      setupNoAgentMocks();

      const result = await handleWorkReputation({ address: TEST_ADDRESS });

      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('Agent not found');
      expect(text).toContain('work_register');
    });

    it('includes the formatted address in the error', async () => {
      setupNoAgentMocks();

      const result = await handleWorkReputation({ address: TEST_ADDRESS });
      expect(result.content[0].text).toContain('0xabcd...ef12');
    });

    it('falls back to "Agent #999" when metadata not found', async () => {
      // When agentId is provided, readAgentMetadata and readReputation catch
      // their own errors and return null. The handler still renders reputation
      // with fallback name "Agent #999".
      mockReadContract.mockRejectedValue(new Error('not found'));

      const result = await handleWorkReputation({ agentId: 999 });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('Agent #999');
      expect(text).toContain('No on-chain reputation');
    });
  });

  describe('Reputation Calculation', () => {
    it('calculates average with decimals', async () => {
      // 2 reviews, total 9, 1 decimal → 9/10/2 = 0.45... wait, let me re-check
      // getSummary returns [count, summaryValue, summaryValueDecimals]
      // avg = summaryValue / (10^decimals) / count
      // = 90 / (10^1) / 2 = 90/10/2 = 4.5
      mockReadContract.mockImplementation(async (params: any) => {
        const fn = params.functionName;
        switch (fn) {
          case 'balanceOf': return 1n;
          case 'tokenOfOwnerByIndex': return 5n;
          case 'ownerOf': return TEST_OWNER;
          case 'tokenURI': return AGENT_URI;
          case 'getSummary': return [2n, 90n, 1n]; // 90 / 10^1 / 2 = 4.5
          default: throw new Error(`Unexpected: ${fn}`);
        }
      });

      const result = await handleWorkReputation({ agentId: 5 });
      expect(result.content[0].text).toContain('4.5');
    });

    it('handles zero reviews gracefully (no divide by zero)', async () => {
      mockReadContract.mockImplementation(async (params: any) => {
        const fn = params.functionName;
        switch (fn) {
          case 'ownerOf': return TEST_OWNER;
          case 'tokenURI': return AGENT_URI;
          case 'getSummary': return [0n, 0n, 0n];
          default: throw new Error(`Unexpected: ${fn}`);
        }
      });

      const result = await handleWorkReputation({ agentId: 1 });
      expect(result.isError).toBeUndefined();
      // avg = 0 (count > 0 check prevents divide-by-zero)
    });

    it('handles readReputation returning null (contract call fails)', async () => {
      mockReadContract.mockImplementation(async (params: any) => {
        const fn = params.functionName;
        switch (fn) {
          case 'ownerOf': return TEST_OWNER;
          case 'tokenURI': return AGENT_URI;
          case 'getSummary': throw new Error('contract reverted');
          default: throw new Error(`Unexpected: ${fn}`);
        }
      });

      const result = await handleWorkReputation({ agentId: 1 });
      // readReputation catches and returns null, so profile still renders
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('No on-chain reputation');
    });
  });

  describe('Completion Rate Edge Cases', () => {
    it('does not show completion rate with 0 claimed bounties', async () => {
      setupFullAgentMocks(42, 0, 0);
      vi.mocked(getBountiesByClaimer).mockReturnValue([]);

      const result = await handleWorkReputation({ agentId: 42 });
      expect(result.content[0].text).not.toContain('Completion Rate');
    });

    it('shows 100% completion rate when all claimed are approved', async () => {
      setupFullAgentMocks(42, 3, 14);
      vi.mocked(getBountiesByClaimer).mockReturnValue([
        makeBountyRecord({ status: 'approved', bountyAddress: '0xb1' }) as any,
        makeBountyRecord({ status: 'approved', bountyAddress: '0xb2' }) as any,
      ]);

      const result = await handleWorkReputation({ agentId: 42 });
      expect(result.content[0].text).toContain('Completion Rate:** 100%');
    });
  });
});
