/**
 * Action Generation Module
 *
 * Builds transaction calldata from ABI for common DeFi actions:
 * - claim() / getReward() - Claim staking rewards
 * - delegate() - Delegate voting power
 * - stake() / deposit() - Stake tokens
 * - withdraw() / unstake() - Withdraw tokens
 * - release() - Release vested tokens
 *
 * The LLM identifies what action to take, this module builds the actual transaction.
 *
 * SAFETY: Uses real ABI from contract when available to prevent selector mismatches
 * with overloaded functions (e.g., claim() vs claim(uint256)).
 */

import { encodeFunctionData, isAddress, getAddress, type Abi, type Hex, type Address } from 'viem';
import type { TokenAnalysis } from './classifier.js';
import type { FunctionInfo } from '../providers/types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Types of actions we can generate
 */
export type ActionType =
  | 'claim_rewards'
  | 'delegate'
  | 'stake'
  | 'unstake'
  | 'withdraw'
  | 'release_vesting'
  | 'exit';  // Combined unstake + claim

/**
 * A generated action ready for simulation/execution
 */
export interface GeneratedAction {
  type: ActionType;
  description: string;
  contractAddress: string;
  functionName: string;
  args: unknown[];
  calldata: Hex;
  value?: string;  // ETH value to send (usually 0)
}

/**
 * Parameters for action generation
 */
export interface ActionParams {
  userAddress: string;
  delegateTo?: string;    // For delegate actions
  amount?: string;        // For stake/withdraw
  tokenId?: string;       // For NFT operations
}

// ============================================================================
// Function Signature Matching
// ============================================================================

/**
 * Find a function by name and expected number of inputs
 * This prevents matching claim() when the contract only has claim(uint256)
 */
function findFunctionBySignature(
  functionSignatures: FunctionInfo[],
  name: string,
  expectedInputCount: number
): FunctionInfo | null {
  const nameLower = name.toLowerCase();
  return functionSignatures.find(
    fn => fn.name.toLowerCase() === nameLower && fn.inputs.length === expectedInputCount
  ) || null;
}

/**
 * Build a viem-compatible ABI fragment from FunctionInfo
 */
function functionInfoToAbi(fn: FunctionInfo): Abi {
  return [{
    name: fn.name,
    type: 'function' as const,
    stateMutability: fn.stateMutability,
    inputs: fn.inputs.map(input => ({
      name: input.name,
      type: input.type,
    })),
    outputs: fn.outputs.map(output => ({
      name: output.name,
      type: output.type,
    })),
  }];
}

/**
 * Try to generate calldata using real ABI from contract
 * Falls back to guessed ABI if real one not available
 */
function encodeWithRealAbi(
  functionSignatures: FunctionInfo[],
  name: string,
  args: unknown[],
  fallbackAbi: Abi
): { calldata: Hex; usedRealAbi: boolean } {
  // Try to find exact signature match
  const realFn = findFunctionBySignature(functionSignatures, name, args.length);

  if (realFn) {
    // Use real ABI from contract
    const realAbi = functionInfoToAbi(realFn);
    const calldata = encodeFunctionData({
      abi: realAbi,
      functionName: name,
      args,
    });
    return { calldata, usedRealAbi: true };
  }

  // Fall back to guessed ABI
  const calldata = encodeFunctionData({
    abi: fallbackAbi,
    functionName: name,
    args,
  });
  return { calldata, usedRealAbi: false };
}

/**
 * Check if a function with exact signature exists
 */
function hasFunction(
  availableFunctions: string[],
  functionSignatures: FunctionInfo[],
  name: string,
  expectedInputCount: number
): boolean {
  // First check by name (legacy support)
  const hasName = availableFunctions.some(f => f.toLowerCase() === name.toLowerCase());
  if (!hasName) return false;

  // If we have signatures, verify input count matches
  if (functionSignatures.length > 0) {
    return findFunctionBySignature(functionSignatures, name, expectedInputCount) !== null;
  }

  // No signatures available, trust name-only match
  return true;
}

// ============================================================================
// Common Function ABIs (Fallbacks)
// ============================================================================

/**
 * ABI fragments for common functions
 * These are used as FALLBACKS when real ABI is not available
 * IMPORTANT: Always prefer real ABI from functionSignatures when available
 */
const COMMON_ABIS: Record<string, Abi> = {
  // Claiming rewards (various names)
  getReward: [{
    name: 'getReward',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  }],
  claim: [{
    name: 'claim',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  }],
  claimReward: [{
    name: 'claimReward',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  }],
  claimRewards: [{
    name: 'claimRewards',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  }],
  harvest: [{
    name: 'harvest',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  }],

  // Delegation
  delegate: [{
    name: 'delegate',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'delegatee', type: 'address' }],
    outputs: [],
  }],

  // Staking
  stake: [{
    name: 'stake',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  }],
  stakeNoArgs: [{
    name: 'stake',
    type: 'function',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  }],

  // Unstaking / Withdrawal
  unstake: [{
    name: 'unstake',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  }],
  withdraw: [{
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  }],
  withdrawNoArgs: [{
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  }],

  // Exit (unstake + claim combined)
  exit: [{
    name: 'exit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  }],

  // Vesting release
  release: [{
    name: 'release',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  }],
  releaseWithToken: [{
    name: 'release',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [],
  }],
};

// ============================================================================
// Action Generation
// ============================================================================

/**
 * Generate a claim rewards action
 *
 * SAFETY: Uses real ABI from contract when available to prevent
 * selector mismatches with overloaded claim functions
 */
export function generateClaimAction(
  contractAddress: string,
  availableFunctions: string[],
  functionSignatures: FunctionInfo[] = []
): GeneratedAction | null {
  // Try different claim function names in order of preference
  // All these are no-arg functions (hence expectedInputCount: 0)
  const claimFunctions = [
    { name: 'getReward', abi: COMMON_ABIS.getReward },
    { name: 'claim', abi: COMMON_ABIS.claim },
    { name: 'claimReward', abi: COMMON_ABIS.claimReward },
    { name: 'claimRewards', abi: COMMON_ABIS.claimRewards },
    { name: 'harvest', abi: COMMON_ABIS.harvest },
  ];

  for (const { name, abi } of claimFunctions) {
    // Check if this exact function exists (name + 0 inputs)
    if (hasFunction(availableFunctions, functionSignatures, name, 0)) {
      const { calldata } = encodeWithRealAbi(functionSignatures, name, [], abi);

      return {
        type: 'claim_rewards',
        description: `Claim pending rewards by calling ${name}()`,
        contractAddress,
        functionName: name,
        args: [],
        calldata,
      };
    }
  }

  return null;
}

/**
 * Generate a delegate voting power action
 *
 * SAFETY: Uses real ABI from contract, validates address format
 */
export function generateDelegateAction(
  contractAddress: string,
  delegateTo: string,
  availableFunctions: string[],
  functionSignatures: FunctionInfo[] = []
): GeneratedAction | null {
  // Check if delegate(address) exists (1 input)
  if (!hasFunction(availableFunctions, functionSignatures, 'delegate', 1)) {
    return null;
  }

  // Validate delegateTo is a valid address (critical: prevents invalid calldata)
  if (!isAddress(delegateTo)) {
    return null;
  }

  // Use checksummed address for safety (prevents phishing via lookalike addresses)
  const checksummedAddress = getAddress(delegateTo) as Address;

  const { calldata } = encodeWithRealAbi(
    functionSignatures,
    'delegate',
    [checksummedAddress],
    COMMON_ABIS.delegate
  );

  return {
    type: 'delegate',
    // Show full checksum address to prevent phishing (GPT-5.2 security recommendation)
    description: `Delegate voting power to ${checksummedAddress}`,
    contractAddress,
    functionName: 'delegate',
    args: [checksummedAddress],
    calldata,
  };
}

/**
 * Generate an exit action (unstake + claim in one tx)
 *
 * SAFETY: Uses real ABI from contract when available
 */
export function generateExitAction(
  contractAddress: string,
  availableFunctions: string[],
  functionSignatures: FunctionInfo[] = []
): GeneratedAction | null {
  // Check if exit() exists (0 inputs)
  if (!hasFunction(availableFunctions, functionSignatures, 'exit', 0)) {
    return null;
  }

  const { calldata } = encodeWithRealAbi(functionSignatures, 'exit', [], COMMON_ABIS.exit);

  return {
    type: 'exit',
    description: 'Exit position: unstake all and claim rewards in one transaction',
    contractAddress,
    functionName: 'exit',
    args: [],
    calldata,
  };
}

/**
 * Generate a release vesting action
 *
 * SAFETY: Uses real ABI from contract when available
 */
export function generateReleaseAction(
  contractAddress: string,
  availableFunctions: string[],
  functionSignatures: FunctionInfo[] = []
): GeneratedAction | null {
  // Check if release() exists (0 inputs)
  if (!hasFunction(availableFunctions, functionSignatures, 'release', 0)) {
    return null;
  }

  const { calldata } = encodeWithRealAbi(functionSignatures, 'release', [], COMMON_ABIS.release);

  return {
    type: 'release_vesting',
    description: 'Release vested tokens that are ready',
    contractAddress,
    functionName: 'release',
    args: [],
    calldata,
  };
}

/**
 * Generate an unstake/withdraw action
 *
 * SAFETY: Uses real ABI from contract, validates amount format
 */
export function generateWithdrawAction(
  contractAddress: string,
  amount: string,
  availableFunctions: string[],
  functionSignatures: FunctionInfo[] = []
): GeneratedAction | null {
  // Validate amount is a valid integer string (base units/wei)
  // BigInt() throws on decimals - we want to catch this early with a better error
  let amountBigInt: bigint;
  try {
    // Only accept integer strings (no decimals - must be in base units)
    if (!/^\d+$/.test(amount)) {
      return null; // Reject non-integer amounts
    }
    amountBigInt = BigInt(amount);
  } catch {
    return null; // Invalid amount format
  }

  // Prefer 'unstake' over 'withdraw' for staking contracts
  // Check for functions with 1 input (the amount)
  let functionToUse: string | null = null;
  if (hasFunction(availableFunctions, functionSignatures, 'unstake', 1)) {
    functionToUse = 'unstake';
  } else if (hasFunction(availableFunctions, functionSignatures, 'withdraw', 1)) {
    functionToUse = 'withdraw';
  }

  if (!functionToUse) {
    return null;
  }

  const fallbackAbi = functionToUse === 'unstake' ? COMMON_ABIS.unstake : COMMON_ABIS.withdraw;
  const { calldata } = encodeWithRealAbi(
    functionSignatures,
    functionToUse,
    [amountBigInt],
    fallbackAbi
  );

  return {
    type: functionToUse === 'unstake' ? 'unstake' : 'withdraw',
    description: `${functionToUse === 'unstake' ? 'Unstake' : 'Withdraw'} tokens from contract`,
    contractAddress,
    functionName: functionToUse,
    // Return bigint for consistency with encoded value (GPT-5.2 recommendation)
    args: [amountBigInt],
    calldata,
  };
}

// ============================================================================
// Smart Action Selection
// ============================================================================

/**
 * Suggest the best action for an opportunity
 *
 * @param analysis - Token analysis result
 * @param opportunityType - Type of opportunity detected
 * @param params - Action parameters (user address, delegate to, etc.)
 * @returns Generated action or null if no suitable action found
 */
export function suggestAction(
  analysis: TokenAnalysis,
  opportunityType: string,
  params: ActionParams
): GeneratedAction | null {
  const fns = analysis.availableFunctions;
  const sigs = analysis.functionSignatures || [];

  switch (opportunityType) {
    case 'unclaimed_rewards':
    case 'claimable':
      return generateClaimAction(analysis.address, fns, sigs);

    case 'governance_vote':
    case 'governance':
      if (params.delegateTo) {
        return generateDelegateAction(analysis.address, params.delegateTo, fns, sigs);
      }
      // Default: delegate to self
      return generateDelegateAction(analysis.address, params.userAddress, fns, sigs);

    case 'vesting_release':
    case 'vestable':
      return generateReleaseAction(analysis.address, fns, sigs);

    case 'exit_position':
      return generateExitAction(analysis.address, fns, sigs);

    default:
      return null;
  }
}

/**
 * Format a generated action for display
 */
export function formatAction(action: GeneratedAction): string {
  const lines: string[] = [];

  lines.push(`## Action: ${action.description}`);
  lines.push('');
  lines.push(`**Contract:** \`${action.contractAddress}\``);
  lines.push(`**Function:** \`${action.functionName}()\``);

  if (action.args.length > 0) {
    lines.push(`**Arguments:** ${action.args.map(a => String(a)).join(', ')}`);
  }

  lines.push('');
  lines.push('_This action will be simulated before execution._');

  return lines.join('\n');
}
