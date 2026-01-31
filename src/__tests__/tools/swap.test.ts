/**
 * Tests for swap tool
 *
 * Tests wallet_swap tool with mocked Li.Fi API responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { swapToolDefinition, handleSwapRequest } from '../../tools/swap.js';

// Mock session storage
vi.mock('../../storage/session.js', () => ({
  getSession: vi.fn(),
  touchSession: vi.fn(),
}));

// Mock Li.Fi service
vi.mock('../../services/lifi.js', () => ({
  getSwapQuote: vi.fn(),
  resolveToken: vi.fn(),
  encodeApproveCalldata: vi.fn(() => '0x095ea7b3...'),
  MAX_UINT256: BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
}));

// Mock transaction signing
vi.mock('../../para/transactions.js', () => ({
  signAndSendTransaction: vi.fn(),
}));

import { getSession, touchSession } from '../../storage/session.js';
import { getSwapQuote } from '../../services/lifi.js';
import { signAndSendTransaction } from '../../para/transactions.js';

describe('Swap Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('has correct name and description', () => {
      expect(swapToolDefinition.name).toBe('wallet_swap');
      expect(swapToolDefinition.description).toContain('Swap');
      expect(swapToolDefinition.description).toContain('DEX');
    });

    it('has required fields', () => {
      expect(swapToolDefinition.inputSchema.required).toContain('fromToken');
      expect(swapToolDefinition.inputSchema.required).toContain('toToken');
      expect(swapToolDefinition.inputSchema.required).toContain('amount');
    });

    it('has correct properties', () => {
      const props = swapToolDefinition.inputSchema.properties;
      expect(props).toHaveProperty('fromToken');
      expect(props).toHaveProperty('toToken');
      expect(props).toHaveProperty('amount');
      expect(props).toHaveProperty('chain');
      expect(props).toHaveProperty('action');
      expect(props.action.enum).toContain('quote');
      expect(props.action.enum).toContain('execute');
    });
  });

  describe('handleSwapRequest - Input Validation', () => {
    it('rejects missing fromToken', async () => {
      const result = await handleSwapRequest({
        toToken: 'USDC',
        amount: '1.0',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required');
    });

    it('rejects missing toToken', async () => {
      const result = await handleSwapRequest({
        fromToken: 'ETH',
        amount: '1.0',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required');
    });

    it('rejects missing amount', async () => {
      const result = await handleSwapRequest({
        fromToken: 'ETH',
        toToken: 'USDC',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required');
    });

    it('rejects unsupported chain', async () => {
      const result = await handleSwapRequest({
        fromToken: 'ETH',
        toToken: 'USDC',
        amount: '1.0',
        chain: 'solana',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unsupported chain');
    });
  });

  describe('handleSwapRequest - Session', () => {
    it('requires wallet setup', async () => {
      vi.mocked(getSession).mockResolvedValue(null);

      const result = await handleSwapRequest({
        fromToken: 'ETH',
        toToken: 'USDC',
        amount: '1.0',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Wallet not configured');
    });

    it('requires authenticated session', async () => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: false,
      });

      const result = await handleSwapRequest({
        fromToken: 'ETH',
        toToken: 'USDC',
        amount: '1.0',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Wallet not configured');
    });
  });

  describe('handleSwapRequest - Quote Action', () => {
    beforeEach(() => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        walletId: 'test-wallet-id',
      });
      vi.mocked(touchSession).mockResolvedValue(undefined);
    });

    it('returns quote successfully', async () => {
      vi.mocked(getSwapQuote).mockResolvedValue({
        fromToken: { symbol: 'ETH', decimals: 18, address: '0x0' },
        toToken: { symbol: 'USDC', decimals: 6, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
        fromAmount: '1.0',
        toAmount: '2500.0',
        toAmountMin: '2487.5',
        fromAmountUsd: '2500',
        toAmountUsd: '2500',
        exchangeRate: '2500',
        priceImpact: '0.1',
        estimatedGasUsd: '0.50',
        toolDetails: 'uniswap',
        needsApproval: false,
      });

      const result = await handleSwapRequest({
        fromToken: 'ETH',
        toToken: 'USDC',
        amount: '1.0',
        action: 'quote',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Swap Quote');
      expect(result.content[0].text).toContain('ETH');
      expect(result.content[0].text).toContain('USDC');
      expect(getSwapQuote).toHaveBeenCalled();
    });

    it('handles quote errors', async () => {
      vi.mocked(getSwapQuote).mockRejectedValue(new Error('No routes found'));

      const result = await handleSwapRequest({
        fromToken: 'ETH',
        toToken: 'USDC',
        amount: '1.0',
        action: 'quote',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No routes found');
    });
  });

  describe('handleSwapRequest - Execute Action', () => {
    beforeEach(() => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        walletId: 'test-wallet-id',
      });
      vi.mocked(touchSession).mockResolvedValue(undefined);
    });

    it('executes swap successfully', async () => {
      vi.mocked(getSwapQuote).mockResolvedValue({
        fromToken: { symbol: 'ETH', decimals: 18, address: '0x0' },
        toToken: { symbol: 'USDC', decimals: 6, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
        fromAmount: '1.0',
        toAmount: '2500.0',
        toAmountMin: '2487.5',
        fromAmountUsd: '2500',
        toAmountUsd: '2500',
        exchangeRate: '2500',
        priceImpact: '0.1',
        estimatedGasUsd: '0.50',
        toolDetails: 'uniswap',
        needsApproval: false,
        transactionRequest: {
          to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
          value: '1000000000000000000',
          data: '0x...',
        },
      });
      vi.mocked(signAndSendTransaction).mockResolvedValue({
        txHash: '0xabc123def456789012345678901234567890123456789012345678901234567890',
      });

      const result = await handleSwapRequest({
        fromToken: 'ETH',
        toToken: 'USDC',
        amount: '1.0',
        action: 'execute',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Swap Submitted');
      expect(result.content[0].text).toContain('0xabc123');
    });

    it('handles swap execution errors', async () => {
      vi.mocked(getSwapQuote).mockRejectedValue(new Error('Insufficient balance'));

      const result = await handleSwapRequest({
        fromToken: 'ETH',
        toToken: 'USDC',
        amount: '100',
        action: 'execute',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Insufficient balance');
    });
  });
});
