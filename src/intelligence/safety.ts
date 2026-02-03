/**
 * Safety Module
 *
 * Provides safety checks before executing transactions:
 * - Contract age warnings (< 30 days old)
 * - Unverified contract warnings
 * - Mandatory simulation before writes
 *
 * Philosophy: Warn, don't block. Let the user decide with full information.
 */

import { createPublicClient, http, formatEther, isAddress, type Hex, type Address } from 'viem';
import { CHAINS, getRpcUrl, type SupportedChain } from '../config/chains.js';
import { getProviderRegistry } from '../providers/index.js';
import {
  simulateWithTenderly,
  isTenderlyConfigured,
  type TenderlyBalanceChange,
} from '../providers/tenderly.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Safety warning severity
 */
export type WarningSeverity = 'info' | 'warning' | 'danger';

/**
 * A safety warning about a contract or transaction
 */
export interface SafetyWarning {
  severity: WarningSeverity;
  code: string;
  title: string;
  description: string;
  recommendation?: string;
}

/**
 * Result of safety checks on a contract
 */
export interface ContractSafetyResult {
  address: string;
  chain: string;
  isVerified: boolean;
  deployedAt?: Date;
  ageInDays?: number;
  warnings: SafetyWarning[];
  overallRisk: 'low' | 'medium' | 'high';
  // Proxy-specific info
  isProxy?: boolean;
  implementationAddress?: string;
  implementationVerified?: boolean;
  // Upgrade awareness
  proxyType?: 'transparent' | 'uups' | 'beacon' | 'unknown';
  adminAddress?: string;
  upgradeCount?: number;
  lastUpgradeDate?: Date;
}

/**
 * Simulation result formatted for safety review
 */
export interface SimulationSafetyResult {
  success: boolean;
  willRevert: boolean;
  revertReason?: string;
  balanceChanges: BalanceChange[];
  gasEstimate?: string;
  warnings: SafetyWarning[];
  // New: distinguish "simulation unavailable" from "will revert" (GPT-5.2 recommendation)
  simulationUnavailable?: boolean;
}

export interface BalanceChange {
  token: string;
  symbol?: string;
  before: string;
  after: string;
  change: string;
  direction: 'increase' | 'decrease' | 'none';
}

// ============================================================================
// Contract Safety Checks
// ============================================================================

// EIP-1967 storage slot for implementation address
// keccak256("eip1967.proxy.implementation") - 1
const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex;

/**
 * Resolve EIP-1967 proxy to get implementation address
 */
async function resolveProxyForSafety(
  address: string,
  chain: SupportedChain
): Promise<{ isProxy: boolean; implementationAddress?: string }> {
  try {
    const client = createPublicClient({
      chain: CHAINS[chain].chain,
      transport: http(getRpcUrl(chain)),
    });

    const slot = await client.getStorageAt({
      address: address as Hex,
      slot: EIP1967_IMPLEMENTATION_SLOT,
    });

    if (slot && slot !== '0x' + '0'.repeat(64)) {
      const implAddress = '0x' + slot.slice(-40);
      if (implAddress.toLowerCase() !== '0x' + '0'.repeat(40)) {
        return { isProxy: true, implementationAddress: implAddress };
      }
    }
    return { isProxy: false };
  } catch {
    return { isProxy: false };
  }
}

/**
 * Extended verification result with upgrade awareness
 */
interface VerificationResult {
  verified: boolean;
  deployedAt?: Date;
  ageInDays?: number;
  // Proxy/upgrade info
  proxyType?: 'transparent' | 'uups' | 'beacon' | 'unknown';
  adminAddress?: string;
  upgradeCount?: number;
  lastUpgradeDate?: Date;
}

/**
 * Check verification status of a single address
 * Also returns proxy/upgrade info if available
 */
async function checkVerification(
  address: string,
  chain: SupportedChain
): Promise<VerificationResult> {
  try {
    const registry = getProviderRegistry();
    if (!registry.hasCapability('ContractMetadata', chain)) {
      return { verified: false };
    }

    const result = await registry.getContractMetadata({
      address,
      chain,
      includeAbi: false,
    });

    if (!result.success || !result.data) {
      return { verified: false };
    }

    let deployedAt: Date | undefined;
    let ageInDays: number | undefined;

    if (result.data.deployment?.timestamp) {
      let timestampMs: number;
      const rawTimestamp = result.data.deployment.timestamp;

      if (typeof rawTimestamp === 'number') {
        timestampMs = rawTimestamp < 1e12 ? rawTimestamp * 1000 : rawTimestamp;
      } else if (typeof rawTimestamp === 'string') {
        const parsed = parseInt(rawTimestamp, 10);
        timestampMs = parsed < 1e12 ? parsed * 1000 : parsed;
      } else {
        timestampMs = Date.now();
      }

      deployedAt = new Date(timestampMs);
      ageInDays = Math.floor(
        (Date.now() - deployedAt.getTime()) / (1000 * 60 * 60 * 24)
      );
    }

    // Extract proxy/upgrade info
    const proxyType = result.data.proxy?.proxyType;
    const adminAddress = result.data.proxy?.adminAddress;
    const upgradeCount = result.data.upgrades?.length;
    let lastUpgradeDate: Date | undefined;

    if (result.data.upgrades && result.data.upgrades.length > 0) {
      // Get most recent upgrade
      const lastUpgrade = result.data.upgrades[result.data.upgrades.length - 1];
      if (lastUpgrade.timestamp) {
        const ts = typeof lastUpgrade.timestamp === 'string'
          ? parseInt(lastUpgrade.timestamp, 10)
          : lastUpgrade.timestamp;
        const tsMs = ts < 1e12 ? ts * 1000 : ts;
        lastUpgradeDate = new Date(tsMs);
      }
    }

    return {
      verified: result.data.verified,
      deployedAt,
      ageInDays,
      proxyType,
      adminAddress,
      upgradeCount,
      lastUpgradeDate,
    };
  } catch {
    return { verified: false };
  }
}

/**
 * Check safety of a contract before interacting
 * Now properly handles proxy contracts by checking both proxy and implementation
 *
 * @param address - Contract address
 * @param chain - Chain to check on
 * @returns Safety result with warnings
 */
export async function checkContractSafety(
  address: string,
  chain: SupportedChain
): Promise<ContractSafetyResult> {
  const warnings: SafetyWarning[] = [];

  // First, check if this is a proxy
  const proxyInfo = await resolveProxyForSafety(address, chain);

  // Check verification of the primary address
  const primaryCheck = await checkVerification(address, chain);
  let isVerified = primaryCheck.verified;
  const deployedAt = primaryCheck.deployedAt;
  const ageInDays = primaryCheck.ageInDays;

  // Extract upgrade awareness info from primary check
  let proxyType = primaryCheck.proxyType;
  let adminAddress = primaryCheck.adminAddress;
  let upgradeCount = primaryCheck.upgradeCount;
  let lastUpgradeDate = primaryCheck.lastUpgradeDate;

  // If it's a proxy, also check implementation verification
  let implementationVerified: boolean | undefined;
  if (proxyInfo.isProxy && proxyInfo.implementationAddress) {
    const implCheck = await checkVerification(proxyInfo.implementationAddress, chain);
    implementationVerified = implCheck.verified;

    // For proxies: we care most about implementation verification since that's the code that runs
    if (!implCheck.verified) {
      warnings.push({
        severity: 'danger',
        code: 'UNVERIFIED_IMPLEMENTATION',
        title: 'Unverified Implementation',
        description: `This proxy's implementation contract (\`${proxyInfo.implementationAddress.slice(0, 10)}...\`) is not verified. Cannot review the actual code that will execute.`,
        recommendation: 'Only interact if you trust the proxy deployer.',
      });
    } else if (!primaryCheck.verified) {
      // Implementation verified but proxy isn't - this is common and less concerning
      warnings.push({
        severity: 'info',
        code: 'UNVERIFIED_PROXY',
        title: 'Unverified Proxy (Implementation Verified)',
        description: 'The proxy contract is not verified, but the implementation is. The actual code is reviewable.',
      });
    }

    // For overall isVerified, implementation verification is what matters for proxies
    isVerified = implCheck.verified;

    // Check implementation age for upgrades
    if (implCheck.ageInDays !== undefined && implCheck.ageInDays < 7) {
      warnings.push({
        severity: 'warning',
        code: 'RECENT_UPGRADE',
        title: 'Recently Upgraded',
        description: `This proxy was upgraded ${implCheck.ageInDays} day${implCheck.ageInDays !== 1 ? 's' : ''} ago. New implementations haven't been battle-tested.`,
        recommendation: 'Review the upgrade changes before using large amounts.',
      });
    }

    // If implementation also has proxy/upgrade info, merge it
    if (implCheck.proxyType) proxyType = implCheck.proxyType;
    if (implCheck.adminAddress) adminAddress = implCheck.adminAddress;
    if (implCheck.upgradeCount) upgradeCount = implCheck.upgradeCount;
    if (implCheck.lastUpgradeDate) lastUpgradeDate = implCheck.lastUpgradeDate;
  } else {
    // Not a proxy - standard verification check
    if (!isVerified) {
      warnings.push({
        severity: 'danger',
        code: 'UNVERIFIED_CONTRACT',
        title: 'Unverified Contract',
        description: 'This contract has not been verified on the block explorer. Source code is not available for review.',
        recommendation: 'Only interact with unverified contracts if you fully trust the source.',
      });
    }
  }

  // Warning: Upgradeable contract with admin address
  if (adminAddress) {
    warnings.push({
      severity: 'info',
      code: 'UPGRADEABLE_CONTRACT',
      title: 'Upgradeable Contract',
      description: `This contract can be upgraded by admin \`${adminAddress.slice(0, 10)}...\`${proxyType ? ` (${proxyType} proxy)` : ''}.`,
      recommendation: 'Upgradeable contracts may change behavior. Verify you trust the admin.',
    });
  }

  // Warning: Multiple upgrades
  if (upgradeCount && upgradeCount > 3) {
    warnings.push({
      severity: 'info',
      code: 'FREQUENTLY_UPGRADED',
      title: 'Frequently Upgraded',
      description: `This contract has been upgraded ${upgradeCount} times.`,
      recommendation: 'Frequent upgrades may indicate active development or potential instability.',
    });
  }

  // Warning: New contract (< 30 days old) - applies to both proxy and non-proxy
  if (ageInDays !== undefined && ageInDays < 30) {
    warnings.push({
      severity: 'warning',
      code: 'NEW_CONTRACT',
      title: 'Recently Deployed Contract',
      description: `This contract was deployed ${ageInDays} day${ageInDays !== 1 ? 's' : ''} ago. New contracts haven't been battle-tested.`,
      recommendation: 'Be cautious with large amounts on new contracts.',
    });
  }

  // Calculate overall risk
  let overallRisk: 'low' | 'medium' | 'high' = 'low';
  if (warnings.some(w => w.severity === 'danger')) {
    overallRisk = 'high';
  } else if (warnings.some(w => w.severity === 'warning')) {
    overallRisk = 'medium';
  }

  return {
    address,
    chain,
    isVerified,
    deployedAt,
    ageInDays,
    warnings,
    overallRisk,
    // Proxy info
    isProxy: proxyInfo.isProxy,
    implementationAddress: proxyInfo.implementationAddress,
    implementationVerified,
    // Upgrade awareness
    proxyType,
    adminAddress,
    upgradeCount,
    lastUpgradeDate,
  };
}

// ============================================================================
// Simulation Safety
// ============================================================================

/**
 * Simulate a transaction and check for safety issues
 *
 * @param transaction - Transaction to simulate
 * @param userAddress - User's wallet address
 * @param chain - Chain to simulate on
 * @returns Simulation result with safety warnings
 */
export async function simulateWithSafetyChecks(
  transaction: {
    to: string;
    data?: string;
    value?: string;
  },
  userAddress: string,
  chain: SupportedChain
): Promise<SimulationSafetyResult> {
  const warnings: SafetyWarning[] = [];
  const balanceChanges: BalanceChange[] = [];

  // Validate addresses (GPT-5.2 recommendation)
  if (!isAddress(transaction.to)) {
    warnings.push({
      severity: 'danger',
      code: 'INVALID_ADDRESS',
      title: 'Invalid Target Address',
      description: 'The target address is not a valid Ethereum address.',
    });
    return { success: false, willRevert: true, balanceChanges: [], warnings };
  }

  if (!isAddress(userAddress)) {
    warnings.push({
      severity: 'danger',
      code: 'INVALID_SENDER',
      title: 'Invalid Sender Address',
      description: 'The sender address is not valid.',
    });
    return { success: false, willRevert: true, balanceChanges: [], warnings };
  }

  try {
    const client = createPublicClient({
      chain: CHAINS[chain].chain,
      transport: http(getRpcUrl(chain)),
    });

    // Check if target is actually a contract (GPT-5.2 recommendation)
    const bytecode = await client.getBytecode({ address: transaction.to as Address });
    if (!bytecode || bytecode === '0x') {
      warnings.push({
        severity: 'warning',
        code: 'NOT_A_CONTRACT',
        title: 'Target is Not a Contract',
        description: 'The target address has no bytecode. This is an EOA or selfdestructed contract.',
        recommendation: 'Verify this is the correct address.',
      });
    }

    // Try Tenderly simulation first for rich balance change data
    let gasEstimate: bigint | undefined;
    let usedTenderly = false;

    if (isTenderlyConfigured()) {
      const tenderlyResult = await simulateWithTenderly(transaction, userAddress, chain);

      if (tenderlyResult) {
        usedTenderly = true;

        // If Tenderly says it will revert, trust that
        if (tenderlyResult.willRevert) {
          warnings.push({
            severity: 'danger',
            code: 'SIMULATION_FAILED',
            title: 'Transaction Would Fail',
            description: tenderlyResult.revertReason || 'Transaction would revert',
            recommendation: 'Do not proceed - this transaction will fail and waste gas.',
          });

          return {
            success: false,
            willRevert: true,
            revertReason: tenderlyResult.revertReason,
            balanceChanges: [],
            warnings,
          };
        }

        // Convert Tenderly balance changes to our format
        for (const change of tenderlyResult.balanceChanges) {
          balanceChanges.push({
            token: change.token,
            symbol: change.symbol,
            before: '0', // Tenderly doesn't give before/after, just the change
            after: '0',
            change: change.formattedAmount,
            direction: change.direction,
          });
        }

        gasEstimate = BigInt(tenderlyResult.gasUsed);

        // Add info about Tenderly usage
        if (balanceChanges.length > 0) {
          warnings.push({
            severity: 'info',
            code: 'TENDERLY_SIMULATION',
            title: 'Simulated with Tenderly',
            description: `Found ${balanceChanges.length} token balance change(s).`,
          });
        }
      }
    }

    // Fall back to basic estimateGas if Tenderly not available or failed
    if (!usedTenderly) {
      gasEstimate = await client.estimateGas({
        account: userAddress as Address,
        to: transaction.to as Address,
        data: (transaction.data || '0x') as Hex,
        value: transaction.value ? BigInt(transaction.value) : 0n,
      });
    }

    // Check contract safety
    const contractSafety = await checkContractSafety(transaction.to, chain);
    warnings.push(...contractSafety.warnings);

    // Warning: High value transaction (use formatEther for precision - GPT-5.2 recommendation)
    if (transaction.value) {
      try {
        const valueBigInt = BigInt(transaction.value);
        const valueInEth = formatEther(valueBigInt);
        const valueNum = parseFloat(valueInEth);
        if (valueNum > 1) {
          warnings.push({
            severity: 'info',
            code: 'HIGH_VALUE',
            title: 'Significant Value Transfer',
            description: `This transaction sends ${valueInEth} ETH.`,
          });
        }
      } catch {
        // Invalid value format - ignore the high value warning
      }
    }

    return {
      success: true,
      willRevert: false,
      balanceChanges,
      gasEstimate: gasEstimate?.toString(),
      warnings,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Distinguish revert vs RPC/network failure (GPT-5.2 recommendation)
    const isRevertError = errorMessage.includes('execution reverted') ||
                          errorMessage.includes('revert') ||
                          errorMessage.includes('require') ||
                          errorMessage.includes('CALL_EXCEPTION');

    const isNetworkError = errorMessage.includes('timeout') ||
                           errorMessage.includes('ECONNREFUSED') ||
                           errorMessage.includes('network') ||
                           errorMessage.includes('rate limit') ||
                           errorMessage.includes('503') ||
                           errorMessage.includes('502');

    if (isNetworkError) {
      // Simulation unavailable - this will block execution (mandatory simulation policy)
      warnings.push({
        severity: 'danger',
        code: 'SIMULATION_UNAVAILABLE',
        title: 'Simulation Unavailable',
        description: 'Could not simulate transaction due to network issues.',
        recommendation: 'Cannot proceed without simulation. Try again when network is available.',
      });

      return {
        success: false,
        willRevert: false,
        simulationUnavailable: true,
        balanceChanges: [],
        warnings,
      };
    }

    // Extract revert reason with better parsing (GPT-5.2 recommendation)
    let revertReason = 'Transaction simulation failed';
    if (isRevertError) {
      // Try multiple patterns for revert reason extraction
      const patterns = [
        /execution reverted: (.+)/,
        /reverted with reason string ["'](.+?)["']/,
        /revert (.+)/i,
        /Error: (.+)/,
      ];
      for (const pattern of patterns) {
        const match = errorMessage.match(pattern);
        if (match) {
          revertReason = match[1].trim();
          break;
        }
      }
    }

    warnings.push({
      severity: 'danger',
      code: 'SIMULATION_FAILED',
      title: 'Transaction Would Fail',
      description: revertReason,
      recommendation: 'Do not proceed - this transaction will fail and waste gas.',
    });

    return {
      success: false,
      willRevert: true,
      revertReason,
      balanceChanges: [],
      warnings,
    };
  }
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format safety warnings for LLM consumption
 */
export function formatSafetyWarnings(warnings: SafetyWarning[]): string {
  if (warnings.length === 0) {
    return '✅ No safety warnings detected.';
  }

  const lines: string[] = [];

  // Group by severity
  const danger = warnings.filter(w => w.severity === 'danger');
  const warning = warnings.filter(w => w.severity === 'warning');
  const info = warnings.filter(w => w.severity === 'info');

  if (danger.length > 0) {
    lines.push('### 🔴 Critical Warnings');
    for (const w of danger) {
      lines.push(`- **${w.title}**: ${w.description}`);
      if (w.recommendation) {
        lines.push(`  _${w.recommendation}_`);
      }
    }
    lines.push('');
  }

  if (warning.length > 0) {
    lines.push('### 🟡 Warnings');
    for (const w of warning) {
      lines.push(`- **${w.title}**: ${w.description}`);
      if (w.recommendation) {
        lines.push(`  _${w.recommendation}_`);
      }
    }
    lines.push('');
  }

  if (info.length > 0) {
    lines.push('### ℹ️ Notes');
    for (const w of info) {
      lines.push(`- **${w.title}**: ${w.description}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format simulation result for LLM consumption
 */
export function formatSimulationResult(result: SimulationSafetyResult): string {
  const lines: string[] = [];

  lines.push('## Transaction Simulation');
  lines.push('');

  if (result.willRevert) {
    lines.push('❌ **This transaction would FAIL**');
    lines.push('');
    lines.push(`**Reason:** ${result.revertReason}`);
    lines.push('');
    lines.push('_Do not proceed - you will lose gas fees with no result._');
  } else {
    lines.push('✅ **Transaction will succeed**');
    lines.push('');

    if (result.gasEstimate) {
      const gasInGwei = (Number(result.gasEstimate) * 30) / 1e9; // Assume 30 gwei
      lines.push(`**Estimated Gas:** ${result.gasEstimate} (~${gasInGwei.toFixed(4)} ETH at 30 gwei)`);
    }

    if (result.balanceChanges.length > 0) {
      lines.push('');
      lines.push('**Expected Balance Changes:**');
      for (const change of result.balanceChanges) {
        const symbol = change.symbol || 'tokens';
        const prefix = change.direction === 'increase' ? '+' : change.direction === 'decrease' ? '-' : '';
        lines.push(`- ${prefix}${change.change} ${symbol}`);
      }
    }
  }

  // Add safety warnings
  if (result.warnings.length > 0) {
    lines.push('');
    lines.push(formatSafetyWarnings(result.warnings));
  }

  return lines.join('\n');
}

/**
 * Check if it's safe to proceed based on simulation result
 * Returns true only if simulation succeeded with no critical warnings.
 *
 * SECURITY: Blocks when simulation is unavailable (GPT-5.2 recommendation).
 * This enforces the "mandatory simulation" guarantee - if we can't verify
 * the transaction won't fail, we shouldn't allow execution.
 */
export function isSafeToProceed(result: SimulationSafetyResult): boolean {
  // Block if transaction would revert
  if (result.willRevert) return false;

  // Block if simulation was unavailable (network/RPC failure)
  // This enforces "mandatory simulation" - can't proceed without verification
  if (result.simulationUnavailable) return false;

  // Block if any danger-level warnings
  return !result.warnings.some(w => w.severity === 'danger');
}
