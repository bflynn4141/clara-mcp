/**
 * Tests for wallet_claim_airdrop tool
 *
 * Tests eligibility checking, already-claimed detection, deadline expiry,
 * and successful claim preparation via MerkleDrop.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  claimAirdropToolDefinition,
  handleClaimAirdropRequest,
} from '../../tools/claim-airdrop.js';
import type { ToolContext } from '../../middleware.js';
import type { Hex } from 'viem';

// ─── Mocks ──────────────────────────────────────────────────────────

// Mock the CLARA contracts config
const mockReadContract = vi.fn();
const mockEstimateGas = vi.fn();

vi.mock('../../config/clara-contracts.js', () => ({
  getClaraContracts: vi.fn(() => ({
    claraToken: '0x514228D83ab8dcf1c0370Fca88444f2F85c6Ef55',
    claraStaking: '0x297BddB4284DC9a78de615D2F2CfB9DB922b4712',
    merkleDrop: '0xd626652314825C4D73fffc5B2b2C925DA0ad1bEc',
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
  })),
  getClaraNetwork: vi.fn(() => 'testnet'),
  getClaraPublicClient: vi.fn(() => ({
    readContract: mockReadContract,
    estimateGas: mockEstimateGas,
  })),
  MERKLE_DROP_ABI: [
    {
      inputs: [{ name: 'index', type: 'uint256' }],
      name: 'isClaimed',
      outputs: [{ name: '', type: 'bool' }],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [
        { name: 'index', type: 'uint256' },
        { name: 'account', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'proof', type: 'bytes32[]' },
      ],
      name: 'claim',
      outputs: [],
      stateMutability: 'nonpayable',
      type: 'function',
    },
    {
      inputs: [],
      name: 'deadline',
      outputs: [{ name: '', type: 'uint256' }],
      stateMutability: 'view',
      type: 'function',
    },
  ],
}));

// Mock the prepared-tx module
vi.mock('../../para/prepared-tx.js', () => ({
  storePreparedTx: vi.fn(() => 'ptx_test_123'),
  formatPreparedTx: vi.fn(() => '## Prepared Transaction: `ptx_test_123`\n\n✅ **Would Succeed**'),
  getPreparedTx: vi.fn(() => ({
    id: 'ptx_test_123',
    to: '0xd626652314825C4D73fffc5B2b2C925DA0ad1bEc',
    functionName: 'claim',
    simulation: { success: true },
  })),
}));

// Mock fs to provide merkle data without reading from disk
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify({
    root: '0xfdbc4f010fbfd47ac317b41246e4f669ccecc31f8fa95968063abc8aa3ddeecf',
    totalAmount: '10000000000000000000000000',
    recipients: [
      {
        index: 0,
        account: '0x7C5FA16118Df518AD0fF27eB108FE5C08f46E994',
        amount: '5000000000000000000000000',
        proof: [
          '0x3e1f8f2ab1a2ccc7717ce704fcf16bf2546ae0d24da63dadc2ea995f73d5d890',
          '0x6eaf434328c41a706649ce3ff6d47eb045af8ede58bc27ef4535776f41010a31',
        ],
      },
      {
        index: 1,
        account: '0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd',
        amount: '3000000000000000000000000',
        proof: [
          '0x3891e97b7db55e12a93822314a5924ba7738663ca0b6126a5f558d05a5bea36f',
          '0x6eaf434328c41a706649ce3ff6d47eb045af8ede58bc27ef4535776f41010a31',
        ],
      },
    ],
  })),
}));

// Mock session (needed by middleware if it runs)
vi.mock('../../storage/session.js', () => ({
  getSession: vi.fn(),
  touchSession: vi.fn(),
}));

// ─── Test Helpers ───────────────────────────────────────────────────

const BRIAN_ADDRESS = '0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd' as Hex;
const DEPLOYER_ADDRESS = '0x7C5FA16118Df518AD0fF27eB108FE5C08f46E994' as Hex;
const INELIGIBLE_ADDRESS = '0x0000000000000000000000000000000000000099' as Hex;

function makeCtx(address: Hex = BRIAN_ADDRESS): ToolContext {
  return {
    session: {
      authenticated: true,
      address,
      walletId: 'test-wallet-id',
    } as any,
    walletAddress: address,
  };
}

// Future deadline (1 year from now)
const FUTURE_DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60);
// Past deadline
const PAST_DEADLINE = BigInt(Math.floor(Date.now() / 1000) - 60);

// ─── Tests ──────────────────────────────────────────────────────────

describe('Claim Airdrop Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('has correct name and description', () => {
      expect(claimAirdropToolDefinition.name).toBe('wallet_claim_airdrop');
      expect(claimAirdropToolDefinition.description).toContain('airdrop');
      expect(claimAirdropToolDefinition.description).toContain('CLARA');
    });

    it('has optional address property', () => {
      const props = claimAirdropToolDefinition.inputSchema.properties as any;
      expect(props).toHaveProperty('address');
      // No required fields — defaults to wallet address
      expect(claimAirdropToolDefinition.inputSchema).not.toHaveProperty('required');
    });
  });

  describe('Ineligible Address', () => {
    it('returns not eligible for unknown address', async () => {
      const result = await handleClaimAirdropRequest(
        { address: INELIGIBLE_ADDRESS },
        makeCtx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Not eligible');
      expect(result.content[0].text).toContain(INELIGIBLE_ADDRESS);
    });
  });

  describe('Already Claimed', () => {
    it('returns already claimed when isClaimed is true', async () => {
      // isClaimed returns true, deadline returns future
      mockReadContract
        .mockResolvedValueOnce(true)       // isClaimed(1) → true
        .mockResolvedValueOnce(FUTURE_DEADLINE); // deadline() → future

      const result = await handleClaimAirdropRequest({}, makeCtx(BRIAN_ADDRESS));

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Already claimed');
      expect(result.content[0].text).toContain('3,000,000');
    });
  });

  describe('Expired Deadline', () => {
    it('returns expired when deadline has passed', async () => {
      // isClaimed returns false, deadline returns past
      mockReadContract
        .mockResolvedValueOnce(false)      // isClaimed(1) → false
        .mockResolvedValueOnce(PAST_DEADLINE); // deadline() → past

      const result = await handleClaimAirdropRequest({}, makeCtx(BRIAN_ADDRESS));

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Expired');
    });
  });

  describe('Eligible - Successful Claim Preparation', () => {
    it('prepares claim for eligible unclaimed address', async () => {
      // isClaimed returns false, deadline returns future
      mockReadContract
        .mockResolvedValueOnce(false)         // isClaimed(1) → false
        .mockResolvedValueOnce(FUTURE_DEADLINE); // deadline() → future

      // Gas estimation succeeds
      mockEstimateGas.mockResolvedValueOnce(80_000n);

      const result = await handleClaimAirdropRequest({}, makeCtx(BRIAN_ADDRESS));

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Eligible');
      expect(result.content[0].text).toContain('3,000,000');
      expect(result.content[0].text).toContain('ptx_test_123');
      expect(result.content[0].text).toContain('wallet_executePrepared');
    });

    it('prepares claim for deployer address via override', async () => {
      mockReadContract
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(FUTURE_DEADLINE);

      mockEstimateGas.mockResolvedValueOnce(80_000n);

      const result = await handleClaimAirdropRequest(
        { address: DEPLOYER_ADDRESS },
        makeCtx(BRIAN_ADDRESS), // ctx has Brian's address, but override uses deployer
      );

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Eligible');
      expect(result.content[0].text).toContain('5,000,000');
    });

    it('handles simulation failure gracefully', async () => {
      mockReadContract
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(FUTURE_DEADLINE);

      // Gas estimation fails
      mockEstimateGas.mockRejectedValueOnce(new Error('insufficient funds for gas'));

      const result = await handleClaimAirdropRequest({}, makeCtx(BRIAN_ADDRESS));

      // Should still return the prepared tx, but with error flag
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Simulation failed');
      expect(result.content[0].text).toContain('insufficient funds for gas');
    });
  });

  describe('Address Resolution', () => {
    it('uses ctx.walletAddress when no address arg provided', async () => {
      mockReadContract
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(FUTURE_DEADLINE);

      const result = await handleClaimAirdropRequest({}, makeCtx(BRIAN_ADDRESS));

      // Should find Brian's allocation (index 1)
      expect(result.content[0].text).toContain('3,000,000');
    });

    it('uses address arg when provided (case-insensitive)', async () => {
      mockReadContract
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(FUTURE_DEADLINE);

      // Pass uppercase version of deployer address
      const result = await handleClaimAirdropRequest(
        { address: '0x7C5FA16118DF518AD0FF27EB108FE5C08F46E994' },
        makeCtx(BRIAN_ADDRESS),
      );

      // Should find deployer's allocation (index 0) despite case mismatch
      expect(result.content[0].text).toContain('5,000,000');
    });
  });

  describe('Error Handling', () => {
    it('handles RPC errors gracefully', async () => {
      // isClaimed call fails
      mockReadContract.mockRejectedValueOnce(new Error('RPC timeout'));

      const result = await handleClaimAirdropRequest({}, makeCtx(BRIAN_ADDRESS));

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Airdrop check failed');
    });
  });
});
