/**
 * work_submit - Submit Work for a Bounty
 *
 * Submits proof of completed work on-chain via Bounty.submitWork(proofURI).
 * The poster can then approve the submission to release funds.
 */

import { encodeFunctionData, type Hex } from 'viem';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { signAndSendTransaction } from '../para/transactions.js';
import { BOUNTY_ABI } from '../config/clara-contracts.js';
import { getChainId, getExplorerTxUrl } from '../config/chains.js';
import { formatAddress, toDataUri, indexerFetch } from './work-helpers.js';

export const workSubmitToolDefinition: Tool = {
  name: 'work_submit',
  description: `Submit your completed work for a bounty.

Provide a proof URL or description of the deliverable.
The bounty poster will review and approve to release your payment.

**Example:**
\`\`\`json
{"bountyAddress": "0x1234...", "proof": "https://github.com/user/repo/pull/42"}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      bountyAddress: {
        type: 'string',
        description: 'The bounty contract address',
      },
      proof: {
        type: 'string',
        description: 'Proof of work — URL (PR, commit, deployment) or description',
      },
    },
    required: ['bountyAddress', 'proof'],
  },
};

export async function handleWorkSubmit(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const bountyAddress = args.bountyAddress as string;
  const proof = args.proof as string;

  if (!bountyAddress || !bountyAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
    return {
      content: [{ type: 'text', text: '❌ Invalid bounty address.' }],
      isError: true,
    };
  }

  if (!proof || proof.trim().length === 0) {
    return {
      content: [{ type: 'text', text: '❌ Proof of work is required.' }],
      isError: true,
    };
  }

  try {
    // Encode proof as data URI if it's not already a URL
    const proofURI = proof.startsWith('http') || proof.startsWith('data:')
      ? proof
      : toDataUri({ proof, submittedBy: ctx.walletAddress, timestamp: new Date().toISOString() });

    const data = encodeFunctionData({
      abi: BOUNTY_ABI,
      functionName: 'submitWork',
      args: [proofURI],
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
          status: 'submitted',
          proofUri: proofURI,
          submittedAt: new Date().toISOString(),
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
          '✅ **Work Submitted!**',
          '',
          `**Bounty:** \`${formatAddress(bountyAddress)}\``,
          `**Proof:** ${proof.startsWith('http') ? `[Link](${proof})` : proof.slice(0, 100)}`,
          '',
          `**Transaction:** [${result.txHash.slice(0, 10)}...](${explorerUrl})`,
          '',
          'The bounty poster will review your submission.',
        ].join('\n'),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Submit failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
