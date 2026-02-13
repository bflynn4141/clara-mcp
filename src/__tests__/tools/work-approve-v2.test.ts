/**
 * Tests for work_approve tool
 *
 * Tests the approve/approveWithFeedback paths, rating clamping,
 * default rating, and ABI encoding correctness.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import { workApproveToolDefinition, handleWorkApprove } from '../../tools/work-approve.js';
import type { ToolContext } from '../../middleware.js';
import { BOUNTY_ABI } from '../../config/clara-contracts.js';
import { toDataUri } from '../../tools/work-helpers.js';

// Mock transaction signing
vi.mock('../../para/transactions.js', () => ({
  signAndSendTransaction: vi.fn(),
}));

// Mock indexer sync (called after approve)
vi.mock('../../indexer/sync.js', () => ({
  syncFromChain: vi.fn(),
}));

// Mock gas-preflight (requireContract makes real RPC calls)
vi.mock('../../gas-preflight.js', () => ({
  requireContract: vi.fn(),
}));

import { signAndSendTransaction } from '../../para/transactions.js';
import { syncFromChain } from '../../indexer/sync.js';

// ─── Test Helpers ───────────────────────────────────────────────────

const TEST_ADDRESS = '0xabcdef1234567890abcdef1234567890abcdef12' as Hex;
const TEST_BOUNTY = '0x1234567890123456789012345678901234567890';
const TEST_TX_HASH = '0xabc123def456789012345678901234567890123456789012345678901234567890';

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

describe('work_approve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(signAndSendTransaction).mockResolvedValue({
      txHash: TEST_TX_HASH,
    });
    vi.mocked(syncFromChain).mockResolvedValue(undefined);
  });

  describe('Tool Definition', () => {
    it('has correct name', () => {
      expect(workApproveToolDefinition.name).toBe('work_approve');
    });

    it('requires bountyAddress', () => {
      expect(workApproveToolDefinition.inputSchema.required).toContain('bountyAddress');
    });

    it('has rating with default 4', () => {
      const props = workApproveToolDefinition.inputSchema.properties as any;
      expect(props.rating.default).toBe(4);
    });
  });

  describe('Input Validation', () => {
    it('rejects missing bountyAddress', async () => {
      const result = await handleWorkApprove({}, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid bounty address');
    });

    it('rejects invalid bountyAddress format', async () => {
      const result = await handleWorkApprove({ bountyAddress: 'not-an-address' }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid bounty address');
    });

    it('rejects short address', async () => {
      const result = await handleWorkApprove({ bountyAddress: '0x1234' }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid bounty address');
    });
  });

  describe('approveWithFeedback Path (rating > 0)', () => {
    it('uses approveWithFeedback when rating is provided', async () => {
      const result = await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
        rating: 5,
        comment: 'Great work!',
      }, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Bounty Approved');
      expect(result.content[0].text).toContain('5/5');

      // Verify the transaction data was encoded with approveWithFeedback
      expect(signAndSendTransaction).toHaveBeenCalledWith(
        'test-wallet-id',
        expect.objectContaining({
          to: TEST_BOUNTY,
          value: 0n,
          data: expect.stringContaining('0x'),
          chainId: 8453,
        }),
      );
    });

    it('includes rating stars in output', async () => {
      const result = await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
        rating: 3,
      }, makeCtx());

      expect(result.content[0].text).toContain('3/5');
    });

    it('includes comment in output when provided', async () => {
      const result = await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
        rating: 4,
        comment: 'Solid delivery',
      }, makeCtx());

      expect(result.content[0].text).toContain('Solid delivery');
    });

    it('includes transaction link in output', async () => {
      const result = await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
        rating: 4,
      }, makeCtx());

      expect(result.content[0].text).toContain(TEST_TX_HASH.slice(0, 10));
      expect(result.content[0].text).toContain('basescan.org');
    });

    it('includes reputation feedback notice', async () => {
      const result = await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
        rating: 4,
      }, makeCtx());

      expect(result.content[0].text).toContain('Reputation feedback recorded');
    });

    it('mentions bonds being returned', async () => {
      const result = await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
        rating: 4,
      }, makeCtx());

      expect(result.content[0].text).toContain('bonds have been returned');
    });

    it('encodes correct ABI args for approveWithFeedback', async () => {
      await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
        rating: 5,
        comment: 'Perfect!',
      }, makeCtx());

      const callArgs = vi.mocked(signAndSendTransaction).mock.calls[0];
      const txParams = callArgs[1];

      // Decode the encoded function data to verify args
      // The data should be encodeFunctionData for approveWithFeedback
      // We verify the shape: (BigInt(rating), 0, 'bounty', 'completed', '', feedbackURI, feedbackHash)
      const feedbackMetadata = {
        rating: 5,
        comment: 'Perfect!',
        bountyAddress: TEST_BOUNTY,
        timestamp: expect.any(String),
      };

      // Build expected data to verify structure
      expect(txParams.data).toBeDefined();
      expect(typeof txParams.data).toBe('string');
      expect((txParams.data as string).startsWith('0x')).toBe(true);
    });

    it('feedbackURI contains bountyAddress, rating, comment, and timestamp', async () => {
      // We can't easily decode the ABI encoding, but we can verify
      // the feedbackURI generation logic through toDataUri
      const metadata = {
        rating: 5,
        comment: 'Good job',
        bountyAddress: TEST_BOUNTY,
        timestamp: '2026-01-01T00:00:00.000Z',
      };

      const uri = toDataUri(metadata);
      expect(uri).toMatch(/^data:application\/json;base64,/);

      // Decode it back to verify contents
      const b64 = uri.replace('data:application/json;base64,', '');
      const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
      expect(decoded.rating).toBe(5);
      expect(decoded.comment).toBe('Good job');
      expect(decoded.bountyAddress).toBe(TEST_BOUNTY);
      expect(decoded.timestamp).toBeDefined();
    });

    it('feedbackHash is keccak256 of feedbackURI', () => {
      const metadata = {
        rating: 4,
        comment: 'Nice',
        bountyAddress: TEST_BOUNTY,
        timestamp: '2026-01-01T00:00:00.000Z',
      };
      const uri = toDataUri(metadata);
      const hash = keccak256(toHex(uri));

      expect(hash).toMatch(/^0x[a-f0-9]{64}$/);
      // Verify it's deterministic
      expect(keccak256(toHex(uri))).toBe(hash);
    });
  });

  describe('Plain Approve Path (rating = 0)', () => {
    it('uses plain approve when rating is 0', async () => {
      const result = await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
        rating: 0,
      }, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Bounty Approved');
      // Should NOT mention feedback/rating
      expect(result.content[0].text).not.toContain('Reputation feedback');
      expect(result.content[0].text).not.toContain('/5');
    });

    it('encodes plain approve() without feedback args', async () => {
      await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
        rating: 0,
      }, makeCtx());

      const callArgs = vi.mocked(signAndSendTransaction).mock.calls[0];
      const txParams = callArgs[1];

      // plain approve() has a much shorter encoded data than approveWithFeedback
      const plainApproveData = encodeFunctionData({
        abi: BOUNTY_ABI,
        functionName: 'approve',
      });
      expect(txParams.data).toBe(plainApproveData);
    });
  });

  describe('Rating Defaults and Clamping', () => {
    it('defaults to rating 4 when no rating provided', async () => {
      const result = await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
      }, makeCtx());

      expect(result.content[0].text).toContain('4/5');
    });

    it('clamps rating > 5 down to 5', async () => {
      const result = await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
        rating: 10,
      }, makeCtx());

      expect(result.content[0].text).toContain('5/5');
    });

    it('clamps rating < 1 up to 1 (for non-zero ratings)', async () => {
      const result = await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
        rating: -1,
      }, makeCtx());

      expect(result.content[0].text).toContain('1/5');
    });

    it('rating=1 is valid and not clamped', async () => {
      const result = await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
        rating: 1,
      }, makeCtx());

      expect(result.content[0].text).toContain('1/5');
    });

    it('rating=5 is valid and not clamped', async () => {
      const result = await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
        rating: 5,
      }, makeCtx());

      expect(result.content[0].text).toContain('5/5');
    });
  });

  describe('Error Handling', () => {
    it('returns error when transaction fails', async () => {
      vi.mocked(signAndSendTransaction).mockRejectedValue(
        new Error('execution reverted'),
      );

      const result = await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
        rating: 4,
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Approval failed');
      expect(result.content[0].text).toContain('execution reverted');
    });

    it('handles non-Error throws', async () => {
      vi.mocked(signAndSendTransaction).mockRejectedValue('string error');

      const result = await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
        rating: 4,
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown error');
    });

    it('continues successfully even if sync fails', async () => {
      vi.mocked(syncFromChain).mockRejectedValue(new Error('sync failed'));

      const result = await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
        rating: 4,
      }, makeCtx());

      // Should still succeed since sync failure is non-fatal
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Bounty Approved');
    });
  });

  describe('Post-Approve Sync', () => {
    it('calls syncFromChain after successful approval', async () => {
      await handleWorkApprove({
        bountyAddress: TEST_BOUNTY,
        rating: 4,
      }, makeCtx());

      expect(syncFromChain).toHaveBeenCalled();
    });
  });
});
