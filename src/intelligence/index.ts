/**
 * Wallet Intelligence Module
 *
 * Provides token classification, opportunity detection, and
 * proactive wallet insights.
 *
 * @module intelligence
 */

// Token patterns and classification
export {
  TOKEN_PATTERNS,
  matchTokenType,
  getPatternFunctions,
  isInterestingFunction,
  type TokenType,
  type PatternMatch,
} from './patterns.js';

// Token analysis
export {
  analyzeToken,
  formatAnalysisForLLM,
  type TokenAnalysis,
} from './classifier.js';

// Related contract discovery
export {
  findRelatedContracts,
  type RelatedContract,
} from './discovery.js';

// Opportunity detection
export {
  scanForOpportunities,
  formatOpportunitiesForLLM,
  detectUnclaimedRewards,
  detectRecentInflows,
  detectGovernanceOpportunities,
  type Opportunity,
  type OpportunityType,
  type OpportunityPriority,
  type OpportunityScanResult,
} from './opportunities.js';

// Caching utilities
export {
  TTLCache,
  tokenCacheKey,
  classificationCache,
  discoveryCache,
  opportunityCache,
} from './cache.js';

// Safety checks and simulation
export {
  checkContractSafety,
  simulateWithSafetyChecks,
  formatSafetyWarnings,
  formatSimulationResult,
  isSafeToProceed,
  type WarningSeverity,
  type SafetyWarning,
  type ContractSafetyResult,
  type SimulationSafetyResult,
  type BalanceChange,
} from './safety.js';

// Action generation from ABI
export {
  generateClaimAction,
  generateDelegateAction,
  generateExitAction,
  generateReleaseAction,
  generateWithdrawAction,
  suggestAction,
  formatAction,
  type ActionType,
  type GeneratedAction,
  type ActionParams,
} from './actions.js';
