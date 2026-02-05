/**
 * Prepared Transaction Cache
 *
 * Stores prepared transactions between wallet_call (simulate) and
 * wallet_executePrepared (execute) to prevent "model drift".
 *
 * Key benefits:
 * - Exact same calldata is executed as was simulated
 * - No re-encoding between phases
 * - Expiry prevents stale transactions from being executed
 */

import type { Hex } from 'viem';
import type { SupportedChain } from '../config/chains.js';

/**
 * A prepared transaction ready for execution
 */
export interface PreparedTransaction {
  id: string;
  createdAt: number;
  expiresAt: number;

  // Transaction data
  to: Hex;
  data: Hex;
  value: bigint;
  chainId: number;
  chain: SupportedChain;

  // Metadata for display
  contractName?: string;
  functionName: string;
  functionSignature: string;
  args: unknown[];

  // Simulation results
  simulation: {
    success: boolean;
    gasEstimate: bigint;
    gasEstimateFormatted: string;
    error?: string;
    returnData?: Hex;
    decodedReturn?: unknown;
  };
}

// In-memory cache with expiry
const preparedTxCache = new Map<string, PreparedTransaction>();

// Default expiry: 5 minutes (transactions can go stale due to nonce/gas changes)
const DEFAULT_EXPIRY_MS = 5 * 60 * 1000;

/**
 * Generate a unique prepared transaction ID
 */
function generateTxId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `ptx_${timestamp}_${random}`;
}

/**
 * Store a prepared transaction
 */
export function storePreparedTx(
  tx: Omit<PreparedTransaction, 'id' | 'createdAt' | 'expiresAt'>,
  expiryMs: number = DEFAULT_EXPIRY_MS
): string {
  const id = generateTxId();
  const now = Date.now();

  const prepared: PreparedTransaction = {
    ...tx,
    id,
    createdAt: now,
    expiresAt: now + expiryMs,
  };

  preparedTxCache.set(id, prepared);

  // Clean up expired entries periodically
  cleanupExpired();

  return id;
}

/**
 * Retrieve a prepared transaction by ID
 */
export function getPreparedTx(id: string): PreparedTransaction | null {
  const tx = preparedTxCache.get(id);

  if (!tx) {
    return null;
  }

  // Check expiry
  if (Date.now() > tx.expiresAt) {
    preparedTxCache.delete(id);
    return null;
  }

  return tx;
}

/**
 * Delete a prepared transaction (after execution or cancellation)
 */
export function deletePreparedTx(id: string): boolean {
  return preparedTxCache.delete(id);
}

/**
 * Clean up expired prepared transactions
 */
function cleanupExpired(): void {
  const now = Date.now();
  for (const [id, tx] of preparedTxCache) {
    if (now > tx.expiresAt) {
      preparedTxCache.delete(id);
    }
  }
}

/**
 * Get all active prepared transactions (for debugging/listing)
 */
export function listPreparedTxs(): PreparedTransaction[] {
  cleanupExpired();
  return Array.from(preparedTxCache.values());
}

/**
 * Format a prepared transaction for display
 */
export function formatPreparedTx(tx: PreparedTransaction): string {
  const lines: string[] = [];

  lines.push(`## Prepared Transaction: \`${tx.id}\``);
  lines.push('');

  // Contract info
  if (tx.contractName) {
    lines.push(`**Contract:** ${tx.contractName} (\`${tx.to}\`)`);
  } else {
    lines.push(`**Contract:** \`${tx.to}\``);
  }

  // Function call
  lines.push(`**Function:** \`${tx.functionSignature}\``);
  if (tx.args.length > 0) {
    lines.push(`**Args:** ${JSON.stringify(tx.args)}`);
  }

  // Value
  if (tx.value > 0n) {
    const ethValue = Number(tx.value) / 1e18;
    lines.push(`**Value:** ${ethValue.toFixed(6)} ETH`);
  }

  lines.push(`**Chain:** ${tx.chain} (${tx.chainId})`);
  lines.push('');

  // Simulation results
  lines.push('### Simulation Result');
  lines.push('');

  if (tx.simulation.success) {
    lines.push('✅ **Would Succeed**');
    lines.push(`**Gas Estimate:** ${tx.simulation.gasEstimateFormatted}`);
    if (tx.simulation.decodedReturn !== undefined) {
      lines.push(`**Return Value:** ${JSON.stringify(tx.simulation.decodedReturn)}`);
    }
  } else {
    lines.push(`❌ **Would Fail:** ${tx.simulation.error}`);
  }

  // Expiry
  const expiresIn = Math.max(0, tx.expiresAt - Date.now());
  const expiresMinutes = Math.floor(expiresIn / 60000);
  const expiresSeconds = Math.floor((expiresIn % 60000) / 1000);
  lines.push('');
  lines.push(`⏱️ **Expires in:** ${expiresMinutes}m ${expiresSeconds}s`);

  return lines.join('\n');
}
