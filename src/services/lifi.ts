/**
 * Li.Fi Integration for Token Swaps and Bridges
 *
 * Li.Fi is a DEX/bridge aggregator that finds the best rates across:
 * - DEXs: Uniswap, Sushiswap, Curve, Balancer, etc.
 * - Bridges: Stargate, Hop, Across, etc.
 *
 * No API key required for basic usage.
 *
 * @see https://docs.li.fi/
 */

import { type Hex, parseUnits, formatUnits } from 'viem';

// Li.Fi API endpoint
const LIFI_API = 'https://li.quest/v1';

// Native token placeholder (Li.Fi convention)
const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

/**
 * Supported chains for swaps
 */
export type SwapChain = 'base' | 'ethereum' | 'arbitrum' | 'optimism' | 'polygon';

/**
 * Chain IDs for Li.Fi
 */
const CHAIN_IDS: Record<SwapChain, number> = {
  base: 8453,
  ethereum: 1,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
};

/**
 * Known token addresses by chain
 */
const KNOWN_TOKENS: Record<SwapChain, Record<string, { address: Hex; decimals: number }>> = {
  base: {
    ETH: { address: NATIVE_TOKEN as Hex, decimals: 18 },
    USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    USDT: { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
    DAI: { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  },
  ethereum: {
    ETH: { address: NATIVE_TOKEN as Hex, decimals: 18 },
    USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    DAI: { address: '0x6B175474E89094C44Da98b954EescdeCB5BE3830', decimals: 18 },
    WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
  },
  arbitrum: {
    ETH: { address: NATIVE_TOKEN as Hex, decimals: 18 },
    USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    WETH: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
  },
  optimism: {
    ETH: { address: NATIVE_TOKEN as Hex, decimals: 18 },
    USDC: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    USDT: { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  },
  polygon: {
    MATIC: { address: NATIVE_TOKEN as Hex, decimals: 18 },
    USDC: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    USDT: { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
    WETH: { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
  },
};

/**
 * Token info for a swap
 */
export interface TokenInfo {
  address: Hex;
  symbol: string;
  decimals: number;
}

/**
 * Swap quote from Li.Fi
 */
export interface SwapQuote {
  fromToken: TokenInfo;
  toToken: TokenInfo;
  fromAmount: string;
  toAmount: string;
  toAmountMin: string;
  fromAmountUsd: string;
  toAmountUsd: string;
  exchangeRate: string;
  priceImpact: string;
  estimatedGasUsd: string;
  tool: string;
  toolDetails: string;
  needsApproval: boolean;
  approvalAddress?: Hex;
  // Transaction data for execution
  transactionRequest?: {
    to: Hex;
    data: Hex;
    value: string;
    gasLimit?: string;
  };
}

/**
 * Resolve token symbol to address and decimals
 */
export function resolveToken(
  tokenInput: string,
  chain: SwapChain
): TokenInfo | null {
  const upperToken = tokenInput.toUpperCase();
  const chainTokens = KNOWN_TOKENS[chain];

  // Native token aliases
  if (upperToken === 'ETH' && chain !== 'polygon') {
    return { ...chainTokens.ETH, symbol: 'ETH' };
  }
  if ((upperToken === 'MATIC' || upperToken === 'ETH') && chain === 'polygon') {
    return { ...chainTokens.MATIC, symbol: 'MATIC' };
  }

  // Known tokens
  if (chainTokens[upperToken]) {
    return { ...chainTokens[upperToken], symbol: upperToken };
  }

  // Contract address
  if (tokenInput.startsWith('0x') && tokenInput.length === 42) {
    return {
      address: tokenInput as Hex,
      symbol: 'TOKEN',
      decimals: 18, // Will be overridden by Li.Fi
    };
  }

  return null;
}

/**
 * Get a swap quote from Li.Fi
 */
export async function getSwapQuote(
  fromToken: string,
  toToken: string,
  amount: string,
  chain: SwapChain,
  fromAddress: Hex,
  options: { slippage?: number } = {}
): Promise<SwapQuote> {
  const slippage = options.slippage ?? 0.5;

  // Resolve tokens
  const fromTokenInfo = resolveToken(fromToken, chain);
  const toTokenInfo = resolveToken(toToken, chain);

  if (!fromTokenInfo) {
    throw new Error(`Unknown token: ${fromToken} on ${chain}`);
  }
  if (!toTokenInfo) {
    throw new Error(`Unknown token: ${toToken} on ${chain}`);
  }

  // Convert amount to base units
  const fromAmountWei = parseUnits(amount, fromTokenInfo.decimals).toString();

  const chainId = CHAIN_IDS[chain];

  // Build Li.Fi quote URL
  const params = new URLSearchParams({
    fromChain: chainId.toString(),
    toChain: chainId.toString(),
    fromToken: fromTokenInfo.address,
    toToken: toTokenInfo.address,
    fromAmount: fromAmountWei,
    fromAddress,
    slippage: (slippage / 100).toString(), // Li.Fi expects decimal (0.005 = 0.5%)
  });

  console.error(`[clara] Fetching Li.Fi quote: ${fromToken} → ${toToken} on ${chain}`);

  const response = await fetch(`${LIFI_API}/quote?${params}`, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Li.Fi API error: ${response.status} - ${error}`);
  }

  const data = await response.json();

  // Parse Li.Fi response
  const estimate = data.estimate;
  const action = data.action;

  // Get decimals with fallback to our resolved token info (fixes Li.Fi response edge cases)
  const toDecimals = estimate.toToken?.decimals ?? toTokenInfo.decimals;

  // Calculate exchange rate
  const fromAmountNum = parseFloat(amount);
  const toAmountNum = parseFloat(formatUnits(BigInt(estimate.toAmount), toDecimals));
  const exchangeRate = (toAmountNum / fromAmountNum).toFixed(6);

  // Check if approval is needed (for ERC-20 tokens)
  const needsApproval = fromTokenInfo.address !== NATIVE_TOKEN && estimate.approvalAddress;

  return {
    fromToken: {
      address: fromTokenInfo.address,
      symbol: estimate.fromToken?.symbol || fromTokenInfo.symbol,
      decimals: estimate.fromToken?.decimals ?? fromTokenInfo.decimals,
    },
    toToken: {
      address: toTokenInfo.address,
      symbol: estimate.toToken?.symbol || toTokenInfo.symbol,
      decimals: toDecimals,
    },
    fromAmount: amount,
    toAmount: formatUnits(BigInt(estimate.toAmount), toDecimals),
    toAmountMin: formatUnits(BigInt(estimate.toAmountMin), toDecimals),
    fromAmountUsd: estimate.fromAmountUSD || '0',
    toAmountUsd: estimate.toAmountUSD || '0',
    exchangeRate,
    priceImpact: estimate.priceImpact || '0',
    estimatedGasUsd: estimate.gasCosts?.[0]?.amountUSD || '0',
    tool: data.tool || 'unknown',
    toolDetails: data.toolDetails?.name || data.tool || 'DEX',
    needsApproval,
    approvalAddress: estimate.approvalAddress as Hex,
    transactionRequest: data.transactionRequest ? {
      to: data.transactionRequest.to as Hex,
      data: data.transactionRequest.data as Hex,
      value: data.transactionRequest.value || '0',
      gasLimit: data.transactionRequest.gasLimit,
    } : undefined,
  };
}

/**
 * Get a bridge quote from Li.Fi (cross-chain)
 */
export async function getBridgeQuote(
  fromToken: string,
  toToken: string,
  amount: string,
  fromChain: SwapChain,
  toChain: SwapChain,
  fromAddress: Hex,
  options: { slippage?: number } = {}
): Promise<SwapQuote> {
  const slippage = options.slippage ?? 0.5;

  // Resolve tokens
  const fromTokenInfo = resolveToken(fromToken, fromChain);
  const toTokenInfo = resolveToken(toToken, toChain);

  if (!fromTokenInfo) {
    throw new Error(`Unknown token: ${fromToken} on ${fromChain}`);
  }
  if (!toTokenInfo) {
    throw new Error(`Unknown token: ${toToken} on ${toChain}`);
  }

  // Convert amount to base units
  const fromAmountWei = parseUnits(amount, fromTokenInfo.decimals).toString();

  const fromChainId = CHAIN_IDS[fromChain];
  const toChainId = CHAIN_IDS[toChain];

  // Build Li.Fi quote URL
  const params = new URLSearchParams({
    fromChain: fromChainId.toString(),
    toChain: toChainId.toString(),
    fromToken: fromTokenInfo.address,
    toToken: toTokenInfo.address,
    fromAmount: fromAmountWei,
    fromAddress,
    toAddress: fromAddress, // Same address on destination
    slippage: (slippage / 100).toString(),
  });

  console.error(`[clara] Fetching Li.Fi bridge quote: ${fromToken}@${fromChain} → ${toToken}@${toChain}`);

  const response = await fetch(`${LIFI_API}/quote?${params}`, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Li.Fi bridge API error: ${response.status} - ${error}`);
  }

  const data = await response.json();

  // Parse Li.Fi response (same structure as swap)
  const estimate = data.estimate;

  // Get decimals with fallback to our resolved token info (fixes Li.Fi response edge cases)
  const toDecimals = estimate.toToken?.decimals ?? toTokenInfo.decimals;

  const fromAmountNum = parseFloat(amount);
  const toAmountNum = parseFloat(formatUnits(BigInt(estimate.toAmount), toDecimals));
  const exchangeRate = (toAmountNum / fromAmountNum).toFixed(6);

  const needsApproval = fromTokenInfo.address !== NATIVE_TOKEN && estimate.approvalAddress;

  return {
    fromToken: {
      address: fromTokenInfo.address,
      symbol: estimate.fromToken?.symbol || fromTokenInfo.symbol,
      decimals: estimate.fromToken?.decimals ?? fromTokenInfo.decimals,
    },
    toToken: {
      address: toTokenInfo.address,
      symbol: estimate.toToken?.symbol || toTokenInfo.symbol,
      decimals: toDecimals,
    },
    fromAmount: amount,
    toAmount: formatUnits(BigInt(estimate.toAmount), toDecimals),
    toAmountMin: formatUnits(BigInt(estimate.toAmountMin), toDecimals),
    fromAmountUsd: estimate.fromAmountUSD || '0',
    toAmountUsd: estimate.toAmountUSD || '0',
    exchangeRate,
    priceImpact: estimate.priceImpact || '0',
    estimatedGasUsd: estimate.gasCosts?.[0]?.amountUSD || '0',
    tool: data.tool || 'unknown',
    toolDetails: data.toolDetails?.name || `${fromChain} → ${toChain}`,
    needsApproval,
    approvalAddress: estimate.approvalAddress as Hex,
    transactionRequest: data.transactionRequest ? {
      to: data.transactionRequest.to as Hex,
      data: data.transactionRequest.data as Hex,
      value: data.transactionRequest.value || '0',
      gasLimit: data.transactionRequest.gasLimit,
    } : undefined,
  };
}

/**
 * Encode ERC-20 approve calldata
 */
export function encodeApproveCalldata(spender: Hex, amount: bigint): Hex {
  // approve(address,uint256) selector: 0x095ea7b3
  const selector = '095ea7b3';
  const spenderPadded = spender.slice(2).padStart(64, '0');
  const amountHex = amount.toString(16).padStart(64, '0');
  return `0x${selector}${spenderPadded}${amountHex}` as Hex;
}

/**
 * Max uint256 for unlimited approval
 */
export const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
