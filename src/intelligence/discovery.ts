/**
 * Related Contract Discovery
 *
 * Find contracts related to a token using simple strategies.
 * MVP: Only use Herd code search to find contracts that reference the token.
 *
 * Future strategies (not in MVP):
 * - Same deployer analysis
 * - Factory backtracking
 * - Event log analysis
 */

import { getProviderRegistry } from '../providers/index.js';
import { discoveryCache, tokenCacheKey } from './cache.js';
import type { SupportedChain } from '../config/chains.js';
import { isSupportedChain } from '../config/chains.js';

/**
 * A contract related to a token
 */
export interface RelatedContract {
  address: string;
  name?: string;
  relationship: string;
  relevance: 'high' | 'medium' | 'low';
}

/**
 * Find contracts related to a token
 *
 * Uses Herd's code search to find contracts that reference this token address.
 * Results are cached for 1 hour.
 *
 * @param tokenAddress - The token address to find relationships for
 * @param chain - The chain to search on
 * @returns Array of related contracts
 */
export async function findRelatedContracts(
  tokenAddress: string,
  chain: string
): Promise<RelatedContract[]> {
  const cacheKey = tokenCacheKey(chain, tokenAddress);

  // Check cache first
  const cached = discoveryCache.get(cacheKey);
  if (cached) {
    return cached as RelatedContract[];
  }

  const related: RelatedContract[] = [];

  try {
    const registry = getProviderRegistry();

    // Validate chain is supported
    if (!isSupportedChain(chain)) {
      return [];
    }
    const supportedChain = chain as SupportedChain;

    // Check if we have code search capability
    if (!registry.hasCapability('CodeSearch', supportedChain)) {
      // No Herd available, return empty
      return [];
    }

    // Strategy: Code reference search via Herd
    // Find contracts that mention this token address in their source code
    const searchResult = await registry.searchCode({
      query: tokenAddress,
      chain: supportedChain,
    });

    if (searchResult.success && searchResult.data) {
      // Process search results
      for (const result of searchResult.data) {
        // Each result might have multiple matches within the same contract
        const matches = result.matches || [];

        // Use best match from this contract (limit snippets analyzed)
        for (const match of matches.slice(0, 3)) {
          // Try to determine the relationship from code context
          // Guard against undefined snippet
          const relationship = inferRelationship(match.snippet || '', match.functionName);

          related.push({
            address: result.contractAddress,  // From parent result, not match
            name: result.contractName,        // From parent result, not match
            relationship,
            relevance: determineRelevance(relationship),
          });
        }
      }

      // Deduplicate by address (skip entries without valid address)
      const seen = new Set<string>();
      const deduped = related.filter(r => {
        // Guard against undefined/null address
        if (!r.address || typeof r.address !== 'string') return false;
        const key = r.address.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Sort by relevance
      deduped.sort((a, b) => {
        const order = { high: 0, medium: 1, low: 2 };
        return order[a.relevance] - order[b.relevance];
      });

      // Limit to top 10
      const final = deduped.slice(0, 10);

      // Cache the result
      discoveryCache.set(cacheKey, final);

      return final;
    }
  } catch (error) {
    // Non-fatal - discovery is best-effort
    console.error('Discovery error:', error);
  }

  return [];
}

/**
 * Infer the relationship type from code context
 */
function inferRelationship(snippet: string, functionName?: string): string {
  const lower = snippet.toLowerCase();

  // Check for staking patterns
  if (lower.includes('stake') || lower.includes('staking')) {
    return 'staking contract for this token';
  }

  // Check for reward patterns
  if (lower.includes('reward') || lower.includes('earned')) {
    return 'rewards/incentives contract';
  }

  // Check for governance patterns
  if (lower.includes('governor') || lower.includes('voting') || lower.includes('proposal')) {
    return 'governance contract';
  }

  // Check for vault/yield patterns
  if (lower.includes('vault') || lower.includes('deposit') || lower.includes('yield')) {
    return 'vault/yield contract';
  }

  // Check for pool/LP patterns
  if (lower.includes('pool') || lower.includes('liquidity') || lower.includes('pair')) {
    return 'liquidity pool contract';
  }

  // Check for bridge patterns
  if (lower.includes('bridge') || lower.includes('gateway')) {
    return 'bridge contract';
  }

  // Function name hints
  if (functionName) {
    const fnLower = functionName.toLowerCase();
    if (fnLower.includes('stake')) return 'staking contract';
    if (fnLower.includes('claim')) return 'rewards contract';
    if (fnLower.includes('deposit')) return 'deposit contract';
  }

  // Default
  return 'references this token';
}

/**
 * Determine relevance based on relationship type
 */
function determineRelevance(relationship: string): 'high' | 'medium' | 'low' {
  const lower = relationship.toLowerCase();

  // High relevance: direct interaction opportunities
  if (lower.includes('staking') || lower.includes('reward') || lower.includes('governance')) {
    return 'high';
  }

  // Medium relevance: useful context
  if (lower.includes('vault') || lower.includes('pool') || lower.includes('liquidity')) {
    return 'medium';
  }

  // Low relevance: just a reference
  return 'low';
}
