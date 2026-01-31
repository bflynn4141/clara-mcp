/**
 * Swap Tool
 *
 * Swap tokens using Li.Fi DEX aggregation for best rates.
 * Supports Uniswap, Sushiswap, Curve, and other DEXs.
 */

import { type Hex, encodeFunctionData } from 'viem';
import { getSession, touchSession } from '../storage/session.js';
import {
  getSwapQuote,
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
 * Tool definition for wallet_swap
 */
export const swapToolDefinition = {
  name: 'wallet_swap',
  description: `Swap tokens using DEX aggregation for best rates.

Finds the best price across Uniswap, Sushiswap, Curve, and other DEXs via Li.Fi.

**Get a quote:**
\`\`\`json
{"fromToken": "ETH", "toToken": "USDC", "amount": "0.1", "chain": "base"}
\`\`\`

**Execute the swap:**
\`\`\`json
{"fromToken": "ETH", "toToken": "USDC", "amount": "0.1", "chain": "base", "action": "execute"}
\`\`\`

Supported tokens: ETH, MATIC, USDC, USDT, DAI, WETH (or any contract address).

⚠️ Always get a quote first to review the rate before executing.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      fromToken: {
        type: 'string',
        description: 'Token to sell (symbol like ETH/USDC or contract address)',
      },
      toToken: {
        type: 'string',
        description: 'Token to buy (symbol like ETH/USDC or contract address)',
      },
      amount: {
        type: 'string',
        description: 'Amount of fromToken to swap',
      },
      chain: {
        type: 'string',
        enum: ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'],
        default: 'base',
        description: 'Blockchain to swap on (default: base)',
      },
      action: {
        type: 'string',
        enum: ['quote', 'execute'],
        default: 'quote',
        description: 'quote = preview only, execute = perform the swap',
      },
      slippage: {
        type: 'number',
        default: 0.5,
        description: 'Max slippage percentage (default: 0.5%)',
      },
    },
    required: ['fromToken', 'toToken', 'amount'],
  },
};

function isSwapChain(chain: string): chain is SwapChain {
  return ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'].includes(chain);
}

/**
 * Format quote for display
 */
function formatQuote(quote: SwapQuote, chain: SwapChain): string {
  const lines = [
    `🔄 **Swap Quote on ${chain.charAt(0).toUpperCase() + chain.slice(1)}** (via ${quote.toolDetails})`,
    '',
    `**You send:** ${quote.fromAmount} ${quote.fromToken.symbol}${quote.fromAmountUsd !== '0' ? ` (~$${parseFloat(quote.fromAmountUsd).toFixed(2)})` : ''}`,
    `**You receive:** ${parseFloat(quote.toAmount).toFixed(6)} ${quote.toToken.symbol}${quote.toAmountUsd !== '0' ? ` (~$${parseFloat(quote.toAmountUsd).toFixed(2)})` : ''}`,
    `**Minimum:** ${parseFloat(quote.toAmountMin).toFixed(6)} ${quote.toToken.symbol} (after slippage)`,
    '',
    `**Rate:** 1 ${quote.fromToken.symbol} = ${quote.exchangeRate} ${quote.toToken.symbol}`,
    `**Price Impact:** ${quote.priceImpact}%`,
    `**Est. Gas:** ~$${parseFloat(quote.estimatedGasUsd).toFixed(2)}`,
  ];

  // Price impact warning
  const impact = parseFloat(quote.priceImpact);
  if (impact > 1) {
    lines.push('');
    if (impact > 5) {
      lines.push('⚠️ **HIGH PRICE IMPACT!** Consider a smaller trade.');
    } else {
      lines.push('⚠️ Price impact above 1%');
    }
  }

  // Approval notice
  if (quote.needsApproval) {
    lines.push('');
    lines.push(`🔐 **Approval required:** You need to approve ${quote.fromToken.symbol} first.`);
  }

  return lines.join('\n');
}

/**
 * Handle wallet_swap requests
 */
export async function handleSwapRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const fromToken = args.fromToken as string;
  const toToken = args.toToken as string;
  const amount = args.amount as string;
  const chainName = (args.chain as string) || 'base';
  const action = (args.action as string) || 'quote';
  const slippage = (args.slippage as number) || 0.5;

  // Validate inputs
  if (!fromToken || !toToken || !amount) {
    return {
      content: [{ type: 'text', text: '❌ Missing required parameters: fromToken, toToken, amount' }],
      isError: true,
    };
  }

  if (!isSwapChain(chainName)) {
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

  const fromAddress = session.address as Hex;
  const chain = chainName as SwapChain;

  try {
    // Get quote from Li.Fi
    const quote = await getSwapQuote(
      fromToken,
      toToken,
      amount,
      chain,
      fromAddress,
      { slippage }
    );

    // If just quoting, show the quote
    if (action === 'quote') {
      return {
        content: [{
          type: 'text',
          text: formatQuote(quote, chain) + '\n\n_To execute, run again with `action: "execute"`_',
        }],
      };
    }

    // Execute the swap
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
        chainId: CHAIN_IDS[chain],
      });

      const explorerUrl = `${EXPLORERS[chain]}/tx/${approvalResult.txHash}`;

      return {
        content: [{
          type: 'text',
          text: [
            '🔐 **Approval Submitted**',
            '',
            `Approving ${quote.fromToken.symbol} for swap...`,
            '',
            `**Transaction:** [${approvalResult.txHash.slice(0, 10)}...](${explorerUrl})`,
            '',
            '⏳ Wait for confirmation, then run the swap again.',
          ].join('\n'),
        }],
      };
    }

    // Execute the swap
    console.error(`[clara] Executing swap: ${quote.fromAmount} ${quote.fromToken.symbol} → ${quote.toToken.symbol}`);

    const swapResult = await signAndSendTransaction(session.walletId, {
      to: quote.transactionRequest.to,
      value: BigInt(quote.transactionRequest.value),
      data: quote.transactionRequest.data,
      chainId: CHAIN_IDS[chain],
    });

    const explorerUrl = `${EXPLORERS[chain]}/tx/${swapResult.txHash}`;

    return {
      content: [{
        type: 'text',
        text: [
          '✅ **Swap Submitted!**',
          '',
          formatQuote(quote, chain),
          '',
          `**Transaction:** [${swapResult.txHash.slice(0, 10)}...${swapResult.txHash.slice(-6)}](${explorerUrl})`,
          '',
          `Your ${quote.toToken.symbol} will arrive shortly.`,
        ].join('\n'),
      }],
    };

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Swap failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
