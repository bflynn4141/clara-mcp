/**
 * Provider Types
 *
 * Interfaces for blockchain data providers (Herd, Zerion, RPC, etc.)
 * Tools use these interfaces; the ProviderRegistry routes to implementations.
 */

import type { SupportedChain } from '../config/chains.js';

// ============================================================================
// Core Types
// ============================================================================

/**
 * Provider capabilities - what a provider can do
 */
export type ProviderCapability =
  | 'HistoryList'        // List transactions for an account
  | 'TxAnalysis'         // Deep transaction decoding
  | 'ContractMetadata'   // ABI, functions, events, token info
  | 'CodeSearch'         // Search contract source code
  | 'EventMonitor'       // Watch for contract events
  | 'ContractDiff'       // Compare contract versions
  | 'Research';          // AI-powered blockchain research

/**
 * Chain support level for a provider
 */
export type ChainSupport = 'full' | 'partial' | 'none';

/**
 * Base result type for all provider operations
 */
export interface ProviderResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  /** Whether this came from cache */
  cached?: boolean;
  /** Provider that handled this request */
  provider: string;
  /** Capability level used */
  level: 'full' | 'basic' | 'unavailable';
}

// ============================================================================
// History Provider
// ============================================================================

/**
 * A single transaction in history
 */
export interface TransactionSummary {
  hash: string;
  chainId: number;
  chain: SupportedChain;
  timestamp: string;  // ISO 8601
  status: 'confirmed' | 'pending' | 'failed';
  type: TransactionType;
  /** Human-readable summary */
  summary: string;
  /** Token/value transfers */
  transfers: TransferInfo[];
  /** Gas cost in native token */
  gasCost?: string;
  /** Gas cost in USD */
  gasCostUsd?: string;
  /** Block explorer URL */
  explorerUrl: string;
}

export type TransactionType =
  | 'send'
  | 'receive'
  | 'swap'
  | 'approve'
  | 'mint'
  | 'burn'
  | 'deposit'
  | 'withdraw'
  | 'stake'
  | 'unstake'
  | 'claim'
  | 'bridge'
  | 'deploy'
  | 'unknown';

export interface TransferInfo {
  direction: 'in' | 'out' | 'self';
  token: {
    symbol: string;
    name?: string;
    address?: string;
    decimals?: number;
  };
  amount: string;       // Human-readable (already decimal-adjusted)
  amountRaw?: string;   // Raw value
  valueUsd?: string;
  from: string;
  to: string;
}

export interface HistoryListParams {
  address: string;
  chain: SupportedChain | 'all';
  limit?: number;
  cursor?: string;  // For pagination
}

export interface HistoryListResult {
  transactions: TransactionSummary[];
  nextCursor?: string;
  hasMore: boolean;
}

/**
 * Provider for listing transaction history
 */
export interface HistoryProvider {
  name: string;
  listTransactions(params: HistoryListParams): Promise<ProviderResult<HistoryListResult>>;
  supportedChains(): SupportedChain[];
}

// ============================================================================
// Transaction Analysis Provider
// ============================================================================

/**
 * Decoded function call
 */
export interface DecodedCall {
  functionName: string;
  signature: string;        // 4-byte selector
  contractAddress: string;
  contractName?: string;
  args: Record<string, unknown>;
  /** Human-readable representation */
  readable: string;
}

/**
 * Balance change from a transaction
 */
export interface BalanceChange {
  address: string;
  token: {
    symbol: string;
    address?: string;
    decimals?: number;
  };
  before?: string;
  after?: string;
  change: string;  // Can be negative
  changeUsd?: string;
}

/**
 * Decoded event log
 */
export interface DecodedEvent {
  eventName: string;
  signature: string;        // 32-byte topic
  contractAddress: string;
  contractName?: string;
  args: Record<string, unknown>;
  logIndex: number;
}

/**
 * Full transaction analysis
 */
export interface TransactionAnalysis {
  hash: string;
  chainId: number;
  chain: SupportedChain;
  blockNumber: number;
  timestamp: string;
  status: 'confirmed' | 'failed';
  /** The main function that was called */
  call: DecodedCall;
  /** Internal calls (trace) */
  internalCalls?: DecodedCall[];
  /** All balance changes */
  balanceChanges: BalanceChange[];
  /** All events emitted */
  events: DecodedEvent[];
  /** Gas used */
  gasUsed: string;
  gasCostUsd?: string;
  /** User intent summary */
  intentSummary: string;
}

export interface TxAnalysisParams {
  txHash: string;
  chain?: SupportedChain;  // Auto-detected if not provided
  includeInternalCalls?: boolean;
}

/**
 * Provider for deep transaction analysis
 */
export interface TxAnalysisProvider {
  name: string;
  analyzeTransaction(params: TxAnalysisParams): Promise<ProviderResult<TransactionAnalysis>>;
  supportedChains(): SupportedChain[];
}

// ============================================================================
// Contract Intelligence Provider
// ============================================================================

/**
 * Function summary from ABI
 */
export interface FunctionInfo {
  name: string;
  signature: string;  // 4-byte selector
  fullSignature: string;  // e.g., "transfer(address,uint256)"
  inputs: Array<{ name: string; type: string }>;
  outputs: Array<{ name: string; type: string }>;
  stateMutability: 'pure' | 'view' | 'nonpayable' | 'payable';
  /** AI-generated summary */
  summary?: string;
}

/**
 * Event summary from ABI
 */
export interface EventInfo {
  name: string;
  signature: string;  // 32-byte topic
  inputs: Array<{ name: string; type: string; indexed: boolean }>;
  /** AI-generated summary */
  summary?: string;
}

/**
 * Token metadata (if contract is a token)
 */
export interface TokenInfo {
  type: 'ERC20' | 'ERC721' | 'ERC1155' | 'unknown';
  symbol: string;
  name: string;
  decimals?: number;
  totalSupply?: string;
  priceUsd?: string;
  marketCapUsd?: string;
  holders?: number;
}

/**
 * Proxy implementation info
 */
export interface ProxyInfo {
  isProxy: boolean;
  implementationAddress?: string;
  proxyType?: 'transparent' | 'uups' | 'beacon' | 'unknown';
  adminAddress?: string;
}

/**
 * Contract upgrade history entry
 */
export interface UpgradeInfo {
  version: number;
  implementationAddress: string;
  blockNumber: number;
  timestamp: string;
  addedFunctions?: string[];
  removedFunctions?: string[];
}

/**
 * Full contract metadata
 */
export interface ContractMetadata {
  address: string;
  chain: SupportedChain;
  chainId: number;
  name: string;
  /** Contract type detection */
  contractType?: string;
  /** Is source verified on explorer */
  verified: boolean;
  /** Deployment info */
  deployment?: {
    blockNumber: number;
    timestamp: string;
    txHash: string;
  };
  /** All functions */
  functions: FunctionInfo[];
  /** All events */
  events: EventInfo[];
  /** Token info (if applicable) */
  token?: TokenInfo;
  /** Proxy info */
  proxy?: ProxyInfo;
  /** Upgrade history */
  upgrades?: UpgradeInfo[];
  /** AI-generated summary */
  summary?: string;
  /** Full ABI (optional, can be large) */
  abi?: unknown[];
}

export interface ContractMetadataParams {
  address: string;
  chain: SupportedChain;
  /** Level of detail to return */
  detailLevel?: 'summary' | 'functions' | 'events' | 'full';
  /** Include full ABI (can be 200KB+) */
  includeAbi?: boolean;
  /** Block to resolve proxy implementation at */
  atBlock?: number;
}

/**
 * Code search result
 */
export interface CodeSearchResult {
  contractAddress: string;
  contractName: string;
  matches: Array<{
    functionName?: string;
    lineNumbers?: string;
    snippet: string;
  }>;
}

export interface CodeSearchParams {
  query: string;
  addresses?: string[];
  chain: SupportedChain;
}

/**
 * Contract version diff
 */
export interface ContractDiff {
  fromVersion: number;
  toVersion: number;
  fromAddress: string;
  toAddress: string;
  added: Array<{ type: 'function' | 'event'; name: string; signature: string }>;
  removed: Array<{ type: 'function' | 'event'; name: string; signature: string }>;
  modified: Array<{ type: 'function' | 'event'; name: string; changes: string }>;
}

export interface ContractDiffParams {
  address: string;
  chain: SupportedChain;
  compareAllVersions?: boolean;
}

/**
 * Provider for contract intelligence
 */
export interface ContractIntelProvider {
  name: string;
  getMetadata(params: ContractMetadataParams): Promise<ProviderResult<ContractMetadata>>;
  searchCode?(params: CodeSearchParams): Promise<ProviderResult<CodeSearchResult[]>>;
  diffVersions?(params: ContractDiffParams): Promise<ProviderResult<ContractDiff[]>>;
  supportedChains(): SupportedChain[];
}

// ============================================================================
// Event Monitor Provider
// ============================================================================

export interface EventFilter {
  address: string;
  eventName?: string;
  eventSignature?: string;  // 32-byte topic
  chain: SupportedChain;
}

export interface EventOccurrence {
  txHash: string;
  blockNumber: number;
  timestamp: string;
  event: DecodedEvent;
  explorerUrl: string;
}

export interface EventMonitorParams {
  filter: EventFilter;
  limit?: number;
}

/**
 * Provider for monitoring contract events
 */
export interface EventMonitorProvider {
  name: string;
  getRecentEvents(params: EventMonitorParams): Promise<ProviderResult<EventOccurrence[]>>;
  supportedChains(): SupportedChain[];
}

// ============================================================================
// Research Provider
// ============================================================================

export interface ResearchResult {
  answer: string;
  sources: Array<{
    title: string;
    url: string;
  }>;
}

export interface ResearchParams {
  question: string;
  network?: SupportedChain;
}

/**
 * Provider for AI-powered blockchain research
 */
export interface ResearchProvider {
  name: string;
  research(params: ResearchParams): Promise<ProviderResult<ResearchResult>>;
}

// ============================================================================
// Risk Assessment Types
// ============================================================================

export type RiskSignalType =
  | 'unverified_contract'
  | 'recent_deployment'
  | 'has_admin_functions'
  | 'upgradeable_proxy'
  | 'unusual_approval'
  | 'known_scam'
  | 'high_risk_pattern';

export type RiskSeverity = 'info' | 'warn' | 'block';

export interface RiskSignal {
  type: RiskSignalType;
  severity: RiskSeverity;
  message: string;
  evidence?: string;
}

export interface RiskAssessment {
  address: string;
  chain: SupportedChain;
  signals: RiskSignal[];
  overallRisk: 'low' | 'medium' | 'high' | 'critical';
  recommendation: 'proceed' | 'caution' | 'avoid';
}
