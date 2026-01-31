/**
 * Tests for smart gas estimation
 */

import { describe, it, expect, vi } from 'vitest';
import { estimateGas, estimateGasLimit, type GasEstimate } from '../para/gas.js';
import type { PublicClient } from 'viem';

// Mock public client for testing
function createMockClient(options: {
  baseFeePerGas?: bigint;
  blockNumber?: bigint;
  transactions?: Array<{ maxPriorityFeePerGas?: bigint }>;
  gasPrice?: bigint;
}): PublicClient {
  const {
    baseFeePerGas = 1_000_000_000n, // 1 gwei
    blockNumber = 1000n,
    transactions = [],
    gasPrice = 2_000_000_000n, // 2 gwei
  } = options;

  return {
    getBlock: vi.fn().mockImplementation(async ({ blockTag, blockNumber: bn, includeTransactions }) => {
      if (blockTag === 'latest' || !bn) {
        return {
          baseFeePerGas,
          number: blockNumber,
          transactions: includeTransactions ? transactions : [],
        };
      }
      return {
        baseFeePerGas,
        number: bn,
        transactions: includeTransactions ? transactions : [],
      };
    }),
    getBlockNumber: vi.fn().mockResolvedValue(blockNumber),
    getGasPrice: vi.fn().mockResolvedValue(gasPrice),
    estimateGas: vi.fn().mockResolvedValue(21000n),
  } as unknown as PublicClient;
}

describe('Gas Estimation', () => {
  describe('estimateGas', () => {
    it('should return valid EIP-1559 gas parameters', async () => {
      const client = createMockClient({
        baseFeePerGas: 1_000_000_000n, // 1 gwei
        transactions: [
          { maxPriorityFeePerGas: 100_000_000n }, // 0.1 gwei
          { maxPriorityFeePerGas: 200_000_000n }, // 0.2 gwei
          { maxPriorityFeePerGas: 150_000_000n }, // 0.15 gwei
        ],
      });

      const result = await estimateGas(client);

      expect(result.baseFeePerGas).toBe(1_000_000_000n);
      expect(result.maxFeePerGas).toBeGreaterThan(result.baseFeePerGas);
      expect(result.maxPriorityFeePerGas).toBeGreaterThan(0n);
      expect(result.formatted).toBeDefined();
      expect(result.formatted.maxFeeGwei).toBeDefined();
    });

    it('should apply safety margin to base fee', async () => {
      const baseFee = 1_000_000_000n; // 1 gwei
      const client = createMockClient({
        baseFeePerGas: baseFee,
        transactions: [{ maxPriorityFeePerGas: 100_000_000n }],
      });

      const result = await estimateGas(client, { safetyMargin: 2 });

      // maxFee should be at least 2 * baseFee (plus priority fee)
      expect(result.maxFeePerGas).toBeGreaterThanOrEqual(baseFee * 2n);
    });

    it('should use fallback when no EIP-1559 transactions found', async () => {
      const client = createMockClient({
        baseFeePerGas: 1_000_000_000n,
        transactions: [], // No transactions to sample
      });

      const result = await estimateGas(client);

      // Should still return valid values using fallback
      expect(result.maxFeePerGas).toBeGreaterThan(0n);
      expect(result.maxPriorityFeePerGas).toBeGreaterThan(0n);
    });

    it('should fallback to legacy gas price when no EIP-1559 support', async () => {
      const gasPrice = 5_000_000_000n; // 5 gwei
      const client = createMockClient({
        baseFeePerGas: undefined as unknown as bigint, // No EIP-1559
        gasPrice,
      });

      // Override getBlock to return no baseFeePerGas
      (client.getBlock as ReturnType<typeof vi.fn>).mockResolvedValue({
        baseFeePerGas: null,
        number: 1000n,
      });

      const result = await estimateGas(client);

      expect(result.maxFeePerGas).toBe(gasPrice);
    });
  });

  describe('estimateGasLimit', () => {
    it('should add 20% buffer to estimate', async () => {
      const estimatedGas = 100_000n;
      const client = {
        estimateGas: vi.fn().mockResolvedValue(estimatedGas),
      } as unknown as PublicClient;

      const result = await estimateGasLimit(client, {
        account: '0x1234567890123456789012345678901234567890',
        to: '0x1234567890123456789012345678901234567890',
        value: 0n,
      });

      // 100,000 * 1.2 = 120,000
      expect(result).toBe(120_000n);
    });

    it('should handle contract calls with data', async () => {
      const estimatedGas = 50_000n;
      const client = {
        estimateGas: vi.fn().mockResolvedValue(estimatedGas),
      } as unknown as PublicClient;

      const result = await estimateGasLimit(client, {
        account: '0x1234567890123456789012345678901234567890',
        to: '0x1234567890123456789012345678901234567890',
        data: '0xa9059cbb', // transfer selector
      });

      // 50,000 * 1.2 = 60,000
      expect(result).toBe(60_000n);
    });
  });
});
