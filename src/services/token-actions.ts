/**
 * Token Actions Classifier
 *
 * Classifies protocol-native actions from Herd's contractMetadataTool topHolders data.
 * When a top holder is a contract named "VotingEscrow" with 50% of supply locked,
 * that tells us users can lock tokens for governance power.
 *
 * Two-level classification:
 * 1. Contract name regex (high confidence) — "VotingEscrow" → vote_escrow
 * 2. CoinGecko label fallback (medium confidence) — "Volatile AMM" → liquidity
 */

import type { SupportedChain } from '../config/chains.js';
import type { TokenHolder } from '../providers/types.js';
import { getProviderRegistry } from '../providers/registry.js';

// ============================================================================
// Types
// ============================================================================

export type TokenActionType =
  | 'vote_escrow'  // Lock for voting power (VotingEscrow, veToken)
  | 'staking'      // Stake for rewards (Staking, StakedToken)
  | 'liquidity'    // Provide liquidity (Pool, Pair, AMM)
  | 'gauge'        // Gauge deposits (Gauge, GaugeV2)
  | 'governance';  // On-chain governance (Governor, Timelock)

export interface TokenAction {
  type: TokenActionType;
  contractAddress: string;
  contractName: string;
  protocol?: string;       // entityLabel or inferred
  description: string;     // Human-readable
  sharePercentage: number; // How much supply is in this contract
  confidence: 'high' | 'medium';
}

/** Result wrapper with diagnostics for debugging */
export interface TokenActionsResult {
  actions: TokenAction[];
  source: 'herd' | 'unavailable';
  holdersAnalyzed: number;  // 0 = no data, 10 = analyzed but none matched
  tokenAddress: string;
  chain: SupportedChain;
}

// ============================================================================
// Classification Patterns
// ============================================================================

/** Level 1: Contract name → action type (high confidence) */
const NAME_PATTERNS: Array<{ pattern: RegExp; type: TokenActionType; description: string }> = [
  { pattern: /VotingEscrow|^ve[A-Z]/i, type: 'vote_escrow', description: 'Lock for voting power' },
  { pattern: /^Staking|^Staked|StakePool|StakingRewards/i, type: 'staking', description: 'Stake for rewards' },
  { pattern: /Gauge(?:V\d)?$/i, type: 'gauge', description: 'Gauge deposit for emissions' },
  { pattern: /Governor|Governance/i, type: 'governance', description: 'On-chain governance' },
  { pattern: /^Pool$|UniswapV\dPool|AerodromePool/i, type: 'liquidity', description: 'Provide liquidity' },
];

/** Level 2: CoinGecko label → action type (medium confidence) */
const LABEL_PATTERNS: Array<{ pattern: RegExp; type: TokenActionType; description: string }> = [
  { pattern: /Voting Escrow/i, type: 'vote_escrow', description: 'Lock for voting power' },
  { pattern: /Volatile AMM|Stable AMM|Concentrated Liquidity/i, type: 'liquidity', description: 'Provide liquidity' },
  { pattern: /Staking/i, type: 'staking', description: 'Stake for rewards' },
];

/** Skip these — not actionable for the user */
const SKIP_PATTERNS = /Treasury|Timelock|Bridge|Wrapped|Multisig|Safe|Team|Foundation|Deployer|Factory/i;

// ============================================================================
// Protocol Inference
// ============================================================================

/**
 * Infer protocol name when entityLabel is missing.
 * Tries to extract from contract name or token symbol.
 *
 * "StakedWell" + "WELL" → "moonwell"
 * "VotingEscrow" + "AERO" → "aerodrome"
 */
const KNOWN_PROTOCOLS: Array<{ pattern: RegExp; protocol: string }> = [
  { pattern: /^Staked?Well|WELL/i, protocol: 'moonwell' },
  { pattern: /AERO|Aerodrome/i, protocol: 'aerodrome' },
  { pattern: /CRV|Curve/i, protocol: 'curve' },
  { pattern: /BAL|Balancer/i, protocol: 'balancer' },
  { pattern: /UNI|Uniswap/i, protocol: 'uniswap' },
  { pattern: /COMP|Compound/i, protocol: 'compound' },
  { pattern: /SUSHI|SushiSwap/i, protocol: 'sushiswap' },
  { pattern: /VELO|Velodrome/i, protocol: 'velodrome' },
];

function inferProtocol(contractName: string, tokenSymbol: string): string | undefined {
  const combined = `${contractName} ${tokenSymbol}`;
  for (const { pattern, protocol } of KNOWN_PROTOCOLS) {
    if (pattern.test(combined)) {
      return protocol;
    }
  }
  return undefined;
}

// ============================================================================
// Classification Logic
// ============================================================================

/**
 * Classify a single top holder into a token action (or null if not actionable)
 */
export function classifyHolder(holder: TokenHolder, tokenSymbol?: string): TokenAction | null {
  const name = holder.name || '';
  const label = holder.coingeckoLabel || '';

  // Skip non-actionable contracts
  if (SKIP_PATTERNS.test(name) || SKIP_PATTERNS.test(label)) {
    return null;
  }

  // Resolve protocol: entityLabel > inference
  const protocol = holder.entityLabel || inferProtocol(name, tokenSymbol || '');

  // Level 1: Match by contract name (high confidence)
  for (const { pattern, type, description } of NAME_PATTERNS) {
    if (pattern.test(name)) {
      return {
        type,
        contractAddress: holder.address,
        contractName: name,
        protocol,
        description: protocol
          ? `${description} on ${protocol}`
          : description,
        sharePercentage: holder.sharePercentage,
        confidence: 'high',
      };
    }
  }

  // Level 2: Match by CoinGecko label (medium confidence)
  for (const { pattern, type, description } of LABEL_PATTERNS) {
    if (pattern.test(label)) {
      return {
        type,
        contractAddress: holder.address,
        contractName: name || label,
        protocol,
        description: protocol
          ? `${description} on ${protocol}`
          : description,
        sharePercentage: holder.sharePercentage,
        confidence: 'medium',
      };
    }
  }

  return null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get protocol-native actions for a token by analyzing its top holders.
 *
 * Calls Herd's contractMetadataTool, extracts topHolders, and classifies each
 * contract holder into an actionable type (vote_escrow, staking, liquidity, etc.)
 *
 * Returns a result object with diagnostics (source, holdersAnalyzed) for debugging.
 */
export async function getTokenActions(
  tokenAddress: string,
  chain: SupportedChain,
  tokenSymbol: string,
): Promise<TokenActionsResult> {
  const registry = getProviderRegistry();

  // Check if ContractMetadata capability is available for this chain
  if (!registry.hasCapability('ContractMetadata', chain)) {
    return { actions: [], source: 'unavailable', holdersAnalyzed: 0, tokenAddress, chain };
  }

  const result = await registry.getContractMetadata({
    address: tokenAddress,
    chain,
    detailLevel: 'summary',
  });

  if (!result.success || !result.data?.token?.topHolders) {
    return { actions: [], source: 'herd', holdersAnalyzed: 0, tokenAddress, chain };
  }

  const holders = result.data.token.topHolders;
  const actions: TokenAction[] = [];

  for (const holder of holders) {
    const action = classifyHolder(holder, tokenSymbol);
    if (action) {
      actions.push(action);
    }
  }

  // Sort by share percentage descending (most supply locked = most important)
  actions.sort((a, b) => b.sharePercentage - a.sharePercentage);

  return {
    actions,
    source: 'herd',
    holdersAnalyzed: holders.length,
    tokenAddress,
    chain,
  };
}

/** Human-readable labels for action types */
export const ACTION_LABELS: Record<TokenActionType, string> = {
  vote_escrow: 'Vote Escrow',
  staking: 'Staking',
  liquidity: 'Liquidity',
  gauge: 'Gauge',
  governance: 'Governance',
};
