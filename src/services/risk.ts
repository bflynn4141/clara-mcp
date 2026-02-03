/**
 * Risk Assessment Service
 *
 * Analyzes contracts and transactions for potential risks.
 * Uses Herd contract intelligence to extract risk signals.
 */

import { getProviderRegistry, type ContractMetadata, type RiskSignal, type RiskAssessment, type RiskSeverity, type RiskSignalType } from '../providers/index.js';
import type { SupportedChain } from '../config/chains.js';

// ============================================================================
// Known Addresses (can be expanded)
// ============================================================================

/**
 * Known safe contracts (major protocols)
 */
const KNOWN_SAFE_CONTRACTS: Record<string, string[]> = {
  // Addresses are lowercase
  ethereum: [
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2 Router
    '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap V3 Router
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', // Uniswap V3 Router 02
  ],
  base: [
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC on Base
    '0x4200000000000000000000000000000000000006', // WETH on Base
    '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap V3 Router on Base
  ],
};

/**
 * Known scam patterns in contract names/code
 */
const SUSPICIOUS_PATTERNS = [
  'honeypot',
  'scam',
  'rug',
  'drain',
  'steal',
  'backdoor',
];

// ============================================================================
// Risk Signal Extraction
// ============================================================================

/**
 * Check if contract is a known safe address
 */
function isKnownSafe(address: string, chain: SupportedChain): boolean {
  const known = KNOWN_SAFE_CONTRACTS[chain] || [];
  return known.includes(address.toLowerCase());
}

/**
 * Extract risk signals from contract metadata
 */
export function extractRiskSignals(metadata: ContractMetadata): RiskSignal[] {
  const signals: RiskSignal[] = [];
  const functionNames = metadata.functions.map(f => f.name.toLowerCase());

  // Unverified contract
  if (!metadata.verified) {
    signals.push({
      type: 'unverified_contract',
      severity: 'warn',
      message: 'Contract source code is not verified',
      evidence: 'No verified source on block explorer',
    });
  }

  // Recent deployment
  if (metadata.deployment?.timestamp) {
    const deployDate = new Date(metadata.deployment.timestamp);
    const daysSinceDeploy = (Date.now() - deployDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceDeploy < 7) {
      signals.push({
        type: 'recent_deployment',
        severity: daysSinceDeploy < 1 ? 'warn' : 'info',
        message: `Contract deployed ${Math.floor(daysSinceDeploy)} days ago`,
        evidence: `Deployment: ${metadata.deployment.timestamp}`,
      });
    }
  }

  // Admin functions
  const adminFunctions: string[] = [];
  if (functionNames.includes('pause')) adminFunctions.push('pause');
  if (functionNames.includes('unpause')) adminFunctions.push('unpause');
  if (functionNames.includes('blacklist')) adminFunctions.push('blacklist');
  if (functionNames.includes('addblacklist')) adminFunctions.push('addBlacklist');
  if (functionNames.includes('setfee')) adminFunctions.push('setFee');
  if (functionNames.includes('settax')) adminFunctions.push('setTax');
  if (functionNames.includes('setmaxwallet')) adminFunctions.push('setMaxWallet');
  if (functionNames.includes('mint') && !functionNames.includes('permit')) adminFunctions.push('mint');

  if (adminFunctions.length > 0) {
    signals.push({
      type: 'has_admin_functions',
      severity: 'info',
      message: `Contract has admin functions: ${adminFunctions.join(', ')}`,
      evidence: `Found ${adminFunctions.length} admin-like functions`,
    });
  }

  // Upgradeable proxy
  if (metadata.proxy?.isProxy) {
    signals.push({
      type: 'upgradeable_proxy',
      severity: 'info',
      message: 'Contract is upgradeable (proxy pattern)',
      evidence: `Implementation: ${metadata.proxy.implementationAddress || 'unknown'}`,
    });
  }

  // Suspicious name patterns
  const nameToCheck = (metadata.name + ' ' + metadata.summary).toLowerCase();
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (nameToCheck.includes(pattern)) {
      signals.push({
        type: 'high_risk_pattern',
        severity: 'block',
        message: `Contract contains suspicious pattern: "${pattern}"`,
        evidence: `Found in contract name or description`,
      });
    }
  }

  return signals;
}

/**
 * Calculate overall risk level from signals
 */
function calculateOverallRisk(signals: RiskSignal[]): 'low' | 'medium' | 'high' | 'critical' {
  const hasBlock = signals.some(s => s.severity === 'block');
  const warnCount = signals.filter(s => s.severity === 'warn').length;
  const infoCount = signals.filter(s => s.severity === 'info').length;

  if (hasBlock) return 'critical';
  if (warnCount >= 2) return 'high';
  if (warnCount === 1 || infoCount >= 3) return 'medium';
  return 'low';
}

/**
 * Determine recommendation based on risk
 */
function getRecommendation(overallRisk: 'low' | 'medium' | 'high' | 'critical'): 'proceed' | 'caution' | 'avoid' {
  switch (overallRisk) {
    case 'critical':
      return 'avoid';
    case 'high':
      return 'caution';
    case 'medium':
      return 'caution';
    default:
      return 'proceed';
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Assess risk for a contract address
 */
export async function assessContractRisk(
  address: string,
  chain: SupportedChain
): Promise<RiskAssessment> {
  const signals: RiskSignal[] = [];

  // Quick check: is it a known safe contract?
  if (isKnownSafe(address, chain)) {
    return {
      address,
      chain,
      signals: [{
        type: 'known_scam' as RiskSignalType, // Reusing type for "known safe"
        severity: 'info',
        message: 'Known trusted contract',
      }],
      overallRisk: 'low',
      recommendation: 'proceed',
    };
  }

  const registry = getProviderRegistry();

  // Try to get contract metadata
  if (registry.hasCapability('ContractMetadata', chain)) {
    try {
      const result = await registry.getContractMetadata({
        address,
        chain,
        detailLevel: 'summary',
      });

      if (result.success && result.data) {
        signals.push(...extractRiskSignals(result.data));
      } else {
        // Could not get metadata - that's a warning
        signals.push({
          type: 'unverified_contract',
          severity: 'warn',
          message: 'Could not fetch contract metadata',
          evidence: result.error,
        });
      }
    } catch (error) {
      // Herd not available - can't do full assessment
      signals.push({
        type: 'unverified_contract',
        severity: 'info',
        message: 'Contract analysis unavailable (Herd not enabled)',
      });
    }
  } else {
    // No contract intel capability for this chain
    signals.push({
      type: 'unverified_contract',
      severity: 'info',
      message: `Contract analysis not available for ${chain}`,
    });
  }

  const overallRisk = calculateOverallRisk(signals);

  return {
    address,
    chain,
    signals,
    overallRisk,
    recommendation: getRecommendation(overallRisk),
  };
}

/**
 * Format risk assessment for display
 */
export function formatRiskAssessment(assessment: RiskAssessment): string[] {
  const lines: string[] = [];

  if (assessment.signals.length === 0) {
    return ['✅ No risk signals detected'];
  }

  // Show signals grouped by severity
  const byBlock = assessment.signals.filter(s => s.severity === 'block');
  const byWarn = assessment.signals.filter(s => s.severity === 'warn');
  const byInfo = assessment.signals.filter(s => s.severity === 'info');

  if (byBlock.length > 0) {
    lines.push('🚫 **Critical Issues:**');
    for (const signal of byBlock) {
      lines.push(`- ${signal.message}`);
    }
  }

  if (byWarn.length > 0) {
    lines.push('⚠️ **Warnings:**');
    for (const signal of byWarn) {
      lines.push(`- ${signal.message}`);
    }
  }

  if (byInfo.length > 0 && lines.length === 0) {
    // Only show info if no higher severity
    lines.push('ℹ️ **Notes:**');
    for (const signal of byInfo) {
      lines.push(`- ${signal.message}`);
    }
  }

  // Recommendation
  switch (assessment.recommendation) {
    case 'avoid':
      lines.push('');
      lines.push('**Recommendation:** 🛑 Avoid this interaction');
      break;
    case 'caution':
      lines.push('');
      lines.push('**Recommendation:** ⚠️ Proceed with caution');
      break;
    case 'proceed':
      // Don't add anything for proceed
      break;
  }

  return lines;
}

/**
 * Quick check if address is likely safe (fast, no API calls)
 */
export function quickSafeCheck(address: string, chain: SupportedChain): boolean {
  return isKnownSafe(address, chain);
}
