/**
 * Quote Cache Module
 *
 * Caches swap quotes with TTL to enable route locking between quote and execute.
 * Includes security features:
 * - Wallet binding: quotes can only be executed by the wallet that requested them
 * - Consumed flag: prevents double-execution of the same quote
 * - Herd check caching: stores safety info with the quote
 */

import type { SwapQuote } from '../para/swap.js';
import type { SupportedChain } from '../config/chains.js';

/**
 * Herd safety check result cached with quote
 */
export interface HerdCheckResult {
  routerRisk: 'low' | 'medium' | 'high';
  verified: boolean;
  checkedAt: number;
}

/**
 * Cached quote with security bindings
 */
interface CachedQuote {
  quote: SwapQuote;
  expiresAt: number;
  chain: SupportedChain;
  walletAddress: string; // Bind to wallet - reject if different wallet tries to execute
  consumed: boolean; // Prevent double-execution
  herdCheck?: HerdCheckResult; // Cache Herd result with quote
}

/**
 * In-memory quote cache
 */
const quoteCache = new Map<string, CachedQuote>();

/**
 * Default TTL for quotes (60 seconds)
 */
const QUOTE_TTL_MS = 60_000;

/**
 * Cache a swap quote and return its ID
 *
 * @param quote - The swap quote from Li.Fi
 * @param chain - The blockchain chain
 * @param walletAddress - The wallet that requested the quote (for binding)
 * @param herdCheck - Optional Herd safety check result
 * @returns The quote ID for later retrieval
 */
export function cacheQuote(
  quote: SwapQuote,
  chain: SupportedChain,
  walletAddress: string,
  herdCheck?: HerdCheckResult
): string {
  // Generate unique quote ID
  const quoteId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  quoteCache.set(quoteId, {
    quote,
    expiresAt: Date.now() + QUOTE_TTL_MS,
    chain,
    walletAddress: walletAddress.toLowerCase(),
    consumed: false,
    herdCheck,
  });

  // Clean up old quotes opportunistically
  if (quoteCache.size > 100) {
    cleanExpiredQuotes();
  }

  return quoteId;
}

/**
 * Result type for getCachedQuote
 */
export type GetCachedQuoteResult =
  | { quote: SwapQuote; chain: SupportedChain; herdCheck?: HerdCheckResult }
  | { error: string };

/**
 * Retrieve a cached quote with security validation
 *
 * @param quoteId - The quote ID from cacheQuote
 * @param walletAddress - The wallet attempting to execute (must match original)
 * @returns The cached quote or an error
 */
export function getCachedQuote(quoteId: string, walletAddress: string): GetCachedQuoteResult {
  const cached = quoteCache.get(quoteId);

  if (!cached) {
    return { error: 'Quote not found' };
  }

  if (Date.now() > cached.expiresAt) {
    quoteCache.delete(quoteId);
    return { error: 'Quote expired. Please request a new quote.' };
  }

  if (cached.walletAddress !== walletAddress.toLowerCase()) {
    return { error: 'Quote was created for a different wallet' };
  }

  if (cached.consumed) {
    return { error: 'Quote already used. Please request a new quote.' };
  }

  return { quote: cached.quote, chain: cached.chain, herdCheck: cached.herdCheck };
}

/**
 * Mark a quote as consumed (prevents re-execution)
 *
 * Call this BEFORE sending any transactions to prevent race conditions.
 *
 * @param quoteId - The quote ID to mark as consumed
 */
export function markQuoteConsumed(quoteId: string): void {
  const cached = quoteCache.get(quoteId);
  if (cached) {
    cached.consumed = true;
  }
}

/**
 * Clean up expired quotes from cache
 *
 * Called automatically when cache grows large, but can be called manually.
 */
export function cleanExpiredQuotes(): void {
  const now = Date.now();
  for (const [id, cached] of quoteCache) {
    if (now > cached.expiresAt) {
      quoteCache.delete(id);
    }
  }
}

/**
 * Get cache statistics (for debugging)
 */
export function getQuoteCacheStats(): { size: number; oldestAge: number | null } {
  const now = Date.now();
  let oldestAge: number | null = null;

  for (const cached of quoteCache.values()) {
    const age = now - (cached.expiresAt - QUOTE_TTL_MS);
    if (oldestAge === null || age > oldestAge) {
      oldestAge = age;
    }
  }

  return { size: quoteCache.size, oldestAge };
}
