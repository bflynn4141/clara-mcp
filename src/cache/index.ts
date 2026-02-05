/**
 * Cache Module
 *
 * Provides caching for expensive blockchain data operations.
 */

export {
  initCache,
  getCachedMetadata,
  getCachedSummary,
  cacheMetadata,
  invalidateCache,
  clearCache,
  getCacheStats,
  generateCacheKey,
  extractSummary,
  type ContractMetadataSummary,
} from './metadata.js';

export {
  cacheQuote,
  getCachedQuote,
  markQuoteConsumed,
  cleanExpiredQuotes,
  getQuoteCacheStats,
  type HerdCheckResult,
  type GetCachedQuoteResult,
} from './quotes.js';
