/**
 * Provider System Entry Point
 *
 * Initializes and registers all blockchain data providers.
 * Import this module to set up the provider system.
 *
 * Usage:
 *   import { initProviders, getProviderRegistry } from './providers/index.js';
 *
 *   // During startup
 *   await initProviders();
 *
 *   // In tools
 *   const registry = getProviderRegistry();
 *   const result = await registry.listHistory({ address, chain: 'base' });
 */

export * from './types.js';
export * from './registry.js';

import { ProviderRegistry, getProviderRegistry } from './registry.js';
import { zerionProvider } from './zerion.js';
import { initCache, getCacheStats } from '../cache/index.js';
import {
  initHerd,
  shutdownHerd,
  isHerdEnabled,
  isHerdSupportedChain,
  herdTxAnalysisProvider,
  herdContractIntelProvider,
  herdEventMonitorProvider,
  herdResearchProvider,
  herdTokenDiscoveryProvider,
} from './herd.js';

// ============================================================================
// Initialization
// ============================================================================

let initialized = false;

/**
 * Initialize all providers and register with the registry
 */
export async function initProviders(): Promise<void> {
  if (initialized) {
    console.error('Providers already initialized');
    return;
  }

  // -------------------------------------------------------------------------
  // Initialize Cache
  // -------------------------------------------------------------------------
  initCache();

  const registry = getProviderRegistry();

  // -------------------------------------------------------------------------
  // Register Zerion (History)
  // -------------------------------------------------------------------------
  registry.registerHistoryProvider(zerionProvider);
  console.error('✓ Zerion history provider registered');

  // -------------------------------------------------------------------------
  // Register Herd (Analysis, Intel, Events, Research)
  // -------------------------------------------------------------------------
  const herdReady = await initHerd();

  if (herdReady) {
    // Register Herd providers
    registry.registerTxAnalysisProvider(herdTxAnalysisProvider);
    registry.registerContractIntelProvider(herdContractIntelProvider);
    registry.registerEventMonitorProvider(herdEventMonitorProvider);
    registry.registerResearchProvider(herdResearchProvider);
    registry.registerTokenDiscoveryProvider(herdTokenDiscoveryProvider);

    // Update chain support matrix to prefer Herd for supported chains
    registry.addChainSupport({
      provider: 'herd',
      capability: 'TxAnalysis',
      chains: ['ethereum', 'base'],
      priority: 1,
    });
    registry.addChainSupport({
      provider: 'herd',
      capability: 'ContractMetadata',
      chains: ['ethereum', 'base'],
      priority: 1,
    });
    registry.addChainSupport({
      provider: 'herd',
      capability: 'CodeSearch',
      chains: ['ethereum', 'base'],
      priority: 1,
    });
    registry.addChainSupport({
      provider: 'herd',
      capability: 'ContractDiff',
      chains: ['ethereum', 'base'],
      priority: 1,
    });
    registry.addChainSupport({
      provider: 'herd',
      capability: 'EventMonitor',
      chains: ['ethereum', 'base'],
      priority: 1,
    });
    registry.addChainSupport({
      provider: 'herd',
      capability: 'Research',
      chains: ['ethereum', 'base'],
      priority: 1,
    });
    registry.addChainSupport({
      provider: 'herd',
      capability: 'TokenDiscovery',
      chains: ['ethereum', 'base'],
      priority: 1,
    });

    console.error('✓ Herd providers registered (ethereum, base)');
  } else {
    console.error('⚠ Herd not available - using fallbacks only');
  }

  // -------------------------------------------------------------------------
  // Log Provider Status
  // -------------------------------------------------------------------------
  const status = registry.getStatus();
  console.error('Provider status:', JSON.stringify(status.providers, null, 2));

  initialized = true;
}

/**
 * Shutdown all providers
 */
export async function shutdownProviders(): Promise<void> {
  await shutdownHerd();
  ProviderRegistry.resetInstance();
  initialized = false;
  console.error('Providers shutdown');
}

/**
 * Check if providers are initialized
 */
export function isProvidersInitialized(): boolean {
  return initialized;
}

/**
 * Wait for providers to initialize (with timeout)
 *
 * Use this in tools that need providers but might be called
 * immediately after server startup (before initProviders completes).
 *
 * @param timeoutMs - Maximum time to wait (default: 3000ms)
 * @returns true if initialized, false if timeout reached
 */
export async function waitForProviders(timeoutMs = 3000): Promise<boolean> {
  if (initialized) return true;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (initialized) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return initialized;
}

// ============================================================================
// Convenience Exports
// ============================================================================

// Re-export for easy access
export { getProviderRegistry };

// Re-export provider instances for testing
export { zerionProvider } from './zerion.js';
export {
  initHerd,
  shutdownHerd,
  isHerdEnabled,
  isHerdSupportedChain,
  herdTxAnalysisProvider,
  herdContractIntelProvider,
  herdEventMonitorProvider,
  herdResearchProvider,
  herdTokenDiscoveryProvider,
} from './herd.js';

// Re-export cache utilities
export {
  initCache,
  getCachedMetadata,
  getCachedSummary,
  cacheMetadata,
  invalidateCache,
  clearCache,
  getCacheStats,
  type ContractMetadataSummary,
} from '../cache/index.js';
