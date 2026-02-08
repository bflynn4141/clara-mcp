/**
 * work_cancel - Cancel an Unclaimed Bounty
 *
 * Cancels a bounty on-chain and refunds the poster.
 * Only works if the bounty has not been claimed yet.
 */

import { encodeFunctionData, type Hex } from 'viem';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { signAndSendTransaction } from '../para/transactions.js';
import { BOUNTY_ABI } from '../config/clara-contracts.js';
import { getChainId, getExplorerTxUrl } from '../config/chains.js';
import { formatAddress, indexerFetch } from './work-helpers.js';

export const workCancelToolDefinition: Tool = {
  name: 'work_cancel',
  description: `Cancel a bounty and get your funds back.

Only works if the bounty hasn't been claimed yet.

**Example:**
\`\`\`json
{"bountyAddress": "0x1234..."}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      bountyAddress: {
        type: 'string',
        description: 'The bounty contract address to cancel',
      },
    },
    required: ['bountyAddress'],
  },
};

export async function handleWorkCancel(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const bountyAddress = args.bountyAddress as string;

  if (!bountyAddress || !bountyAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
    return {
      content: [{ type: 'text', text: '❌ Invalid bounty address.' }],
      isError: true,
    };
  }

  try {
    const data = encodeFunctionData({
      abi: BOUNTY_ABI,
      functionName: 'cancel',
    });

    const result = await signAndSendTransaction(ctx.session.walletId!, {
      to: bountyAddress as Hex,
      value: 0n,
      data,
      chainId: getChainId('base'),
    });

    // Update indexer (best-effort)
    try {
      await indexerFetch(`/api/bounties/${bountyAddress}`, {
        method: 'PUT',
        body: JSON.stringify({
          status: 'cancelled',
          cancelledAt: new Date().toISOString(),
        }),
      });
    } catch (e) {
      console.error(`[work] Indexer update failed (non-fatal): ${e}`);
    }

    const explorerUrl = getExplorerTxUrl('base', result.txHash);

    return {
      content: [{
        type: 'text',
        text: [
          '✅ **Bounty Cancelled — Funds Refunded**',
          '',
          `**Bounty:** \`${formatAddress(bountyAddress)}\``,
          '',
          `**Transaction:** [${result.txHash.slice(0, 10)}...](${explorerUrl})`,
        ].join('\n'),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Cancel failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
