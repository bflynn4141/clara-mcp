/**
 * Smart EIP-1559 Gas Estimation
 *
 * Implements block-sampling based gas estimation inspired by evm-wallet-skill.
 * Analyzes recent blocks to determine optimal gas parameters.
 *
 * Key improvements over basic estimation:
 * - Samples priority fees from actual recent transactions (not just current gas price)
 * - Uses percentile-based selection (75th) to avoid outliers
 * - Applies safety margin to base fee for price volatility
 * - Provides consistent gas limit buffers
 *
 * @see https://eips.ethereum.org/EIPS/eip-1559 for EIP-1559 background
 */

import { type PublicClient, formatGwei as viemFormatGwei } from 'viem';

/**
 * Gas estimation result with EIP-1559 parameters
 */
export interface GasEstimate {
  /** Maximum total fee per gas unit (base + priority) */
  maxFeePerGas: bigint;
  /** Maximum priority fee (tip to validators) */
  maxPriorityFeePerGas: bigint;
  /** Current base fee from latest block */
  baseFeePerGas: bigint;
  /** Human-readable values for logging */
  formatted: {
    maxFeeGwei: string;
    priorityFeeGwei: string;
    baseFeeGwei: string;
  };
}

/**
 * Options for gas estimation
 */
export interface GasEstimateOptions {
  /**
   * Safety margin multiplier for base fee (default: 2)
   * Higher values protect against base fee spikes but cost more
   */
  safetyMargin?: number;
  /**
   * Percentile of priority fees to use (default: 75)
   * 75th percentile is a good balance between speed and cost
   */
  priorityFeePercentile?: number;
  /**
   * Number of blocks to sample for priority fee analysis (default: 10)
   */
  blocksToSample?: number;
}

/**
 * Format wei to gwei string
 */
function formatGwei(wei: bigint): string {
  const gwei = Number(wei) / 1_000_000_000;
  return gwei.toFixed(4);
}

/**
 * Estimate priority fee by sampling recent block transactions
 *
 * Analyzes transactions from recent blocks to find realistic priority fees.
 * Uses percentile selection to avoid outliers (e.g., MEV bots paying extreme fees).
 *
 * @param client - Viem public client
 * @param percentile - Which percentile to use (0-100, default 75)
 * @param blocksToSample - How many blocks to analyze (default 10)
 */
async function estimatePriorityFee(
  client: PublicClient,
  percentile: number = 75,
  blocksToSample: number = 10
): Promise<bigint> {
  try {
    const latestBlockNumber = await client.getBlockNumber();
    const priorityFees: bigint[] = [];

    // Sample every other block for efficiency
    const step = 2n;
    const startBlock = latestBlockNumber - BigInt(blocksToSample * 2);

    for (let i = 0; i < blocksToSample; i++) {
      const blockNumber = startBlock + BigInt(i) * step;

      try {
        const block = await client.getBlock({
          blockNumber,
          includeTransactions: true,
        });

        if (block.transactions && Array.isArray(block.transactions)) {
          // Sample up to 10 transactions per block
          const txs = block.transactions.slice(0, 10);
          for (const tx of txs) {
            // Only include EIP-1559 transactions (they have maxPriorityFeePerGas)
            if (typeof tx === 'object' && tx.maxPriorityFeePerGas) {
              priorityFees.push(tx.maxPriorityFeePerGas);
            }
          }
        }
      } catch {
        // Skip blocks that fail to fetch
        continue;
      }
    }

    if (priorityFees.length === 0) {
      // Fallback: 0.1 gwei (reasonable default for L2s like Base)
      console.error('[gas] No priority fees found in recent blocks, using fallback');
      return 100_000_000n; // 0.1 gwei
    }

    // Sort and get percentile
    priorityFees.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const index = Math.floor((percentile / 100) * (priorityFees.length - 1));
    const selectedFee = priorityFees[index];

    // Ensure minimum of 0.01 gwei (some chains need non-zero priority)
    const minPriorityFee = 10_000_000n; // 0.01 gwei
    return selectedFee > minPriorityFee ? selectedFee : minPriorityFee;
  } catch (error) {
    // Fallback on any error
    console.error('[gas] Priority fee estimation failed:', error);
    return 100_000_000n; // 0.1 gwei fallback
  }
}

/**
 * Smart EIP-1559 gas estimation
 *
 * Calculates optimal gas parameters by:
 * 1. Getting current base fee from latest block
 * 2. Sampling priority fees from recent transactions
 * 3. Applying safety margin: maxFee = (safetyMargin × baseFee) + priorityFee
 *
 * This approach is more reliable than simply doubling gas price because:
 * - It accounts for actual network conditions (priority fee sampling)
 * - It handles base fee volatility (safety margin)
 * - It works well on both L1 (Ethereum) and L2s (Base, Optimism)
 *
 * @param client - Viem public client connected to target chain
 * @param options - Estimation options
 * @returns Gas parameters for EIP-1559 transaction
 *
 * @example
 * ```ts
 * const gas = await estimateGas(publicClient);
 * const tx = await walletClient.sendTransaction({
 *   to: '0x...',
 *   value: parseEther('0.1'),
 *   maxFeePerGas: gas.maxFeePerGas,
 *   maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
 * });
 * ```
 */
export async function estimateGas(
  client: PublicClient,
  options: GasEstimateOptions = {}
): Promise<GasEstimate> {
  const {
    safetyMargin = 2,
    priorityFeePercentile = 75,
    blocksToSample = 10,
  } = options;

  // Get latest block for base fee
  const latestBlock = await client.getBlock({ blockTag: 'latest' });
  const baseFeePerGas = latestBlock.baseFeePerGas;

  if (!baseFeePerGas) {
    // Chain doesn't support EIP-1559 (rare for modern chains)
    // Fall back to legacy gas price
    const gasPrice = await client.getGasPrice();
    return {
      maxFeePerGas: gasPrice,
      maxPriorityFeePerGas: gasPrice / 10n,
      baseFeePerGas: gasPrice,
      formatted: {
        maxFeeGwei: formatGwei(gasPrice),
        priorityFeeGwei: formatGwei(gasPrice / 10n),
        baseFeeGwei: formatGwei(gasPrice),
      },
    };
  }

  // Estimate priority fee from recent transactions
  const maxPriorityFeePerGas = await estimatePriorityFee(
    client,
    priorityFeePercentile,
    blocksToSample
  );

  // Calculate max fee with safety margin
  // Formula: maxFee = safetyMargin × baseFee + priorityFee
  // This ensures we can handle base fee increases while the tx is pending
  const maxFeePerGas =
    baseFeePerGas * BigInt(safetyMargin) + maxPriorityFeePerGas;

  console.error(
    `[gas] Estimated: baseFee=${formatGwei(baseFeePerGas)} gwei, ` +
      `priorityFee=${formatGwei(maxPriorityFeePerGas)} gwei, ` +
      `maxFee=${formatGwei(maxFeePerGas)} gwei`
  );

  return {
    maxFeePerGas,
    maxPriorityFeePerGas,
    baseFeePerGas,
    formatted: {
      maxFeeGwei: formatGwei(maxFeePerGas),
      priorityFeeGwei: formatGwei(maxPriorityFeePerGas),
      baseFeeGwei: formatGwei(baseFeePerGas),
    },
  };
}

/**
 * Estimate gas limit with safety buffer
 *
 * Adds a 20% buffer to the estimated gas to handle:
 * - State changes between estimation and execution
 * - Minor variations in execution path
 * - Contract optimizations that affect actual gas used
 *
 * @param client - Viem public client
 * @param tx - Transaction parameters for estimation
 * @returns Gas limit with 20% buffer
 */
export async function estimateGasLimit(
  client: PublicClient,
  tx: {
    account: `0x${string}`;
    to: `0x${string}`;
    value?: bigint;
    data?: `0x${string}`;
  }
): Promise<bigint> {
  const estimate = await client.estimateGas(tx);

  // Add 20% buffer (multiply by 1.2 = multiply by 6/5)
  const buffered = (estimate * 6n) / 5n;

  console.error(`[gas] Gas limit: estimated=${estimate}, buffered=${buffered}`);

  return buffered;
}
