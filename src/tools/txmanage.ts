/**
 * Transaction Management Tools
 *
 * Cancel or speed up pending transactions.
 * Uses nonce replacement (same nonce, higher gas price).
 */

import {
  createPublicClient,
  http,
  formatGwei,
  type Hex,
  type PublicClient,
} from 'viem';
import { getSession, touchSession } from '../storage/session.js';
import { signAndSendTransaction } from '../para/transactions.js';
import { CHAINS, getRpcUrl, isSupportedChain, type SupportedChain } from '../config/chains.js';

/**
 * Get chain config (convenience wrapper for CHAINS)
 */
function getChainConfig(chainName: SupportedChain) {
  return CHAINS[chainName];
}

/**
 * Tool definition for wallet_cancel
 */
export const cancelToolDefinition = {
  name: 'wallet_cancel',
  description: `Cancel a pending transaction by replacing it with a zero-value self-transfer.

**How it works:**
- Sends 0 ETH to yourself with the same nonce
- Higher gas price ensures the replacement gets mined first
- The original transaction becomes invalid once the cancellation is mined

**Example:**
\`\`\`json
{"nonce": 42, "chain": "base"}
\`\`\`

⚠️ Only works for pending (unmined) transactions.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      nonce: {
        type: 'number',
        description: 'Nonce of the transaction to cancel',
      },
      chain: {
        type: 'string',
        enum: ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'],
        default: 'base',
        description: 'Chain where the transaction is pending',
      },
      gasPriceMultiplier: {
        type: 'number',
        default: 1.5,
        description: 'Multiply current gas price by this factor (default: 1.5x)',
      },
    },
    required: ['nonce'],
  },
};

/**
 * Tool definition for wallet_speed_up
 */
export const speedUpToolDefinition = {
  name: 'wallet_speed_up',
  description: `Speed up a pending transaction by resubmitting with higher gas.

**How it works:**
- Resubmits the same transaction with a higher gas price
- Miners/validators prefer higher gas, so it gets picked up faster
- The original lower-gas version is dropped from the mempool

**Example:**
\`\`\`json
{
  "nonce": 42,
  "to": "0x...",
  "value": "0.1",
  "chain": "base"
}
\`\`\`

⚠️ Only works for pending (unmined) transactions.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      nonce: {
        type: 'number',
        description: 'Nonce of the pending transaction',
      },
      to: {
        type: 'string',
        description: 'Recipient address',
      },
      value: {
        type: 'string',
        default: '0',
        description: 'ETH value (same as original transaction)',
      },
      data: {
        type: 'string',
        description: 'Transaction data (same as original transaction)',
      },
      chain: {
        type: 'string',
        enum: ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'],
        default: 'base',
        description: 'Chain where the transaction is pending',
      },
      gasPriceMultiplier: {
        type: 'number',
        default: 1.5,
        description: 'Multiply current gas price by this factor (default: 1.5x)',
      },
    },
    required: ['nonce', 'to'],
  },
};

/**
 * Get current gas prices with multiplier
 */
async function getGasPrices(
  chainName: SupportedChain,
  multiplier: number
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const chainConfig = getChainConfig(chainName);
  const client = createPublicClient({
    chain: chainConfig.chain,
    transport: http(getRpcUrl(chainName)),
  });

  try {
    const feeData = await client.estimateFeesPerGas();
    const maxFeePerGas = BigInt(Math.floor(Number(feeData.maxFeePerGas || 30000000000n) * multiplier));
    const maxPriorityFeePerGas = BigInt(Math.floor(Number(feeData.maxPriorityFeePerGas || 1000000000n) * multiplier));
    return { maxFeePerGas, maxPriorityFeePerGas };
  } catch {
    // Fallback gas prices
    const baseFee = chainName === 'ethereum' ? 30000000000n : 100000000n;
    const priorityFee = 1000000000n;
    return {
      maxFeePerGas: BigInt(Math.floor(Number(baseFee) * multiplier)),
      maxPriorityFeePerGas: BigInt(Math.floor(Number(priorityFee) * multiplier)),
    };
  }
}

/**
 * Handle wallet_cancel requests
 */
export async function handleCancelRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const nonce = args.nonce as number;
  const chainName = (args.chain as string) || 'base';
  const gasPriceMultiplier = (args.gasPriceMultiplier as number) || 1.5;

  // Validate inputs
  if (nonce === undefined || nonce < 0) {
    return {
      content: [{ type: 'text', text: '❌ Valid nonce is required' }],
      isError: true,
    };
  }

  if (!isSupportedChain(chainName)) {
    return {
      content: [{
        type: 'text',
        text: `❌ Unsupported chain: ${chainName}\n\nSupported: base, ethereum, arbitrum, optimism, polygon`,
      }],
      isError: true,
    };
  }

  // Check session
  const session = await getSession();
  if (!session?.authenticated || !session.walletId || !session.address) {
    return {
      content: [{ type: 'text', text: '❌ Wallet not configured. Run `wallet_setup` first.' }],
      isError: true,
    };
  }

  await touchSession();

  const chainConfig = getChainConfig(chainName);
  const address = session.address as Hex;

  try {
    const client = createPublicClient({
      chain: chainConfig.chain,
      transport: http(getRpcUrl(chainName)),
    });

    // Get current nonce to verify
    const currentNonce = await client.getTransactionCount({ address });

    if (nonce < currentNonce) {
      return {
        content: [{
          type: 'text',
          text: `❌ Transaction with nonce ${nonce} has already been mined.\n\nYour current nonce is ${currentNonce}.`,
        }],
        isError: true,
      };
    }

    // Get gas prices
    const { maxFeePerGas, maxPriorityFeePerGas } = await getGasPrices(chainName, gasPriceMultiplier);

    // Send cancellation (0 ETH to self with same nonce)
    const result = await signAndSendTransaction(session.walletId, {
      to: address,
      value: 0n,
      chainId: chainConfig.chainId,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    const explorerUrl = `${chainConfig.explorerUrl}/tx/${result.txHash}`;

    return {
      content: [{
        type: 'text',
        text: [
          '✅ **Cancellation Submitted**',
          '',
          `**Nonce:** ${nonce}`,
          `**Chain:** ${chainName}`,
          `**Gas Price:** ${formatGwei(maxFeePerGas)} gwei (${gasPriceMultiplier}x current)`,
          '',
          `**Transaction:** [${result.txHash.slice(0, 10)}...](${explorerUrl})`,
          '',
          'The original transaction will be replaced once this is mined.',
        ].join('\n'),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Cancellation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

/**
 * Handle wallet_speed_up requests
 */
export async function handleSpeedUpRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const nonce = args.nonce as number | undefined;
  const to = args.to as string | undefined;
  const value = (args.value as string) || '0';
  const data = args.data as string | undefined;
  const chainName = (args.chain as string) || 'base';
  const gasPriceMultiplier = (args.gasPriceMultiplier as number) || 1.5;

  // Validate inputs
  if (nonce === undefined || !to) {
    return {
      content: [{
        type: 'text',
        text: '❌ Both `nonce` and `to` parameters are required.',
      }],
      isError: true,
    };
  }

  if (!isSupportedChain(chainName)) {
    return {
      content: [{
        type: 'text',
        text: `❌ Unsupported chain: ${chainName}\n\nSupported: base, ethereum, arbitrum, optimism, polygon`,
      }],
      isError: true,
    };
  }

  // Check session
  const session = await getSession();
  if (!session?.authenticated || !session.walletId || !session.address) {
    return {
      content: [{ type: 'text', text: '❌ Wallet not configured. Run `wallet_setup` first.' }],
      isError: true,
    };
  }

  await touchSession();

  const chainConfig = getChainConfig(chainName);
  const address = session.address as Hex;

  try {
    const client = createPublicClient({
      chain: chainConfig.chain,
      transport: http(getRpcUrl(chainName)),
    });

    // Verify nonce is still pending
    const currentNonce = await client.getTransactionCount({ address });

    if (nonce < currentNonce) {
      return {
        content: [{
          type: 'text',
          text: `❌ Transaction with nonce ${nonce} has already been mined.\n\nYour current nonce is ${currentNonce}.`,
        }],
        isError: true,
      };
    }

    // Get higher gas prices
    const { maxFeePerGas, maxPriorityFeePerGas } = await getGasPrices(chainName, gasPriceMultiplier);

    // Resubmit with higher gas
    const result = await signAndSendTransaction(session.walletId, {
      to: to as Hex,
      value: BigInt(Math.floor(parseFloat(value) * 1e18)),
      data: data as Hex | undefined,
      chainId: chainConfig.chainId,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    const explorerUrl = `${chainConfig.explorerUrl}/tx/${result.txHash}`;

    return {
      content: [{
        type: 'text',
        text: [
          '✅ **Speed Up Submitted**',
          '',
          `**Nonce:** ${nonce}`,
          `**To:** \`${to}\``,
          `**Chain:** ${chainName}`,
          `**New Gas Price:** ${formatGwei(maxFeePerGas)} gwei (${gasPriceMultiplier}x)`,
          '',
          `**New Transaction:** [${result.txHash.slice(0, 10)}...](${explorerUrl})`,
          '',
          'The faster version should be picked up by validators soon.',
        ].join('\n'),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Speed up failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
