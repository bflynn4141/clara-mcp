/**
 * Swap Tool - DEX Aggregation with Herd Contract Intelligence
 *
 * Swaps tokens using Li.Fi aggregation for best rates across DEXs.
 * Integrates with Herd for contract safety checks on the DEX router.
 *
 * Flow:
 * 1. Get quote (shows rate, price impact, gas)
 * 2. Check contract via Herd (verified status, proxy info)
 * 3. Execute swap (with user confirmation)
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createPublicClient, encodeFunctionData, http, type Hex } from 'viem';
import {
  getSwapQuote,
  executeSwap,
  getExplorerTxUrl,
  resolveToken,
  parseAmountToBigInt,
  type SwapQuote,
} from '../para/swap.js';
import { signAndSendTransaction } from '../para/transactions.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { type SupportedChain, isSupportedChain, getChainId, getRpcUrl, CHAINS } from '../config/chains.js';
import { getProviderRegistry, isHerdEnabled } from '../providers/index.js';
import {
  cacheQuote,
  getCachedQuote,
  markQuoteConsumed,
  type HerdCheckResult,
} from '../cache/quotes.js';
import { checkSpendingLimits, recordSpending } from '../storage/spending.js';
import { requireGas } from '../gas-preflight.js';
import { ClaraError, ClaraErrorCode } from '../errors.js';

// Supported chains for swaps
const SWAP_CHAINS = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'] as const;

/**
 * Tool definition for wallet_swap
 */
export const swapToolDefinition: Tool = {
  name: 'wallet_swap',
  description: `Swap tokens using DEX aggregation for best rates.

Finds the best price across Uniswap, Sushiswap, Curve, Aerodrome, and other DEXs.

**Get a quote:**
- fromToken="ETH", toToken="USDC", amount="0.1", chain="base"
- Returns a quoteId valid for 60 seconds

**Execute the swap:**
- action="execute", quoteId="q_..." (uses the locked quote route)
- Auto-handles token approval if needed

**Examples:**
- "Swap 0.1 ETH for USDC on Base" → Gets quote with quoteId
- Execute with quoteId to use the same route

Supported tokens: ETH, MATIC, USDC, USDT, DAI, WETH, WBTC (or any contract address)`,
  inputSchema: {
    type: 'object',
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
        description: 'Amount of fromToken to swap (human-readable, e.g., "0.1")',
      },
      chain: {
        type: 'string',
        enum: SWAP_CHAINS,
        description: 'Blockchain to swap on',
      },
      action: {
        type: 'string',
        enum: ['quote', 'execute'],
        description: 'quote = preview only (default), execute = perform the swap',
      },
      quoteId: {
        type: 'string',
        description: 'Quote ID from previous quote request. Locks in the route for execution.',
      },
      slippage: {
        type: 'number',
        description: 'Max slippage percentage (default 0.5%)',
      },
    },
    required: [],
  },
};

/**
 * Contract safety info from Herd
 */
interface ContractSafetyInfo {
  checked: boolean;
  contractName?: string;
  verified?: boolean;
  isProxy?: boolean;
  warnings: string[];
}

/**
 * ERC-20 approve ABI for auto-approval
 */
const APPROVE_ABI = [
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

/**
 * Determine risk level from Herd safety check
 */
function determineRiskLevel(safetyInfo: ContractSafetyInfo): 'low' | 'medium' | 'high' {
  if (!safetyInfo.checked) return 'medium'; // Herd unavailable = medium risk
  if (!safetyInfo.verified) return 'high'; // Unverified router = high risk
  if (safetyInfo.warnings && safetyInfo.warnings.length > 0) return 'medium';
  return 'low';
}

/**
 * Check DEX router contract safety using Herd
 */
async function checkRouterSafety(
  routerAddress: string,
  chain: SupportedChain
): Promise<ContractSafetyInfo> {
  if (!isHerdEnabled()) {
    return { checked: false, warnings: [] };
  }

  try {
    const registry = getProviderRegistry();
    const result = await registry.getContractMetadata({
      address: routerAddress,
      chain,
      detailLevel: 'summary',
      includeAbi: false,
    });

    if (!result.success || !result.data) {
      return { checked: false, warnings: [] };
    }

    const metadata = result.data;
    const warnings: string[] = [];

    // Warn about unverified routers (very suspicious for a DEX)
    if (!metadata.verified) {
      warnings.push('⚠️ DEX router contract is NOT verified - high risk!');
    }

    // Note proxy status (common for upgradeable DEXs)
    if (metadata.proxy?.isProxy) {
      warnings.push(
        `📋 Router is a proxy (implementation: ${metadata.proxy.implementationAddress?.slice(0, 10)}...)`
      );
    }

    return {
      checked: true,
      contractName: metadata.name,
      verified: metadata.verified,
      isProxy: metadata.proxy?.isProxy,
      warnings,
    };
  } catch (error) {
    console.warn('Router safety check failed:', error);
    return { checked: false, warnings: [] };
  }
}

/**
 * Format a swap quote for display
 */
function formatQuote(quote: SwapQuote, chain: SupportedChain, safetyInfo?: ContractSafetyInfo): string {
  const lines: string[] = [
    `🔄 **Swap Quote on ${capitalize(chain)}** (via ${quote.toolDetails || quote.tool})`,
    '',
  ];

  // Show router info if Herd provided it
  if (safetyInfo?.checked && safetyInfo.contractName) {
    lines.push(`**Router:** ${safetyInfo.contractName}`);
  }

  lines.push(
    `**You send:** ${quote.fromAmount} ${quote.fromToken.symbol}${quote.fromAmountUsd !== '0' ? ` (~$${quote.fromAmountUsd})` : ''}`
  );
  lines.push(
    `**You receive:** ${quote.toAmount} ${quote.toToken.symbol}${quote.toAmountUsd !== '0' ? ` (~$${quote.toAmountUsd})` : ''}`
  );
  lines.push(`**Minimum:** ${quote.toAmountMin} ${quote.toToken.symbol} (after slippage)`);
  lines.push('');
  lines.push(`**Rate:** 1 ${quote.fromToken.symbol} = ${quote.exchangeRate} ${quote.toToken.symbol}`);
  lines.push(`**Price Impact:** ${quote.priceImpact}%`);
  lines.push(`**Gas:** ~$${quote.estimatedGasUsd}`);

  // Price impact warnings
  const impact = parseFloat(quote.priceImpact);
  if (impact > 1) {
    lines.push('');
    if (impact > 5) {
      lines.push(`🚨 **HIGH PRICE IMPACT!** You may lose significant value.`);
    } else {
      lines.push(`⚠️ Price impact is above 1%. Consider a smaller swap.`);
    }
  }

  // Herd contract safety warnings
  if (safetyInfo?.warnings && safetyInfo.warnings.length > 0) {
    lines.push('');
    lines.push('**Contract Intel (via Herd):**');
    for (const warning of safetyInfo.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  // Router address (for transparency)
  if (quote.approvalAddress) {
    lines.push('');
    lines.push(
      `**Router:** \`${quote.approvalAddress.slice(0, 10)}...${quote.approvalAddress.slice(-8)}\``
    );
  }

  // Approval status
  lines.push('');
  if (quote.needsApproval) {
    lines.push(`🔐 **Approval needed** (will be handled automatically on execute)`);
  } else {
    lines.push(`✅ **Already approved** - ready to execute`);
  }

  return lines.join('\n');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Handle wallet_swap requests
 *
 * Improved flow with route locking and auto-approval:
 * 1. Quote mode: Fetches quote, caches it with quoteId, returns details
 * 2. Execute mode: Uses cached quote, applies Herd policy gate, auto-approves if needed
 */
export async function handleSwapRequest(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const fromToken = args.fromToken as string | undefined;
  const toToken = args.toToken as string | undefined;
  const amount = args.amount as string | undefined;
  const chainArg = args.chain as string | undefined;
  const action = (args.action as string) || 'quote';
  const quoteIdArg = args.quoteId as string | undefined;
  const rawSlippage = (args.slippage as number) ?? 0.5;
  const slippage = Math.min(rawSlippage, 15);

  const session = ctx.session;

  try {

    // Minimum swap amount to cover gas overhead
    const MIN_SWAP_USD = 0.05;

    // Variables to hold quote and chain (either from cache or fresh)
    let quote: SwapQuote;
    let chain: SupportedChain;
    let cachedHerdCheck: HerdCheckResult | undefined;

    // If quoteId provided, use cached quote (route locking)
    if (quoteIdArg) {
      const cached = getCachedQuote(quoteIdArg, session.address!);
      if ('error' in cached) {
        return {
          content: [{ type: 'text', text: `❌ ${cached.error}` }],
          isError: true,
        };
      }
      quote = cached.quote;
      chain = cached.chain;
      cachedHerdCheck = cached.herdCheck;
    } else {
      // Need fresh quote - validate inputs
      if (!fromToken || !toToken || !amount || !chainArg) {
        return {
          content: [
            {
              type: 'text',
              text: '❌ Missing required parameters: fromToken, toToken, amount, chain (or provide quoteId)',
            },
          ],
          isError: true,
        };
      }

      if (!SWAP_CHAINS.includes(chainArg as (typeof SWAP_CHAINS)[number])) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Unsupported chain: ${chainArg}. Supported: ${SWAP_CHAINS.join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      chain = chainArg as SupportedChain;

      // Get fresh quote from Li.Fi
      quote = await getSwapQuote(fromToken, toToken, amount, chain, { slippage });
    }

    // Validate minimum swap amount to cover gas fees
    const quoteFromUsd = parseFloat(quote.fromAmountUsd || '0');
    if (quoteFromUsd > 0 && quoteFromUsd < MIN_SWAP_USD) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Swap amount too small. Minimum swap amount is $${MIN_SWAP_USD.toFixed(2)} to cover gas fees. You requested ~$${quoteFromUsd.toFixed(4)}.`,
          },
        ],
        isError: true,
      };
    }

    // Run Herd safety check on router
    const routerAddress = quote.approvalAddress || quote.transactionRequest?.to;
    let safetyInfo: ContractSafetyInfo = { checked: false, warnings: [] };
    if (routerAddress) {
      safetyInfo = await checkRouterSafety(routerAddress, chain);
    }
    const routerRisk = determineRiskLevel(safetyInfo);

    // ═══════════════════════════════════════════════════════════════
    // QUOTE MODE - Cache quote and return details with quoteId
    // ═══════════════════════════════════════════════════════════════
    if (action === 'quote') {
      const newQuoteId = cacheQuote(quote, chain, session.address!, {
        routerRisk,
        verified: safetyInfo.verified ?? false,
        checkedAt: Date.now(),
      });

      const riskDisplay =
        routerRisk === 'low' ? '🟢 Low' : routerRisk === 'medium' ? '🟡 Medium' : '🔴 High';

      const txPreview = quote.needsApproval
        ? '**Will send:** approval → swap (2 transactions)'
        : '**Will send:** swap (1 transaction)';

      // Fetch fromToken balance (best-effort)
      let balanceHint = '';
      try {
        const publicClient = createPublicClient({
          chain: CHAINS[chain].chain,
          transport: http(getRpcUrl(chain)),
        });

        const isNative = quote.fromToken.address === '0x0000000000000000000000000000000000000000' ||
                         quote.fromToken.symbol === 'ETH' || quote.fromToken.symbol === 'MATIC';

        if (isNative) {
          const { formatUnits } = await import('viem');
          const bal = await publicClient.getBalance({ address: session.address as Hex });
          const formatted = parseFloat(formatUnits(bal, 18)).toFixed(6);
          balanceHint = `\n**Your ${quote.fromToken.symbol} balance:** ${formatted}`;
        } else {
          const { formatUnits } = await import('viem');
          const bal = await publicClient.readContract({
            address: quote.fromToken.address as Hex,
            abi: [{ inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' }] as const,
            functionName: 'balanceOf',
            args: [session.address as Hex],
          });
          const formatted = parseFloat(formatUnits(bal, quote.fromToken.decimals)).toFixed(6);
          balanceHint = `\n**Your ${quote.fromToken.symbol} balance:** ${formatted}`;
        }
      } catch {
        // Best-effort — don't fail the quote if balance fetch fails
      }

      return {
        content: [
          {
            type: 'text',
            text:
              formatQuote(quote, chain, safetyInfo) +
              balanceHint +
              `\n\n**Quote ID:** \`${newQuoteId}\` (valid for 60 seconds)` +
              `\n**Router Risk:** ${riskDisplay}` +
              `\n${txPreview}` +
              `\n\n💡 To execute: \`action="execute", quoteId="${newQuoteId}"\``,
          },
        ],
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // EXECUTE MODE - Spending Limits + Herd Policy Gate + Auto-Approval
    // ═══════════════════════════════════════════════════════════════

    // Spending limit check (use fromAmountUsd from the quote)
    const fromUsd = parseFloat(quote.fromAmountUsd || '0');
    if (fromUsd > 0) {
      const spendCheck = checkSpendingLimits(quote.fromAmountUsd);
      if (!spendCheck.allowed) {
        return {
          content: [{
            type: 'text',
            text: `🛑 **Swap blocked by spending limits**\n\n${spendCheck.reason}\n\nUse \`wallet_spending_limits\` to view or adjust your limits.`,
          }],
          isError: true,
        };
      }
    }

    // Slippage warning
    const slippageWarnings: string[] = [];
    if (slippage > 3) {
      slippageWarnings.push(`⚠️ High slippage tolerance: ${slippage}%. You may receive significantly less than quoted.`);
    }

    // Use cached Herd check if available, otherwise use fresh check
    const effectiveRisk = cachedHerdCheck?.routerRisk || routerRisk;

    // HERD POLICY GATE: Block high-risk routers from auto-approval
    if (effectiveRisk === 'high' && quote.needsApproval) {
      return {
        content: [
          {
            type: 'text',
            text:
              `🛑 **Auto-approval blocked by Herd**\n\n` +
              `Router \`${routerAddress}\` is flagged as high-risk:\n` +
              `- ${safetyInfo.warnings?.join('\n- ') || 'Unverified or suspicious contract'}\n\n` +
              `To proceed anyway, manually approve using \`wallet_call\` then re-run the swap.`,
          },
        ],
        isError: true,
      };
    }

    // Gas pre-flight check (replaces the old zero-balance check)
    const isNativeFrom = quote.fromToken.symbol === 'ETH' || quote.fromToken.symbol === 'MATIC';
    await requireGas(chain, ctx.walletAddress, {
      txValue: isNativeFrom ? parseAmountToBigInt(quote.fromAmount, 18) : 0n,
      gasLimit: 500_000n, // Swap routers use more gas than simple transfers
    });

    // Simulate the swap transaction before committing
    if (quote.transactionRequest) {
      const viemChain = CHAINS[chain].chain;
      const simClient = createPublicClient({
        chain: viemChain,
        transport: http(getRpcUrl(chain)),
      });
      try {
        await simClient.call({
          account: ctx.walletAddress,
          to: quote.transactionRequest.to as Hex,
          data: quote.transactionRequest.data as Hex,
          value: quote.transactionRequest.value ? BigInt(quote.transactionRequest.value) : 0n,
        });
      } catch (simError: any) {
        // Swap simulation is advisory, not blocking — DEX router calldata
        // often fails in eth_call due to delegatecalls and external connectors.
        // Log the warning and proceed with the swap.
        console.error(`[clara] Swap simulation warning: ${simError.shortMessage || simError.message}`);
      }
    }

    // Mark quote as consumed BEFORE sending transactions (prevents double-execution)
    if (quoteIdArg) {
      markQuoteConsumed(quoteIdArg);
    }

    // Track transactions sent for response
    const txHashes: string[] = [];

    // Auto-approve if needed (using EXACT amount + 1% buffer per GPT recommendation)
    if (quote.needsApproval && quote.approvalAddress) {
      console.error(`[clara] Auto-approving ${quote.fromToken.symbol} for router ${quote.approvalAddress}`);

      // Use exact amount + 1% buffer instead of unlimited (safer)
      const exactAmount = parseAmountToBigInt(quote.fromAmount, quote.fromToken.decimals);
      const approvalAmount = exactAmount + exactAmount / 100n; // +1% buffer

      const approveData = encodeFunctionData({
        abi: APPROVE_ABI,
        functionName: 'approve',
        args: [quote.approvalAddress as Hex, approvalAmount],
      });

      const approvalResult = await signAndSendTransaction(session.walletId!, {
        to: quote.fromToken.address as Hex,
        value: 0n,
        data: approveData,
        chainId: getChainId(chain),
      });

      txHashes.push(approvalResult.txHash);
      console.error(`[clara] Approval tx: ${approvalResult.txHash}`);

      // Brief pause for approval to propagate (2 seconds)
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Update quote to reflect approval is done
      quote.needsApproval = false;
    }

    // Execute the swap using cached transaction data
    const swapResult = await executeSwap(quote, chain);
    txHashes.push(swapResult.txHash);

    // Wait for transaction confirmation and verify success
    console.error(`[clara] Waiting for swap confirmation: ${swapResult.txHash}`);
    const publicClient = createPublicClient({
      chain: CHAINS[chain].chain,
      transport: http(getRpcUrl(chain)),
    });
    
    let receipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({
        hash: swapResult.txHash as Hex,
        timeout: 120_000, // 2 minutes
      });
    } catch (waitError) {
      // Timeout or other error waiting for receipt
      throw new Error(
        `Swap transaction submitted but confirmation timed out. ` +
        `Check status: ${getExplorerTxUrl(chain, swapResult.txHash)}`
      );
    }

    if (receipt.status !== 'success') {
      throw new Error(
        `Swap transaction failed on-chain. ` +
        `Check details: ${getExplorerTxUrl(chain, swapResult.txHash)}`
      );
    }

    console.error(`[clara] Swap confirmed: ${swapResult.txHash}`);

    // Build success message
    const successLines: string[] = [
      formatQuote(quote, chain, safetyInfo),
      '',
      '✅ **Swap Confirmed!**',
      '',
    ];

    if (txHashes.length > 1) {
      successLines.push(`**Approval TX:** \`${txHashes[0]}\``);
      successLines.push(`**Swap TX:** \`${txHashes[1]}\``);
    } else {
      successLines.push(`**Transaction:** \`${swapResult.txHash}\``);
    }

    successLines.push(`🔗 [View on Explorer](${getExplorerTxUrl(chain, swapResult.txHash)})`);
    successLines.push('');
    successLines.push(`Your ${quote.toToken.symbol} will arrive shortly.`);

    // Add slippage warnings if applicable
    if (slippageWarnings.length > 0) {
      successLines.push('');
      successLines.push(...slippageWarnings);
    }

    // Record spending for limit tracking
    if (fromUsd > 0) {
      recordSpending({
        timestamp: new Date().toISOString(),
        amountUsd: quote.fromAmountUsd,
        recipient: routerAddress || 'dex-router',
        description: `Swap ${quote.fromAmount} ${quote.fromToken.symbol} → ${quote.toToken.symbol} on ${chain}`,
        url: '',
        chainId: getChainId(chain),
        txHash: swapResult.txHash,
        paymentId: `swap-${swapResult.txHash.slice(0, 10)}`,
      });
    }

    return {
      content: [{ type: 'text', text: successLines.join('\n') }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: `❌ Swap failed: ${message}`,
        },
      ],
      isError: true,
    };
  }
}
