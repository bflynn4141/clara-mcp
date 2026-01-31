/**
 * Tests for balance tool
 *
 * Tests wallet_balance tool with mocked RPC responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { balanceToolDefinition, handleBalanceRequest } from '../../tools/balance.js';

// Mock session storage
vi.mock('../../storage/session.js', () => ({
  getSession: vi.fn(),
  touchSession: vi.fn(),
}));

// Mock viem
vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBalance: vi.fn(),
      readContract: vi.fn(),
    })),
  };
});

import { getSession, touchSession } from '../../storage/session.js';
import { createPublicClient } from 'viem';

describe('Balance Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('has correct name and description', () => {
      expect(balanceToolDefinition.name).toBe('wallet_balance');
      expect(balanceToolDefinition.description).toContain('balance');
    });

    it('has correct input schema', () => {
      expect(balanceToolDefinition.inputSchema.type).toBe('object');
      expect(balanceToolDefinition.inputSchema.properties).toHaveProperty('chain');
      expect(balanceToolDefinition.inputSchema.properties.chain.enum).toContain('base');
      expect(balanceToolDefinition.inputSchema.properties.chain.enum).toContain('ethereum');
    });
  });

  describe('handleBalanceRequest', () => {
    it('rejects unsupported chains', async () => {
      const result = await handleBalanceRequest({ chain: 'solana' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unsupported chain');
      expect(result.content[0].text).toContain('solana');
    });

    it('requires wallet setup', async () => {
      vi.mocked(getSession).mockResolvedValue(null);

      const result = await handleBalanceRequest({ chain: 'base' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Wallet not configured');
    });

    it('requires authenticated session', async () => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: false,
      });

      const result = await handleBalanceRequest({ chain: 'base' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Wallet not configured');
    });

    it('fetches balances with valid session', async () => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        walletId: 'test-wallet-id',
      });
      vi.mocked(touchSession).mockResolvedValue(undefined);

      const mockClient = {
        getBalance: vi.fn().mockResolvedValue(1000000000000000000n), // 1 ETH
        readContract: vi.fn().mockResolvedValue(1000000n), // 1 USDC
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleBalanceRequest({ chain: 'base' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Wallet Balance: base');
      expect(result.content[0].text).toContain('0x1234567890123456789012345678901234567890');
      expect(touchSession).toHaveBeenCalled();
    });

    it('defaults to base chain', async () => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        walletId: 'test-wallet-id',
      });
      vi.mocked(touchSession).mockResolvedValue(undefined);

      const mockClient = {
        getBalance: vi.fn().mockResolvedValue(0n),
        readContract: vi.fn().mockResolvedValue(0n),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleBalanceRequest({});

      expect(result.content[0].text).toContain('base');
    });

    it('handles RPC errors gracefully', async () => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        walletId: 'test-wallet-id',
      });
      vi.mocked(touchSession).mockResolvedValue(undefined);

      vi.mocked(createPublicClient).mockReturnValue({
        getBalance: vi.fn().mockRejectedValue(new Error('RPC timeout')),
        readContract: vi.fn(),
      } as any);

      const result = await handleBalanceRequest({ chain: 'base' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to fetch balances');
      expect(result.content[0].text).toContain('RPC timeout');
    });
  });
});
