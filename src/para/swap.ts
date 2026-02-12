/**
 * Swap Module - DEX Aggregation via Li.Fi
 *
 * Provides best-rate swaps across multiple DEXs:
 * - Uniswap, Sushiswap, Curve, Balancer, Aerodrome, and more
 * - Automatic routing for best price
 * - Slippage protection
 *
 * Uses Li.Fi API (free, no API key required).
 */

import { type Hex, createPublicClient } from 'viem';
import { getSession } from '../storage/session.js';
import { signAndSendTransaction, type TransactionParams } from './transactions.js';
import { type SupportedChain, getChainId, getTransport, CHAINS } from '../config/chains.js';

// Li.Fi API - aggregates across multiple DEXs
const LIFI_API = 'https://li.quest/v1';

// Map chain names to chain IDs for Li.Fi
const LIFI_CHAIN_IDS: Record<SupportedChain, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
};

// Native token address placeholder (used by Li.Fi for ETH/MATIC/etc)
const NATIVE_TOKEN_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// Common token addresses by chain
const POPULAR_TOKENS: Record<string, Partial<Record<SupportedChain, { address: string; decimals: number }>>> = {
  USDC: {
    ethereum: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    base: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    arbitrum: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    optimism: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    polygon: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
  },
  USDT: {
    ethereum: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    arbitrum: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    optimism: { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
    polygon: { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
  },
  DAI: {
    ethereum: { address: '0x6B175474E89094C44Da98b954EesddFD16f43B7', decimals: 18 },
    base: { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
    arbitrum: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
    optimism: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
    polygon: { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18 },
  },
  WETH: {
    ethereum: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
    base: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    arbitrum: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
    optimism: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    polygon: { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
  },
  WBTC: {
    ethereum: { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
    arbitrum: { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8 },
    optimism: { address: '0x68f180fcCe6836688e9084f035309E29Bf0A2095', decimals: 8 },
    polygon: { address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', decimals: 8 },
  },
};

/**
 * Swap quote from Li.Fi aggregator
 */
export interface SwapQuote {
  id: string;
  fromToken: {
    address: string;
    symbol: string;
    decimals: number;
    priceUsd: string;
  };
  toToken: {
    address: string;
    symbol: string;
    decimals: number;
    priceUsd: string;
  };
  fromAmount: string;
  fromAmountUsd: string;
  toAmount: string;
  toAmountUsd: string;
  toAmountMin: string;
  exchangeRate: string;
  priceImpact: string;
  estimatedGas: string;
  estimatedGasUsd: string;
  approvalAddress?: string;
  needsApproval: boolean;
  currentAllowance?: string;
  transactionRequest?: {
    to: string;
    data: string;
    value: string;
    gasLimit: string;
  };
  tool: string;
  toolDetails?: string;
}

/**
 * Options for swap quote request
 */
export interface SwapQuoteOptions {
  /** Max slippage percentage (default 0.5%) */
  slippage?: number;
}

/**
 * Resolve token symbol to address
 */
export function resolveToken(
  token: string,
  chain: SupportedChain
): { address: string; decimals: number } | null {
  // Native tokens
  const nativeSymbols = ['ETH', 'MATIC', 'NATIVE'];
  if (nativeSymbols.includes(token.toUpperCase())) {
    return { address: NATIVE_TOKEN_ADDRESS, decimals: 18 };
  }

  // Already an address
  if (token.startsWith('0x')) {
    return { address: token, decimals: 18 }; // Assume 18 decimals, will be corrected by Li.Fi
  }

  // Look up in popular tokens
  const tokenData = POPULAR_TOKENS[token.toUpperCase()];
  if (tokenData && tokenData[chain]) {
    return tokenData[chain]!;
  }

  return null;
}

/**
 * Parse human-readable amount to raw units
 * Exported for use in swap tool auto-approval
 */
export function parseAmountToBigInt(amount: string, decimals: number): bigint {
  const [whole, fraction = ''] = amount.split('.');
  const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(whole + paddedFraction);
}

/**
 * ERC-20 allowance ABI
 */
const ALLOWANCE_ABI = [
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * Check current token allowance for a spender
 *
 * @param tokenAddress - The ERC-20 token contract address
 * @param ownerAddress - The wallet address that owns the tokens
 * @param spenderAddress - The address that would spend the tokens (e.g., DEX router)
 * @param chain - The blockchain chain
 * @returns The current allowance as a bigint
 */
export async function checkAllowance(
  tokenAddress: string,
  ownerAddress: string,
  spenderAddress: string,
  chain: SupportedChain
): Promise<bigint> {
  // Native tokens don't need approval
  if (tokenAddress === NATIVE_TOKEN_ADDRESS) {
    return BigInt(2n ** 256n - 1n);
  }

  const client = createPublicClient({
    chain: CHAINS[chain].chain,
    transport: getTransport(chain),
  });

  try {
    const allowance = await client.readContract({
      address: tokenAddress as Hex,
      abi: ALLOWANCE_ABI,
      functionName: 'allowance',
      args: [ownerAddress as Hex, spenderAddress as Hex],
    });
    return allowance;
  } catch (error) {
    console.error(`[clara] Failed to check allowance: ${error}`);
    // On error, assume approval is needed (safer)
    return 0n;
  }
}

/**
 * Get a swap quote from Li.Fi
 */
export async function getSwapQuote(
  fromToken: string,
  toToken: string,
  amount: string,
  chain: SupportedChain,
  options: SwapQuoteOptions = {}
): Promise<SwapQuote> {
  const slippage = options.slippage ?? 0.5;

  const session = await getSession();
  if (!session?.authenticated || !session.address) {
    throw new Error('Not authenticated. Run wallet_setup first.');
  }

  const chainId = LIFI_CHAIN_IDS[chain];
  if (!chainId) {
    throw new Error(`Swaps not supported on ${chain}`);
  }

  // Resolve token addresses
  const fromResolved = resolveToken(fromToken, chain);
  const toResolved = resolveToken(toToken, chain);

  if (!fromResolved) {
    throw new Error(`Unknown token: ${fromToken} on ${chain}`);
  }
  if (!toResolved) {
    throw new Error(`Unknown token: ${toToken} on ${chain}`);
  }

  // Convert amount to raw units
  const amountRaw = parseAmountToBigInt(amount, fromResolved.decimals);

  console.error(`[clara] Getting swap quote: ${amount} ${fromToken} → ${toToken} on ${chain}`);

  // Call Li.Fi quote endpoint
  const params = new URLSearchParams({
    fromChain: chainId.toString(),
    toChain: chainId.toString(),
    fromToken: fromResolved.address,
    toToken: toResolved.address,
    fromAmount: amountRaw.toString(),
    fromAddress: session.address,
    slippage: (slippage / 100).toString(),
  });

  const response = await fetch(`${LIFI_API}/quote?${params}`);

  if (!response.ok) {
    const error = await response.text();
    console.error(`[clara] Li.Fi API error: ${response.status} - ${error}`);
    throw new Error(`Quote failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    id: string;
    action: {
      fromToken: { address: string; symbol: string; decimals: number; priceUSD: string };
      toToken: { address: string; symbol: string; decimals: number; priceUSD: string };
      fromAmount: string;
      slippage: number;
    };
    estimate: {
      toAmount: string;
      toAmountMin: string;
      fromAmountUSD: string;
      toAmountUSD: string;
      gasCosts: Array<{ amountUSD: string; estimate: string }>;
      approvalAddress?: string;
    };
    transactionRequest?: {
      to: string;
      data: string;
      value: string;
      gasLimit: string;
    };
    tool: string;
    toolDetails?: { name: string };
  };

  // Calculate exchange rate
  const fromAmountNum = parseFloat(amount);
  const toAmountNum =
    Number(BigInt(data.estimate.toAmount)) / Math.pow(10, data.action.toToken.decimals);
  const exchangeRate = (toAmountNum / fromAmountNum).toFixed(6);

  // Calculate price impact
  const fromUsd = parseFloat(data.estimate.fromAmountUSD || '0');
  const toUsd = parseFloat(data.estimate.toAmountUSD || '0');
  const priceImpact = fromUsd > 0 ? (((fromUsd - toUsd) / fromUsd) * 100).toFixed(2) : '0';

  // Check if approval is needed by checking actual on-chain allowance
  let needsApproval = false;
  let currentAllowance = '0';

  if (fromResolved.address !== NATIVE_TOKEN_ADDRESS && data.estimate.approvalAddress) {
    const allowance = await checkAllowance(
      fromResolved.address,
      session.address,
      data.estimate.approvalAddress,
      chain
    );
    currentAllowance = allowance.toString();
    needsApproval = allowance < amountRaw;

    console.error(
      `[clara] Allowance check: have ${allowance}, need ${amountRaw}, needsApproval=${needsApproval}`
    );
  }

  // Sum up gas costs
  const totalGasUsd = data.estimate.gasCosts.reduce(
    (sum, g) => sum + parseFloat(g.amountUSD || '0'),
    0
  );

  return {
    id: data.id,
    fromToken: {
      address: data.action.fromToken.address,
      symbol: data.action.fromToken.symbol,
      decimals: data.action.fromToken.decimals,
      priceUsd: data.action.fromToken.priceUSD,
    },
    toToken: {
      address: data.action.toToken.address,
      symbol: data.action.toToken.symbol,
      decimals: data.action.toToken.decimals,
      priceUsd: data.action.toToken.priceUSD,
    },
    fromAmount: amount,
    fromAmountUsd: data.estimate.fromAmountUSD || '0',
    toAmount: toAmountNum.toFixed(Math.min(data.action.toToken.decimals, 6)),
    toAmountUsd: data.estimate.toAmountUSD || '0',
    toAmountMin: (
      Number(BigInt(data.estimate.toAmountMin)) / Math.pow(10, data.action.toToken.decimals)
    ).toFixed(6),
    exchangeRate,
    priceImpact,
    estimatedGas: data.estimate.gasCosts.reduce((sum, g) => sum + parseInt(g.estimate || '0'), 0).toString(),
    estimatedGasUsd: totalGasUsd.toFixed(2),
    approvalAddress: data.estimate.approvalAddress,
    needsApproval,
    currentAllowance,
    transactionRequest: data.transactionRequest
      ? {
          to: data.transactionRequest.to,
          data: data.transactionRequest.data,
          value: data.transactionRequest.value,
          gasLimit: data.transactionRequest.gasLimit,
        }
      : undefined,
    tool: data.tool,
    toolDetails: data.toolDetails?.name,
  };
}

/**
 * Execute a swap using the quote's transaction request
 */
export async function executeSwap(
  quote: SwapQuote,
  chain: SupportedChain
): Promise<{ txHash: string }> {
  if (!quote.transactionRequest) {
    throw new Error('Quote does not include transaction data. Get a fresh quote.');
  }

  if (quote.needsApproval) {
    throw new Error(
      `Approval needed first. Approve ${quote.fromToken.symbol} for spender ${quote.approvalAddress}`
    );
  }

  const session = await getSession();
  if (!session?.authenticated || !session.walletId) {
    throw new Error('Not authenticated');
  }

  console.error(
    `[clara] Executing swap: ${quote.fromAmount} ${quote.fromToken.symbol} → ${quote.toToken.symbol}`
  );

  const txReq = quote.transactionRequest;
  const chainId = LIFI_CHAIN_IDS[chain];

  // Build transaction params for Clara's signAndSendTransaction
  const txParams: TransactionParams = {
    to: txReq.to as Hex,
    value: txReq.value ? BigInt(txReq.value) : 0n,
    data: txReq.data as Hex,
    chainId,
    gas: txReq.gasLimit ? BigInt(txReq.gasLimit) : undefined,
  };

  // Execute via Clara's transaction infrastructure
  const result = await signAndSendTransaction(session.walletId, txParams);

  return { txHash: result.txHash };
}

/**
 * Get explorer URL for a transaction
 */
export function getExplorerTxUrl(chain: SupportedChain, txHash: string): string {
  const explorers: Record<SupportedChain, string> = {
    ethereum: 'https://etherscan.io/tx/',
    base: 'https://basescan.org/tx/',
    arbitrum: 'https://arbiscan.io/tx/',
    optimism: 'https://optimistic.etherscan.io/tx/',
    polygon: 'https://polygonscan.com/tx/',
  };
  return `${explorers[chain]}${txHash}`;
}
