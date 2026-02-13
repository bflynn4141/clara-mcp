/**
 * Tests for work_reputation tool
 *
 * Tests reputation lookup from the local indexer (AgentRecord +
 * ReputationSummary) enriched with bounty stats.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workReputationToolDefinition, handleWorkReputation } from '../../tools/work-reputation.js';

// ─── Mocks ──────────────────────────────────────────────────────────

vi.mock('../../indexer/queries.js', () => ({
  getAgentByAddress: vi.fn(() => null),
  getAgentByAgentId: vi.fn(() => null),
  getReputationSummary: vi.fn(() => null),
  getBountiesByPoster: vi.fn(() => []),
  getBountiesByClaimer: vi.fn(() => []),
}));

import {
  getAgentByAddress,
  getAgentByAgentId,
  getReputationSummary,
  getBountiesByPoster,
  getBountiesByClaimer,
} from '../../indexer/queries.js';

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

function makeAgentRecord(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 42,
    owner: TEST_OWNER,
    agentURI: AGENT_URI,
    name: 'ReputationBot',
    skills: ['solidity', 'auditing'],
    description: 'Reputation test agent',
    registeredBlock: 100,
    registeredTxHash: '0xreg001',
    ...overrides,
  };
}

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
  const avgRating = reviewCount > 0 ? totalValue / reviewCount : 0;
  const agent = makeAgentRecord({ agentId, owner: TEST_OWNER });

  vi.mocked(getAgentByAgentId).mockReturnValue(agent as any);
  vi.mocked(getAgentByAddress).mockReturnValue(agent as any);
  vi.mocked(getReputationSummary).mockReturnValue({
    count: reviewCount,
    averageRating: avgRating,
    totalValue,
  });
}

function setupNoAgentMocks() {
  vi.mocked(getAgentByAddress).mockReturnValue(null);
  vi.mocked(getAgentByAgentId).mockReturnValue(null);
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
      // 5 reviews, total 22 → avg 4.4
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
    it('resolves agentId from address via getAgentByAddress', async () => {
      const agent = makeAgentRecord({ agentId: 77 });
      vi.mocked(getAgentByAddress).mockReturnValue(agent as any);
      vi.mocked(getReputationSummary).mockReturnValue({
        count: 5,
        averageRating: 4.4,
        totalValue: 22,
      });

      const result = await handleWorkReputation({ address: TEST_ADDRESS });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('77');
      expect(getAgentByAddress).toHaveBeenCalledWith(TEST_ADDRESS);
    });
  });

  describe('No On-Chain Reputation', () => {
    it('shows "no on-chain reputation yet" when reputation count is 0', async () => {
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

  describe('Agent Not Found (Graceful Degradation)', () => {
    it('returns success with "not registered" when address has no agent', async () => {
      setupNoAgentMocks();

      const result = await handleWorkReputation({ address: TEST_ADDRESS });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('Not registered as an agent');
      expect(text).toContain('work_register');
    });

    it('includes the formatted address in the output', async () => {
      setupNoAgentMocks();

      const result = await handleWorkReputation({ address: TEST_ADDRESS });
      expect(result.content[0].text).toContain('0xabcd...ef12');
    });

    it('returns success with "not registered" when agentId not found', async () => {
      vi.mocked(getAgentByAgentId).mockReturnValue(null);

      const result = await handleWorkReputation({ agentId: 999 });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Not registered as an agent');
    });
  });

  describe('Reputation Calculation', () => {
    it('calculates average with decimals', async () => {
      // The indexer pre-computes the average: 4.5
      const agent = makeAgentRecord({ agentId: 5 });
      vi.mocked(getAgentByAgentId).mockReturnValue(agent as any);
      vi.mocked(getReputationSummary).mockReturnValue({
        count: 2,
        averageRating: 4.5,
        totalValue: 9,
      });

      const result = await handleWorkReputation({ agentId: 5 });
      expect(result.content[0].text).toContain('4.5');
    });

    it('handles zero reviews gracefully (no divide by zero)', async () => {
      const agent = makeAgentRecord({ agentId: 1 });
      vi.mocked(getAgentByAgentId).mockReturnValue(agent as any);
      vi.mocked(getReputationSummary).mockReturnValue({
        count: 0,
        averageRating: 0,
        totalValue: 0,
      });

      const result = await handleWorkReputation({ agentId: 1 });
      expect(result.isError).toBeUndefined();
    });

    it('handles agent not in index with graceful degradation', async () => {
      vi.mocked(getAgentByAgentId).mockReturnValue(null);

      const result = await handleWorkReputation({ agentId: 1 });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Not registered as an agent');
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
