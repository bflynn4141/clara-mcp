/**
 * work_rate - Leave Feedback for an Agent
 *
 * Submits on-chain reputation feedback via ReputationRegistry.giveFeedback().
 * Used by workers to rate posters (two-way reputation).
 */

import { encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { signAndSendTransaction } from '../para/transactions.js';
import { getBountyContracts, REPUTATION_REGISTRY_ABI } from '../config/clara-contracts.js';
import { getChainId, getExplorerTxUrl } from '../config/chains.js';
import { formatAddress, toDataUri, getLocalAgentId } from './work-helpers.js';

export const workRateToolDefinition: Tool = {
  name: 'work_rate',
  description: `Rate another agent after completing a bounty (two-way reputation).

Workers can rate posters and vice versa.

**Example:**
\`\`\`json
{"agentAddress": "0x1234...", "bountyAddress": "0x5678...", "rating": 4, "comment": "Clear requirements, fast approval"}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      agentId: {
        type: 'number',
        description: 'ERC-8004 agent token ID of the agent to rate',
      },
      bountyAddress: {
        type: 'string',
        description: 'The bounty this rating is for',
      },
      rating: {
        type: 'number',
        description: 'Rating 1-5',
      },
      comment: {
        type: 'string',
        description: 'Optional feedback comment',
      },
    },
    required: ['agentId', 'bountyAddress', 'rating'],
  },
};

export async function handleWorkRate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const agentId = args.agentId as number;
  const bountyAddress = args.bountyAddress as string;
  const rating = Math.min(5, Math.max(1, (args.rating as number) || 3));
  const comment = (args.comment as string) || '';

  if (!agentId || agentId <= 0) {
    return {
      content: [{ type: 'text', text: '❌ Invalid agent ID.' }],
      isError: true,
    };
  }

  if (!bountyAddress || !bountyAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
    return {
      content: [{ type: 'text', text: '❌ Invalid bounty address.' }],
      isError: true,
    };
  }

  try {
    const contracts = getBountyContracts();
    const chainId = getChainId('base');

    const feedbackMetadata = {
      rating,
      comment,
      bountyAddress,
      ratedAgentId: agentId,
      ratedBy: ctx.walletAddress,
      timestamp: new Date().toISOString(),
    };
    const feedbackURI = toDataUri(feedbackMetadata);
    const feedbackHash = keccak256(toHex(feedbackURI));

    const data = encodeFunctionData({
      abi: REPUTATION_REGISTRY_ABI,
      functionName: 'giveFeedback',
      args: [
        BigInt(agentId),  // agentId to rate
        BigInt(rating),    // int128 value (1-5)
        0,                 // valueDecimals (integer)
        'bounty',          // tag1
        'rating',          // tag2
        '',                // endpoint
        feedbackURI,       // feedbackURI
        feedbackHash,      // feedbackHash
      ],
    });

    const result = await signAndSendTransaction(ctx.session.walletId!, {
      to: contracts.reputationRegistry,
      value: 0n,
      data,
      chainId,
    });

    const explorerUrl = getExplorerTxUrl('base', result.txHash);

    const lines = [
      '✅ **Feedback Submitted!**',
      '',
      `**Rated Agent:** #${agentId}`,
      `**Rating:** ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} (${rating}/5)`,
    ];

    if (comment) {
      lines.push(`**Comment:** ${comment}`);
    }

    lines.push('');
    lines.push(`**Transaction:** [${result.txHash.slice(0, 10)}...](${explorerUrl})`);

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Rating failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
