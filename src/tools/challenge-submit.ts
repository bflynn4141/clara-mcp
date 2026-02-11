/**
 * challenge_submit - Submit Solution to a Challenge
 *
 * Submits a solution on-chain via Challenge.submit(agentId, solutionURI, solutionHash).
 * Requires authentication and an ERC-8004 agent identity.
 */

import { encodeFunctionData, keccak256, toBytes, type Hex } from 'viem';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { signAndSendTransaction } from '../para/transactions.js';
import { CHALLENGE_ABI } from '../config/clara-contracts.js';
import { getChainId, getExplorerTxUrl } from '../config/chains.js';
import { formatAddress } from './work-helpers.js';
import { getLocalAgentId } from './work-helpers.js';
import { syncFromChain } from '../indexer/sync.js';
import { getChallengeByAddress } from '../indexer/challenge-queries.js';

export const challengeSubmitToolDefinition: Tool = {
  name: 'challenge_submit',
  description: `Submit or resubmit a solution to a challenge.

Requires an ERC-8004 agent identity (use \`work_register\` first).
You can resubmit to improve your score before the deadline.

**Example:**
\`\`\`json
{"challengeAddress": "0x1234...", "solutionURI": "https://github.com/user/repo/blob/main/solution.py"}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      challengeAddress: {
        type: 'string',
        description: 'The challenge contract address',
      },
      solutionURI: {
        type: 'string',
        description: 'URL or data URI pointing to your solution',
      },
      agentId: {
        type: 'number',
        description: 'Your ERC-8004 agent ID (auto-detected if previously registered)',
      },
    },
    required: ['challengeAddress', 'solutionURI'],
  },
};

export async function handleChallengeSubmit(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const challengeAddress = args.challengeAddress as string;
  const solutionURI = args.solutionURI as string;
  let agentId = args.agentId as number | undefined;

  if (!challengeAddress || !challengeAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
    return {
      content: [{ type: 'text', text: 'Invalid challenge address.' }],
      isError: true,
    };
  }

  if (!solutionURI || solutionURI.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Solution URI is required.' }],
      isError: true,
    };
  }

  // Auto-detect agent ID if not provided
  if (!agentId) {
    agentId = getLocalAgentId() ?? undefined;
    if (!agentId) {
      return {
        content: [{
          type: 'text',
          text: 'No agent ID found. Register first with `work_register`, then try again.',
        }],
        isError: true,
      };
    }
  }

  // Check the challenge exists and is open
  const challenge = getChallengeByAddress(challengeAddress);
  if (challenge && challenge.status !== 'open') {
    return {
      content: [{
        type: 'text',
        text: `Challenge is ${challenge.status}. Submissions are only accepted while the challenge is open.`,
      }],
      isError: true,
    };
  }

  try {
    // Compute solutionHash = keccak256(solutionURI bytes)
    const solutionHash = keccak256(toBytes(solutionURI));

    const data = encodeFunctionData({
      abi: CHALLENGE_ABI,
      functionName: 'submit',
      args: [BigInt(agentId), solutionURI, solutionHash],
    });

    const result = await signAndSendTransaction(ctx.session.walletId!, {
      to: challengeAddress as Hex,
      value: 0n,
      data,
      chainId: getChainId('base'),
    });

    // Sync indexer to pick up SubmissionReceived event
    try {
      await syncFromChain();
    } catch (e) {
      console.error(`[challenge] Local indexer sync failed (non-fatal): ${e}`);
    }

    const explorerUrl = getExplorerTxUrl('base', result.txHash);

    // Check if this was a resubmission
    const isResubmission = (challenge?.submissions[ctx.walletAddress.toLowerCase()]?.version ?? 0) > 0;

    const lines = [
      isResubmission ? '**Solution Resubmitted!**' : '**Solution Submitted!**',
      '',
      `**Challenge:** \`${formatAddress(challengeAddress)}\``,
      `**Agent:** #${agentId}`,
      `**Solution:** ${solutionURI.startsWith('http') ? `[Link](${solutionURI})` : solutionURI.slice(0, 80)}`,
      `**Hash:** \`${solutionHash.slice(0, 18)}...\``,
      '',
      `**Transaction:** [${result.txHash.slice(0, 10)}...](${explorerUrl})`,
      '',
    ];

    if (isResubmission) {
      lines.push('Your previous submission has been replaced. Scores update after evaluation.');
    } else {
      lines.push('Your submission is recorded on-chain. The poster will evaluate all submissions after the deadline.');
    }

    lines.push('Use `challenge_score` to check your results after scoring.');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Submit failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
