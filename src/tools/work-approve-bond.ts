/**
 * work_approve_bond - Approve Worker Bond for a Bounty
 *
 * Pre-approves the ERC-20 token transfer for the worker bond.
 * This is useful when claim() fails due to insufficient allowance.
 */

import { encodeFunctionData, createPublicClient, http, type Hex } from 'viem';
import { base } from 'viem/chains';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { signAndSendTransaction } from '../para/transactions.js';
import { BOUNTY_ABI, ERC20_APPROVE_ABI } from '../config/clara-contracts.js';
import { getChainId, getExplorerTxUrl, getRpcUrl } from '../config/chains.js';
import { formatAddress, formatRawAmount } from './work-helpers.js';
import { formatContractError } from '../utils/contract-errors.js';
import { requireContract } from '../gas-preflight.js';
import { checkSpendingLimits, recordSpending } from '../storage/spending.js';

export const workApproveBondToolDefinition: Tool = {
  name: 'work_approve_bond',
  description: `Approve the worker bond for a bounty before claiming.

Some bounties require a worker bond (typically 10% of the prize). 
If your claim fails with an allowance or token error, run this first.

**Example:**
\`\`\`json
{"bountyAddress": "0x1234..."}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      bountyAddress: {
        type: 'string',
        description: 'The bounty contract address to approve the bond for',
      },
      amount: {
        type: 'string',
        description: 'Optional: Override the bond amount (default: read from bounty)',
      },
    },
    required: ['bountyAddress'],
  },
};

export async function handleWorkApproveBond(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const bountyAddress = args.bountyAddress as string;
  const overrideAmount = args.amount as string | undefined;

  if (!bountyAddress || !bountyAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
    return {
      content: [{ type: 'text', text: '❌ Invalid bounty address.' }],
      isError: true,
    };
  }

  try {
    await requireContract('base', bountyAddress as Hex, 'bounty contract');

    // Read bounty details to get token and bond amount
    const publicClient = createPublicClient({
      chain: base,
      transport: http(getRpcUrl('base')),
    });

    const [token, workerBond] = await Promise.all([
      publicClient.readContract({
        address: bountyAddress as Hex,
        abi: BOUNTY_ABI,
        functionName: 'token',
      }),
      publicClient.readContract({
        address: bountyAddress as Hex,
        abi: BOUNTY_ABI,
        functionName: 'workerBond',
      }),
    ]);

    // Use override amount if provided, otherwise use workerBond from contract
    let approveAmount: bigint;
    if (overrideAmount) {
      // Parse with 18 decimals as default (most tokens)
      approveAmount = BigInt(parseFloat(overrideAmount) * 1e18);
    } else {
      approveAmount = workerBond;
    }

    // Format for display
    const formattedAmount = formatRawAmount(approveAmount.toString(), token);

    // Check spending limits for worker bond (stablecoins only)
    // Bond is locked on claim and returned on approval — still a real spend risk
    const STABLECOIN_ADDRESSES = new Set([
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC on Base
      '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDT on Base
      '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI on Base
    ]);
    if (STABLECOIN_ADDRESSES.has((token as string).toLowerCase())) {
      // For 6-decimal tokens (USDC/USDT), divide by 1e6; for 18-decimal (DAI), divide by 1e18
      const isDAI = (token as string).toLowerCase() === '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
      const decimals = isDAI ? 18 : 6;
      const estimatedUsd = Number(approveAmount) / (10 ** decimals);
      if (estimatedUsd > 0) {
        const spendCheck = checkSpendingLimits(estimatedUsd.toFixed(2));
        if (!spendCheck.allowed) {
          return {
            content: [{
              type: 'text',
              text: `🛑 **Bond approval blocked by spending limits**\n\n${spendCheck.reason}\n\nBond amount: ~$${estimatedUsd.toFixed(2)}\n\nUse \`wallet_spending_limits\` to view or adjust your limits.`,
            }],
            isError: true,
          };
        }
      }
    }

    // Encode approval
    const data = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [bountyAddress as Hex, approveAmount],
    });

    const result = await signAndSendTransaction(ctx.session.walletId!, {
      to: token,
      value: 0n,
      data,
      chainId: getChainId('base'),
    });

    const explorerUrl = getExplorerTxUrl('base', result.txHash);

    // Record spending for bond approval (stablecoins only)
    if (STABLECOIN_ADDRESSES.has((token as string).toLowerCase())) {
      const isDAI = (token as string).toLowerCase() === '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
      const decimals = isDAI ? 18 : 6;
      const estimatedUsd = Number(approveAmount) / (10 ** decimals);
      if (estimatedUsd > 0) {
        recordSpending({
          timestamp: new Date().toISOString(),
          amountUsd: estimatedUsd.toFixed(2),
          recipient: bountyAddress,
          description: `Worker bond approval for bounty ${formatAddress(bountyAddress)}`,
          url: '',
          chainId: getChainId('base'),
          txHash: result.txHash,
          paymentId: `bond-${result.txHash.slice(0, 10)}`,
        });
      }
    }

    return {
      content: [{
        type: 'text',
        text: [
          '✅ **Worker Bond Approved**',
          '',
          `**Bounty:** \`${formatAddress(bountyAddress)}\``,
          `**Amount:** ${formattedAmount}`,
          `**Token:** \`${formatAddress(token)}\``,
          '',
          `**Transaction:** [${result.txHash.slice(0, 10)}...](${explorerUrl})`,
          '',
          'You can now claim this bounty with `work_claim`.',
        ].join('\n'),
      }],
    };
  } catch (error) {
    // Check if this is a decoded contract error
    if ((error as any).isContractError) {
      return {
        content: [{
          type: 'text',
          text: formatContractError(error),
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: `❌ Approval failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
