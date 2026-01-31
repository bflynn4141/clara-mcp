/**
 * Tests for credits tool
 *
 * Tests wallet_credits tool for ClaraCredits balance checking.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { creditsToolDefinition, handleCreditsRequest } from '../../tools/credits.js';

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
      readContract: vi.fn(),
    })),
  };
});

import { getSession, touchSession } from '../../storage/session.js';
import { createPublicClient } from 'viem';

describe('Credits Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('has correct name and description', () => {
      expect(creditsToolDefinition.name).toBe('wallet_credits');
      expect(creditsToolDefinition.description).toContain('Credits');
      expect(creditsToolDefinition.description).toContain('prepaid');
    });

    it('has empty required properties (no input needed)', () => {
      expect(creditsToolDefinition.inputSchema.type).toBe('object');
      expect(Object.keys(creditsToolDefinition.inputSchema.properties)).toHaveLength(0);
    });

    it('mentions cost per operation', () => {
      expect(creditsToolDefinition.description).toContain('$0.001');
    });
  });

  describe('handleCreditsRequest - Session', () => {
    it('requires wallet setup', async () => {
      vi.mocked(getSession).mockResolvedValue(null);

      const result = await handleCreditsRequest({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Wallet not configured');
    });

    it('requires authenticated session', async () => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: false,
      });

      const result = await handleCreditsRequest({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Wallet not configured');
    });

    it('requires address in session', async () => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: undefined,
      });

      const result = await handleCreditsRequest({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Wallet not configured');
    });
  });

  describe('handleCreditsRequest - Balance Checking', () => {
    beforeEach(() => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        walletId: 'test-wallet-id',
      });
      vi.mocked(touchSession).mockResolvedValue(undefined);
    });

    it('shows zero balance with deposit instructions', async () => {
      const mockClient = {
        readContract: vi.fn()
          .mockResolvedValueOnce(0n) // credits balance
          .mockResolvedValueOnce(0n), // available operations
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleCreditsRequest({});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Clara Credits');
      expect(result.content[0].text).toContain('$0.0000');
      expect(result.content[0].text).toContain('No Credits');
      expect(result.content[0].text).toContain('deposit');
    });

    it('shows low balance warning', async () => {
      // Low balance: 5 operations worth ($0.005)
      const mockClient = {
        readContract: vi.fn()
          .mockResolvedValueOnce(5000n) // credits balance ($0.005)
          .mockResolvedValueOnce(5n), // 5 available operations
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleCreditsRequest({});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Low Credits');
      expect(result.content[0].text).toContain('5 operations remaining');
    });

    it('shows healthy balance', async () => {
      // Healthy balance: 1000 operations worth ($1.00)
      const mockClient = {
        readContract: vi.fn()
          .mockResolvedValueOnce(1000000n) // credits balance ($1.00)
          .mockResolvedValueOnce(1000n), // 1000 available operations
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleCreditsRequest({});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Credits Active');
      expect(result.content[0].text).toContain('1,000 signing operations');
    });

    it('touches session after successful check', async () => {
      const mockClient = {
        readContract: vi.fn()
          .mockResolvedValueOnce(1000000n)
          .mockResolvedValueOnce(1000n),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      await handleCreditsRequest({});

      expect(touchSession).toHaveBeenCalled();
    });
  });

  describe('handleCreditsRequest - Error Handling', () => {
    beforeEach(() => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        walletId: 'test-wallet-id',
      });
      vi.mocked(touchSession).mockResolvedValue(undefined);
    });

    it('handles contract read errors', async () => {
      const mockClient = {
        readContract: vi.fn().mockRejectedValue(new Error('Contract not found')),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleCreditsRequest({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to fetch credits');
      expect(result.content[0].text).toContain('Contract not found');
    });

    it('handles RPC errors', async () => {
      const mockClient = {
        readContract: vi.fn().mockRejectedValue(new Error('RPC timeout')),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleCreditsRequest({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('RPC timeout');
    });
  });
});
