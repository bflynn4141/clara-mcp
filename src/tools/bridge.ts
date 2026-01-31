/**
 * Bridge Tool
 *
 * Bridge tokens across chains using Li.Fi aggregation.
 * Supports Stargate, Hop, Across, and other bridges.
 */

import { type Hex } from 'viem';
import { getSession, touchSession } from '../storage/session.js';
import {
  getBridgeQuote,
  resolveToken,
  encodeApproveCalldata,
  MAX_UINT256,
  type SwapQuote,
  type SwapChain,
} from '../services/lifi.js';
import { signAndSendTransaction } from '../para/transactions.js';

/**
 * Chain explorer URLs
 */
const EXPLORERS: Record<SwapChain, string> = {
  base: 'https://basescan.org',
  ethereum: 'https://etherscan.io',
  arbitrum: 'https://arbiscan.io',
  optimism: 'https://optimistic.etherscan.io',
  polygon: 'https://polygonscan.com',
};

/**
 * Chain IDs
 */
const CHAIN_IDS: Record<SwapChain, number> = {
  base: 8453,
  ethereum: 1,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
};

/**
 * Tool definition for wallet_bridge
 */
export const bridgeToolDefinition = {
  name: 'wallet_bridge',
  description: `Bridge tokens across chains using Li.Fi bridge aggregation.

Finds the best route across Stargate, Hop, Across, and other bridges.

**Get a quote:**
\`\`\`json
{"fromToken": "ETH", "toToken": "ETH", "amount": "0.1", "fromChain": "ethereum", "toChain": "base"}
\`\`\`

**Execute the bridge:**
\`\`\`json
{"fromToken": "ETH", "toToken": "ETH", "amount": "0.1", "fromChain": "ethereum", "toChain": "base", "action": "execute"}
\`\`\`

Can also swap while bridging (e.g., ETH on Ethereum → USDC on Base).

⚠️ Cross-chain transfers take 5-30 minutes depending on the route.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      fromToken: {
        type: 'string',
        description: 'Token to send (symbol like ETH/USDC or contract address)',
      },
      toToken: {
        type: 'string',
        description: 'Token to receive (symbol like ETH/USDC or contract address)',
      },
      amount: {
        type: 'string',
        description: 'Amount of fromToken to bridge',
      },
      fromChain: {
        type: 'string',
        enum: ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'],
        description: 'Source chain',
      },
      toChain: {
        type: 'string',
        enum: ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'],
        description: 'Destination chain',
      },
      action: {
        type: 'string',
        enum: ['quote', 'execute'],
        default: 'quote',
        description: 'quote = preview only, execute = perform the bridge',
      },
      slippage: {
        type: 'number',
        default: 0.5,
        description: 'Max slippage percentage (default: 0.5%)',
      },
    },
    required: ['fromToken', 'toToken', 'amount', 'fromChain', 'toChain'],
  },
};

function isSwapChain(chain: string): chain is SwapChain {
  return ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'].includes(chain);
}

/**
 * Format bridge quote for display
 */
function formatQuote(quote: SwapQuote, fromChain: SwapChain, toChain: SwapChain): string {
  const lines = [
    `🌉 **Bridge Quote: ${fromChain} → ${toChain}** (via ${quote.toolDetails})`,
    '',
    `**You send:** ${quote.fromAmount} ${quote.fromToken.symbol} on ${fromChain}${quote.fromAmountUsd !== '0' ? ` (~$${parseFloat(quote.fromAmountUsd).toFixed(2)})` : ''}`,
    `**You receive:** ${parseFloat(quote.toAmount).toFixed(6)} ${quote.toToken.symbol} on ${toChain}${quote.toAmountUsd !== '0' ? ` (~$${parseFloat(quote.toAmountUsd).toFixed(2)})` : ''}`,
    `**Minimum:** ${parseFloat(quote.toAmountMin).toFixed(6)} ${quote.toToken.symbol}`,
    '',
    `**Rate:** 1 ${quote.fromToken.symbol} = ${quote.exchangeRate} ${quote.toToken.symbol}`,
    `**Est. Gas:** ~$${parseFloat(quote.estimatedGasUsd).toFixed(2)}`,
    '',
    '⏱️ **Estimated time:** 5-30 minutes (varies by bridge)',
  ];

  // Approval notice
  if (quote.needsApproval) {
    lines.push('');
    lines.push(`🔐 **Approval required:** You need to approve ${quote.fromToken.symbol} first.`);
  }

  return lines.join('\n');
}

/**
 * Handle wallet_bridge requests
 */
export async function handleBridgeRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const fromToken = args.fromToken as string;
  const toToken = args.toToken as string;
  const amount = args.amount as string;
  const fromChainName = args.fromChain as string;
  const toChainName = args.toChain as string;
  const action = (args.action as string) || 'quote';
  const slippage = (args.slippage as number) || 0.5;

  // Validate inputs
  if (!fromToken || !toToken || !amount || !fromChainName || !toChainName) {
    return {
      content: [{ type: 'text', text: '❌ Missing required parameters: fromToken, toToken, amount, fromChain, toChain' }],
      isError: true,
    };
  }

  if (!isSwapChain(fromChainName) || !isSwapChain(toChainName)) {
    return {
      content: [{
        type: 'text',
        text: `❌ Unsupported chain\n\nSupported: base, ethereum, arbitrum, optimism, polygon`,
      }],
      isError: true,
    };
  }

  if (fromChainName === toChainName) {
    return {
      content: [{
        type: 'text',
        text: '❌ Source and destination chains are the same. Use `wallet_swap` for same-chain swaps.',
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

  const fromAddress = session.address as Hex;
  const fromChain = fromChainName as SwapChain;
  const toChain = toChainName as SwapChain;

  try {
    // Get bridge quote from Li.Fi
    const quote = await getBridgeQuote(
      fromToken,
      toToken,
      amount,
      fromChain,
      toChain,
      fromAddress,
      { slippage }
    );

    // If just quoting, show the quote
    if (action === 'quote') {
      return {
        content: [{
          type: 'text',
          text: formatQuote(quote, fromChain, toChain) + '\n\n_To execute, run again with `action: "execute"`_',
        }],
      };
    }

    // Execute the bridge
    if (!quote.transactionRequest) {
      return {
        content: [{
          type: 'text',
          text: '❌ No transaction data returned from Li.Fi. Try getting a fresh quote.',
        }],
        isError: true,
      };
    }

    // Handle approval if needed
    if (quote.needsApproval && quote.approvalAddress) {
      console.error(`[clara] Sending approval for ${quote.fromToken.symbol}...`);

      const approvalData = encodeApproveCalldata(quote.approvalAddress, MAX_UINT256);

      const approvalResult = await signAndSendTransaction(session.walletId, {
        to: quote.fromToken.address,
        value: 0n,
        data: approvalData,
        chainId: CHAIN_IDS[fromChain],
      });

      const explorerUrl = `${EXPLORERS[fromChain]}/tx/${approvalResult.txHash}`;

      return {
        content: [{
          type: 'text',
          text: [
            '🔐 **Approval Submitted**',
            '',
            `Approving ${quote.fromToken.symbol} for bridging...`,
            '',
            `**Transaction:** [${approvalResult.txHash.slice(0, 10)}...](${explorerUrl})`,
            '',
            '⏳ Wait for confirmation, then run the bridge again.',
          ].join('\n'),
        }],
      };
    }

    // Execute the bridge
    console.error(`[clara] Executing bridge: ${quote.fromAmount} ${quote.fromToken.symbol} (${fromChain} → ${toChain})`);

    const bridgeResult = await signAndSendTransaction(session.walletId, {
      to: quote.transactionRequest.to,
      value: BigInt(quote.transactionRequest.value),
      data: quote.transactionRequest.data,
      chainId: CHAIN_IDS[fromChain],
    });

    const explorerUrl = `${EXPLORERS[fromChain]}/tx/${bridgeResult.txHash}`;

    return {
      content: [{
        type: 'text',
        text: [
          '✅ **Bridge Submitted!**',
          '',
          formatQuote(quote, fromChain, toChain),
          '',
          `**Transaction:** [${bridgeResult.txHash.slice(0, 10)}...${bridgeResult.txHash.slice(-6)}](${explorerUrl})`,
          '',
          `⏱️ Your ${quote.toToken.symbol} will arrive on ${toChain} in 5-30 minutes.`,
        ].join('\n'),
      }],
    };

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Bridge failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
