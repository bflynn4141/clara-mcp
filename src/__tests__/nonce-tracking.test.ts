/**
 * Nonce Tracking Regression Test
 *
 * BUG: When signAndSendTransaction is called multiple times in sequence
 * (e.g., approve + createBounty in work_post), each call independently
 * fetches the nonce via publicClient.getTransactionCount(). Since the
 * first transaction hasn't been mined yet, the second call gets the
 * SAME nonce, causing "nonce too low" or "replacement transaction
 * underpriced" errors.
 *
 * Root cause: transactions.ts:217-218 fetches nonce from on-chain state
 * with no local nonce tracking or increment between sequential calls.
 *
 * Affected flow: work-post.ts:137-170 (approve tx → create bounty tx)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getTrackedNonce,
  setTrackedNonce,
  resetNonceTracker,
} from '../para/transactions.js';

/**
 * We can't easily call signAndSendTransaction directly because it has
 * deep dependencies (getSession, createParaAccount, RPC, etc.). Instead,
 * we extract and test the NONCE LOGIC pattern as implemented in the
 * production code's signAndSendTransaction function.
 *
 * This test simulates what happens when two sequential transactions
 * are built using the nonce-tracking approach from transactions.ts.
 */

// Default chain ID for testing (Base)
const TEST_CHAIN_ID = 8453;

/**
 * Simulate the nonce-fetching + tracking behavior from signAndSendTransaction.
 *
 * This mirrors the production code's nonce logic:
 *   1. Fetch chain nonce via getTransactionCount
 *   2. Check tracked nonce via getTrackedNonce
 *   3. Use Math.max logic: if tracked >= chainNonce, use tracked + 1
 *   4. After successful "send", update the tracker via setTrackedNonce
 */
async function getNonceForTransaction(
  publicClient: { getTransactionCount: (args: { address: string }) => Promise<number> },
  address: string,
  _overrideNonce?: number,
): Promise<number> {
  if (_overrideNonce !== undefined) {
    return _overrideNonce;
  }

  // Same logic as transactions.ts nonce section
  const chainNonce = await publicClient.getTransactionCount({ address });
  const tracked = getTrackedNonce(TEST_CHAIN_ID, address);
  let nonce: number;
  if (tracked !== undefined && tracked >= chainNonce) {
    nonce = tracked + 1;
  } else {
    nonce = chainNonce;
  }

  // Simulate successful send: update the tracker (mirrors setTrackedNonce
  // call in signAndSendTransaction after walletClient.sendTransaction)
  setTrackedNonce(TEST_CHAIN_ID, address, nonce);

  return nonce;
}

describe('Stale nonce in multi-transaction workflows', () => {
  const TEST_ADDRESS = '0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd';

  let mockGetTransactionCount: ReturnType<typeof vi.fn>;
  let mockPublicClient: { getTransactionCount: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    // Reset the nonce tracker between tests
    resetNonceTracker();

    // Mock getTransactionCount to always return the same nonce (simulating
    // the chain state where no transactions have been mined yet)
    mockGetTransactionCount = vi.fn().mockResolvedValue(42);
    mockPublicClient = {
      getTransactionCount: mockGetTransactionCount,
    };
  });

  it('should use incremented nonce for second transaction in a sequence', async () => {
    // Transaction 1: ERC-20 approve (like work-post.ts:137-142)
    const nonce1 = await getNonceForTransaction(mockPublicClient, TEST_ADDRESS);
    expect(nonce1).toBe(42);

    // At this point in the real code, the first tx has been sent but NOT mined.
    // The chain still reports nonce=42 for getTransactionCount (pending state).
    // The mock simulates this by always returning 42.

    // Transaction 2: createBounty (like work-post.ts:165-170)
    const nonce2 = await getNonceForTransaction(mockPublicClient, TEST_ADDRESS);

    // With nonce tracking, the second transaction uses nonce 43 (42 + 1).
    expect(nonce2).toBe(43);
  });

  it('should use sequential nonces for three rapid transactions', async () => {
    // Simulate a hypothetical 3-tx workflow (approve + deposit + stake)
    const nonce1 = await getNonceForTransaction(mockPublicClient, TEST_ADDRESS);
    const nonce2 = await getNonceForTransaction(mockPublicClient, TEST_ADDRESS);
    const nonce3 = await getNonceForTransaction(mockPublicClient, TEST_ADDRESS);

    // Each transaction should have a unique, incrementing nonce
    expect(nonce1).toBe(42);
    expect(nonce2).toBe(43);
    expect(nonce3).toBe(44);
  });

  it('confirms getTransactionCount is called per-transaction (no caching)', async () => {
    // Call nonce fetching twice in sequence
    await getNonceForTransaction(mockPublicClient, TEST_ADDRESS);
    await getNonceForTransaction(mockPublicClient, TEST_ADDRESS);

    // Both calls independently query the chain — but the tracker prevents stale use
    expect(mockGetTransactionCount).toHaveBeenCalledTimes(2);

    // Both calls return the same nonce (42) — but the tracker overrides the second
    const results = await Promise.all(
      mockGetTransactionCount.mock.results.map(
        (r: { type: string; value: Promise<number> }) => r.value,
      ),
    );
    expect(results[0]).toBe(results[1]); // Both are 42 from chain — stale!
  });

  it('should track nonces even when transactions are sent in rapid succession (no mining delay)', async () => {
    // This test simulates the exact work_post flow:
    // 1. signAndSendTransaction for approve
    // 2. signAndSendTransaction for createBounty (immediately after, no await for mining)

    const usedNonces: number[] = [];

    // Simulate two back-to-back signAndSendTransaction calls
    for (let i = 0; i < 2; i++) {
      const nonce = await getNonceForTransaction(mockPublicClient, TEST_ADDRESS);
      usedNonces.push(nonce);
    }

    // The nonces should be unique
    const uniqueNonces = new Set(usedNonces);
    expect(uniqueNonces.size).toBe(2);
  });
});
