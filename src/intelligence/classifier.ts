/**
 * Token Classification
 *
 * Analyzes any token contract to determine:
 * - What type of token it is (governance, LP, vault, staking, etc.)
 * - What functions are available
 * - Related contracts (staking, governance, rewards)
 * - User's balance (if wallet connected)
 *
 * Key features:
 * - EIP-1967 proxy resolution (analyzes implementation, not proxy)
 * - Pattern matching on function names
 * - 24-hour caching for classifications
 * - Graceful degradation for unverified contracts
 */

import { createPublicClient, http, formatUnits, type Hex } from 'viem';
import { getProviderRegistry } from '../providers/index.js';
import type { FunctionInfo } from '../providers/types.js';
import { CHAINS, getRpcUrl, type SupportedChain, isSupportedChain } from '../config/chains.js';
import { matchTokenType, isInterestingFunction, type PatternMatch } from './patterns.js';
import { findRelatedContracts, type RelatedContract } from './discovery.js';
import { classificationCache, tokenCacheKey } from './cache.js';

// EIP-1967 storage slot for implementation address
// keccak256("eip1967.proxy.implementation") - 1
const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex;

/**
 * Result of token analysis
 */
export interface TokenAnalysis {
  // Identity
  address: string;
  chain: string;

  // Basic metadata
  name?: string;
  symbol?: string;
  decimals?: number;

  // Verification status
  isVerified: boolean;

  // Proxy info
  isProxy: boolean;
  implementationAddress?: string;

  // Classification
  classification?: PatternMatch;
  likelyType?: string;

  // Functions (for LLM reasoning)
  availableFunctions: string[];  // Just names (for pattern matching and display)
  interestingFunctions: string[];

  // Full function signatures (for safe calldata generation)
  // This prevents mismatches with overloaded functions like claim() vs claim(uint256)
  functionSignatures: FunctionInfo[];

  // Related contracts
  relatedContracts: RelatedContract[];

  // User's position (if wallet connected)
  userBalance?: {
    raw: string;
    formatted: string;
    valueUsd?: number;
  };
}

/**
 * Analyze a token contract
 *
 * @param tokenAddress - The token contract address
 * @param chain - The blockchain (base, ethereum, etc.)
 * @param userAddress - Optional: user's address for balance lookup
 * @returns Full token analysis
 */
export async function analyzeToken(
  tokenAddress: string,
  chain: string,
  userAddress?: string
): Promise<TokenAnalysis> {
  // Validate chain
  if (!isSupportedChain(chain)) {
    throw new Error(`Unsupported chain: ${chain}`);
  }

  const cacheKey = tokenCacheKey(chain, tokenAddress);

  // Check cache for base classification (without user balance)
  const cached = classificationCache.get(cacheKey);
  if (cached) {
    // Clone to avoid mutating cached object (prevents user balance leakage)
    const analysis = { ...(cached as TokenAnalysis) };
    // Add fresh user balance if requested
    if (userAddress) {
      analysis.userBalance = await getUserBalance(tokenAddress, chain, userAddress);
    }
    return analysis;
  }

  // Step 1: Check if this is a proxy and resolve implementation
  const proxyInfo = await resolveProxy(tokenAddress, chain);

  // Step 2: Get contract metadata from Herd
  const targetAddress = proxyInfo.implementationAddress || tokenAddress;
  const registry = getProviderRegistry();

  let metadata: any = null;
  try {
    if (registry.hasCapability('ContractMetadata', chain)) {
      const result = await registry.getContractMetadata({
        address: targetAddress,
        chain: chain as SupportedChain,
        includeAbi: true,
      });

      if (result.success && result.data) {
        metadata = result.data;
      }
    }
  } catch (error) {
    console.error('Failed to get contract metadata:', error);
  }

  // If no metadata, contract is likely unverified
  if (!metadata || !metadata.abi) {
    const unverifiedResult: TokenAnalysis = {
      address: tokenAddress,
      chain,
      isVerified: false,
      isProxy: proxyInfo.isProxy,
      implementationAddress: proxyInfo.implementationAddress,
      availableFunctions: [],
      interestingFunctions: [],
      functionSignatures: [],
      relatedContracts: [],
    };

    // Still try to get balance
    if (userAddress) {
      unverifiedResult.userBalance = await getUserBalance(tokenAddress, chain, userAddress);
    }

    return unverifiedResult;
  }

  // Step 3: Extract function names from ABI (guard against missing names)
  const functions = metadata.abi
    .filter((item: any) => item.type === 'function' && typeof item.name === 'string')
    .map((item: any) => item.name) as string[];

  // Step 4: Classify using pattern matching
  const classification = matchTokenType(functions);

  // Step 5: Find interesting functions
  const interestingFunctions = functions.filter(isInterestingFunction);

  // Step 6: Find related contracts
  const relatedContracts = await findRelatedContracts(tokenAddress, chain);

  // Extract full function signatures from metadata (for safe calldata generation)
  // This prevents issues with overloaded functions like claim() vs claim(uint256)
  const functionSignatures: FunctionInfo[] = metadata.functions || [];

  // Build the analysis result
  const analysis: TokenAnalysis = {
    address: tokenAddress,
    chain,
    // Use metadata.token (not tokenInfo - that field doesn't exist in ContractMetadata)
    name: metadata.name || metadata.token?.name,
    symbol: metadata.token?.symbol,
    decimals: metadata.token?.decimals,
    isVerified: true,
    isProxy: proxyInfo.isProxy,
    implementationAddress: proxyInfo.implementationAddress,
    classification: classification ?? undefined,  // Convert null to undefined
    likelyType: classification?.type,
    availableFunctions: functions,
    interestingFunctions,
    functionSignatures,  // Full signatures for safe action generation
    relatedContracts,
  };

  // Cache the base analysis (without user-specific balance)
  classificationCache.set(cacheKey, analysis);

  // Add user balance if requested
  if (userAddress) {
    analysis.userBalance = await getUserBalance(tokenAddress, chain, userAddress);
  }

  return analysis;
}

/**
 * Resolve EIP-1967 proxy to get implementation address
 */
async function resolveProxy(
  address: string,
  chain: SupportedChain
): Promise<{ isProxy: boolean; implementationAddress?: string }> {
  try {
    const client = createPublicClient({
      chain: CHAINS[chain].chain,
      transport: http(getRpcUrl(chain)),
    });

    // Read EIP-1967 implementation storage slot
    const slot = await client.getStorageAt({
      address: address as Hex,
      slot: EIP1967_IMPLEMENTATION_SLOT,
    });

    // Check if slot contains a valid address (not zero)
    if (slot && slot !== '0x' + '0'.repeat(64)) {
      // Extract address from storage slot (last 20 bytes = 40 hex chars)
      const implAddress = '0x' + slot.slice(-40);

      // Verify it's not the zero address
      if (implAddress.toLowerCase() !== '0x' + '0'.repeat(40)) {
        return {
          isProxy: true,
          implementationAddress: implAddress,
        };
      }
    }

    return { isProxy: false };
  } catch (error) {
    // If we can't check, assume not a proxy
    console.error('Proxy resolution error:', error);
    return { isProxy: false };
  }
}

/**
 * Get user's balance of a token
 */
async function getUserBalance(
  tokenAddress: string,
  chain: SupportedChain,
  userAddress: string
): Promise<{ raw: string; formatted: string; valueUsd?: number } | undefined> {
  try {
    const client = createPublicClient({
      chain: CHAINS[chain].chain,
      transport: http(getRpcUrl(chain)),
    });

    // ERC20 balanceOf ABI
    const balanceOfAbi = [{
      name: 'balanceOf',
      type: 'function',
      stateMutability: 'view',
      inputs: [{ name: 'account', type: 'address' }],
      outputs: [{ name: 'balance', type: 'uint256' }],
    }] as const;

    // Get decimals
    const decimalsAbi = [{
      name: 'decimals',
      type: 'function',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'uint8' }],
    }] as const;

    const [balance, decimals] = await Promise.all([
      client.readContract({
        address: tokenAddress as Hex,
        abi: balanceOfAbi,
        functionName: 'balanceOf',
        args: [userAddress as Hex],
      }),
      client.readContract({
        address: tokenAddress as Hex,
        abi: decimalsAbi,
        functionName: 'decimals',
      }).catch(() => 18), // Default to 18 if decimals() fails
    ]);

    const formatted = formatUnits(balance as bigint, decimals as number);

    return {
      raw: (balance as bigint).toString(),
      formatted,
      // Note: USD value would require price feed, skipping for MVP
    };
  } catch (error) {
    console.error('Balance lookup error:', error);
    return undefined;
  }
}

/**
 * Format token analysis for LLM consumption
 */
export function formatAnalysisForLLM(analysis: TokenAnalysis): string {
  const lines: string[] = [];

  lines.push(`## Token Analysis: ${analysis.symbol || analysis.address.slice(0, 10) + '...'}`);
  lines.push('');

  // Handle unverified contracts
  if (!analysis.isVerified) {
    lines.push('⚠️ **Contract not verified** - Cannot analyze source code safely.');
    lines.push('');
    lines.push('This contract has not been verified on the block explorer.');
    lines.push('Be cautious when interacting with unverified contracts.');

    if (analysis.userBalance) {
      lines.push('');
      lines.push(`**Your Balance:** ${analysis.userBalance.formatted} tokens`);
    }

    return lines.join('\n');
  }

  // Basic info
  lines.push(`**Address:** \`${analysis.address}\``);
  lines.push(`**Chain:** ${analysis.chain}`);
  if (analysis.name) lines.push(`**Name:** ${analysis.name}`);
  if (analysis.symbol) lines.push(`**Symbol:** ${analysis.symbol}`);

  // User balance
  if (analysis.userBalance) {
    lines.push(`**Your Balance:** ${analysis.userBalance.formatted} ${analysis.symbol || 'tokens'}`);
  }

  // Proxy info
  if (analysis.isProxy) {
    lines.push(`**Proxy:** Yes`);
    lines.push(`**Implementation:** \`${analysis.implementationAddress}\``);
  }

  lines.push('');

  // Classification
  if (analysis.classification) {
    lines.push(`**Type:** ${analysis.classification.description}`);
    lines.push(`**Confidence:** ${Math.round(analysis.classification.matchScore * 100)}%`);
    lines.push(`**Matched:** ${analysis.classification.matchedFunctions.join(', ')}`);
  } else {
    lines.push('**Type:** Could not classify - showing all functions for analysis');
  }

  lines.push('');

  // Interesting functions (actionable)
  if (analysis.interestingFunctions.length > 0) {
    lines.push('**Notable Functions:**');
    for (const fn of analysis.interestingFunctions.slice(0, 10)) {
      lines.push(`- \`${fn}\``);
    }
    lines.push('');
  }

  // All functions (for LLM reasoning)
  lines.push('**All Functions:**');
  const displayFns = analysis.availableFunctions.slice(0, 25);
  for (const fn of displayFns) {
    const marker = analysis.interestingFunctions.includes(fn) ? '→' : '-';
    lines.push(`${marker} \`${fn}\``);
  }
  if (analysis.availableFunctions.length > 25) {
    lines.push(`- ... and ${analysis.availableFunctions.length - 25} more`);
  }

  // Related contracts
  if (analysis.relatedContracts.length > 0) {
    lines.push('');
    lines.push('**Related Contracts:**');
    for (const rel of analysis.relatedContracts.slice(0, 5)) {
      const relevanceIcon = rel.relevance === 'high' ? '🔴' : rel.relevance === 'medium' ? '🟡' : '⚪';
      lines.push(`${relevanceIcon} \`${rel.address.slice(0, 10)}...\` - ${rel.relationship}`);
      if (rel.name) lines.push(`   Name: ${rel.name}`);
    }
  }

  return lines.join('\n');
}
