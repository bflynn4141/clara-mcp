/**
 * Tests for send tool
 *
 * Tests wallet_send tool with input validation and mocked transactions.
 *
 * NOTE: Session validation is handled by middleware (not the handler).
 * The handler receives a pre-validated ToolContext from middleware.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendToolDefinition, handleSendRequest } from '../../tools/send.js';
import type { ToolContext } from '../../middleware.js';
import type { Hex } from 'viem';

// Mock session storage (used by middleware, kept for compatibility)
vi.mock('../../storage/session.js', () => ({
  getSession: vi.fn(),
  touchSession: vi.fn(),
}));

// Mock transaction signing
vi.mock('../../para/transactions.js', () => ({
  signAndSendTransaction: vi.fn(),
}));

// Mock token resolution
vi.mock('../../config/tokens.js', () => ({
  resolveToken: vi.fn(),
}));

// Mock spending limits
vi.mock('../../storage/spending.js', () => ({
  checkSpendingLimits: vi.fn(() => ({ allowed: true })),
  recordSpending: vi.fn(),
}));

// Mock risk assessment
vi.mock('../../services/risk.js', () => ({
  assessContractRisk: vi.fn(),
  formatRiskAssessment: vi.fn(() => []),
  quickSafeCheck: vi.fn(() => true),
}));

// Mock gas preflight
vi.mock('../../gas-preflight.js', () => ({
  requireGas: vi.fn(),
  checkGasPreflight: vi.fn(),
}));

// Mock viem's createPublicClient to prevent real RPC calls during simulation
// The handler calls client.call() to simulate transactions before signing,
// and client.getCode() to check if recipient is a contract (isContract).
vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      call: vi.fn().mockResolvedValue(undefined),
      getCode: vi.fn().mockResolvedValue('0x'),
    })),
  };
});

import { signAndSendTransaction } from '../../para/transactions.js';
import { resolveToken } from '../../config/tokens.js';

// ─── Test Helpers ───────────────────────────────────────────────────

const TEST_ADDRESS = '0xabcdef1234567890abcdef1234567890abcdef12' as Hex;

function makeCtx(address: Hex = TEST_ADDRESS): ToolContext {
  return {
    session: {
      authenticated: true,
      address,
      walletId: 'test-wallet-id',
    } as any,
    walletAddress: address,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Send Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('has correct name and description', () => {
      expect(sendToolDefinition.name).toBe('wallet_send');
      expect(sendToolDefinition.description).toContain('Send');
      expect(sendToolDefinition.description).toContain('real money');
    });

    it('has required fields', () => {
      expect(sendToolDefinition.inputSchema.required).toContain('to');
      expect(sendToolDefinition.inputSchema.required).toContain('amount');
    });

    it('has correct properties', () => {
      const props = sendToolDefinition.inputSchema.properties;
      expect(props).toHaveProperty('to');
      expect(props).toHaveProperty('amount');
      expect(props).toHaveProperty('chain');
      expect(props).toHaveProperty('token');
      expect(props.chain.enum).toContain('base');
    });
  });

  describe('handleSendRequest - Input Validation', () => {
    it('rejects missing recipient address', async () => {
      const result = await handleSendRequest({ amount: '1.0' }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid recipient address');
    });

    it('rejects invalid address format', async () => {
      const result = await handleSendRequest({
        to: 'not-an-address',
        amount: '1.0',
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid recipient address');
    });

    it('rejects address with wrong length', async () => {
      const result = await handleSendRequest({
        to: '0x123', // Too short
        amount: '1.0',
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid recipient address');
    });

    it('rejects missing amount', async () => {
      const result = await handleSendRequest({
        to: '0x1234567890123456789012345678901234567890',
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid amount');
    });

    it('rejects invalid amount (not a number)', async () => {
      const result = await handleSendRequest({
        to: '0x1234567890123456789012345678901234567890',
        amount: 'abc',
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid amount');
    });

    it('rejects zero amount', async () => {
      const result = await handleSendRequest({
        to: '0x1234567890123456789012345678901234567890',
        amount: '0',
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid amount');
    });

    it('rejects negative amount', async () => {
      const result = await handleSendRequest({
        to: '0x1234567890123456789012345678901234567890',
        amount: '-1',
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid amount');
    });

    it('rejects unsupported chain', async () => {
      const result = await handleSendRequest({
        to: '0x1234567890123456789012345678901234567890',
        amount: '1.0',
        chain: 'solana',
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unsupported chain');
    });
  });

  describe('handleSendRequest - Native Token Transfer', () => {
    it('sends native token successfully', async () => {
      vi.mocked(signAndSendTransaction).mockResolvedValue({
        txHash: '0xabc123def456789012345678901234567890123456789012345678901234567890',
      });

      const result = await handleSendRequest({
        to: '0x1234567890123456789012345678901234567890',
        amount: '0.1',
        chain: 'base',
      }, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Transaction sent');
      expect(result.content[0].text).toContain('0.1');
      expect(result.content[0].text).toContain('ETH');
      expect(signAndSendTransaction).toHaveBeenCalledWith(
        'test-wallet-id',
        expect.objectContaining({
          to: '0x1234567890123456789012345678901234567890',
          chainId: 8453, // Base
        })
      );
    });

    it('handles transaction errors', async () => {
      vi.mocked(signAndSendTransaction).mockRejectedValue(
        new Error('Insufficient funds')
      );

      const result = await handleSendRequest({
        to: '0x1234567890123456789012345678901234567890',
        amount: '100',
        chain: 'base',
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Send failed');
      expect(result.content[0].text).toContain('Insufficient funds');
    });
  });

  describe('handleSendRequest - ERC20 Token Transfer', () => {
    it('sends ERC20 token successfully', async () => {
      vi.mocked(resolveToken).mockReturnValue({
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        symbol: 'USDC',
        decimals: 6,
      });
      vi.mocked(signAndSendTransaction).mockResolvedValue({
        txHash: '0xabc123def456789012345678901234567890123456789012345678901234567890',
      });

      const result = await handleSendRequest({
        to: '0x1234567890123456789012345678901234567890',
        amount: '100',
        chain: 'base',
        token: 'USDC',
      }, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Transaction sent');
      expect(result.content[0].text).toContain('100');
      expect(result.content[0].text).toContain('USDC');
      expect(signAndSendTransaction).toHaveBeenCalledWith(
        'test-wallet-id',
        expect.objectContaining({
          to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC contract
          value: 0n, // ERC20 transfers send 0 ETH
          data: expect.stringContaining('0x'), // Has transfer calldata
        })
      );
    });

    it('rejects unknown token', async () => {
      vi.mocked(resolveToken).mockReturnValue(null);

      const result = await handleSendRequest({
        to: '0x1234567890123456789012345678901234567890',
        amount: '100',
        chain: 'base',
        token: 'FAKE',
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown token');
      expect(result.content[0].text).toContain('FAKE');
    });
  });
});
