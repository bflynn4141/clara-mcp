/**
 * Token Pattern Definitions
 *
 * Simple pattern matching based on function names in contract ABIs.
 * This is the 80% solution - good enough for most common token types.
 *
 * When pattern matching fails, the LLM can still reason about
 * the raw function list to understand the contract.
 */

/**
 * Token type patterns based on characteristic function signatures
 */
export const TOKEN_PATTERNS = {
  /**
   * Governance tokens - can delegate voting power
   * Examples: AAVE, UNI, COMP, ARB
   */
  governance: {
    functions: ['delegate', 'delegates', 'getVotes'],
    altFunctions: ['getPastVotes', 'delegateBySig', 'numCheckpoints'],
    description: 'Governance token with voting power delegation',
  },

  /**
   * LP tokens - represent liquidity pool positions (Uniswap V2 style)
   * Examples: UNI-V2 LP tokens, SushiSwap LP, Aerodrome volatile pairs
   */
  lpToken: {
    functions: ['token0', 'token1', 'getReserves'],
    altFunctions: ['mint', 'burn', 'swap', 'sync', 'skim'],
    description: 'Liquidity pool token (AMM pair)',
  },

  /**
   * Vault/Yield tokens - ERC4626 standard
   * Examples: Yearn vaults, Aave aTokens, yield-bearing wrappers
   */
  vault: {
    functions: ['asset', 'convertToAssets', 'convertToShares'],
    altFunctions: ['deposit', 'withdraw', 'redeem', 'totalAssets', 'previewDeposit'],
    description: 'Yield-bearing vault token (ERC4626)',
  },

  /**
   * Staking contracts - stake tokens for rewards
   * Examples: Aave stkAAVE, Curve gauges, Synthetix staking
   */
  staking: {
    functions: ['stake', 'withdraw', 'earned'],
    altFunctions: ['getReward', 'claimReward', 'exit', 'notifyRewardAmount', 'rewardRate'],
    description: 'Staking contract with reward distribution',
  },

  /**
   * Vesting contracts - locked tokens with release schedule
   * Examples: Team vesting, investor lockups, OpenZeppelin VestingWallet
   */
  vesting: {
    functions: ['release', 'vestedAmount'],
    altFunctions: ['releasable', 'released', 'start', 'duration', 'cliff'],
    description: 'Token vesting contract with time-based release',
  },

  /**
   * Vote-escrowed tokens - lock for voting power (Curve style)
   * Examples: veCRV, veBAL, veAERO
   */
  veToken: {
    functions: ['create_lock', 'locked'],
    altFunctions: ['increase_amount', 'increase_unlock_time', 'withdraw', 'balanceOfAt'],
    description: 'Vote-escrowed token with time-locked governance',
  },

  /**
   * Rebasing tokens - balance changes automatically
   * Examples: stETH, AMPL, OHM
   */
  rebasing: {
    functions: ['sharesOf', 'getSharesByPooledEth'],
    altFunctions: ['getTotalShares', 'getPooledEthByShares', 'submit'],
    description: 'Rebasing token (balance changes with protocol)',
  },
} as const;

export type TokenType = keyof typeof TOKEN_PATTERNS;

/**
 * Result of pattern matching
 */
export interface PatternMatch {
  type: TokenType;
  matchedFunctions: string[];
  matchScore: number; // 0-1, how many functions matched
  description: string;
}

/**
 * Match ABI functions against known token patterns
 *
 * Returns the best match, or null if no pattern matches well enough.
 * Requires at least 60% of primary functions to match.
 *
 * @param abiFunctions - Array of function names from the contract ABI
 * @returns Best matching pattern or null
 */
export function matchTokenType(abiFunctions: string[]): PatternMatch | null {
  // Normalize function names to lowercase for comparison
  const fnLower = new Set(abiFunctions.map(f => f.toLowerCase()));

  let bestMatch: PatternMatch | null = null;
  let bestScore = 0;

  for (const [type, pattern] of Object.entries(TOKEN_PATTERNS)) {
    // Check primary functions (required for match)
    const primaryMatches = pattern.functions.filter(fn =>
      fnLower.has(fn.toLowerCase())
    );

    // Must match at least 60% of primary functions
    const primaryMatchRatio = primaryMatches.length / pattern.functions.length;
    if (primaryMatchRatio < 0.6) {
      continue;
    }

    // Check alternative functions (boost score)
    const altMatches = pattern.altFunctions.filter(fn =>
      fnLower.has(fn.toLowerCase())
    );

    // Calculate score: primary matches weighted more heavily
    const score = primaryMatchRatio * 0.7 + (altMatches.length / pattern.altFunctions.length) * 0.3;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = {
        type: type as TokenType,
        matchedFunctions: [...primaryMatches, ...altMatches],
        matchScore: score,
        description: pattern.description,
      };
    }
  }

  return bestMatch;
}

/**
 * Get all function names that indicate a specific token type
 * Useful for explaining why a classification was made
 */
export function getPatternFunctions(type: TokenType): string[] {
  const pattern = TOKEN_PATTERNS[type];
  return [...pattern.functions, ...pattern.altFunctions];
}

/**
 * Check if a function name is interesting (indicates special capability)
 */
export function isInterestingFunction(fnName: string): boolean {
  // All entries must be lowercase for case-insensitive matching
  const interesting = new Set([
    // Governance
    'delegate', 'vote', 'propose', 'queue', 'execute', 'cancel',
    // Staking
    'stake', 'unstake', 'claim', 'earned', 'getreward', 'exit',
    // DeFi
    'deposit', 'withdraw', 'borrow', 'repay', 'liquidate',
    'swap', 'addliquidity', 'removeliquidity',
    // Admin (potential risks)
    'pause', 'unpause', 'blacklist', 'freeze', 'mint', 'burn',
    'setowner', 'transferownership', 'renounceownership',
    // Upgrades
    'upgradeto', 'upgradetoandcall',
  ]);

  const lower = fnName.toLowerCase();
  return interesting.has(lower) ||
    lower.includes('claim') ||
    lower.includes('reward') ||
    lower.includes('withdraw');
}
