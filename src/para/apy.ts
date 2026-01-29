/**
 * APY Calculation Utilities
 *
 * Provides ETH price fetching and APY calculation for Clara ecosystem tokens.
 * All values are displayed in USD for user clarity.
 *
 * Key concepts:
 * - ETH price: Fetched from DeFiLlama (no API key needed), cached 5 minutes
 * - Revenue: totalRevenueDeposited in ETH × ETH price = USD revenue
 * - TVL: totalStaked × tokenPrice (from auction) × ETH price = USD TVL
 * - APY: Annualized return based on revenue rate and time since creation
 * - Payback Period: How long to recoup token cost from staking rewards
 *
 * IMPORTANT: Uses viem's formatUnits() for bigint→number conversion to avoid
 * JavaScript Number overflow (safe only up to 2^53 ≈ 0.009 ETH in wei).
 */

import { formatUnits } from 'viem';

// ETH price cache (5 minute TTL)
let ethPriceCache: { price: number; timestamp: number } | null = null;
const ETH_PRICE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch current ETH/USD price from DeFiLlama
 *
 * DeFiLlama is preferred because:
 * - No API key required
 * - Aggregates prices from multiple DEXs
 * - Highly reliable uptime
 */
export async function getEthPriceUSD(): Promise<number> {
  // Return cached price if still valid
  if (ethPriceCache && Date.now() - ethPriceCache.timestamp < ETH_PRICE_CACHE_TTL) {
    return ethPriceCache.price;
  }

  try {
    const response = await fetch('https://coins.llama.fi/prices/current/coingecko:ethereum', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`DeFiLlama API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      coins: { 'coingecko:ethereum'?: { price: number } };
    };

    const price = data.coins['coingecko:ethereum']?.price;
    if (!price || typeof price !== 'number') {
      throw new Error('Invalid price data from DeFiLlama');
    }

    ethPriceCache = { price, timestamp: Date.now() };
    return price;
  } catch (error) {
    // If we have a stale cache, use it as fallback
    if (ethPriceCache) {
      console.error('Failed to fetch ETH price, using stale cache:', error);
      return ethPriceCache.price;
    }

    // Last resort fallback (should rarely happen)
    console.error('Failed to fetch ETH price, using fallback $2500:', error);
    return 2500;
  }
}

/**
 * Result of APY calculation
 */
export interface APYResult {
  /** Total revenue distributed in USD */
  revenueUSD: number;
  /** Total value locked in USD */
  tvlUSD: number;
  /** Estimated annual percentage yield */
  apyPercent: number;
  /** Years to recoup investment via staking rewards */
  paybackYears: number;
  /** Current ETH price used in calculation */
  ethPriceUSD: number;
}

/**
 * Calculate APY for a staking distributor
 *
 * Formula:
 * APY = (revenueUSD / tvlUSD) × (365 / daysSinceCreation) × 100
 *
 * This extrapolates current revenue rate to a full year.
 * More accurate with longer operating history.
 *
 * @param totalRevenueWei - Total ETH revenue deposited (wei)
 * @param totalStakedWei - Total tokens staked (in token's smallest unit)
 * @param tokenPriceEth - Token price in ETH (from CCA clearing price)
 * @param daysSinceCreation - Days since distributor was created
 * @param tokenDecimals - Token decimals (default 18)
 */
export async function calculateAPY(
  totalRevenueWei: bigint,
  totalStakedWei: bigint,
  tokenPriceEth: number,
  daysSinceCreation: number,
  tokenDecimals: number = 18
): Promise<APYResult> {
  const ethPriceUSD = await getEthPriceUSD();

  // Convert revenue from wei to ETH using formatUnits (avoids Number overflow)
  // formatUnits returns a string, parseFloat converts to number safely
  const revenueETH = parseFloat(formatUnits(totalRevenueWei, 18));
  const revenueUSD = revenueETH * ethPriceUSD;

  // Calculate TVL in USD using actual token decimals
  const totalStakedTokens = parseFloat(formatUnits(totalStakedWei, tokenDecimals));
  const tokenPriceUSD = tokenPriceEth * ethPriceUSD;
  const tvlUSD = totalStakedTokens * tokenPriceUSD;

  // Handle edge cases
  if (tvlUSD === 0 || daysSinceCreation === 0) {
    return {
      revenueUSD,
      tvlUSD,
      apyPercent: 0,
      paybackYears: Infinity,
      ethPriceUSD,
    };
  }

  // Calculate APY: (revenue / tvl) × (365 / days) × 100
  const apyPercent = (revenueUSD / tvlUSD) * (365 / daysSinceCreation) * 100;

  // Payback period: years to recoup investment
  // If APY is 50%, payback = 100/50 = 2 years
  const paybackYears = apyPercent > 0 ? 100 / apyPercent : Infinity;

  return {
    revenueUSD,
    tvlUSD,
    apyPercent,
    paybackYears,
    ethPriceUSD,
  };
}

/**
 * Format USD amount for display
 *
 * Examples:
 * - 1,500,000 → "$1.5M"
 * - 50,000 → "$50k"
 * - 1,234.56 → "$1,234.56"
 */
export function formatUSD(amount: number): string {
  if (amount >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(1)}M`;
  } else if (amount >= 10_000) {
    return `$${(amount / 1_000).toFixed(0)}k`;
  } else if (amount >= 1_000) {
    return `$${(amount / 1_000).toFixed(1)}k`;
  } else if (amount >= 1) {
    return `$${amount.toFixed(2)}`;
  } else if (amount > 0) {
    return `$${amount.toFixed(4)}`;
  }
  return '$0.00';
}

/**
 * Format APY percentage for display
 */
export function formatAPY(apy: number): string {
  if (!isFinite(apy) || apy === 0) {
    return '—';
  }
  if (apy >= 1000) {
    return `${(apy / 1000).toFixed(1)}k%`;
  }
  if (apy >= 100) {
    return `${apy.toFixed(0)}%`;
  }
  return `${apy.toFixed(1)}%`;
}

/**
 * Format payback period for display
 */
export function formatPayback(years: number): string {
  if (!isFinite(years) || years <= 0) {
    return '—';
  }
  if (years < 1) {
    const months = Math.round(years * 12);
    return `${months} mo`;
  }
  if (years >= 100) {
    return '100+ yrs';
  }
  return `${years.toFixed(1)} yrs`;
}

/**
 * Convert Q96 fixed-point price to decimal
 *
 * CCA auctions use Q96 format for clearing prices:
 * actualPrice = q96Value / (2^96)
 *
 * This gives the price in ETH per token.
 *
 * Uses scaled bigint arithmetic to avoid Number overflow:
 * - Scale q96 by 1e18 (for precision)
 * - Divide by Q96
 * - Convert result to decimal
 */
export function q96ToDecimal(q96: bigint): number {
  // 2^96 = 79228162514264337593543950336
  const Q96 = BigInt('79228162514264337593543950336');

  // Scale by 1e18 for precision, then divide
  // This keeps intermediate values as bigint until final conversion
  const SCALE = BigInt('1000000000000000000'); // 1e18
  const scaledResult = (q96 * SCALE) / Q96;

  // Convert scaled result to decimal (divide by 1e18)
  return parseFloat(formatUnits(scaledResult, 18));
}

/**
 * Format ETH amount for display
 * Uses formatUnits to avoid Number overflow on large wei values
 */
export function formatETH(weiAmount: bigint): string {
  const eth = parseFloat(formatUnits(weiAmount, 18));
  if (eth >= 1000) {
    return `${(eth / 1000).toFixed(1)}k ETH`;
  }
  if (eth >= 1) {
    return `${eth.toFixed(2)} ETH`;
  }
  if (eth >= 0.001) {
    return `${eth.toFixed(4)} ETH`;
  }
  return `${eth.toFixed(6)} ETH`;
}

/**
 * Convert wei amount to number with specified decimals
 * Safe alternative to Number(bigint)/1eN
 */
export function weiToNumber(wei: bigint, decimals: number = 18): number {
  return parseFloat(formatUnits(wei, decimals));
}
