/**
 * Simple TTL Cache for Token Classifications
 *
 * Token types don't change frequently, so we cache aggressively.
 * Default TTL: 24 hours for classifications.
 *
 * Note: We use generic types here to avoid circular dependencies.
 * The actual cached types are:
 * - classificationCache: TokenAnalysis (from classifier.ts)
 * - discoveryCache: RelatedContract[] (from discovery.ts)
 * - opportunityCache: Opportunity[] (from opportunities.ts - Week 2)
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Simple in-memory TTL cache with max size limit
 */
export class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private defaultTtlMs: number;
  private maxSize: number;

  constructor(defaultTtlMs: number = 24 * 60 * 60 * 1000, maxSize: number = 1000) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxSize = maxSize;
  }

  /**
   * Get a value from cache
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value;
  }

  /**
   * Set a value in cache with optional custom TTL
   * Enforces max size limit with LRU-like eviction (oldest entries first)
   */
  set(key: string, value: T, ttlMs?: number): void {
    // Enforce max size - evict oldest entries if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      // Remove expired entries first
      this.cleanup();

      // If still at capacity, remove oldest entries (first inserted)
      if (this.cache.size >= this.maxSize) {
        const keysToDelete = Array.from(this.cache.keys()).slice(0, Math.ceil(this.maxSize * 0.1));
        for (const k of keysToDelete) {
          this.cache.delete(k);
        }
      }
    }

    const expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
    this.cache.set(key, { value, expiresAt });
  }

  /**
   * Check if a key exists and is not expired
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Delete a specific key
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Remove expired entries (call periodically if needed)
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Get cache stats
   */
  stats(): { size: number; oldestEntry: number | null } {
    let oldest: number | null = null;

    for (const entry of this.cache.values()) {
      if (oldest === null || entry.expiresAt < oldest) {
        oldest = entry.expiresAt;
      }
    }

    return {
      size: this.cache.size,
      oldestEntry: oldest,
    };
  }
}

/**
 * Generate cache key for token analysis
 */
export function tokenCacheKey(chain: string, address: string): string {
  return `${chain}:${address.toLowerCase()}`;
}

/**
 * Global cache instances
 */

// Token classification cache - 24 hour TTL
export const classificationCache = new TTLCache<any>(24 * 60 * 60 * 1000);

// Related contracts cache - 1 hour TTL (relationships can change)
export const discoveryCache = new TTLCache<any>(60 * 60 * 1000);

// Opportunity cache - 5 minute TTL (claimable amounts change)
export const opportunityCache = new TTLCache<any>(5 * 60 * 1000);
