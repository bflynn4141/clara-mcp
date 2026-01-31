/**
 * Tests for bridge tool
 *
 * Tests wallet_bridge tool with mocked Li.Fi API responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bridgeToolDefinition, handleBridgeRequest } from '../../tools/bridge.js';

// Mock session storage
vi.mock('../../storage/session.js', () => ({
  getSession: vi.fn(),
  touchSession: vi.fn(),
}));

// Mock Li.Fi service
vi.mock('../../services/lifi.js', () => ({
  getBridgeQuote: vi.fn(),
  resolveToken: vi.fn(),
  encodeApproveCalldata: vi.fn(() => '0x095ea7b3...'),
  MAX_UINT256: BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
}));

// Mock transaction signing
vi.mock('../../para/transactions.js', () => ({
  signAndSendTransaction: vi.fn(),
}));

import { getSession, touchSession } from '../../storage/session.js';
import { getBridgeQuote } from '../../services/lifi.js';
import { signAndSendTransaction } from '../../para/transactions.js';

describe('Bridge Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('has correct name and description', () => {
      expect(bridgeToolDefinition.name).toBe('wallet_bridge');
      expect(bridgeToolDefinition.description).toContain('Bridge');
      expect(bridgeToolDefinition.description).toContain('Li.Fi');
    });

    it('has required fields', () => {
      expect(bridgeToolDefinition.inputSchema.required).toContain('fromToken');
      expect(bridgeToolDefinition.inputSchema.required).toContain('toToken');
      expect(bridgeToolDefinition.inputSchema.required).toContain('amount');
      expect(bridgeToolDefinition.inputSchema.required).toContain('fromChain');
      expect(bridgeToolDefinition.inputSchema.required).toContain('toChain');
    });

    it('has chain enums', () => {
      const props = bridgeToolDefinition.inputSchema.properties;
      expect(props.fromChain.enum).toContain('base');
      expect(props.fromChain.enum).toContain('ethereum');
      expect(props.toChain.enum).toContain('base');
      expect(props.toChain.enum).toContain('arbitrum');
    });
  });

  describe('handleBridgeRequest - Input Validation', () => {
    it('rejects missing required params', async () => {
      const result = await handleBridgeRequest({
        fromToken: 'USDC',
        toToken: 'USDC',
        amount: '100',
        // missing fromChain and toChain
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required');
    });

    it('rejects same source and destination chain', async () => {
      const result = await handleBridgeRequest({
        fromToken: 'USDC',
        toToken: 'USDC',
        amount: '100',
        fromChain: 'base',
        toChain: 'base',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('same');
    });

    it('rejects unsupported fromChain', async () => {
      const result = await handleBridgeRequest({
        fromToken: 'USDC',
        toToken: 'USDC',
        amount: '100',
        fromChain: 'solana',
        toChain: 'base',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unsupported');
    });

    it('rejects unsupported toChain', async () => {
      const result = await handleBridgeRequest({
        fromToken: 'USDC',
        toToken: 'USDC',
        amount: '100',
        fromChain: 'base',
        toChain: 'solana',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unsupported');
    });
  });

  describe('handleBridgeRequest - Session', () => {
    it('requires wallet setup', async () => {
      vi.mocked(getSession).mockResolvedValue(null);

      const result = await handleBridgeRequest({
        fromToken: 'USDC',
        toToken: 'USDC',
        amount: '100',
        fromChain: 'base',
        toChain: 'arbitrum',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Wallet not configured');
    });

    it('requires authenticated session', async () => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: false,
      });

      const result = await handleBridgeRequest({
        fromToken: 'USDC',
        toToken: 'USDC',
        amount: '100',
        fromChain: 'base',
        toChain: 'arbitrum',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Wallet not configured');
    });
  });

  describe('handleBridgeRequest - Quote Action', () => {
    beforeEach(() => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        walletId: 'test-wallet-id',
      });
      vi.mocked(touchSession).mockResolvedValue(undefined);
    });

    it('returns bridge quote successfully', async () => {
      vi.mocked(getBridgeQuote).mockResolvedValue({
        fromToken: { symbol: 'USDC', decimals: 6, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
        toToken: { symbol: 'USDC', decimals: 6, address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
        fromAmount: '100',
        toAmount: '99.5',
        toAmountMin: '99.0',
        fromAmountUsd: '100',
        toAmountUsd: '99.5',
        exchangeRate: '0.995',
        priceImpact: '0.5',
        estimatedGasUsd: '2.50',
        toolDetails: 'across',
        needsApproval: false,
      });

      const result = await handleBridgeRequest({
        fromToken: 'USDC',
        toToken: 'USDC',
        amount: '100',
        fromChain: 'base',
        toChain: 'arbitrum',
        action: 'quote',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Bridge Quote');
      expect(result.content[0].text).toContain('base');
      expect(result.content[0].text).toContain('arbitrum');
      expect(getBridgeQuote).toHaveBeenCalled();
    });

    it('handles quote errors', async () => {
      vi.mocked(getBridgeQuote).mockRejectedValue(new Error('No bridge routes available'));

      const result = await handleBridgeRequest({
        fromToken: 'USDC',
        toToken: 'USDC',
        amount: '100',
        fromChain: 'base',
        toChain: 'arbitrum',
        action: 'quote',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No bridge routes');
    });
  });

  describe('handleBridgeRequest - Execute Action', () => {
    beforeEach(() => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        walletId: 'test-wallet-id',
      });
      vi.mocked(touchSession).mockResolvedValue(undefined);
    });

    it('executes bridge successfully', async () => {
      vi.mocked(getBridgeQuote).mockResolvedValue({
        fromToken: { symbol: 'USDC', decimals: 6, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
        toToken: { symbol: 'USDC', decimals: 6, address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
        fromAmount: '100',
        toAmount: '99.5',
        toAmountMin: '99.0',
        fromAmountUsd: '100',
        toAmountUsd: '99.5',
        exchangeRate: '0.995',
        priceImpact: '0.5',
        estimatedGasUsd: '2.50',
        toolDetails: 'across',
        needsApproval: false,
        transactionRequest: {
          to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
          value: '0',
          data: '0x...',
        },
      });
      vi.mocked(signAndSendTransaction).mockResolvedValue({
        txHash: '0xbridge123456789012345678901234567890123456789012345678901234567890',
      });

      const result = await handleBridgeRequest({
        fromToken: 'USDC',
        toToken: 'USDC',
        amount: '100',
        fromChain: 'base',
        toChain: 'arbitrum',
        action: 'execute',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Bridge Submitted');
      expect(result.content[0].text).toContain('0xbridge123');
    });

    it('handles execution errors', async () => {
      vi.mocked(getBridgeQuote).mockRejectedValue(new Error('Bridge liquidity exhausted'));

      const result = await handleBridgeRequest({
        fromToken: 'USDC',
        toToken: 'USDC',
        amount: '1000000',
        fromChain: 'base',
        toChain: 'arbitrum',
        action: 'execute',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Bridge liquidity');
    });
  });
});
