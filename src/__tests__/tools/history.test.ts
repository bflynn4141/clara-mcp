/**
 * Tests for history tool
 *
 * Tests wallet_history tool with mocked Zerion API responses.
 *
 * NOTE: ZERION_API_KEY is captured at module load time in history.ts.
 * We use vi.hoisted() to set the env var before any module loading.
 *
 * NOTE: Session validation is handled by middleware (not the handler).
 * The handler receives a pre-validated ToolContext from middleware.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../middleware.js';
import type { Hex } from 'viem';

// Use vi.hoisted to set env var before module loading
vi.hoisted(() => {
  process.env.ZERION_API_KEY = 'test-zerion-key';
});

// Mock session storage (used by middleware, kept for compatibility)
vi.mock('../../storage/session.js', () => ({
  getSession: vi.fn(),
  touchSession: vi.fn(),
}));

// Mock fetch for Zerion API
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Now import (after env is set via hoisted)
import { historyToolDefinition, handleHistoryRequest } from '../../tools/history.js';

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

describe('History Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fetch mock for each test
    mockFetch.mockReset();
  });

  describe('Tool Definition', () => {
    it('has correct name and description', () => {
      expect(historyToolDefinition.name).toBe('wallet_history');
      expect(historyToolDefinition.description).toContain('history');
      expect(historyToolDefinition.description).toContain('transaction');
    });

    it('has limit and chain properties', () => {
      const props = historyToolDefinition.inputSchema.properties;
      expect(props).toHaveProperty('limit');
      expect(props).toHaveProperty('chain');
      expect(props.limit.default).toBe(10);
    });

    it('has no required fields', () => {
      expect(historyToolDefinition.inputSchema.required).toEqual([]);
    });
  });

  describe('handleHistoryRequest - Input Validation', () => {
    it('rejects unsupported chain', async () => {
      const result = await handleHistoryRequest({
        chain: 'solana',
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unsupported chain');
    });

    it('accepts valid limit', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      const result = await handleHistoryRequest({
        limit: 5,
      }, makeCtx());

      expect(result.isError).toBeUndefined();
    });
  });

  describe('handleHistoryRequest - Transaction Display', () => {
    it('displays transaction history', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: [
            {
              type: 'transactions',
              id: 'tx1',
              attributes: {
                hash: '0xabc123',
                operation_type: 'send',
                mined_at: '2024-01-15T10:30:00Z',
                sent_from: '0x1234567890123456789012345678901234567890',
                sent_to: '0xabcdef1234567890abcdef1234567890abcdef12',
                status: 'confirmed',
                transfers: [
                  {
                    direction: 'out',
                    fungible_info: { symbol: 'ETH', name: 'Ethereum', decimals: 18 },
                    quantity: { float: 0.5, numeric: '500000000000000000' },
                    value: 1250.0,
                    sender: '0x1234567890123456789012345678901234567890',
                    recipient: '0xabcdef1234567890abcdef1234567890abcdef12',
                  },
                ],
              },
              relationships: {
                chain: { data: { id: 'base' } },
              },
            },
          ],
        }),
      });

      const result = await handleHistoryRequest({}, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Transaction History');
      expect(result.content[0].text).toContain('0xabc123');
      expect(result.content[0].text).toContain('Sent');
    });

    it('handles empty history', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      const result = await handleHistoryRequest({}, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('No transaction');
    });

    it('shows pending transactions', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: [
            {
              type: 'transactions',
              id: 'tx1',
              attributes: {
                hash: '0xpending123',
                operation_type: 'send',
                mined_at: '2024-01-15T10:30:00Z',
                sent_from: '0x1234',
                sent_to: '0xabcd',
                status: 'pending',
                transfers: [],
              },
            },
          ],
        }),
      });

      const result = await handleHistoryRequest({}, makeCtx());

      expect(result.isError).toBeUndefined();
    });
  });

  describe('handleHistoryRequest - Error Handling', () => {
    it('handles API errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const result = await handleHistoryRequest({}, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed');
    });

    it('handles network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await handleHistoryRequest({}, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network error');
    });
  });

  describe('handleHistoryRequest - Chain Filtering', () => {
    it('filters by chain', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      await handleHistoryRequest({
        chain: 'base',
      }, makeCtx());

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('base'),
        expect.any(Object)
      );
    });

    it('handles all chains', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      const result = await handleHistoryRequest({
        chain: 'all',
      }, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(mockFetch).toHaveBeenCalled();
    });

    // NOTE: touchSession is now called by middleware after handler returns,
    // not inside the handler itself. Middleware tests should cover this.
  });
});

// Separate describe block for testing missing API key
describe('History Tool - API Key Documentation', () => {
  it('documents ZERION_API_KEY requirement in tool description', () => {
    expect(historyToolDefinition.description).toContain('ZERION_API_KEY');
  });
});
