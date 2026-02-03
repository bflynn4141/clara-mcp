/**
 * Opportunity Detection
 *
 * Scans user holdings to detect actionable opportunities:
 * - Unclaimed rewards from staking contracts
 * - Active governance proposals to vote on
 * - Recent token inflows to investigate
 *
 * The LLM uses these opportunities to proactively suggest actions.
 */

import { createPublicClient, http, formatUnits, type Hex } from 'viem';
import { CHAINS, getRpcUrl, type SupportedChain } from '../config/chains.js';
import { getProviderRegistry } from '../providers/index.js';
import { analyzeToken, type TokenAnalysis } from './classifier.js';
import { opportunityCache } from './cache.js';
// Note: checkContractSafety removed - reusing analysis.isVerified to avoid duplicate metadata calls
// Note: tokenCacheKey removed - using user-specific cache key inline (GPT-5.2 security fix)

// ============================================================================
// Types
// ============================================================================

/**
 * Types of opportunities we can detect
 */
export type OpportunityType =
  | 'unclaimed_rewards'    // Staking rewards ready to claim
  | 'governance_vote'      // Active proposal to vote on
  | 'token_inflow'         // New token received recently
  | 'vesting_release'      // Vested tokens ready to release
  | 'approval_risk';       // Old approval to risky contract

/**
 * Priority for displaying opportunities
 */
export type OpportunityPriority = 'high' | 'medium' | 'low';

/**
 * Risk level for an opportunity based on contract safety
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';

/**
 * A detected opportunity
 */
export interface Opportunity {
  type: OpportunityType;
  priority: OpportunityPriority;
  title: string;
  description: string;
  tokenAddress: string;
  tokenSymbol?: string;
  chain: string;
  // For rewards
  claimableAmount?: string;
  claimableValueUsd?: number;
  // For governance
  proposalId?: string;
  proposalTitle?: string;
  votingDeadline?: string;
  // For inflows
  amount?: string;
  fromAddress?: string;
  timestamp?: string;
  // Action hint for LLM
  suggestedAction: string;
  // Safety information
  riskLevel?: RiskLevel;
  riskWarnings?: string[];
}

/**
 * Result of opportunity scan
 */
export interface OpportunityScanResult {
  opportunities: Opportunity[];
  scannedTokens: number;
  scanTime: number;
  errors: string[];
}

// ============================================================================
// Detector Functions
// ============================================================================

/**
 * Check for unclaimed staking rewards
 *
 * Looks for contracts with earned(), claimable(), or similar functions
 * and checks if user has pending rewards.
 */
export async function detectUnclaimedRewards(
  tokenAddress: string,
  chain: SupportedChain,
  userAddress: string,
  analysis: TokenAnalysis
): Promise<Opportunity | null> {
  // Only check staking contracts or contracts with reward functions
  const hasRewardFunctions = analysis.availableFunctions.some(fn => {
    const lower = fn.toLowerCase();
    return lower === 'earned' ||
           lower === 'claimable' ||
           lower === 'claimablereward' ||
           lower === 'claimablerewards' ||
           lower === 'pendingreward' ||
           lower === 'getreward';
  });

  if (!hasRewardFunctions) {
    return null;
  }

  try {
    const client = createPublicClient({
      chain: CHAINS[chain].chain,
      transport: http(getRpcUrl(chain)),
    });

    // Try different function names for checking rewards
    const rewardFunctions = [
      { name: 'earned', args: [userAddress] },
      { name: 'claimable', args: [userAddress] },
      { name: 'claimableReward', args: [userAddress] },
      { name: 'claimableRewards', args: [userAddress] },
      { name: 'pendingReward', args: [userAddress] },
    ];

    for (const fn of rewardFunctions) {
      // Check if this function exists in the contract
      const hasFunction = analysis.availableFunctions.some(
        f => f.toLowerCase() === fn.name.toLowerCase()
      );
      if (!hasFunction) continue;

      try {
        const abi = [{
          name: fn.name,
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'account', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
        }] as const;

        const reward = await client.readContract({
          address: tokenAddress as Hex,
          abi,
          functionName: fn.name as any,
          args: [userAddress as Hex],
        });

        const rewardBigInt = reward as bigint;

        // Check if there are meaningful rewards (> 0)
        if (rewardBigInt > 0n) {
          // Default to 18 decimals, could be improved with actual decimals lookup
          const formatted = formatUnits(rewardBigInt, 18);
          const formattedNum = parseFloat(formatted);

          // Only report if > dust amount
          if (formattedNum > 0.0001) {
            return {
              type: 'unclaimed_rewards',
              priority: formattedNum > 10 ? 'high' : formattedNum > 1 ? 'medium' : 'low',
              title: `Unclaimed rewards on ${analysis.symbol || 'contract'}`,
              description: `You have ${formatted} tokens ready to claim`,
              tokenAddress,
              tokenSymbol: analysis.symbol,
              chain,
              claimableAmount: formatted,
              suggestedAction: `Call getReward() or claim() to collect your ${formatted} rewards`,
            };
          }
        }
      } catch {
        // This function call failed, try the next one
        continue;
      }
    }
  } catch (error) {
    console.error('Reward detection error:', error);
  }

  return null;
}

/**
 * Detect new token inflows (received in last 24h)
 *
 * Uses Zerion transaction history to find recent receives.
 */
export async function detectRecentInflows(
  userAddress: string,
  chain: SupportedChain
): Promise<Opportunity[]> {
  const opportunities: Opportunity[] = [];

  try {
    const registry = getProviderRegistry();

    // Get recent transaction history
    const historyResult = await registry.listHistory({
      address: userAddress,
      chain,
      limit: 20,
    });

    if (!historyResult.success || !historyResult.data) {
      return [];
    }

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    for (const tx of historyResult.data.transactions) {
      const txTime = new Date(tx.timestamp).getTime();

      // Only look at recent transactions
      if (txTime < oneDayAgo) continue;

      // Look for incoming transfers
      for (const transfer of tx.transfers) {
        if (transfer.direction === 'in' && transfer.token.address) {
          // Check if this is a meaningful amount
          const amount = parseFloat(transfer.amount);
          if (amount > 0) {
            opportunities.push({
              type: 'token_inflow',
              priority: 'medium',
              title: `Received ${transfer.token.symbol}`,
              description: `You received ${transfer.amount} ${transfer.token.symbol} from ${transfer.from.slice(0, 10)}...`,
              tokenAddress: transfer.token.address,
              tokenSymbol: transfer.token.symbol,
              chain,
              amount: transfer.amount,
              fromAddress: transfer.from,
              timestamp: tx.timestamp,
              suggestedAction: `Analyze this token with wallet_analyze_holding to understand what you received`,
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('Inflow detection error:', error);
  }

  // Deduplicate by token address (only report once per token)
  const seen = new Set<string>();
  return opportunities.filter(opp => {
    const key = opp.tokenAddress.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Check for governance voting opportunities
 *
 * For governance tokens, checks if there are active proposals
 * and if user has voting power.
 */
export async function detectGovernanceOpportunities(
  tokenAddress: string,
  chain: SupportedChain,
  userAddress: string,
  analysis: TokenAnalysis
): Promise<Opportunity | null> {
  // Only check governance tokens
  if (analysis.likelyType !== 'governance') {
    return null;
  }

  // Check if user has voting power
  const hasVotes = analysis.availableFunctions.some(fn =>
    fn.toLowerCase() === 'getvotes' || fn.toLowerCase() === 'getpriortotalvotes'
  );

  if (!hasVotes) {
    return null;
  }

  try {
    const client = createPublicClient({
      chain: CHAINS[chain].chain,
      transport: http(getRpcUrl(chain)),
    });

    // Check voting power
    const getVotesAbi = [{
      name: 'getVotes',
      type: 'function',
      stateMutability: 'view',
      inputs: [{ name: 'account', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }],
    }] as const;

    const votes = await client.readContract({
      address: tokenAddress as Hex,
      abi: getVotesAbi,
      functionName: 'getVotes',
      args: [userAddress as Hex],
    });

    const votesNum = parseFloat(formatUnits(votes as bigint, 18));

    if (votesNum > 0) {
      // User has voting power - they might want to vote
      return {
        type: 'governance_vote',
        priority: 'medium',
        title: `You have voting power: ${analysis.symbol || 'governance token'}`,
        description: `You have ${votesNum.toFixed(2)} votes. Check for active proposals.`,
        tokenAddress,
        tokenSymbol: analysis.symbol,
        chain,
        suggestedAction: `Check the protocol's governance page for active proposals to vote on`,
      };
    }
  } catch {
    // Voting power check failed
  }

  return null;
}

// ============================================================================
// Scanner Configuration
// ============================================================================

/** Maximum concurrent token scans */
const MAX_CONCURRENT_SCANS = 5;

/** Maximum time for opportunity scan (ms) */
const SCAN_TIME_BUDGET_MS = 10000; // 10 seconds

// ============================================================================
// Scanner
// ============================================================================

/**
 * Scan a single token for opportunities
 * Extracted for parallelization
 */
async function scanSingleToken(
  tokenAddress: string,
  chain: SupportedChain,
  userAddress: string
): Promise<{ opportunities: Opportunity[]; error?: string }> {
  // CRITICAL: Include userAddress in cache key (GPT-5.2 security review)
  // Opportunity data is user-specific (claimable rewards, voting power)
  // Without this, User B could see User A's cached opportunities
  const cacheKey = `${chain}:${tokenAddress.toLowerCase()}:${userAddress.toLowerCase()}`;

  // Check cache first
  const cached = opportunityCache.get(cacheKey);
  if (cached) {
    return { opportunities: cached as Opportunity[] };
  }

  try {
    // Get token analysis (includes verification status)
    const analysis = await analyzeToken(tokenAddress, chain, userAddress);

    // Build safety result from analysis data to avoid duplicate metadata calls
    // This reuses verification data already fetched in analyzeToken
    const safetyInfo: { overallRisk: RiskLevel; warnings: string[] } = {
      overallRisk: analysis.isVerified ? 'low' : 'high',
      warnings: [],
    };

    if (!analysis.isVerified) {
      safetyInfo.warnings.push('Unverified Contract');
    }
    if (analysis.isProxy && !analysis.implementationAddress) {
      safetyInfo.warnings.push('Unverified Implementation');
    }

    const tokenOpportunities: Opportunity[] = [];

    // Check for unclaimed rewards
    const rewards = await detectUnclaimedRewards(tokenAddress, chain, userAddress, analysis);
    if (rewards) {
      rewards.riskLevel = safetyInfo.overallRisk;
      rewards.riskWarnings = safetyInfo.warnings.length > 0 ? safetyInfo.warnings : undefined;
      tokenOpportunities.push(rewards);
    }

    // Check for governance opportunities
    const governance = await detectGovernanceOpportunities(tokenAddress, chain, userAddress, analysis);
    if (governance) {
      governance.riskLevel = safetyInfo.overallRisk;
      governance.riskWarnings = safetyInfo.warnings.length > 0 ? safetyInfo.warnings : undefined;
      tokenOpportunities.push(governance);
    }

    // Cache the results for this token
    opportunityCache.set(cacheKey, tokenOpportunities);

    return { opportunities: tokenOpportunities };
  } catch (error) {
    return {
      opportunities: [],
      error: `Failed to scan ${tokenAddress.slice(0, 10)}...: ${error instanceof Error ? error.message : 'Unknown'}`,
    };
  }
}

/**
 * Process tokens in parallel with concurrency limit
 */
async function processTokensInParallel<T>(
  items: string[],
  processor: (item: string) => Promise<T>,
  concurrency: number,
  timeBudgetMs: number,
  startTime: number
): Promise<{ results: T[]; processedCount: number; timedOut: boolean }> {
  const results: T[] = [];
  let processedCount = 0;
  let timedOut = false;

  // Process in batches of `concurrency` size
  for (let i = 0; i < items.length; i += concurrency) {
    // Check time budget
    if (Date.now() - startTime > timeBudgetMs) {
      timedOut = true;
      break;
    }

    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
    processedCount += batch.length;
  }

  return { results, processedCount, timedOut };
}

/**
 * Scan user's holdings for opportunities
 *
 * Performance optimizations (GPT-5.2 recommendations):
 * - Parallel scanning with concurrency limit (MAX_CONCURRENT_SCANS)
 * - Time budget to prevent long scans (SCAN_TIME_BUDGET_MS)
 * - Reuses verification data from analyzeToken (avoids duplicate metadata calls)
 *
 * @param userAddress - User's wallet address
 * @param chain - Chain to scan
 * @param tokenAddresses - List of token addresses to check (from user's holdings)
 * @returns Scan results with all detected opportunities
 */
export async function scanForOpportunities(
  userAddress: string,
  chain: SupportedChain,
  tokenAddresses: string[]
): Promise<OpportunityScanResult> {
  const startTime = Date.now();
  const opportunities: Opportunity[] = [];
  const errors: string[] = [];

  // Check for recent inflows first (doesn't need token analysis)
  try {
    const inflows = await detectRecentInflows(userAddress, chain);
    opportunities.push(...inflows);
  } catch (error) {
    errors.push(`Inflow detection failed: ${error instanceof Error ? error.message : 'Unknown'}`);
  }

  // Process tokens in parallel with concurrency limit and time budget
  const { results, processedCount, timedOut } = await processTokensInParallel(
    tokenAddresses,
    (addr) => scanSingleToken(addr, chain, userAddress),
    MAX_CONCURRENT_SCANS,
    SCAN_TIME_BUDGET_MS,
    startTime
  );

  // Collect results
  for (const result of results) {
    opportunities.push(...result.opportunities);
    if (result.error) {
      errors.push(result.error);
    }
  }

  // Add timeout warning if applicable
  if (timedOut) {
    errors.push(`Scan timed out after ${SCAN_TIME_BUDGET_MS}ms. Scanned ${processedCount}/${tokenAddresses.length} tokens.`);
  }

  // Sort by priority
  opportunities.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.priority] - order[b.priority];
  });

  return {
    opportunities,
    scannedTokens: processedCount,
    scanTime: Date.now() - startTime,
    errors,
  };
}

/**
 * Format risk level as a visual badge
 */
function formatRiskBadge(riskLevel?: RiskLevel): string {
  if (!riskLevel || riskLevel === 'low') return '';
  if (riskLevel === 'high') return ' 🛑';
  if (riskLevel === 'medium') return ' ⚠️';
  return '';
}

/**
 * Format opportunities for LLM consumption
 */
export function formatOpportunitiesForLLM(result: OpportunityScanResult): string {
  const lines: string[] = [];

  if (result.opportunities.length === 0) {
    lines.push('## No Opportunities Detected');
    lines.push('');
    lines.push('Your wallet looks good! No immediate actions needed.');
    lines.push('');
    lines.push(`Scanned ${result.scannedTokens} tokens in ${result.scanTime}ms.`);
    return lines.join('\n');
  }

  lines.push(`## Found ${result.opportunities.length} Opportunities`);
  lines.push('');

  // Group by priority
  const high = result.opportunities.filter(o => o.priority === 'high');
  const medium = result.opportunities.filter(o => o.priority === 'medium');
  const low = result.opportunities.filter(o => o.priority === 'low');

  if (high.length > 0) {
    lines.push('### 🔴 High Priority');
    for (const opp of high) {
      lines.push(`- **${opp.title}** (${opp.chain})${formatRiskBadge(opp.riskLevel)}`);
      lines.push(`  ${opp.description}`);
      if (opp.riskWarnings && opp.riskWarnings.length > 0) {
        lines.push(`  ⚠️ _${opp.riskWarnings.join(', ')}_`);
      }
      lines.push(`  _Action: ${opp.suggestedAction}_`);
    }
    lines.push('');
  }

  if (medium.length > 0) {
    lines.push('### 🟡 Medium Priority');
    for (const opp of medium) {
      lines.push(`- **${opp.title}** (${opp.chain})${formatRiskBadge(opp.riskLevel)}`);
      lines.push(`  ${opp.description}`);
      if (opp.riskWarnings && opp.riskWarnings.length > 0) {
        lines.push(`  ⚠️ _${opp.riskWarnings.join(', ')}_`);
      }
      lines.push(`  _Action: ${opp.suggestedAction}_`);
    }
    lines.push('');
  }

  if (low.length > 0) {
    lines.push('### ⚪ Low Priority');
    for (const opp of low) {
      lines.push(`- **${opp.title}** (${opp.chain})${formatRiskBadge(opp.riskLevel)}`);
      lines.push(`  ${opp.description}`);
      if (opp.riskWarnings && opp.riskWarnings.length > 0) {
        lines.push(`  ⚠️ _${opp.riskWarnings.join(', ')}_`);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`Scanned ${result.scannedTokens} tokens in ${result.scanTime}ms.`);

  if (result.errors.length > 0) {
    lines.push('');
    lines.push(`⚠️ ${result.errors.length} tokens could not be scanned.`);
  }

  return lines.join('\n');
}
