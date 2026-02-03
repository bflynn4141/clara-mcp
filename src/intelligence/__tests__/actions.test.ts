/**
 * Action Generation Tests
 *
 * Tests for the action generation module that builds calldata from ABI.
 */

import { describe, it, expect } from 'vitest';
import {
  generateClaimAction,
  generateDelegateAction,
  generateExitAction,
  generateReleaseAction,
  generateWithdrawAction,
} from '../actions.js';

describe('Action Generation', () => {
  // Use real-looking addresses that pass viem's isAddress check
  const testAddress = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'; // vitalik.eth
  const delegateAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // WETH

  describe('generateClaimAction', () => {
    it('should generate claim action for getReward function', () => {
      const result = generateClaimAction(testAddress, ['getReward', 'stake', 'exit']);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('claim_rewards');
      expect(result?.functionName).toBe('getReward');
      expect(result?.args).toEqual([]);
      expect(result?.calldata).toMatch(/^0x/);
    });

    it('should generate claim action for claim function', () => {
      const result = generateClaimAction(testAddress, ['claim', 'deposit']);

      expect(result).not.toBeNull();
      expect(result?.functionName).toBe('claim');
    });

    it('should prefer getReward over claim when both exist', () => {
      const result = generateClaimAction(testAddress, ['claim', 'getReward']);

      expect(result).not.toBeNull();
      expect(result?.functionName).toBe('getReward');
    });

    it('should handle case-insensitive function names', () => {
      const result = generateClaimAction(testAddress, ['GETREWARD', 'STAKE']);

      expect(result).not.toBeNull();
      expect(result?.functionName).toBe('getReward');
    });

    it('should return null when no claim function exists', () => {
      const result = generateClaimAction(testAddress, ['deposit', 'withdraw']);

      expect(result).toBeNull();
    });

    it('should return null for empty function list', () => {
      const result = generateClaimAction(testAddress, []);

      expect(result).toBeNull();
    });
  });

  describe('generateDelegateAction', () => {
    it('should generate delegate action with valid address', () => {
      const result = generateDelegateAction(testAddress, delegateAddress, ['delegate', 'vote']);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('delegate');
      expect(result?.functionName).toBe('delegate');
      // Should show full checksum address (GPT-5.2 fix)
      expect(result?.description).toContain(delegateAddress);
      expect(result?.args).toContain(delegateAddress);
    });

    it('should return null for invalid delegate address', () => {
      const result = generateDelegateAction(testAddress, 'not-an-address', ['delegate']);

      expect(result).toBeNull();
    });

    it('should return null when delegate function not available', () => {
      const result = generateDelegateAction(testAddress, delegateAddress, ['vote', 'propose']);

      expect(result).toBeNull();
    });

    it('should return checksum address in args', () => {
      // Use a valid address in lowercase
      const lowercaseAddress = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'; // WETH lowercase
      const result = generateDelegateAction(testAddress, lowercaseAddress, ['delegate']);

      expect(result).not.toBeNull();
      // Checksum address should have mixed case (getAddress converts to checksum)
      expect(result?.args[0]).toMatch(/0x[a-fA-F0-9]{40}/);
      // Should be checksummed (not all lowercase)
      expect(result?.args[0]).not.toBe(lowercaseAddress);
    });
  });

  describe('generateExitAction', () => {
    it('should generate exit action when available', () => {
      const result = generateExitAction(testAddress, ['exit', 'stake', 'getReward']);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('exit');
      expect(result?.functionName).toBe('exit');
      expect(result?.args).toEqual([]);
    });

    it('should return null when exit not available', () => {
      const result = generateExitAction(testAddress, ['stake', 'unstake']);

      expect(result).toBeNull();
    });
  });

  describe('generateReleaseAction', () => {
    it('should generate release action for vesting contracts', () => {
      const result = generateReleaseAction(testAddress, ['release', 'vestedAmount']);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('release_vesting');
      expect(result?.functionName).toBe('release');
    });

    it('should return null when release not available', () => {
      const result = generateReleaseAction(testAddress, ['claim', 'vest']);

      expect(result).toBeNull();
    });
  });

  describe('generateWithdrawAction', () => {
    it('should prefer unstake over withdraw', () => {
      const result = generateWithdrawAction(testAddress, '1000000000000000000', ['unstake', 'withdraw']);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('unstake');
      expect(result?.functionName).toBe('unstake');
    });

    it('should use withdraw when unstake not available', () => {
      const result = generateWithdrawAction(testAddress, '1000000000000000000', ['withdraw', 'deposit']);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('withdraw');
      expect(result?.functionName).toBe('withdraw');
    });

    it('should return bigint in args (GPT-5.2 fix)', () => {
      const result = generateWithdrawAction(testAddress, '1000000000000000000', ['unstake']);

      expect(result).not.toBeNull();
      expect(typeof result?.args[0]).toBe('bigint');
      expect(result?.args[0]).toBe(1000000000000000000n);
    });

    it('should return null for non-integer amount', () => {
      const result = generateWithdrawAction(testAddress, '1.5', ['unstake']);

      expect(result).toBeNull();
    });

    it('should return null for decimal amount', () => {
      const result = generateWithdrawAction(testAddress, '1000.50', ['unstake']);

      expect(result).toBeNull();
    });

    it('should return null for invalid amount', () => {
      const result = generateWithdrawAction(testAddress, 'not-a-number', ['unstake']);

      expect(result).toBeNull();
    });

    it('should return null when neither unstake nor withdraw available', () => {
      const result = generateWithdrawAction(testAddress, '1000', ['stake', 'deposit']);

      expect(result).toBeNull();
    });
  });

  describe('Calldata generation', () => {
    it('should generate valid calldata starting with 0x', () => {
      const claimAction = generateClaimAction(testAddress, ['getReward']);
      const delegateAction = generateDelegateAction(testAddress, delegateAddress, ['delegate']);
      const exitAction = generateExitAction(testAddress, ['exit']);

      expect(claimAction?.calldata).toMatch(/^0x[a-fA-F0-9]+$/);
      expect(delegateAction?.calldata).toMatch(/^0x[a-fA-F0-9]+$/);
      expect(exitAction?.calldata).toMatch(/^0x[a-fA-F0-9]+$/);
    });

    it('should generate different selectors for different functions', () => {
      const claimAction = generateClaimAction(testAddress, ['getReward']);
      const exitAction = generateExitAction(testAddress, ['exit']);

      // Function selectors are first 4 bytes (8 hex chars after 0x)
      const claimSelector = claimAction?.calldata.slice(0, 10);
      const exitSelector = exitAction?.calldata.slice(0, 10);

      expect(claimSelector).not.toBe(exitSelector);
    });
  });
});
