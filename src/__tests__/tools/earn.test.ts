/**
 * Tests for earn tool
 *
 * Tests wallet_earn tool with mocked Aave/DeFi responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { earnToolDefinition, handleEarnRequest } from '../../tools/earn.js';

// Mock session storage
vi.mock('../../storage/session.js', () => ({
  getSession: vi.fn(),
  touchSession: vi.fn(),
}));

// Mock yield service
vi.mock('../../services/yield.js', () => ({
  getYieldOpportunities: vi.fn(),
  createYieldPlan: vi.fn(),
  encodeAaveSupply: vi.fn(() => '0x617ba037...'),
  encodeAaveWithdraw: vi.fn(() => '0x69328dec...'),
  encodeApprove: vi.fn(() => '0x095ea7b3...'),
  MAX_UINT256: BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
  getChainId: vi.fn((chain: string) => chain === 'base' ? 8453 : 1),
  getAavePool: vi.fn(() => '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'),
  getToken: vi.fn((symbol: string, chain: string) => ({
    address: symbol === 'USDC' ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : '0x4200000000000000000000000000000000000006',
    symbol,
    decimals: symbol === 'USDC' ? 6 : 18,
  })),
}));

// Mock transaction signing
vi.mock('../../para/transactions.js', () => ({
  signAndSendTransaction: vi.fn(),
}));

import { getSession, touchSession } from '../../storage/session.js';
import { getYieldOpportunities, createYieldPlan, getToken } from '../../services/yield.js';
import { signAndSendTransaction } from '../../para/transactions.js';

describe('Earn Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('has correct name and description', () => {
      expect(earnToolDefinition.name).toBe('wallet_earn');
      expect(earnToolDefinition.description).toContain('yield');
      expect(earnToolDefinition.description).toContain('Earn');
    });

    it('has action enum', () => {
      const props = earnToolDefinition.inputSchema.properties;
      expect(props.action.enum).toContain('plan');
      expect(props.action.enum).toContain('deposit');
      expect(props.action.enum).toContain('withdraw');
    });

    it('requires action and asset', () => {
      expect(earnToolDefinition.inputSchema.required).toContain('action');
      expect(earnToolDefinition.inputSchema.required).toContain('asset');
    });
  });

  describe('handleEarnRequest - Input Validation', () => {
    it('rejects missing required params', async () => {
      const result = await handleEarnRequest({
        action: 'plan',
        // missing asset
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required');
    });

    it('rejects unsupported chain', async () => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        walletId: 'test-wallet-id',
      });

      const result = await handleEarnRequest({
        action: 'plan',
        asset: 'USDC',
        chain: 'solana',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unsupported chain');
    });
  });

  describe('handleEarnRequest - Session', () => {
    it('requires wallet setup', async () => {
      vi.mocked(getSession).mockResolvedValue(null);

      const result = await handleEarnRequest({
        action: 'plan',
        asset: 'USDC',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Wallet not configured');
    });

    it('requires authenticated session', async () => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: false,
      });

      const result = await handleEarnRequest({
        action: 'plan',
        asset: 'USDC',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Wallet not configured');
    });
  });

  describe('handleEarnRequest - Plan Action', () => {
    beforeEach(() => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        walletId: 'test-wallet-id',
      });
      vi.mocked(touchSession).mockResolvedValue(undefined);
    });

    it('shows yield opportunities', async () => {
      vi.mocked(getYieldOpportunities).mockResolvedValue([
        {
          project: 'aave-v3',
          symbol: 'USDC',
          apy: 5.5,
          tvlUsd: 1000000000,
          chain: 'base',
        },
        {
          project: 'aave-v3',
          symbol: 'USDC',
          apy: 4.2,
          tvlUsd: 500000000,
          chain: 'ethereum',
        },
      ]);

      const result = await handleEarnRequest({
        action: 'plan',
        asset: 'USDC',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Yield Opportunities');
      expect(result.content[0].text).toContain('USDC');
      expect(result.content[0].text).toContain('aave');
    });

    it('handles no opportunities found', async () => {
      vi.mocked(getYieldOpportunities).mockResolvedValue([]);

      const result = await handleEarnRequest({
        action: 'plan',
        asset: 'FAKE',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('No yield opportunities');
    });

    it('handles API errors', async () => {
      vi.mocked(getYieldOpportunities).mockRejectedValue(new Error('DeFiLlama API unavailable'));

      const result = await handleEarnRequest({
        action: 'plan',
        asset: 'USDC',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('DeFiLlama');
    });
  });

  describe('handleEarnRequest - Deposit Action', () => {
    beforeEach(() => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        walletId: 'test-wallet-id',
      });
      vi.mocked(touchSession).mockResolvedValue(undefined);
      // Reset getToken to return valid token (may be overridden by individual tests)
      vi.mocked(getToken).mockImplementation((symbol: string) => ({
        address: symbol === 'USDC' ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : '0x4200000000000000000000000000000000000006',
        symbol,
        decimals: symbol === 'USDC' ? 6 : 18,
      }));
    });

    it('requires amount for deposit', async () => {
      const result = await handleEarnRequest({
        action: 'deposit',
        asset: 'USDC',
        chain: 'base',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Amount is required');
    });

    it('deposits successfully', async () => {
      vi.mocked(getYieldOpportunities).mockResolvedValue([
        { project: 'aave-v3', symbol: 'USDC', apy: 5.5, tvlUsd: 1000000000, chain: 'base' },
      ]);
      vi.mocked(signAndSendTransaction).mockResolvedValue({
        txHash: '0xdeposit123456789012345678901234567890123456789012345678901234567890',
      });

      const result = await handleEarnRequest({
        action: 'deposit',
        asset: 'USDC',
        amount: '100',
        chain: 'base',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Deposit Submitted');
      expect(result.content[0].text).toContain('100');
      expect(result.content[0].text).toContain('USDC');
      expect(result.content[0].text).toContain('0xdeposit123');
    });

    it('handles unsupported token on chain', async () => {
      // Use mockReturnValueOnce to not affect subsequent tests
      vi.mocked(getToken).mockReturnValueOnce(null);

      const result = await handleEarnRequest({
        action: 'deposit',
        asset: 'FAKE',
        amount: '100',
        chain: 'base',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not supported');
    });

    it('handles deposit errors', async () => {
      vi.mocked(signAndSendTransaction).mockRejectedValue(new Error('Insufficient balance'));

      const result = await handleEarnRequest({
        action: 'deposit',
        asset: 'USDC',
        amount: '10000',
        chain: 'base',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Insufficient balance');
    });
  });

  describe('handleEarnRequest - Withdraw Action', () => {
    beforeEach(() => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        walletId: 'test-wallet-id',
      });
      vi.mocked(touchSession).mockResolvedValue(undefined);
      // Reset getToken to return valid token
      vi.mocked(getToken).mockImplementation((symbol: string) => ({
        address: symbol === 'USDC' ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : '0x4200000000000000000000000000000000000006',
        symbol,
        decimals: symbol === 'USDC' ? 6 : 18,
      }));
    });

    it('withdraws successfully', async () => {
      vi.mocked(signAndSendTransaction).mockResolvedValue({
        txHash: '0xwithdraw123456789012345678901234567890123456789012345678901234567890',
      });

      const result = await handleEarnRequest({
        action: 'withdraw',
        asset: 'USDC',
        amount: '50',
        chain: 'base',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Withdrawal Submitted');
      expect(result.content[0].text).toContain('50');
      expect(result.content[0].text).toContain('0xwithdraw123');
    });

    it('handles withdrawal errors', async () => {
      vi.mocked(signAndSendTransaction).mockRejectedValue(new Error('No position to withdraw'));

      const result = await handleEarnRequest({
        action: 'withdraw',
        asset: 'USDC',
        amount: '1000',
        chain: 'base',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No position');
    });
  });

  describe('handleEarnRequest - Unknown Action', () => {
    beforeEach(() => {
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        walletId: 'test-wallet-id',
      });
      vi.mocked(touchSession).mockResolvedValue(undefined);
    });

    it('rejects unknown action', async () => {
      const result = await handleEarnRequest({
        action: 'invalid',
        asset: 'USDC',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown action');
    });
  });
});
