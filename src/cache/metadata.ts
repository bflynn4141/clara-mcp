/**
 * Metadata Cache
 *
 * Caches large contract metadata responses to avoid repeated expensive Herd calls.
 * Uses a two-tier strategy:
 * 1. In-memory LRU cache for hot data (fast, limited size)
 * 2. File-based cache for persistence (survives restarts)
 *
 * Cache key format: `{chainId}:{address}:{blockTag}`
 * - blockTag is 'latest' or a specific block number
 * - For proxy contracts, the key includes the implementation address
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { gzipSync, gunzipSync } from 'zlib';
import type { ContractMetadata } from '../providers/types.js';

// ============================================================================
// Configuration
// ============================================================================

interface CacheConfig {
  /** Directory for file cache */
  cacheDir: string;
  /** Max entries in memory cache */
  maxMemoryEntries: number;
  /** TTL for price data (ms) - 1 hour */
  priceTtl: number;
  /** TTL for ABI/metadata (ms) - 24 hours */
  metadataTtl: number;
  /** Max file cache size in bytes - 100MB */
  maxFileCacheSize: number;
  /** Enable compression */
  enableCompression: boolean;
}

const DEFAULT_CONFIG: CacheConfig = {
  cacheDir: process.env.CLARA_CACHE_DIR || join(process.env.HOME || '/tmp', '.clara', 'cache', 'metadata'),
  maxMemoryEntries: parseInt(process.env.CLARA_CACHE_MAX_MEMORY || '100', 10),
  priceTtl: 60 * 60 * 1000,      // 1 hour
  metadataTtl: 24 * 60 * 60 * 1000,  // 24 hours
  maxFileCacheSize: 100 * 1024 * 1024,  // 100MB
  enableCompression: true,
};

let config: CacheConfig = DEFAULT_CONFIG;

// ============================================================================
// Types
// ============================================================================

interface CacheEntry {
  data: ContractMetadata;
  summary: ContractMetadataSummary;
  timestamp: number;
  size: number;
}

/**
 * Compact summary for quick access without loading full metadata
 */
export interface ContractMetadataSummary {
  address: string;
  chain: string;
  chainId: number;
  name: string;
  verified: boolean;
  /** Contract standards detected */
  standards: string[];
  /** Is this a proxy contract */
  isProxy: boolean;
  /** Implementation address (if proxy) */
  implementationAddress?: string;
  /** Token info (if token) */
  token?: {
    symbol: string;
    decimals?: number;
    priceUsd?: string;
  };
  /** Number of functions */
  functionCount: number;
  /** Number of events */
  eventCount: number;
  /** Top 5 most important functions */
  topFunctions: string[];
  /** Cached at timestamp */
  cachedAt: string;
  /** Reference ID for full data */
  ref: string;
}

// ============================================================================
// In-Memory LRU Cache
// ============================================================================

class LRUCache<K, V> {
  private cache: Map<K, V> = new Map();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    // Remove if exists (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // Evict oldest if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  keys(): IterableIterator<K> {
    return this.cache.keys();
  }
}

const memoryCache = new LRUCache<string, CacheEntry>(DEFAULT_CONFIG.maxMemoryEntries);

// ============================================================================
// Cache Key Generation
// ============================================================================

/**
 * Generate cache key for contract metadata
 * For proxy contracts, include implementation address to avoid serving stale ABIs after upgrades
 */
export function generateCacheKey(
  chainId: number,
  address: string,
  blockTag: string | number = 'latest',
  implementationAddress?: string
): string {
  const normalizedAddress = address.toLowerCase();
  const implSuffix = implementationAddress ? `:impl:${implementationAddress.toLowerCase()}` : '';
  return `${chainId}:${normalizedAddress}:${blockTag}${implSuffix}`;
}

/**
 * Generate file-safe hash from cache key
 */
function keyToFilename(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const parts = key.split(':');
  // Format: chainId_shortAddress_hash.json.gz
  return `${parts[0]}_${parts[1].slice(0, 10)}_${hash}.json${config.enableCompression ? '.gz' : ''}`;
}

// ============================================================================
// Summary Extraction
// ============================================================================

/**
 * Detect ERC standards from function signatures
 */
function detectStandards(metadata: ContractMetadata): string[] {
  const standards: string[] = [];
  const functionNames = new Set(metadata.functions.map(f => f.name));

  // ERC-20 detection
  const erc20Functions = ['transfer', 'approve', 'transferFrom', 'balanceOf', 'allowance'];
  if (erc20Functions.every(f => functionNames.has(f))) {
    standards.push('ERC-20');
  }

  // ERC-721 detection
  const erc721Functions = ['ownerOf', 'safeTransferFrom', 'setApprovalForAll', 'getApproved'];
  if (erc721Functions.every(f => functionNames.has(f))) {
    standards.push('ERC-721');
  }

  // ERC-1155 detection
  if (functionNames.has('balanceOfBatch') && functionNames.has('safeBatchTransferFrom')) {
    standards.push('ERC-1155');
  }

  // Proxy detection
  if (functionNames.has('upgradeTo') || functionNames.has('upgradeToAndCall')) {
    standards.push('UUPS');
  }

  // Ownable
  if (functionNames.has('owner') && functionNames.has('transferOwnership')) {
    standards.push('Ownable');
  }

  // Pausable
  if (functionNames.has('pause') && functionNames.has('unpause')) {
    standards.push('Pausable');
  }

  return standards;
}

/**
 * Get top functions (most likely to be user-facing)
 */
function getTopFunctions(metadata: ContractMetadata): string[] {
  // Priority order for common DeFi operations
  const priorityFunctions = [
    'swap', 'transfer', 'approve', 'mint', 'burn', 'deposit', 'withdraw',
    'stake', 'unstake', 'claim', 'borrow', 'repay', 'liquidate',
    'addLiquidity', 'removeLiquidity', 'exactInputSingle', 'exactOutputSingle',
  ];

  const found: string[] = [];
  const functionNames = metadata.functions.map(f => f.name);

  // First, add priority functions in order
  for (const priority of priorityFunctions) {
    if (functionNames.includes(priority) && found.length < 5) {
      found.push(priority);
    }
  }

  // Fill remaining with non-view functions
  if (found.length < 5) {
    for (const func of metadata.functions) {
      if (
        !found.includes(func.name) &&
        func.stateMutability !== 'view' &&
        func.stateMutability !== 'pure' &&
        !func.name.startsWith('_') &&
        found.length < 5
      ) {
        found.push(func.name);
      }
    }
  }

  return found;
}

/**
 * Extract compact summary from full metadata
 */
export function extractSummary(metadata: ContractMetadata, ref: string): ContractMetadataSummary {
  return {
    address: metadata.address,
    chain: metadata.chain,
    chainId: metadata.chainId,
    name: metadata.name,
    verified: metadata.verified,
    standards: detectStandards(metadata),
    isProxy: metadata.proxy?.isProxy || false,
    implementationAddress: metadata.proxy?.implementationAddress,
    token: metadata.token ? {
      symbol: metadata.token.symbol,
      decimals: metadata.token.decimals,
      priceUsd: metadata.token.priceUsd,
    } : undefined,
    functionCount: metadata.functions.length,
    eventCount: metadata.events.length,
    topFunctions: getTopFunctions(metadata),
    cachedAt: new Date().toISOString(),
    ref,
  };
}

// ============================================================================
// File Cache Operations
// ============================================================================

/**
 * Ensure cache directory exists
 */
function ensureCacheDir(): void {
  if (!existsSync(config.cacheDir)) {
    mkdirSync(config.cacheDir, { recursive: true });
  }
}

/**
 * Get total size of file cache
 */
function getFileCacheSize(): number {
  ensureCacheDir();
  let total = 0;
  try {
    const files = readdirSync(config.cacheDir);
    for (const file of files) {
      const stat = statSync(join(config.cacheDir, file));
      total += stat.size;
    }
  } catch {
    // Ignore errors
  }
  return total;
}

/**
 * Evict oldest files until under size limit
 */
function evictOldFiles(): void {
  ensureCacheDir();
  const currentSize = getFileCacheSize();
  if (currentSize <= config.maxFileCacheSize) return;

  try {
    const files = readdirSync(config.cacheDir)
      .map(file => ({
        name: file,
        path: join(config.cacheDir, file),
        stat: statSync(join(config.cacheDir, file)),
      }))
      .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs); // Oldest first

    let freedSize = 0;
    const targetFree = currentSize - config.maxFileCacheSize + (config.maxFileCacheSize * 0.1); // Free extra 10%

    for (const file of files) {
      if (freedSize >= targetFree) break;
      unlinkSync(file.path);
      freedSize += file.stat.size;
      console.log(`Cache evicted: ${file.name} (${file.stat.size} bytes)`);
    }
  } catch (error) {
    console.error('Error evicting cache files:', error);
  }
}

/**
 * Write entry to file cache
 */
function writeToFileCache(key: string, entry: CacheEntry): void {
  ensureCacheDir();
  evictOldFiles();

  const filename = keyToFilename(key);
  const filepath = join(config.cacheDir, filename);

  try {
    const json = JSON.stringify({
      key,
      ...entry,
    });

    const data = config.enableCompression
      ? gzipSync(Buffer.from(json, 'utf-8'))
      : Buffer.from(json, 'utf-8');

    writeFileSync(filepath, data);
  } catch (error) {
    console.error('Error writing to file cache:', error);
  }
}

/**
 * Read entry from file cache
 */
function readFromFileCache(key: string): CacheEntry | null {
  const filename = keyToFilename(key);
  const filepath = join(config.cacheDir, filename);

  if (!existsSync(filepath)) return null;

  try {
    const data = readFileSync(filepath);
    const json = config.enableCompression
      ? gunzipSync(data).toString('utf-8')
      : data.toString('utf-8');

    const parsed = JSON.parse(json);
    return {
      data: parsed.data,
      summary: parsed.summary,
      timestamp: parsed.timestamp,
      size: parsed.size,
    };
  } catch (error) {
    console.error('Error reading from file cache:', error);
    // Remove corrupted file
    try { unlinkSync(filepath); } catch { /* ignore */ }
    return null;
  }
}

// ============================================================================
// Cache API
// ============================================================================

/**
 * Initialize cache with custom config
 */
export function initCache(customConfig?: Partial<CacheConfig>): void {
  config = { ...DEFAULT_CONFIG, ...customConfig };
  ensureCacheDir();
  console.log(`✓ Metadata cache initialized at ${config.cacheDir}`);
}

/**
 * Get metadata from cache
 * Returns null if not cached or expired
 * @param implementationAddress - For proxy contracts, include impl address to avoid stale data
 */
export function getCachedMetadata(
  chainId: number,
  address: string,
  blockTag: string | number = 'latest',
  implementationAddress?: string
): { data: ContractMetadata; summary: ContractMetadataSummary; fromCache: 'memory' | 'file' } | null {
  const key = generateCacheKey(chainId, address, blockTag, implementationAddress);

  // Check memory cache first
  const memEntry = memoryCache.get(key);
  if (memEntry) {
    // Check TTL
    const age = Date.now() - memEntry.timestamp;
    if (age < config.metadataTtl) {
      return { data: memEntry.data, summary: memEntry.summary, fromCache: 'memory' };
    }
    // Expired, remove
    memoryCache.delete(key);
  }

  // Check file cache
  const fileEntry = readFromFileCache(key);
  if (fileEntry) {
    const age = Date.now() - fileEntry.timestamp;
    if (age < config.metadataTtl) {
      // Promote to memory cache
      memoryCache.set(key, fileEntry);
      return { data: fileEntry.data, summary: fileEntry.summary, fromCache: 'file' };
    }
    // Expired, file will be overwritten on next write
  }

  return null;
}

/**
 * Get just the summary (fast, doesn't load full data)
 * Note: Currently calls getCachedMetadata which loads full data - future optimization
 * could store summaries separately for faster access.
 */
export function getCachedSummary(
  chainId: number,
  address: string,
  blockTag: string | number = 'latest',
  implementationAddress?: string
): ContractMetadataSummary | null {
  const cached = getCachedMetadata(chainId, address, blockTag, implementationAddress);
  return cached?.summary || null;
}

/**
 * Store metadata in cache
 * @param implementationAddress - For proxy contracts, include impl address to avoid stale data
 */
export function cacheMetadata(
  chainId: number,
  address: string,
  metadata: ContractMetadata,
  blockTag: string | number = 'latest',
  implementationAddress?: string
): ContractMetadataSummary {
  const key = generateCacheKey(chainId, address, blockTag, implementationAddress);
  const ref = createHash('sha256').update(key + Date.now()).digest('hex').slice(0, 12);

  const summary = extractSummary(metadata, ref);
  const size = JSON.stringify(metadata).length;

  const entry: CacheEntry = {
    data: metadata,
    summary,
    timestamp: Date.now(),
    size,
  };

  // Store in memory
  memoryCache.set(key, entry);

  // Store in file cache (async-ish, fire and forget)
  setImmediate(() => writeToFileCache(key, entry));

  console.log(`Cached metadata for ${address} on chain ${chainId} (${(size / 1024).toFixed(1)}KB)`);

  return summary;
}

/**
 * Invalidate cache entry
 */
export function invalidateCache(
  chainId: number,
  address: string,
  blockTag: string | number = 'latest',
  implementationAddress?: string
): void {
  const key = generateCacheKey(chainId, address, blockTag, implementationAddress);
  memoryCache.delete(key);
  // File will be overwritten on next cache write
}

/**
 * Clear all cache
 */
export function clearCache(): void {
  memoryCache.clear();
  ensureCacheDir();
  try {
    const files = readdirSync(config.cacheDir);
    for (const file of files) {
      unlinkSync(join(config.cacheDir, file));
    }
  } catch (error) {
    console.error('Error clearing cache:', error);
  }
}

/**
 * Get cache statistics
 */
export function getCacheStats(): {
  memoryEntries: number;
  fileCacheSize: number;
  cacheDir: string;
} {
  return {
    memoryEntries: memoryCache.size(),
    fileCacheSize: getFileCacheSize(),
    cacheDir: config.cacheDir,
  };
}
