/**
 * work_reject - Reject a Bounty Submission
 *
 * Rejects submitted work on-chain via Bounty.reject().
 * First rejection slashes the worker bond (50% to poster, 50% burned).
 * Second rejection burns both bonds and returns escrow to poster.
 */

import { encodeFunctionData, type Hex } from 'viem';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { signAndSendTransaction } from '../para/transactions.js';
import { BOUNTY_ABI } from '../config/clara-contracts.js';
import { getChainId, getExplorerTxUrl } from '../config/chains.js';
import { formatAddress } from './work-helpers.js';
import { requireContract } from '../gas-preflight.js';
import { awaitIndexed, getBountyByAddress } from '../indexer/index.js';

export const workRejectToolDefinition: Tool = {
  name: 'work_reject',
  description: `Reject a submitted bounty. The worker's bond is slashed on first rejection.

A second rejection burns both bonds and returns the escrow to the poster (resolved).
The worker may resubmit after a first rejection.

**Example:**
\`\`\`json
{"bountyAddress": "0x1234..."}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      bountyAddress: {
        type: 'string',
        description: 'The bounty contract address to reject',
      },
    },
    required: ['bountyAddress'],
  },
};

export async function handleWorkReject(
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
    await requireContract('base', bountyAddress as Hex, 'bounty contract');

    // Check current rejection count for appropriate messaging
    const bounty = await getBountyByAddress(bountyAddress);
    const currentRejections = bounty?.rejectionCount ?? 0;

    const data = encodeFunctionData({
      abi: BOUNTY_ABI,
      functionName: 'reject',
    });

    const result = await signAndSendTransaction(ctx.session.walletId!, {
      to: bountyAddress as Hex,
      value: 0n,
      data,
      chainId: getChainId('base'),
    });

    // Wait for indexer to pick up BountyRejected event
    try {
      await awaitIndexed(result.txHash);
    } catch (e) {
      console.error(`[work] Indexer sync failed (non-fatal): ${e}`);
    }

    const explorerUrl = getExplorerTxUrl('base', result.txHash);

    const lines: string[] = [];

    if (currentRejections === 0) {
      // First rejection
      lines.push('⚠️ **Submission Rejected (1st rejection)**');
      lines.push('');
      lines.push(`**Bounty:** \`${formatAddress(bountyAddress)}\``);
      lines.push('**Worker bond:** Slashed (50% to you, 50% burned)');
      lines.push('');
      lines.push('The worker may resubmit their work. A second rejection will burn both bonds and return the escrow to you.');
    } else {
      // Second rejection — resolved
      lines.push('🔒 **Submission Rejected (2nd rejection) — Bounty Resolved**');
      lines.push('');
      lines.push(`**Bounty:** \`${formatAddress(bountyAddress)}\``);
      lines.push('**Both bonds:** Burned');
      lines.push('**Escrow:** Returned to you');
      lines.push('');
      lines.push('The bounty is now permanently resolved.');
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
        text: `❌ Reject failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
