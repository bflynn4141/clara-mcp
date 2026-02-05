/**
 * wallet_executePrepared - Execute a Previously Prepared Transaction
 *
 * Second phase of the two-phase execution pattern:
 * 1. wallet_call prepares and simulates → returns preparedTxId
 * 2. wallet_executePrepared executes → sends the exact same transaction
 *
 * Benefits:
 * - Exact same calldata is executed as was simulated
 * - No re-encoding between phases (prevents "model drift")
 * - Transaction expires after 5 minutes for safety
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Hex } from 'viem';
import { signAndSendTransaction, type TransactionParams } from '../para/transactions.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { getPreparedTx, deletePreparedTx, formatPreparedTx } from '../para/prepared-tx.js';
import { type SupportedChain } from '../config/chains.js';
import { requireGas } from '../gas-preflight.js';

// Explorer URLs by chain
const EXPLORERS: Record<SupportedChain, string> = {
  ethereum: 'https://etherscan.io/tx/',
  base: 'https://basescan.org/tx/',
  arbitrum: 'https://arbiscan.io/tx/',
  optimism: 'https://optimistic.etherscan.io/tx/',
  polygon: 'https://polygonscan.com/tx/',
};

/**
 * Tool definition for wallet_executePrepared
 */
export const executePreparedToolDefinition: Tool = {
  name: 'wallet_executePrepared',
  description: `Execute a prepared transaction from wallet_call.

**Flow:**
1. Use \`wallet_call\` to prepare and simulate a transaction
2. Review the simulation results and preparedTxId
3. Use this tool to execute the exact same transaction

**Example:**
\`\`\`json
{"preparedTxId": "ptx_abc123_xyz"}
\`\`\`

**Safety:**
- Executes the EXACT same calldata that was simulated
- Prepared transactions expire after 5 minutes
- Only simulated-successful transactions can be executed (use \`force: true\` to override)

**Note:** If the prepared transaction has expired, run \`wallet_call\` again to get a fresh one.`,
  inputSchema: {
    type: 'object',
    properties: {
      preparedTxId: {
        type: 'string',
        description: 'The prepared transaction ID from wallet_call',
      },
      force: {
        type: 'boolean',
        description: 'Force execution even if simulation failed (dangerous!)',
      },
    },
    required: ['preparedTxId'],
  },
};

/**
 * Handle wallet_executePrepared requests
 */
export async function handleExecutePreparedRequest(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const preparedTxId = args.preparedTxId as string;
  const force = (args.force as boolean) || false;

  try {
    // Validate input
    if (!preparedTxId) {
      return {
        content: [{ type: 'text', text: '❌ Missing preparedTxId parameter' }],
        isError: true,
      };
    }

    const session = ctx.session;

    // Get prepared transaction
    const preparedTx = getPreparedTx(preparedTxId);

    if (!preparedTx) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ **Prepared transaction not found or expired:** \`${preparedTxId}\`\n\nPrepared transactions expire after 5 minutes.\n\nRun \`wallet_call\` again to prepare a fresh transaction.`,
          },
        ],
        isError: true,
      };
    }

    // Check simulation status
    if (!preparedTx.simulation.success && !force) {
      const display = formatPreparedTx(preparedTx);
      return {
        content: [
          {
            type: 'text',
            text: `${display}\n\n❌ **Cannot execute:** Simulation failed.\n\nTo force execution anyway, use \`force: true\` (dangerous!)`,
          },
        ],
        isError: true,
      };
    }

    // Gas pre-flight check
    await requireGas(preparedTx.chain, ctx.walletAddress, {
      txValue: preparedTx.value,
      gasLimit: preparedTx.simulation.gasEstimate
        ? (preparedTx.simulation.gasEstimate * 150n) / 100n  // Match the 50% buffer below
        : 200_000n,
    });

    // Build transaction params
    const txParams: TransactionParams = {
      to: preparedTx.to,
      data: preparedTx.data,
      value: preparedTx.value,
      chainId: preparedTx.chainId,
      // Use simulated gas estimate with 50% buffer (complex contract calls need headroom)
      gas: preparedTx.simulation.gasEstimate
        ? (preparedTx.simulation.gasEstimate * 150n) / 100n
        : undefined,
    };

    // Execute the transaction
    console.error(
      `[clara] Executing prepared tx ${preparedTxId}: ${preparedTx.functionSignature} on ${preparedTx.chain}`
    );

    const result = await signAndSendTransaction(session.walletId!, txParams);

    // Delete the prepared transaction (one-time use)
    deletePreparedTx(preparedTxId);

    // Build success message
    const explorerUrl = `${EXPLORERS[preparedTx.chain]}${result.txHash}`;

    const lines: string[] = [
      `✅ **Transaction Submitted!**`,
      '',
      `**Function:** \`${preparedTx.functionSignature}\``,
    ];

    if (preparedTx.contractName) {
      lines.push(`**Contract:** ${preparedTx.contractName}`);
    }

    lines.push(
      `**Chain:** ${preparedTx.chain}`,
      '',
      `**Transaction Hash:** \`${result.txHash}\``,
      `🔗 [View on Explorer](${explorerUrl})`
    );

    if (preparedTx.value > 0n) {
      const ethValue = Number(preparedTx.value) / 1e18;
      lines.push('', `**Value sent:** ${ethValue.toFixed(6)} ETH`);
    }

    if (force && !preparedTx.simulation.success) {
      lines.push('', `⚠️ **Note:** This transaction was force-executed despite simulation failure.`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Check for common error patterns
    if (message.includes('insufficient funds')) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ **Insufficient funds** for this transaction.\n\nCheck your balance with \`wallet_balance\` and ensure you have enough for gas.`,
          },
        ],
        isError: true,
      };
    }

    if (message.includes('nonce')) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ **Nonce error:** ${message}\n\nThis can happen if you have pending transactions. Wait for them to confirm or cancel them.`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: `❌ Execution failed: ${message}` }],
      isError: true,
    };
  }
}
