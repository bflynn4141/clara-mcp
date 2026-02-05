/**
 * Provider Registry
 *
 * Routes capability requests to the appropriate provider based on chain support.
 * Implements graceful degradation when primary providers are unavailable.
 *
 * Usage:
 *   const registry = ProviderRegistry.getInstance();
 *   const result = await registry.listHistory({ address, chain: 'base', limit: 10 });
 *
 * The registry automatically selects the best available provider for each request.
 */

import type { SupportedChain } from '../config/chains.js';
import type {
  ProviderCapability,
  ProviderResult,
  HistoryProvider,
  HistoryListParams,
  HistoryListResult,
  TxAnalysisProvider,
  TxAnalysisParams,
  TransactionAnalysis,
  ContractIntelProvider,
  ContractMetadataParams,
  ContractMetadata,
  TokenDiscoveryProvider,
  TokenDiscoveryResult,
} from './types.js';

// ============================================================================
// Chain Support Matrix
// ============================================================================

/**
 * Which chains each provider supports for each capability
 */
export interface ProviderChainSupport {
  provider: string;
  capability: ProviderCapability;
  chains: SupportedChain[];
  priority: number;  // Lower = higher priority
}

/**
 * Default chain support matrix
 * This is configured at startup and can be modified
 */
const DEFAULT_CHAIN_SUPPORT: ProviderChainSupport[] = [
  // Zerion - history listing across all chains
  { provider: 'zerion', capability: 'HistoryList', chains: ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'], priority: 1 },

  // RPC - fallback for basic operations
  { provider: 'rpc', capability: 'TxAnalysis', chains: ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'], priority: 10 },
  { provider: 'rpc', capability: 'ContractMetadata', chains: ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'], priority: 10 },
];

// ============================================================================
// Registry Implementation
// ============================================================================

export class ProviderRegistry {
  private static instance: ProviderRegistry | null = null;

  private historyProviders: Map<string, HistoryProvider> = new Map();
  private txAnalysisProviders: Map<string, TxAnalysisProvider> = new Map();
  private contractIntelProviders: Map<string, ContractIntelProvider> = new Map();
  private tokenDiscoveryProviders: Map<string, TokenDiscoveryProvider> = new Map();

  private chainSupport: ProviderChainSupport[] = [...DEFAULT_CHAIN_SUPPORT];

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): ProviderRegistry {
    if (!ProviderRegistry.instance) {
      ProviderRegistry.instance = new ProviderRegistry();
    }
    return ProviderRegistry.instance;
  }

  /**
   * Reset instance (for testing)
   */
  static resetInstance(): void {
    ProviderRegistry.instance = null;
  }

  // ==========================================================================
  // Provider Registration
  // ==========================================================================

  registerHistoryProvider(provider: HistoryProvider): void {
    this.historyProviders.set(provider.name, provider);
  }

  registerTxAnalysisProvider(provider: TxAnalysisProvider): void {
    this.txAnalysisProviders.set(provider.name, provider);
  }

  registerContractIntelProvider(provider: ContractIntelProvider): void {
    this.contractIntelProviders.set(provider.name, provider);
  }

  registerTokenDiscoveryProvider(provider: TokenDiscoveryProvider): void {
    this.tokenDiscoveryProviders.set(provider.name, provider);
  }

  /**
   * Update chain support matrix (e.g., when Herd is enabled)
   */
  updateChainSupport(support: ProviderChainSupport[]): void {
    this.chainSupport = support;
  }

  /**
   * Add chain support for a provider
   */
  addChainSupport(support: ProviderChainSupport): void {
    // Remove existing entry for same provider+capability
    this.chainSupport = this.chainSupport.filter(
      s => !(s.provider === support.provider && s.capability === support.capability)
    );
    this.chainSupport.push(support);
    // Sort by priority
    this.chainSupport.sort((a, b) => a.priority - b.priority);
  }

  // ==========================================================================
  // Provider Selection
  // ==========================================================================

  /**
   * Find the best provider for a capability and chain
   */
  private findProvider<T>(
    capability: ProviderCapability,
    chain: SupportedChain,
    providers: Map<string, T>
  ): { provider: T; name: string } | null {
    // Get all providers that support this capability on this chain, sorted by priority
    const supportEntries = this.chainSupport
      .filter(s => s.capability === capability && s.chains.includes(chain))
      .sort((a, b) => a.priority - b.priority);

    for (const entry of supportEntries) {
      const provider = providers.get(entry.provider);
      if (provider) {
        return { provider, name: entry.provider };
      }
    }

    return null;
  }

  /**
   * Check if a capability is available for a chain
   */
  hasCapability(capability: ProviderCapability, chain: SupportedChain): boolean {
    const providers = this.getProviderMapForCapability(capability);
    return this.findProvider(capability, chain, providers) !== null;
  }

  /**
   * Get the provider map for a capability
   */
  private getProviderMapForCapability(capability: ProviderCapability): Map<string, unknown> {
    switch (capability) {
      case 'HistoryList':
        return this.historyProviders;
      case 'TxAnalysis':
        return this.txAnalysisProviders;
      case 'ContractMetadata':
        return this.contractIntelProviders;
      case 'TokenDiscovery':
        return this.tokenDiscoveryProviders;
      default:
        return new Map();
    }
  }

  /**
   * Get supported chains for a capability
   */
  getSupportedChains(capability: ProviderCapability): SupportedChain[] {
    const chains = new Set<SupportedChain>();
    const providers = this.getProviderMapForCapability(capability);

    for (const entry of this.chainSupport) {
      if (entry.capability === capability && providers.has(entry.provider)) {
        for (const chain of entry.chains) {
          chains.add(chain);
        }
      }
    }

    return Array.from(chains);
  }

  // ==========================================================================
  // Capability Methods
  // ==========================================================================

  /**
   * List transaction history
   */
  async listHistory(params: HistoryListParams): Promise<ProviderResult<HistoryListResult>> {
    // Handle 'all' chain - aggregate from all supported chains
    if (params.chain === 'all') {
      return this.listHistoryAllChains(params);
    }

    const found = this.findProvider<HistoryProvider>('HistoryList', params.chain, this.historyProviders);

    if (!found) {
      const supportedChains = this.getSupportedChains('HistoryList');
      return {
        success: false,
        error: `Transaction history not available for ${params.chain}. Supported chains: ${supportedChains.join(', ')}`,
        provider: 'none',
        level: 'unavailable',
      };
    }

    return found.provider.listTransactions(params);
  }

  /**
   * List history across all supported chains
   */
  private async listHistoryAllChains(params: HistoryListParams): Promise<ProviderResult<HistoryListResult>> {
    const chains = this.getSupportedChains('HistoryList');
    const perChainLimit = Math.ceil((params.limit || 10) / chains.length);

    const results = await Promise.all(
      chains.map(chain =>
        this.listHistory({ ...params, chain, limit: perChainLimit })
      )
    );

    // Aggregate and sort by timestamp
    const allTransactions = results
      .filter(r => r.success && r.data)
      .flatMap(r => r.data!.transactions)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, params.limit || 10);

    const successCount = results.filter(r => r.success).length;

    return {
      success: successCount > 0,
      data: {
        transactions: allTransactions,
        hasMore: results.some(r => r.data?.hasMore),
      },
      provider: 'aggregated',
      level: successCount === chains.length ? 'full' : 'basic',
    };
  }

  /**
   * Analyze a transaction
   */
  async analyzeTransaction(params: TxAnalysisParams): Promise<ProviderResult<TransactionAnalysis>> {
    const chain = params.chain || 'ethereum';  // Default to ethereum if not specified

    const found = this.findProvider<TxAnalysisProvider>('TxAnalysis', chain, this.txAnalysisProviders);

    if (!found) {
      const supportedChains = this.getSupportedChains('TxAnalysis');
      return {
        success: false,
        error: `Transaction analysis not available for ${chain}. Supported chains: ${supportedChains.join(', ')}`,
        provider: 'none',
        level: 'unavailable',
      };
    }

    return found.provider.analyzeTransaction(params);
  }

  /**
   * Get contract metadata
   */
  async getContractMetadata(params: ContractMetadataParams): Promise<ProviderResult<ContractMetadata>> {
    const found = this.findProvider<ContractIntelProvider>('ContractMetadata', params.chain, this.contractIntelProviders);

    if (!found) {
      const supportedChains = this.getSupportedChains('ContractMetadata');
      return {
        success: false,
        error: `Contract analysis not available for ${params.chain}. Supported chains: ${supportedChains.join(', ')}`,
        provider: 'none',
        level: 'unavailable',
      };
    }

    return found.provider.getMetadata(params);
  }

  /**
   * Discover all tokens held by an address
   */
  async discoverTokens(
    address: string,
    chain: SupportedChain
  ): Promise<ProviderResult<TokenDiscoveryResult>> {
    const found = this.findProvider<TokenDiscoveryProvider>('TokenDiscovery', chain, this.tokenDiscoveryProviders);

    if (!found) {
      return {
        success: false,
        error: `Token discovery not available for ${chain}`,
        provider: 'none',
        level: 'unavailable',
      };
    }

    return found.provider.discoverTokens(address, chain);
  }

  // ==========================================================================
  // Diagnostics
  // ==========================================================================

  /**
   * Get current provider status for debugging
   */
  getStatus(): {
    providers: {
      history: string[];
      txAnalysis: string[];
      contractIntel: string[];
      tokenDiscovery: string[];
    };
    chainSupport: ProviderChainSupport[];
  } {
    return {
      providers: {
        history: Array.from(this.historyProviders.keys()),
        txAnalysis: Array.from(this.txAnalysisProviders.keys()),
        contractIntel: Array.from(this.contractIntelProviders.keys()),
        tokenDiscovery: Array.from(this.tokenDiscoveryProviders.keys()),
      },
      chainSupport: this.chainSupport,
    };
  }
}

// Export singleton getter for convenience
export const getProviderRegistry = (): ProviderRegistry => ProviderRegistry.getInstance();
