/**
 * work_claim - Claim an Open Bounty
 *
 * Claims a bounty on-chain by calling Bounty.claim().
 * The claimer commits to delivering the work before the deadline.
 */

import { encodeFunctionData, type Hex } from 'viem';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { signAndSendTransaction } from '../para/transactions.js';
import { BOUNTY_ABI } from '../config/clara-contracts.js';
import { getChainId, getExplorerTxUrl } from '../config/chains.js';
import { formatAddress, formatRawAmount } from './work-helpers.js';
import { syncFromChain } from '../indexer/sync.js';
import { getBountyByAddress } from '../indexer/queries.js';

export const workClaimToolDefinition: Tool = {
  name: 'work_claim',
  description: `Claim an open bounty to start working on it.

Once claimed, you are committing to deliver the work before the deadline.
Submit your deliverable with \`work_submit\` when done.

**Example:**
\`\`\`json
{"bountyAddress": "0x1234..."}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      bountyAddress: {
        type: 'string',
        description: 'The bounty contract address to claim',
      },
      agentId: {
        type: 'number',
        description: 'Your ERC-8004 agent token ID (required to prove identity)',
      },
    },
    required: ['bountyAddress', 'agentId'],
  },
};

export async function handleWorkClaim(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const bountyAddress = args.bountyAddress as string;
  const agentId = args.agentId as number;

  if (!bountyAddress || !bountyAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
    return {
      content: [{ type: 'text', text: '❌ Invalid bounty address.' }],
      isError: true,
    };
  }

  if (!agentId || agentId <= 0) {
    return {
      content: [{ type: 'text', text: '❌ Invalid agentId. Register first with `work_register`.' }],
      isError: true,
    };
  }

  try {
    // Look up bounty to show bond info
    const bounty = getBountyByAddress(bountyAddress);
    let workerBondInfo = '';
    if (bounty && bounty.bondRate && bounty.bondRate > 0) {
      const bondAmount = (BigInt(bounty.amount) * BigInt(bounty.bondRate)) / 10000n;
      workerBondInfo = formatRawAmount(bondAmount.toString(), bounty.token);
    }

    const data = encodeFunctionData({
      abi: BOUNTY_ABI,
      functionName: 'claim',
      args: [BigInt(agentId)],
    });

    const result = await signAndSendTransaction(ctx.session.walletId!, {
      to: bountyAddress as Hex,
      value: 0n,
      data,
      chainId: getChainId('base'),
    });

    // Sync local indexer to pick up BountyClaimed event
    try {
      await syncFromChain();
    } catch (e) {
      console.error(`[work] Local indexer sync failed (non-fatal): ${e}`);
    }

    const explorerUrl = getExplorerTxUrl('base', result.txHash);

    const lines = [
      '✅ **Bounty Claimed!**',
      '',
      `**Bounty:** \`${formatAddress(bountyAddress)}\``,
      `**Claimer:** \`${formatAddress(ctx.walletAddress)}\``,
    ];

    if (workerBondInfo) {
      lines.push(`**Worker Bond:** ${workerBondInfo} (held in escrow, returned on approval)`);
    }

    lines.push('');
    lines.push(`**Transaction:** [${result.txHash.slice(0, 10)}...](${explorerUrl})`);
    lines.push('');
    lines.push('Submit your work with `work_submit` when ready.');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Claim failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
