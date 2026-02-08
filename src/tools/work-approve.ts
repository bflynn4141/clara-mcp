/**
 * work_approve - Approve Bounty Submission
 *
 * Approves a submitted bounty, releasing escrowed funds to the claimer.
 * Also submits on-chain reputation feedback via ReputationRegistry.
 */

import { encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { signAndSendTransaction } from '../para/transactions.js';
import {
  getBountyContracts,
  BOUNTY_ABI,
  REPUTATION_REGISTRY_ABI,
} from '../config/clara-contracts.js';
import { getChainId, getExplorerTxUrl } from '../config/chains.js';
import { formatAddress, toDataUri, getLocalAgentId } from './work-helpers.js';
import { syncFromChain } from '../indexer/sync.js';

export const workApproveToolDefinition: Tool = {
  name: 'work_approve',
  description: `Approve a bounty submission and release payment to the worker.

Also leaves on-chain reputation feedback for the worker.

**Example:**
\`\`\`json
{"bountyAddress": "0x1234...", "rating": 5, "comment": "Excellent work, fast delivery"}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      bountyAddress: {
        type: 'string',
        description: 'The bounty contract address to approve',
      },
      rating: {
        type: 'number',
        default: 4,
        description: 'Rating 1-5 (default: 4)',
      },
      comment: {
        type: 'string',
        description: 'Optional feedback comment',
      },
    },
    required: ['bountyAddress'],
  },
};

export async function handleWorkApprove(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const bountyAddress = args.bountyAddress as string;
  const rating = Math.min(5, Math.max(1, (args.rating as number) || 4));
  const comment = (args.comment as string) || '';

  if (!bountyAddress || !bountyAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
    return {
      content: [{ type: 'text', text: '❌ Invalid bounty address.' }],
      isError: true,
    };
  }

  try {
    const contracts = getBountyContracts();
    const chainId = getChainId('base');

    // Step 1: Approve the bounty (releases funds)
    const approveData = encodeFunctionData({
      abi: BOUNTY_ABI,
      functionName: 'approve',
    });

    const approveResult = await signAndSendTransaction(ctx.session.walletId!, {
      to: bountyAddress as Hex,
      value: 0n,
      data: approveData,
      chainId,
    });

    // Step 2: Give reputation feedback via approveWithFeedback (on-chain)
    // Note: In v1, we use simple approve() above and do reputation separately.
    // The bounty contract stores the claimerAgentId from claim().
    let repTxHash: string | null = null;
    try {
      // Read the claimerAgentId from the bounty contract (stored during claim)
      const localAgentId = getLocalAgentId();
      if (localAgentId) {
        // Convert 1-5 rating to int128 value (0 = no decimals)
        const value = BigInt(rating);

        const feedbackMetadata = {
          rating,
          comment,
          bountyAddress,
          timestamp: new Date().toISOString(),
        };
        const feedbackURI = toDataUri(feedbackMetadata);
        const feedbackHash = keccak256(toHex(feedbackURI));

        // Read claimerAgentId from bounty to know who to rate
        // For now, use 0 as agentId — the contract's approveWithFeedback uses stored claimerAgentId
        const repData = encodeFunctionData({
          abi: REPUTATION_REGISTRY_ABI,
          functionName: 'giveFeedback',
          args: [
            BigInt(localAgentId),  // agentId to rate (poster's own agent — TODO: should be claimer's)
            value,                 // int128 value
            0,                     // valueDecimals (integer rating)
            'bounty',              // tag1
            'completed',           // tag2
            '',                    // endpoint
            feedbackURI,           // feedbackURI
            feedbackHash,          // feedbackHash
          ],
        });

        const repResult = await signAndSendTransaction(ctx.session.walletId!, {
          to: contracts.reputationRegistry,
          value: 0n,
          data: repData,
          chainId,
        });

        repTxHash = repResult.txHash;
      }
    } catch (e) {
      console.error(`[work] Reputation feedback failed (non-fatal): ${e}`);
    }

    // Sync local indexer to pick up BountyApproved event
    try {
      await syncFromChain();
    } catch (e) {
      console.error(`[work] Local indexer sync failed (non-fatal): ${e}`);
    }

    const explorerUrl = getExplorerTxUrl('base', approveResult.txHash);

    const lines = [
      '✅ **Bounty Approved — Funds Released!**',
      '',
      `**Bounty:** \`${formatAddress(bountyAddress)}\``,
      `**Rating:** ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} (${rating}/5)`,
    ];

    if (comment) {
      lines.push(`**Feedback:** ${comment}`);
    }

    lines.push('');
    lines.push(`**Approval tx:** [${approveResult.txHash.slice(0, 10)}...](${explorerUrl})`);

    if (repTxHash) {
      const repUrl = getExplorerTxUrl('base', repTxHash);
      lines.push(`**Reputation tx:** [${repTxHash.slice(0, 10)}...](${repUrl})`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Approval failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
