/**
 * Tests for simulate tool
 *
 * Tests wallet_simulate tool with mocked RPC and Tenderly responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { simulateToolDefinition, handleSimulateRequest } from '../../tools/simulate.js';

// Mock session storage
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
  getChainId: vi.fn((chain: string) => chain === 'base' ? 8453 : 1),
}));

// Mock viem
vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      estimateGas: vi.fn(),
    })),
  };
});

import { getSession, touchSession } from '../../storage/session.js';
import { createPublicClient } from 'viem';

describe('Simulate Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear Tenderly API key to test eth_call fallback
    delete process.env.TENDERLY_API_KEY;
  });

  describe('Tool Definition', () => {
    it('has correct name and description', () => {
      expect(simulateToolDefinition.name).toBe('wallet_simulate');
      expect(simulateToolDefinition.description).toContain('Simulate');
      expect(simulateToolDefinition.description).toContain('transaction');
    });

    it('has required to field', () => {
      expect(simulateToolDefinition.inputSchema.required).toContain('to');
    });

    it('has correct properties', () => {
      const props = simulateToolDefinition.inputSchema.properties;
      expect(props).toHaveProperty('to');
      expect(props).toHaveProperty('data');
      expect(props).toHaveProperty('value');
      expect(props).toHaveProperty('chain');
    });
  });

  describe('handleSimulateRequest - Input Validation', () => {
    it('rejects missing to address', async () => {
      const result = await handleSimulateRequest({
        data: '0x',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid');
    });

    it('rejects invalid to address format', async () => {
      const result = await handleSimulateRequest({
        to: 'not-an-address',
        data: '0x',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid');
    });

    it('rejects unsupported chain', async () => {
      const result = await handleSimulateRequest({
        to: '0x1234567890123456789012345678901234567890',
        data: '0x',
        chain: 'solana',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unsupported chain');
    });
  });

  describe('handleSimulateRequest - Session', () => {
    it('requires wallet setup', async () => {
      vi.mocked(getSession).mockResolvedValue(null);

      const result = await handleSimulateRequest({
        to: '0x1234567890123456789012345678901234567890',
        data: '0x',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Wallet not configured');
    });

    it('requires authenticated session', async () => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: false,
      });

      const result = await handleSimulateRequest({
        to: '0x1234567890123456789012345678901234567890',
        data: '0x',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Wallet not configured');
    });
  });

  describe('handleSimulateRequest - Simulation', () => {
    beforeEach(() => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: '0xabcdef1234567890abcdef1234567890abcdef12',
        walletId: 'test-wallet-id',
      });
      vi.mocked(touchSession).mockResolvedValue(undefined);
    });

    it('simulates simple ETH transfer successfully', async () => {
      const mockClient = {
        estimateGas: vi.fn().mockResolvedValue(21000n),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleSimulateRequest({
        to: '0x1234567890123456789012345678901234567890',
        value: '0.1',
        chain: 'base',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('SUCCEED');
      expect(result.content[0].text).toContain('Native Transfer');
    });

    it('simulates contract call', async () => {
      const mockClient = {
        estimateGas: vi.fn().mockResolvedValue(50000n),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      // ERC20 transfer calldata
      const transferData = '0xa9059cbb0000000000000000000000001234567890123456789012345678901234567890000000000000000000000000000000000000000000000000000000000000000a';

      const result = await handleSimulateRequest({
        to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        data: transferData,
        chain: 'base',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('SUCCEED');
      expect(result.content[0].text).toContain('transfer');
    });

    it('handles revert errors', async () => {
      const mockClient = {
        estimateGas: vi.fn().mockRejectedValue(new Error('execution reverted: Insufficient balance')),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleSimulateRequest({
        to: '0x1234567890123456789012345678901234567890',
        data: '0xa9059cbb',
        chain: 'base',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('FAIL');
    });

    it('decodes known method selectors', async () => {
      const mockClient = {
        estimateGas: vi.fn().mockResolvedValue(100000n),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      // Approve calldata
      const approveData = '0x095ea7b30000000000000000000000001111111111111111111111111111111111111111ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

      const result = await handleSimulateRequest({
        to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        data: approveData,
        chain: 'base',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('approve');
    });

    it('defaults to base chain', async () => {
      const mockClient = {
        estimateGas: vi.fn().mockResolvedValue(21000n),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleSimulateRequest({
        to: '0x1234567890123456789012345678901234567890',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('base');
    });
  });
});
