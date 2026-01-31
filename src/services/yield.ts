/**
 * Yield Service
 *
 * Integrates with DeFiLlama for yield discovery and Aave v3 for deposits.
 *
 * @see https://defillama.com/docs/api
 */

import { type Hex, parseUnits, formatUnits, encodeFunctionData } from 'viem';

// DeFiLlama yield API
const DEFILLAMA_API = 'https://yields.llama.fi';

/**
 * Supported chains for yield
 */
export type YieldChain = 'base' | 'ethereum' | 'arbitrum' | 'optimism';

/**
 * Chain IDs
 */
const CHAIN_IDS: Record<YieldChain, number> = {
  base: 8453,
  ethereum: 1,
  arbitrum: 42161,
  optimism: 10,
};

/**
 * DeFiLlama chain names
 */
const LLAMA_CHAINS: Record<YieldChain, string> = {
  base: 'Base',
  ethereum: 'Ethereum',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
};

/**
 * Aave v3 Pool addresses
 */
const AAVE_POOLS: Record<YieldChain, Hex> = {
  base: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  ethereum: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  optimism: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
};

/**
 * Known token addresses
 */
const TOKENS: Record<YieldChain, Record<string, { address: Hex; decimals: number }>> = {
  base: {
    USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  },
  ethereum: {
    USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    DAI: { address: '0x6B175474E89094C44Da98b954EescdeCB5BE3830', decimals: 18 },
    WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
  },
  arbitrum: {
    USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    WETH: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
  },
  optimism: {
    USDC: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    USDT: { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  },
};

/**
 * Yield opportunity from DeFiLlama
 */
export interface YieldOpportunity {
  pool: string;
  chain: YieldChain;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  apyBase: number;
  apyReward: number;
  underlyingTokens: string[];
  poolAddress: Hex;
}

/**
 * Yield plan for deposit/withdraw
 */
export interface YieldPlan {
  action: 'deposit' | 'withdraw';
  asset: string;
  amount: string;
  chain: YieldChain;
  protocol: string;
  apy: number;
  poolAddress: Hex;
  tokenAddress: Hex;
  tokenDecimals: number;
}

/**
 * Get yield opportunities from DeFiLlama
 */
export async function getYieldOpportunities(
  asset: string,
  options: { chains?: YieldChain[] } = {}
): Promise<YieldOpportunity[]> {
  const chains = options.chains || ['base', 'arbitrum', 'ethereum', 'optimism'];
  const llamaChains = chains.map(c => LLAMA_CHAINS[c]);

  console.error(`[clara] Fetching yield opportunities for ${asset}...`);

  const response = await fetch(`${DEFILLAMA_API}/pools`);
  if (!response.ok) {
    throw new Error(`DeFiLlama API error: ${response.status}`);
  }

  const data = await response.json() as { data: Array<{
    pool: string;
    chain: string;
    project: string;
    symbol: string;
    tvlUsd: number;
    apy: number;
    apyBase: number;
    apyReward: number;
    underlyingTokens: string[];
  }> };

  // Filter for matching asset and chains
  const upperAsset = asset.toUpperCase();
  const opportunities = data.data
    .filter(pool => {
      // Match asset in symbol
      if (!pool.symbol.toUpperCase().includes(upperAsset)) return false;
      // Match chain
      if (!llamaChains.includes(pool.chain)) return false;
      // Only lending protocols (Aave, Compound, Morpho)
      const lendingProjects = ['aave-v3', 'compound-v3', 'morpho-blue', 'morpho-aavev3'];
      if (!lendingProjects.includes(pool.project.toLowerCase())) return false;
      // Minimum TVL
      if (pool.tvlUsd < 100000) return false;
      return true;
    })
    .map(pool => {
      // Map DeFiLlama chain to our chain type
      const chain = Object.entries(LLAMA_CHAINS).find(
        ([, name]) => name === pool.chain
      )?.[0] as YieldChain;

      return {
        pool: pool.pool,
        chain,
        project: pool.project,
        symbol: pool.symbol,
        tvlUsd: pool.tvlUsd,
        apy: pool.apy || 0,
        apyBase: pool.apyBase || 0,
        apyReward: pool.apyReward || 0,
        underlyingTokens: pool.underlyingTokens || [],
        poolAddress: AAVE_POOLS[chain], // Default to Aave pool
      };
    })
    .filter(o => o.chain) // Only valid chains
    .sort((a, b) => b.apy - a.apy); // Best APY first

  return opportunities;
}

/**
 * Create a yield deposit plan
 */
export async function createYieldPlan(
  asset: string,
  amount: string,
  preferredChain?: YieldChain
): Promise<YieldPlan | null> {
  const chains = preferredChain ? [preferredChain] : undefined;
  const opportunities = await getYieldOpportunities(asset, { chains });

  if (opportunities.length === 0) {
    return null;
  }

  // Pick best opportunity
  const best = opportunities[0];
  const upperAsset = asset.toUpperCase();
  const token = TOKENS[best.chain]?.[upperAsset];

  if (!token) {
    throw new Error(`Token ${asset} not supported on ${best.chain}`);
  }

  return {
    action: 'deposit',
    asset: upperAsset,
    amount,
    chain: best.chain,
    protocol: best.project,
    apy: best.apy,
    poolAddress: best.poolAddress,
    tokenAddress: token.address,
    tokenDecimals: token.decimals,
  };
}

/**
 * Encode Aave v3 supply transaction
 */
export function encodeAaveSupply(
  asset: Hex,
  amount: bigint,
  onBehalfOf: Hex,
  referralCode: number = 0
): Hex {
  // supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)
  // Selector: 0x617ba037
  const selector = '617ba037';
  const assetPadded = asset.slice(2).padStart(64, '0');
  const amountHex = amount.toString(16).padStart(64, '0');
  const onBehalfOfPadded = onBehalfOf.slice(2).padStart(64, '0');
  const referralPadded = referralCode.toString(16).padStart(64, '0');

  return `0x${selector}${assetPadded}${amountHex}${onBehalfOfPadded}${referralPadded}` as Hex;
}

/**
 * Encode Aave v3 withdraw transaction
 */
export function encodeAaveWithdraw(
  asset: Hex,
  amount: bigint,
  to: Hex
): Hex {
  // withdraw(address asset, uint256 amount, address to)
  // Selector: 0x69328dec
  const selector = '69328dec';
  const assetPadded = asset.slice(2).padStart(64, '0');
  const amountHex = amount.toString(16).padStart(64, '0');
  const toPadded = to.slice(2).padStart(64, '0');

  return `0x${selector}${assetPadded}${amountHex}${toPadded}` as Hex;
}

/**
 * Encode ERC-20 approve
 */
export function encodeApprove(spender: Hex, amount: bigint): Hex {
  const selector = '095ea7b3';
  const spenderPadded = spender.slice(2).padStart(64, '0');
  const amountHex = amount.toString(16).padStart(64, '0');
  return `0x${selector}${spenderPadded}${amountHex}` as Hex;
}

/**
 * Max uint256 for unlimited approval
 */
export const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

/**
 * Get chain ID
 */
export function getChainId(chain: YieldChain): number {
  return CHAIN_IDS[chain];
}

/**
 * Get Aave pool address
 */
export function getAavePool(chain: YieldChain): Hex {
  return AAVE_POOLS[chain];
}

/**
 * Get token info
 */
export function getToken(
  symbol: string,
  chain: YieldChain
): { address: Hex; decimals: number } | null {
  return TOKENS[chain]?.[symbol.toUpperCase()] || null;
}
