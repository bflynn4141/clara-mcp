/**
 * work_approve - Approve Bounty Submission
 *
 * Approves a submitted bounty via approveWithFeedback(), which atomically:
 * 1. Releases escrowed funds to the claimer
 * 2. Records on-chain reputation feedback for the claimer's agent
 *
 * The Bounty contract stores the claimerAgentId during claim(), so
 * approveWithFeedback() automatically targets the correct agent.
 * No need to look up or pass the claimer's agentId manually.
 */

import { encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { signAndSendTransaction } from '../para/transactions.js';
import { BOUNTY_ABI } from '../config/clara-contracts.js';
import { getChainId, getExplorerTxUrl } from '../config/chains.js';
import { formatAddress, toDataUri } from './work-helpers.js';
import { requireContract } from '../gas-preflight.js';
import { awaitIndexed } from '../indexer/index.js';

export const workApproveToolDefinition: Tool = {
  name: 'work_approve',
  description: `Approve a bounty submission and release payment to the worker.

Leaves on-chain reputation feedback for the worker (1-5 rating).
Payment + reputation are recorded in a single atomic transaction.

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
        description: 'Rating 1-5 for the worker (default: 4). Set to 0 to skip feedback.',
      },
      comment: {
        type: 'string',
        description: 'Optional feedback comment for the worker',
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
  const rawRating = args.rating as number | undefined;
  const rating = rawRating === 0 ? 0 : Math.min(5, Math.max(1, rawRating || 4));
  const comment = (args.comment as string) || '';

  if (!bountyAddress || !bountyAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
    return {
      content: [{ type: 'text', text: '❌ Invalid bounty address.' }],
      isError: true,
    };
  }

  try {
    await requireContract('base', bountyAddress as Hex, 'bounty contract');
    const chainId = getChainId('base');
    let txData: Hex;
    let hasFeedback = false;

    if (rating > 0) {
      // Use approveWithFeedback() — single atomic transaction:
      // 1. Releases funds to claimer
      // 2. Calls reputationRegistry.giveFeedback(claimerAgentId, ...) automatically
      const feedbackMetadata = {
        rating,
        comment: comment || undefined,
        bountyAddress,
        timestamp: new Date().toISOString(),
      };
      const feedbackURI = toDataUri(feedbackMetadata);
      const feedbackHash = keccak256(toHex(feedbackURI));

      txData = encodeFunctionData({
        abi: BOUNTY_ABI,
        functionName: 'approveWithFeedback',
        args: [
          BigInt(rating),     // value (1-5 rating)
          0,                  // valueDecimals (integer rating, no decimals)
          'bounty',           // tag1 — category
          'completed',        // tag2 — subcategory
          '',                 // endpoint (not used)
          feedbackURI,        // detailed feedback as data URI
          feedbackHash,       // keccak256 integrity hash
        ],
      });
      hasFeedback = true;
    } else {
      // rating=0: plain approve without reputation feedback
      txData = encodeFunctionData({
        abi: BOUNTY_ABI,
        functionName: 'approve',
      });
    }

    const result = await signAndSendTransaction(ctx.session.walletId!, {
      to: bountyAddress as Hex,
      value: 0n,
      data: txData,
      chainId,
    });

    // Wait for indexer to pick up BountyApproved event
    try {
      await awaitIndexed(result.txHash);
    } catch (e) {
      console.error(`[work] Indexer sync failed (non-fatal): ${e}`);
    }

    const explorerUrl = getExplorerTxUrl('base', result.txHash);

    const lines = [
      '✅ **Bounty Approved — Funds Released!**',
      '',
      `**Bounty:** \`${formatAddress(bountyAddress)}\``,
      'Both poster and worker bonds have been returned.',
    ];

    if (hasFeedback) {
      lines.push(`**Rating:** ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} (${rating}/5)`);
      if (comment) {
        lines.push(`**Feedback:** ${comment}`);
      }
    }

    lines.push('');
    lines.push(`**Transaction:** [${result.txHash.slice(0, 10)}...](${explorerUrl})`);

    if (hasFeedback) {
      lines.push('');
      lines.push('Reputation feedback recorded on-chain for the worker.');
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
