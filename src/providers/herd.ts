/**
 * Herd MCP Provider
 *
 * Implements all provider interfaces using Herd MCP tools.
 * Herd provides deep blockchain intelligence: contract analysis, tx decoding,
 * event monitoring, code search, and AI-powered research.
 *
 * Herd MCP Tools:
 * - contractMetadataTool: Full ABI, functions, events, pricing, proxy history
 * - queryTransactionTool: Deep tx analysis with traces, balance changes, decoded logs
 * - getLatestTransactionsTool: Recent txs for specific function/event signature
 * - regexCodeAnalysisTool: Search contract source with natural language
 * - diffContractVersions: Compare proxy implementations
 * - researchTool: AI-powered blockchain research with citations
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { SupportedChain } from '../config/chains.js';
import {
  getCachedMetadata,
  cacheMetadata,
  type ContractMetadataSummary,
} from '../cache/index.js';
import {
  sanitizeContractMetadata,
  sanitizeTransactionAnalysis,
  sanitizeContractName,
  sanitizeFunctionName,
  sanitizeDescription,
  warnIfSuspicious,
} from '../utils/sanitize.js';
import type {
  // History
  HistoryProvider,
  HistoryListParams,
  HistoryListResult,
  // Tx Analysis
  TxAnalysisProvider,
  TxAnalysisParams,
  TransactionAnalysis,
  DecodedCall,
  DecodedEvent,
  BalanceChange,
  // Contract Intel
  ContractIntelProvider,
  ContractMetadataParams,
  ContractMetadata,
  FunctionInfo,
  EventInfo,
  CodeSearchParams,
  CodeSearchResult,
  ContractDiffParams,
  ContractDiff,
  // Event Monitor
  EventMonitorProvider,
  EventMonitorParams,
  EventOccurrence,
  // Research
  ResearchProvider,
  ResearchParams,
  ResearchResult,
  // Common
  ProviderResult,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Chains supported by Herd
 */
const HERD_SUPPORTED_CHAINS: SupportedChain[] = ['ethereum', 'base'];

/**
 * Chain ID mapping
 */
const CHAIN_IDS: Record<SupportedChain, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
};

/**
 * Explorer URLs
 */
const EXPLORER_URLS: Record<SupportedChain, string> = {
  ethereum: 'https://etherscan.io',
  base: 'https://basescan.org',
  arbitrum: 'https://arbiscan.io',
  optimism: 'https://optimistic.etherscan.io',
  polygon: 'https://polygonscan.com',
};

/**
 * Configuration options
 */
interface HerdConfig {
  /** Transport mode: 'stdio' for local process, 'http' for remote API */
  transportMode: 'stdio' | 'http';
  /** Command to start Herd MCP (default: 'npx') - only for stdio mode */
  command: string;
  /** Arguments for the command (default: ['herd-mcp']) - only for stdio mode */
  args: string[];
  /** HTTP API URL - only for http mode */
  apiUrl?: string;
  /** HTTP API Key - only for http mode */
  apiKey?: string;
  /** Request timeout in ms (default: 30000) */
  timeout: number;
  /** Max retry attempts (default: 3) */
  maxRetries: number;
  /** Payload size warning threshold (default: 100KB) */
  warnPayloadSize: number;
  /** Payload size truncate threshold (default: 500KB) */
  maxPayloadSize: number;
  /** Connection timeout in ms (default: 60000) */
  connectTimeout: number;
  /** Health check interval in ms (default: 30000) */
  healthCheckInterval: number;
}

/**
 * Default configuration for Herd MCP
 *
 * Supports two modes:
 *
 * 1. HTTP Mode (recommended) - Uses hosted Herd API:
 *    HERD_ENABLED=true
 *    HERD_API_URL=https://api.herd.eco/v1/mcp
 *    HERD_API_KEY=your_api_key
 *
 * 2. Stdio Mode - Runs local Herd MCP process:
 *    HERD_ENABLED=true
 *    HERD_MCP_COMMAND=npx
 *    HERD_MCP_ARGS="-y @anthropic/herd"
 *
 * HTTP mode is used automatically if HERD_API_URL is set.
 */
const DEFAULT_CONFIG: HerdConfig = {
  // Auto-detect mode: use HTTP if URL is provided, otherwise stdio
  transportMode: process.env.HERD_API_URL ? 'http' : 'stdio',
  // Stdio mode config
  command: process.env.HERD_MCP_COMMAND || 'npx',
  args: process.env.HERD_MCP_ARGS?.split(' ') || ['-y', '@anthropic/herd'],
  // HTTP mode config
  apiUrl: process.env.HERD_API_URL,
  apiKey: process.env.HERD_API_KEY,
  // Common config
  timeout: parseInt(process.env.HERD_TIMEOUT || '30000', 10),
  maxRetries: parseInt(process.env.HERD_MAX_RETRIES || '3', 10),
  warnPayloadSize: 100 * 1024,  // 100KB
  maxPayloadSize: 500 * 1024,   // 500KB
  connectTimeout: parseInt(process.env.HERD_CONNECT_TIMEOUT || '60000', 10),
  healthCheckInterval: parseInt(process.env.HERD_HEALTH_INTERVAL || '30000', 10),
};

// ============================================================================
// Herd MCP Client
// ============================================================================

let herdClient: Client | null = null;
let herdConfig: HerdConfig = DEFAULT_CONFIG;
let herdConnected: boolean = false;
let lastHealthCheck: number = 0;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures: number = 0;
const MAX_CONSECUTIVE_FAILURES = 3;

// Concurrency control - prevent multiple simultaneous stdio calls from interleaving
const MAX_CONCURRENT_CALLS = 1; // stdio is serial, so we queue calls
let activeCallCount = 0;
const callQueue: Array<{
  resolve: () => void;
  reject: (error: Error) => void;
}> = [];

/**
 * Acquire a slot to make a Herd call (simple semaphore)
 */
async function acquireCallSlot(): Promise<void> {
  if (activeCallCount < MAX_CONCURRENT_CALLS) {
    activeCallCount++;
    return;
  }

  // Wait in queue
  return new Promise((resolve, reject) => {
    callQueue.push({ resolve, reject });
  });
}

/**
 * Release a call slot
 */
function releaseCallSlot(): void {
  activeCallCount--;

  // Wake up next waiting caller
  if (callQueue.length > 0 && activeCallCount < MAX_CONCURRENT_CALLS) {
    const next = callQueue.shift();
    if (next) {
      activeCallCount++;
      next.resolve();
    }
  }
}

/**
 * Check if Herd is enabled and connected
 */
export function isHerdEnabled(): boolean {
  return process.env.HERD_ENABLED === 'true' && herdClient !== null && herdConnected;
}

/**
 * Check if a chain is supported by Herd
 */
export function isHerdSupportedChain(chain: SupportedChain): boolean {
  return HERD_SUPPORTED_CHAINS.includes(chain);
}

/**
 * Perform health check by listing tools
 */
async function performHealthCheck(): Promise<boolean> {
  if (!herdClient) return false;

  try {
    // Use a simple tools list as health check
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Health check timeout')), 5000);
    });

    await Promise.race([
      herdClient.listTools(),
      timeoutPromise,
    ]);

    consecutiveFailures = 0;
    lastHealthCheck = Date.now();
    return true;
  } catch (error) {
    consecutiveFailures++;
    console.warn(`Herd health check failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, error);

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error('Herd connection appears dead, marking as disconnected');
      herdConnected = false;
    }

    return false;
  }
}

/**
 * Start periodic health checks
 */
function startHealthChecks(): void {
  if (healthCheckTimer) return;

  healthCheckTimer = setInterval(async () => {
    if (herdConnected) {
      await performHealthCheck();
    }
  }, herdConfig.healthCheckInterval);

  // Don't prevent process exit
  healthCheckTimer.unref?.();
}

/**
 * Initialize Herd MCP client
 */
export async function initHerd(config?: Partial<HerdConfig>): Promise<boolean> {
  if (process.env.HERD_ENABLED !== 'true') {
    console.error('Herd provider disabled (HERD_ENABLED != true)');
    return false;
  }

  herdConfig = { ...DEFAULT_CONFIG, ...config };

  try {
    // Create transport based on mode
    let transport: StdioClientTransport | StreamableHTTPClientTransport;

    if (herdConfig.transportMode === 'http') {
      if (!herdConfig.apiUrl) {
        throw new Error('HERD_API_URL is required for HTTP mode');
      }

      console.error(`Connecting to Herd API: ${herdConfig.apiUrl}`);

      transport = new StreamableHTTPClientTransport(
        new URL(herdConfig.apiUrl),
        {
          requestInit: herdConfig.apiKey ? {
            headers: {
              'Authorization': `Bearer ${herdConfig.apiKey}`,
            },
          } : undefined,
        }
      );
    } else {
      console.error(`Starting Herd MCP: ${herdConfig.command} ${herdConfig.args.join(' ')}`);

      transport = new StdioClientTransport({
        command: herdConfig.command,
        args: herdConfig.args,
      });
    }

    herdClient = new Client({
      name: 'clara-herd-client',
      version: '1.0.0',
    });

    // Connect with timeout
    const connectPromise = herdClient.connect(transport);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Connection timeout after ${herdConfig.connectTimeout}ms`)), herdConfig.connectTimeout);
    });

    await Promise.race([connectPromise, timeoutPromise]);

    // Verify connection with health check
    const healthy = await performHealthCheck();
    if (!healthy) {
      throw new Error('Initial health check failed');
    }

    herdConnected = true;
    consecutiveFailures = 0;

    // Start periodic health checks
    startHealthChecks();

    console.error(`✓ Herd MCP client connected via ${herdConfig.transportMode.toUpperCase()}`);
    return true;
  } catch (error) {
    console.error('Failed to connect to Herd MCP:', error);
    herdClient = null;
    herdConnected = false;
    return false;
  }
}

/**
 * Shutdown Herd MCP client
 */
export async function shutdownHerd(): Promise<void> {
  // Stop health checks
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }

  if (herdClient) {
    try {
      await herdClient.close();
    } catch (error) {
      console.error('Error closing Herd client:', error);
    }
    herdClient = null;
  }

  herdConnected = false;
  consecutiveFailures = 0;
}

// ============================================================================
// Low-Level Tool Calls with Retry & Error Handling
// ============================================================================

/**
 * Sleep utility for retry backoff
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if error is retryable (connection issues vs bad requests)
 */
function isRetryableError(error: string): boolean {
  const retryablePatterns = [
    'timeout',
    'EPIPE',
    'ECONNRESET',
    'client closed',
    'connection',
    'socket',
  ];
  const lowerError = error.toLowerCase();
  return retryablePatterns.some(p => lowerError.includes(p));
}

/**
 * Call a Herd tool with timeout, retries, and error handling
 */
async function callHerdTool<T>(
  toolName: string,
  args: Record<string, unknown>
): Promise<{ success: boolean; data?: T; error?: string }> {
  if (!herdClient || !herdConnected) {
    return { success: false, error: 'Herd client not connected' };
  }

  // Acquire semaphore slot to prevent concurrent stdio interleaving
  await acquireCallSlot();

  let lastError: string = 'Unknown error';

  try {
    for (let attempt = 1; attempt <= herdConfig.maxRetries; attempt++) {
      try {
        // Create timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Request timeout')), herdConfig.timeout);
        });

        // Make the tool call with timeout
        const rawResult = await Promise.race([
          herdClient.callTool({ name: toolName, arguments: args }),
          timeoutPromise,
        ]);

        // Type the result properly
        const result = rawResult as {
          isError?: boolean;
          content?: Array<{ type: string; text?: string }>;
        };

        // Check for tool-level errors
        if (result.isError) {
          const errorContent = result.content?.[0];
          if (errorContent && typeof errorContent.text === 'string') {
            lastError = errorContent.text;
          }
          throw new Error(lastError);
        }

        // Extract text content
        const content = result.content?.[0];
        if (!content || typeof content.text !== 'string') {
          return { success: false, error: 'Empty response from Herd' };
        }

        const text = content.text;

        // Check payload size
        if (text.length > herdConfig.maxPayloadSize) {
          console.warn(`Herd response truncated: ${text.length} bytes > ${herdConfig.maxPayloadSize}`);
          // For very large payloads, we'd need to handle differently
          // For now, try to parse what we have
        } else if (text.length > herdConfig.warnPayloadSize) {
          console.warn(`Large Herd response: ${text.length} bytes`);
        }

        // Parse JSON response
        try {
          const data = JSON.parse(text) as T;
          // Success - reset failure counter
          consecutiveFailures = 0;
          return { success: true, data };
        } catch {
          // Some tools might return plain text
          consecutiveFailures = 0;
          return { success: true, data: text as unknown as T };
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error';
        console.warn(`Herd tool ${toolName} attempt ${attempt} failed:`, lastError);

        // Check if this is a retryable error
        if (!isRetryableError(lastError)) {
          // Non-retryable error (bad request, schema error) - don't retry
          return { success: false, error: lastError };
        }

        // Track connection failures
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error('Too many consecutive Herd failures, marking as disconnected');
          herdConnected = false;
          return { success: false, error: `Herd connection lost: ${lastError}` };
        }

        if (attempt < herdConfig.maxRetries) {
          // Exponential backoff: 1s, 2s, 4s
          await sleep(1000 * Math.pow(2, attempt - 1));
        }
      }
    }

    return { success: false, error: `Herd tool ${toolName} failed after ${herdConfig.maxRetries} attempts: ${lastError}` };
  } finally {
    // Always release the semaphore slot
    releaseCallSlot();
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function herdDisabled<T>(): ProviderResult<T> {
  return {
    success: false,
    error: 'Herd provider not enabled. Set HERD_ENABLED=true to enable.',
    provider: 'herd',
    level: 'unavailable',
  };
}

function unsupportedChain<T>(chain: SupportedChain): ProviderResult<T> {
  return {
    success: false,
    error: `Chain ${chain} not supported by Herd. Supported: ${HERD_SUPPORTED_CHAINS.join(', ')}`,
    provider: 'herd',
    level: 'unavailable',
  };
}

// ============================================================================
// Herd Response Types (from MCP tools)
// ============================================================================

interface HerdContractMetadata {
  addressDetails?: {
    address: string;
    deploymentBlockNumber?: number;
    deploymentTimestamp?: string;
    deploymentTxHash?: string;
  };
  contractName?: string;
  contractSummary?: string;
  abi?: Array<{
    name: string;
    type: string;
    inputs?: Array<{ name: string; type: string; indexed?: boolean }>;
    outputs?: Array<{ name: string; type: string }>;
    stateMutability?: string;
    keccak_hash?: string;
  }>;
  functionSummaries?: Array<{
    name: string;
    signature: string;
    summary: string;
  }>;
  eventSummaries?: Array<{
    name: string;
    summary: string;
  }>;
  tokenDetails?: {
    tokenType?: string;
    symbol?: string;
    name?: string;
    decimals?: number;
    totalSupply?: number;
    currentPriceUsd?: number;
    marketCapUsd?: number;
  };
  historicalImplementations?: Array<{
    versionNumber: number;
    address: string;
    deploymentBlockNumber?: number;
    deploymentTxHash?: string;
    newFunctions?: string[];
    newEvents?: string[];
  }>;
  proxyAbi?: unknown[];
}

interface HerdTransactionAnalysis {
  txHash: string;
  blockNumber: number;
  blockTimestamp: number;
  from: string;
  success: boolean;
  logs: Array<{
    output: Record<string, unknown>;
    contractAddress: string;
    contractName?: string;
    eventName: string;
    eventSignature: string;
    index: number;
  }>;
}

interface HerdLatestTransaction {
  txHash: string;
  blockNumber: number;
  blockTimestamp: number;
  from: string;
  success: boolean;
  logs: Array<{
    output: Record<string, unknown>;
    contractAddress: string;
    contractName?: string;
    eventName: string;
    eventSignature: string;
    index: number;
  }>;
}

interface HerdResearchResponse {
  answer: string;
  sources: Array<{ type: string; payload: { url: string; title: string } }>;
  status: string;
}

// ============================================================================
// History Provider (if Herd adds account listing)
// ============================================================================

export class HerdHistoryProvider implements HistoryProvider {
  name = 'herd';

  supportedChains(): SupportedChain[] {
    return HERD_SUPPORTED_CHAINS;
  }

  async listTransactions(params: HistoryListParams): Promise<ProviderResult<HistoryListResult>> {
    if (!isHerdEnabled()) return herdDisabled();

    // NOTE: Herd's queryTransactionTool analyzes individual transactions by hash.
    // Until we confirm Herd supports account-level listing, this returns unavailable.
    // Use Zerion for HistoryList capability instead.
    return {
      success: false,
      error: 'Herd does not support account-level transaction listing. Use Zerion for history.',
      provider: this.name,
      level: 'unavailable',
    };
  }
}

// ============================================================================
// Transaction Analysis Provider
// ============================================================================

export class HerdTxAnalysisProvider implements TxAnalysisProvider {
  name = 'herd';

  supportedChains(): SupportedChain[] {
    return HERD_SUPPORTED_CHAINS;
  }

  async analyzeTransaction(params: TxAnalysisParams): Promise<ProviderResult<TransactionAnalysis>> {
    if (!isHerdEnabled()) return herdDisabled();

    const chain = params.chain || 'ethereum';
    if (!isHerdSupportedChain(chain)) return unsupportedChain(chain);

    const result = await callHerdTool<HerdTransactionAnalysis>('queryTransactionTool', {
      txHash: params.txHash,
      returnAllData: true,
      includeRawData: false,
      blockchain: chain,
    });

    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error || 'Failed to analyze transaction',
        provider: this.name,
        level: 'unavailable',
      };
    }

    const data = result.data;

    // Map Herd response to our TransactionAnalysis type with sanitization
    const events: DecodedEvent[] = (data.logs || []).map((log, idx) => ({
      eventName: sanitizeFunctionName(log.eventName),
      signature: log.eventSignature,
      contractAddress: log.contractAddress,
      contractName: sanitizeContractName(log.contractName),
      args: log.output,
      logIndex: log.index ?? idx,
    }));

    // TODO: Extract balance changes from Herd response
    const balanceChanges: BalanceChange[] = [];

    // TODO: Extract internal calls from Herd trace
    const call: DecodedCall = {
      functionName: 'unknown',
      signature: '0x00000000',
      contractAddress: data.from || '',
      args: {},
      readable: `Transaction ${params.txHash}`,
    };

    const analysis: TransactionAnalysis = {
      hash: data.txHash || params.txHash,
      chainId: CHAIN_IDS[chain],
      chain,
      blockNumber: data.blockNumber,
      timestamp: new Date(data.blockTimestamp * 1000).toISOString(),
      status: data.success ? 'confirmed' : 'failed',
      call,
      balanceChanges,
      events,
      gasUsed: '0', // TODO: Extract from Herd response
      intentSummary: sanitizeDescription(`Transaction with ${events.length} events`),
    };

    return {
      success: true,
      data: analysis,
      provider: this.name,
      level: 'full',
    };
  }
}

// ============================================================================
// Contract Intelligence Provider
// ============================================================================

export class HerdContractIntelProvider implements ContractIntelProvider {
  name = 'herd';

  supportedChains(): SupportedChain[] {
    return HERD_SUPPORTED_CHAINS;
  }

  async getMetadata(params: ContractMetadataParams): Promise<ProviderResult<ContractMetadata>> {
    if (!isHerdEnabled()) return herdDisabled();
    if (!isHerdSupportedChain(params.chain)) return unsupportedChain(params.chain);

    const chainId = CHAIN_IDS[params.chain];
    const blockTag = params.atBlock || 'latest';

    // Check cache first (without impl address - we don't know it yet for cache lookup)
    // This means we might miss cache for upgraded proxies, but it's safer
    const cached = getCachedMetadata(chainId, params.address, blockTag);
    if (cached) {
      console.error(`Cache hit for ${params.address} on ${params.chain} (${cached.fromCache})`);

      // Apply detail level filtering to cached data
      let data = cached.data;
      if (params.detailLevel === 'events') {
        data = { ...data, functions: [] };
      } else if (params.detailLevel === 'functions') {
        data = { ...data, events: [] };
      }
      if (!params.includeAbi) {
        data = { ...data, abi: undefined };
      }

      return {
        success: true,
        data,
        cached: true,
        provider: this.name,
        level: 'full',
      };
    }

    // Fetch from Herd
    const result = await callHerdTool<HerdContractMetadata>('contractMetadataTool', {
      contractAddress: params.address,
      blockchain: params.chain,
    });

    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error || 'Failed to get contract metadata',
        provider: this.name,
        level: 'unavailable',
      };
    }

    const data = result.data;

    // Map functions from ABI
    const functions: FunctionInfo[] = (data.abi || [])
      .filter(entry => entry.type === 'function')
      .map(entry => ({
        name: entry.name,
        signature: entry.keccak_hash?.slice(0, 10) || '',
        fullSignature: `${entry.name}(${(entry.inputs || []).map(i => i.type).join(',')})`,
        inputs: (entry.inputs || []).map(i => ({ name: i.name, type: i.type })),
        outputs: (entry.outputs || []).map(o => ({ name: o.name, type: o.type })),
        stateMutability: (entry.stateMutability as 'pure' | 'view' | 'nonpayable' | 'payable') || 'nonpayable',
        summary: data.functionSummaries?.find(s => s.name === entry.name)?.summary,
      }));

    // Map events from ABI
    const events: EventInfo[] = (data.abi || [])
      .filter(entry => entry.type === 'event')
      .map(entry => ({
        name: entry.name,
        signature: entry.keccak_hash || '',
        inputs: (entry.inputs || []).map(i => ({
          name: i.name,
          type: i.type,
          indexed: i.indexed || false,
        })),
        summary: data.eventSummaries?.find(s => s.name === entry.name)?.summary,
      }));

    // Warn if contract name looks suspicious
    warnIfSuspicious(data.contractName || '', `contract ${params.address}`);
    warnIfSuspicious(data.contractSummary || '', `summary for ${params.address}`);

    // Build metadata with sanitized strings
    const metadata: ContractMetadata = {
      address: params.address,
      chain: params.chain,
      chainId: CHAIN_IDS[params.chain],
      name: sanitizeContractName(data.contractName) || 'Unknown',
      verified: !!data.abi && data.abi.length > 0,
      deployment: data.addressDetails ? {
        blockNumber: data.addressDetails.deploymentBlockNumber || 0,
        timestamp: data.addressDetails.deploymentTimestamp || '',
        txHash: data.addressDetails.deploymentTxHash || '',
      } : undefined,
      functions: (params.detailLevel === 'events' ? [] : functions).map(f => ({
        ...f,
        name: sanitizeFunctionName(f.name),
        summary: f.summary ? sanitizeDescription(f.summary) : undefined,
      })),
      events: (params.detailLevel === 'functions' ? [] : events).map(e => ({
        ...e,
        name: sanitizeFunctionName(e.name),
        summary: e.summary ? sanitizeDescription(e.summary) : undefined,
      })),
      token: data.tokenDetails ? {
        type: (data.tokenDetails.tokenType as 'ERC20' | 'ERC721' | 'ERC1155') || 'unknown',
        symbol: sanitizeContractName(data.tokenDetails.symbol) || '',
        name: sanitizeContractName(data.tokenDetails.name) || '',
        decimals: data.tokenDetails.decimals,
        totalSupply: data.tokenDetails.totalSupply?.toString(),
        priceUsd: data.tokenDetails.currentPriceUsd?.toString(),
        marketCapUsd: data.tokenDetails.marketCapUsd?.toString(),
      } : undefined,
      proxy: data.historicalImplementations && data.historicalImplementations.length > 0 ? {
        isProxy: true,
        implementationAddress: data.historicalImplementations[data.historicalImplementations.length - 1]?.address,
      } : { isProxy: false },
      upgrades: data.historicalImplementations?.map(impl => ({
        version: impl.versionNumber,
        implementationAddress: impl.address,
        blockNumber: impl.deploymentBlockNumber || 0,
        timestamp: '',
        addedFunctions: impl.newFunctions?.map(f => sanitizeFunctionName(f)),
      })),
      summary: sanitizeDescription(data.contractSummary),
      abi: data.abi,  // Cache full ABI, filter on return
    };

    // Cache the full metadata (include impl address for proxies to avoid stale data)
    const implAddress = metadata.proxy?.implementationAddress;
    cacheMetadata(chainId, params.address, metadata, blockTag, implAddress);

    // Apply detail level filtering before returning
    let returnData = metadata;
    if (params.detailLevel === 'events') {
      returnData = { ...returnData, functions: [] };
    } else if (params.detailLevel === 'functions') {
      returnData = { ...returnData, events: [] };
    }
    if (!params.includeAbi) {
      returnData = { ...returnData, abi: undefined };
    }

    return {
      success: true,
      data: returnData,
      provider: this.name,
      level: 'full',
    };
  }

  async searchCode(params: CodeSearchParams): Promise<ProviderResult<CodeSearchResult[]>> {
    if (!isHerdEnabled()) return herdDisabled();
    if (!isHerdSupportedChain(params.chain)) return unsupportedChain(params.chain);

    const result = await callHerdTool<{ matches?: Array<{ contractAddress: string; contractName?: string; functionName?: string; lineNumbers?: string; snippet: string }> }>('regexCodeAnalysisTool', {
      query: params.query,
      contractAddresses: params.addresses,
    });

    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error || 'Failed to search code',
        provider: this.name,
        level: 'unavailable',
      };
    }

    // Group matches by contract
    const byContract = new Map<string, CodeSearchResult>();
    for (const match of result.data.matches || []) {
      const existing = byContract.get(match.contractAddress);
      if (existing) {
        existing.matches.push({
          functionName: match.functionName,
          lineNumbers: match.lineNumbers,
          snippet: match.snippet,
        });
      } else {
        byContract.set(match.contractAddress, {
          contractAddress: match.contractAddress,
          contractName: match.contractName || 'Unknown',
          matches: [{
            functionName: match.functionName,
            lineNumbers: match.lineNumbers,
            snippet: match.snippet,
          }],
        });
      }
    }

    return {
      success: true,
      data: Array.from(byContract.values()),
      provider: this.name,
      level: 'full',
    };
  }

  async diffVersions(params: ContractDiffParams): Promise<ProviderResult<ContractDiff[]>> {
    if (!isHerdEnabled()) return herdDisabled();
    if (!isHerdSupportedChain(params.chain)) return unsupportedChain(params.chain);

    const result = await callHerdTool<{ diffs?: Array<{ from: string; to: string; added?: Array<{ type: string; name: string; signature: string }>; removed?: Array<{ type: string; name: string; signature: string }>; modified?: Array<{ type: string; name: string; changes: string }> }> }>('diffContractVersions', {
      compareAllVersions: params.compareAllVersions,
    });

    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error || 'Failed to diff versions',
        provider: this.name,
        level: 'unavailable',
      };
    }

    const diffs: ContractDiff[] = (result.data.diffs || []).map((diff, idx) => ({
      fromVersion: idx,
      toVersion: idx + 1,
      fromAddress: diff.from,
      toAddress: diff.to,
      added: (diff.added || []).map(a => ({
        type: a.type as 'function' | 'event',
        name: a.name,
        signature: a.signature,
      })),
      removed: (diff.removed || []).map(r => ({
        type: r.type as 'function' | 'event',
        name: r.name,
        signature: r.signature,
      })),
      modified: (diff.modified || []).map(m => ({
        type: m.type as 'function' | 'event',
        name: m.name,
        changes: m.changes,
      })),
    }));

    return {
      success: true,
      data: diffs,
      provider: this.name,
      level: 'full',
    };
  }
}

// ============================================================================
// Event Monitor Provider
// ============================================================================

export class HerdEventMonitorProvider implements EventMonitorProvider {
  name = 'herd';

  supportedChains(): SupportedChain[] {
    return HERD_SUPPORTED_CHAINS;
  }

  async getRecentEvents(params: EventMonitorParams): Promise<ProviderResult<EventOccurrence[]>> {
    if (!isHerdEnabled()) return herdDisabled();
    if (!isHerdSupportedChain(params.filter.chain)) return unsupportedChain(params.filter.chain);

    if (!params.filter.eventSignature) {
      return {
        success: false,
        error: 'Event signature (keccak hash) is required. Use contractMetadata to get it.',
        provider: this.name,
        level: 'unavailable',
      };
    }

    const result = await callHerdTool<{ transactions?: HerdLatestTransaction[] }>('getLatestTransactionsTool', {
      type: 'event',
      signature: params.filter.eventSignature,
      contractAddress: params.filter.address,
      blockchain: params.filter.chain,
    });

    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error || 'Failed to get recent events',
        provider: this.name,
        level: 'unavailable',
      };
    }

    const events: EventOccurrence[] = [];

    for (const tx of result.data.transactions || []) {
      for (const log of tx.logs || []) {
        events.push({
          txHash: tx.txHash,
          blockNumber: tx.blockNumber,
          timestamp: new Date(tx.blockTimestamp * 1000).toISOString(),
          event: {
            eventName: log.eventName,
            signature: log.eventSignature,
            contractAddress: log.contractAddress,
            contractName: log.contractName,
            args: log.output,
            logIndex: log.index,
          },
          explorerUrl: `${EXPLORER_URLS[params.filter.chain]}/tx/${tx.txHash}`,
        });
      }
    }

    // Limit results
    const limited = events.slice(0, params.limit || 50);

    return {
      success: true,
      data: limited,
      provider: this.name,
      level: 'full',
    };
  }
}

// ============================================================================
// Research Provider
// ============================================================================

export class HerdResearchProvider implements ResearchProvider {
  name = 'herd';

  async research(params: ResearchParams): Promise<ProviderResult<ResearchResult>> {
    if (!isHerdEnabled()) return herdDisabled();

    const result = await callHerdTool<HerdResearchResponse>('researchTool', {
      question: params.question,
      selectedNetwork: params.network,
    });

    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error || 'Failed to research',
        provider: this.name,
        level: 'unavailable',
      };
    }

    return {
      success: true,
      data: {
        answer: result.data.answer,
        sources: (result.data.sources || []).map(s => ({
          title: s.payload?.title || 'Source',
          url: s.payload?.url || '',
        })),
      },
      provider: this.name,
      level: 'full',
    };
  }
}

// ============================================================================
// Export Provider Instances
// ============================================================================

export const herdHistoryProvider = new HerdHistoryProvider();
export const herdTxAnalysisProvider = new HerdTxAnalysisProvider();
export const herdContractIntelProvider = new HerdContractIntelProvider();
export const herdEventMonitorProvider = new HerdEventMonitorProvider();
export const herdResearchProvider = new HerdResearchProvider();
