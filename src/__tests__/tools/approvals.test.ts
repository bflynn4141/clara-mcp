/**
 * Tests for approvals tool
 *
 * Tests wallet_approvals tool with mocked RPC responses.
 *
 * NOTE: Session validation is handled by middleware (not the handler).
 * The handler receives a pre-validated ToolContext from middleware.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { approvalsToolDefinition, handleApprovalsRequest } from '../../tools/approvals.js';
import type { ToolContext } from '../../middleware.js';
import type { Hex } from 'viem';

// Mock session storage (used by middleware, kept for compatibility)
vi.mock('../../storage/session.js', () => ({
  getSession: vi.fn(),
  touchSession: vi.fn(),
}));

// Mock chains config
vi.mock('../../config/chains.js', () => ({
  CHAINS: {
    base: { chainId: 8453, chain: { id: 8453, name: 'Base' }, explorerUrl: 'https://basescan.org' },
    ethereum: { chainId: 1, chain: { id: 1, name: 'Ethereum' }, explorerUrl: 'https://etherscan.io' },
  },
  getRpcUrl: vi.fn(() => 'https://rpc.base.org'),
  isSupportedChain: vi.fn((chain: string) => ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'].includes(chain)),
}));

// Mock viem
vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: vi.fn(),
    })),
    encodeFunctionData: vi.fn(() => '0x095ea7b3...'),
  };
});

// Mock transaction signing
vi.mock('../../para/transactions.js', () => ({
  signAndSendTransaction: vi.fn(),
}));

import { createPublicClient } from 'viem';
import { signAndSendTransaction } from '../../para/transactions.js';

// ─── Test Helpers ───────────────────────────────────────────────────

const TEST_ADDRESS = '0x1234567890123456789012345678901234567890' as Hex;

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

describe('Approvals Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('has correct name and description', () => {
      expect(approvalsToolDefinition.name).toBe('wallet_approvals');
      expect(approvalsToolDefinition.description).toContain('approvals');
      expect(approvalsToolDefinition.description).toContain('token');
    });

    it('has action enum', () => {
      const props = approvalsToolDefinition.inputSchema.properties;
      expect(props.action.enum).toContain('view');
      expect(props.action.enum).toContain('revoke');
    });

    it('has no required fields', () => {
      expect(approvalsToolDefinition.inputSchema.required).toEqual([]);
    });
  });

  describe('handleApprovalsRequest - Input Validation', () => {
    it('rejects unsupported chain', async () => {
      const result = await handleApprovalsRequest({
        action: 'view',
        chain: 'solana',
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unsupported chain');
    });

    it('revoke requires token and spender', async () => {
      // Mock client
      const mockClient = {
        readContract: vi.fn().mockResolvedValue(0n),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleApprovalsRequest({
        action: 'revoke',
        // missing token and spender
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('token');
      expect(result.content[0].text).toContain('spender');
    });

    it('rejects invalid spender address format', async () => {
      // Mock client
      const mockClient = {
        readContract: vi.fn().mockResolvedValue(0n),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleApprovalsRequest({
        action: 'revoke',
        token: 'USDC',
        spender: 'invalid-spender',
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid');
    });
  });

  describe('handleApprovalsRequest - View Action', () => {
    it('shows approvals when found', async () => {
      const mockClient = {
        readContract: vi.fn()
          .mockResolvedValueOnce(BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')) // Unlimited approval
          .mockResolvedValue(0n), // Other checks return 0
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleApprovalsRequest({
        action: 'view',
        chain: 'base',
      }, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Token Approvals');
    });

    it('shows no approvals message', async () => {
      const mockClient = {
        readContract: vi.fn().mockResolvedValue(0n),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleApprovalsRequest({
        action: 'view',
        chain: 'base',
      }, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('No active approvals');
    });

    it('handles RPC errors gracefully by skipping failed checks', async () => {
      const mockClient = {
        readContract: vi.fn().mockRejectedValue(new Error('RPC timeout')),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleApprovalsRequest({
        action: 'view',
        chain: 'base',
      }, makeCtx());

      // Individual errors are caught, so result shows no approvals
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('No active approvals');
    });
  });

  describe('handleApprovalsRequest - Revoke Action', () => {
    beforeEach(() => {
      // Mock client for view checks
      const mockClient = {
        readContract: vi.fn().mockResolvedValue(0n),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);
    });

    it('revokes approval successfully', async () => {
      vi.mocked(signAndSendTransaction).mockResolvedValue({
        txHash: '0xrevoke123456789012345678901234567890123456789012345678901234567890',
      });

      const result = await handleApprovalsRequest({
        action: 'revoke',
        token: 'USDC',
        spender: '0x1111111254fb6c44bAC0beD2854e76F90643097d',
        chain: 'base',
      }, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Approval Revoked');
      expect(result.content[0].text).toContain('0xrevoke123');
    });

    it('handles revoke errors', async () => {
      vi.mocked(signAndSendTransaction).mockRejectedValue(new Error('Transaction failed'));

      const result = await handleApprovalsRequest({
        action: 'revoke',
        token: 'USDC',
        spender: '0x1111111254fb6c44bAC0beD2854e76F90643097d',
        chain: 'base',
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Transaction failed');
    });

    it('sends approve(0) transaction', async () => {
      vi.mocked(signAndSendTransaction).mockResolvedValue({
        txHash: '0xrevoke123456789012345678901234567890123456789012345678901234567890',
      });

      await handleApprovalsRequest({
        action: 'revoke',
        token: 'USDC',
        spender: '0x1111111254fb6c44bAC0beD2854e76F90643097d',
        chain: 'base',
      }, makeCtx());

      expect(signAndSendTransaction).toHaveBeenCalledWith(
        'test-wallet-id',
        expect.objectContaining({
          chainId: 8453,
        })
      );
    });
  });

  describe('handleApprovalsRequest - Unknown Action', () => {
    it('rejects unknown action', async () => {
      const mockClient = {
        readContract: vi.fn().mockResolvedValue(0n),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleApprovalsRequest({
        action: 'invalid',
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown action');
    });
  });
});
