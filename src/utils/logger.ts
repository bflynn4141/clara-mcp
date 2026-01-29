/**
 * Structured Logging & Observability
 *
 * Provides:
 * - Fast JSON logging via pino
 * - Timing utilities for RPC calls
 * - In-memory error ring buffer for /status
 * - Metrics aggregation (counts, durations)
 *
 * Usage:
 *   import { logger, withTiming, getStats } from './utils/logger.js';
 *
 *   logger.info({ chain: 'base', method: 'getLogs' }, 'Scanning events');
 *
 *   const result = await withTiming('enrichToken', { tokenAddress }, async () => {
 *     return await enrichAuctionData(chain, token);
 *   });
 */

import pino from 'pino';

// ============================================================================
// Logger Configuration
// ============================================================================

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  // Pretty print in dev, JSON in production
  transport: isDev
    ? {
        target: 'pino/file',
        options: { destination: 1 }, // stdout
      }
    : undefined,
  base: {
    service: 'clara-mcp',
    version: '1.0.0',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// ============================================================================
// Timing Utilities
// ============================================================================

interface TimingContext {
  [key: string]: string | number | boolean | undefined;
}

interface TimingResult<T> {
  result: T;
  durationMs: number;
}

/**
 * Execute an async function with timing measurement and logging
 */
export async function withTiming<T>(
  operation: string,
  context: TimingContext,
  fn: () => Promise<T>
): Promise<TimingResult<T>> {
  const startTime = performance.now();

  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - startTime);

    logger.debug({ operation, ...context, durationMs, success: true }, `${operation} completed`);

    // Track metrics
    recordMetric(operation, durationMs, true);

    return { result, durationMs };
  } catch (error) {
    const durationMs = Math.round(performance.now() - startTime);

    logger.error(
      {
        operation,
        ...context,
        durationMs,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      `${operation} failed`
    );

    // Track metrics and errors
    recordMetric(operation, durationMs, false);
    recordError(operation, error);

    throw error;
  }
}

/**
 * Create a child logger with bound context
 */
export function createChildLogger(context: TimingContext) {
  return logger.child(context);
}

// ============================================================================
// Metrics Aggregation
// ============================================================================

interface OperationMetrics {
  count: number;
  successCount: number;
  errorCount: number;
  totalDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  lastDurationMs: number;
  lastUpdated: number;
}

const metrics = new Map<string, OperationMetrics>();

function recordMetric(operation: string, durationMs: number, success: boolean): void {
  const existing = metrics.get(operation);

  if (existing) {
    existing.count++;
    if (success) existing.successCount++;
    else existing.errorCount++;
    existing.totalDurationMs += durationMs;
    existing.minDurationMs = Math.min(existing.minDurationMs, durationMs);
    existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);
    existing.lastDurationMs = durationMs;
    existing.lastUpdated = Date.now();
  } else {
    metrics.set(operation, {
      count: 1,
      successCount: success ? 1 : 0,
      errorCount: success ? 0 : 1,
      totalDurationMs: durationMs,
      minDurationMs: durationMs,
      maxDurationMs: durationMs,
      lastDurationMs: durationMs,
      lastUpdated: Date.now(),
    });
  }
}

// ============================================================================
// Error Ring Buffer
// ============================================================================

interface ErrorEntry {
  operation: string;
  message: string;
  timestamp: number;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

const MAX_ERROR_ENTRIES = 100;
const errorBuffer: ErrorEntry[] = [];
const errorCounts = new Map<string, ErrorEntry>();

function recordError(operation: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${operation}:${message.slice(0, 100)}`; // Truncate for grouping
  const now = Date.now();

  const existing = errorCounts.get(key);

  if (existing) {
    existing.count++;
    existing.lastSeen = now;
  } else {
    const entry: ErrorEntry = {
      operation,
      message: message.slice(0, 500), // Truncate long messages
      timestamp: now,
      count: 1,
      firstSeen: now,
      lastSeen: now,
    };

    errorCounts.set(key, entry);
    errorBuffer.push(entry);

    // Trim buffer if too large
    if (errorBuffer.length > MAX_ERROR_ENTRIES) {
      const removed = errorBuffer.shift();
      if (removed) {
        errorCounts.delete(`${removed.operation}:${removed.message.slice(0, 100)}`);
      }
    }
  }
}

// ============================================================================
// Stats & Observability
// ============================================================================

export interface Stats {
  uptime: number;
  metrics: Record<
    string,
    {
      count: number;
      successRate: number;
      avgDurationMs: number;
      minDurationMs: number;
      maxDurationMs: number;
      lastDurationMs: number;
    }
  >;
  recentErrors: Array<{
    operation: string;
    message: string;
    count: number;
    lastSeen: string;
  }>;
  cache: {
    discoveryEntries: number;
    tokenInfoEntries: number;
  };
}

const startTime = Date.now();

// These will be set by the cache modules
let getDiscoveryCacheSize: () => number = () => 0;
let getTokenInfoCacheSize: () => number = () => 0;

export function registerCacheSizeProviders(
  discoveryFn: () => number,
  tokenInfoFn: () => number
): void {
  getDiscoveryCacheSize = discoveryFn;
  getTokenInfoCacheSize = tokenInfoFn;
}

/**
 * Get current stats for observability
 */
export function getStats(): Stats {
  const metricsOutput: Stats['metrics'] = {};

  for (const [operation, m] of metrics) {
    metricsOutput[operation] = {
      count: m.count,
      successRate: m.count > 0 ? Math.round((m.successCount / m.count) * 100) : 0,
      avgDurationMs: m.count > 0 ? Math.round(m.totalDurationMs / m.count) : 0,
      minDurationMs: m.minDurationMs,
      maxDurationMs: m.maxDurationMs,
      lastDurationMs: m.lastDurationMs,
    };
  }

  // Get recent errors (last 10)
  const recentErrors = errorBuffer
    .slice(-10)
    .reverse()
    .map((e) => ({
      operation: e.operation,
      message: e.message,
      count: e.count,
      lastSeen: new Date(e.lastSeen).toISOString(),
    }));

  return {
    uptime: Math.round((Date.now() - startTime) / 1000),
    metrics: metricsOutput,
    recentErrors,
    cache: {
      discoveryEntries: getDiscoveryCacheSize(),
      tokenInfoEntries: getTokenInfoCacheSize(),
    },
  };
}

/**
 * Reset all metrics (useful for testing)
 */
export function resetStats(): void {
  metrics.clear();
  errorBuffer.length = 0;
  errorCounts.clear();
}
