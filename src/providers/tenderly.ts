/**
 * Tenderly Simulation Provider
 *
 * Provides transaction simulation with full state diffs and balance changes.
 * This replaces basic `estimateGas()` with rich simulation data.
 *
 * Free tier: 25M TU/month = ~62,500 simulations
 * Cost: 400 TU per simulation
 */

import { formatUnits, type Hex } from 'viem';
import { getChainId, type SupportedChain } from '../config/chains.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Tenderly API configuration
 * Set via environment variables
 */
export interface TenderlyConfig {
  apiKey: string;
  accountSlug: string;
  projectSlug: string;
}

/**
 * Get Tenderly config from environment
 */
export function getTenderlyConfig(): TenderlyConfig | null {
  const apiKey = process.env.TENDERLY_API_KEY;
  const accountSlug = process.env.TENDERLY_ACCOUNT_SLUG || 'jamm';
  const projectSlug = process.env.TENDERLY_PROJECT_SLUG || 'project';

  if (!apiKey) {
    return null;
  }

  return { apiKey, accountSlug, projectSlug };
}

/**
 * Check if Tenderly is configured
 */
export function isTenderlyConfigured(): boolean {
  return getTenderlyConfig() !== null;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Tenderly simulation request
 */
interface TenderlySimulationRequest {
  network_id: string;
  from: string;
  to: string;
  input: string;
  value: string;
  gas?: number;
  gas_price?: string;
  save?: boolean;
  save_if_fails?: boolean;
  simulation_type?: 'quick' | 'full';
}

/**
 * Tenderly simulation response
 */
interface TenderlySimulationResponse {
  transaction: {
    hash: string;
    block_number: number;
    from: string;
    to: string;
    gas: number;
    gas_price: string;
    gas_used: number;
    value: string;
    input: string;
    status: boolean;
    error_message?: string;
  };
  simulation: {
    id: string;
    project_id: string;
    status: boolean;
    block_number: number;
    gas_used: number;
    error_message?: string;
  };
  contracts?: Array<{
    address: string;
    contract_name?: string;
  }>;
  // Asset changes from simulation
  transaction_info?: {
    asset_changes?: Array<{
      token_info: {
        standard: string;
        type: string;
        contract_address: string;
        symbol?: string;
        name?: string;
        decimals?: number;
      };
      from?: string;
      to?: string;
      raw_amount: string;
      amount?: string;
      type: 'Transfer' | 'Mint' | 'Burn';
    }>;
    balance_changes?: Array<{
      address: string;
      dollar_value?: string;
      transfers?: Array<{
        token_info: {
          contract_address: string;
          symbol?: string;
          decimals?: number;
        };
        from?: string;
        to?: string;
        raw_amount: string;
      }>;
    }>;
    logs?: Array<{
      address: string;
      name?: string;
      inputs?: Array<{
        name: string;
        value: string;
      }>;
    }>;
  };
}

/**
 * Parsed balance change from Tenderly
 */
export interface TenderlyBalanceChange {
  token: string;
  symbol?: string;
  decimals: number;
  rawAmount: string;
  formattedAmount: string;
  direction: 'increase' | 'decrease';
  from?: string;
  to?: string;
}

/**
 * Result of Tenderly simulation
 */
export interface TenderlySimulationResult {
  success: boolean;
  willRevert: boolean;
  revertReason?: string;
  gasUsed: number;
  balanceChanges: TenderlyBalanceChange[];
  logs?: Array<{
    address: string;
    name?: string;
    inputs?: Record<string, string>;
  }>;
}

// ============================================================================
// API Client
// ============================================================================

/**
 * Simulate a transaction using Tenderly API
 */
export async function simulateWithTenderly(
  transaction: {
    to: string;
    data?: string;
    value?: string;
  },
  userAddress: string,
  chain: SupportedChain
): Promise<TenderlySimulationResult | null> {
  const config = getTenderlyConfig();
  if (!config) {
    return null; // Tenderly not configured, fall back to basic simulation
  }

  const chainId = getChainId(chain);
  const apiUrl = `https://api.tenderly.co/api/v1/account/${config.accountSlug}/project/${config.projectSlug}/simulate`;

  const request: TenderlySimulationRequest = {
    network_id: chainId.toString(),
    from: userAddress,
    to: transaction.to,
    input: transaction.data || '0x',
    value: transaction.value || '0',
    save: false, // Don't save to dashboard (saves TU)
    save_if_fails: false,
    simulation_type: 'full', // Get full state diffs and balance changes
  };

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Key': config.apiKey,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Tenderly API error:', response.status, errorText);
      return null; // Fall back to basic simulation
    }

    const data = await response.json() as TenderlySimulationResponse;

    // Parse the response
    return parseSimulationResponse(data, userAddress);
  } catch (error) {
    console.error('Tenderly simulation failed:', error);
    return null; // Fall back to basic simulation
  }
}

/**
 * Parse Tenderly response into our format
 */
function parseSimulationResponse(
  data: TenderlySimulationResponse,
  userAddress: string
): TenderlySimulationResult {
  const willRevert = !data.simulation.status || !data.transaction.status;
  const revertReason = data.simulation.error_message || data.transaction.error_message;

  // Extract balance changes for the user
  const balanceChanges: TenderlyBalanceChange[] = [];

  // Parse asset_changes (more detailed)
  if (data.transaction_info?.asset_changes) {
    for (const change of data.transaction_info.asset_changes) {
      // Check if this change affects the user
      const isIncoming = change.to?.toLowerCase() === userAddress.toLowerCase();
      const isOutgoing = change.from?.toLowerCase() === userAddress.toLowerCase();

      if (isIncoming || isOutgoing) {
        const decimals = change.token_info.decimals || 18;
        const rawAmount = change.raw_amount;
        const formattedAmount = formatUnits(BigInt(rawAmount), decimals);

        balanceChanges.push({
          token: change.token_info.contract_address,
          symbol: change.token_info.symbol,
          decimals,
          rawAmount,
          formattedAmount,
          direction: isIncoming ? 'increase' : 'decrease',
          from: change.from,
          to: change.to,
        });
      }
    }
  }

  // Parse logs for additional context
  const logs = data.transaction_info?.logs?.map(log => ({
    address: log.address,
    name: log.name,
    inputs: log.inputs?.reduce((acc, input) => {
      acc[input.name] = input.value;
      return acc;
    }, {} as Record<string, string>),
  }));

  return {
    success: !willRevert,
    willRevert,
    revertReason,
    gasUsed: data.transaction.gas_used || data.simulation.gas_used,
    balanceChanges,
    logs,
  };
}

/**
 * Format Tenderly balance changes for display
 */
export function formatTenderlyBalanceChanges(changes: TenderlyBalanceChange[]): string {
  if (changes.length === 0) {
    return 'No token balance changes detected.';
  }

  const lines: string[] = ['**Expected Balance Changes:**'];

  for (const change of changes) {
    const symbol = change.symbol || `${change.token.slice(0, 8)}...`;
    const prefix = change.direction === 'increase' ? '+' : '-';
    const amount = parseFloat(change.formattedAmount).toFixed(6);
    lines.push(`- ${prefix}${amount} ${symbol}`);
  }

  return lines.join('\n');
}
