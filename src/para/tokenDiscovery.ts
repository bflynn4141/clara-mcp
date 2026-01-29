/**
 * Clara Token Discovery
 *
 * Scans on-chain events to discover tokens deployed through the Clara ecosystem:
 * - CCA (Constant Commitment Auctions) via LiquidityLauncher
 * - Staking Distributors via StakingDistributorFactory
 *
 * Architecture:
 * 1. Event Scanning Layer - Query factory events to find all deployments
 * 2. State Enrichment Layer - Read contract state for each token
 * 3. APY Calculation - Compute yields using price data
 *
 * @see https://docs.clara.xyz/cca - CCA auction documentation
 * @see https://docs.clara.xyz/staking - Staking distributor docs
 */

import { createPublicClient, http, type Hex, parseAbiItem, formatUnits } from 'viem';
import { base, mainnet } from 'viem/chains';
import pLimit from 'p-limit';
import { calculateAPY, q96ToDecimal, getEthPriceUSD, weiToNumber } from './apy.js';
import { logger, withTiming, registerCacheSizeProviders } from '../utils/logger.js';

// Limit concurrent RPC calls to avoid rate limiting
const RPC_CONCURRENCY = 5;
const rpcLimit = pLimit(RPC_CONCURRENCY);

// ============================================================================
// Discovery Cache with Stale-While-Revalidate
// ============================================================================

// Cache discovery results with SWR pattern:
// - STALE_THRESHOLD: Return immediately, trigger background refresh
// - MAX_TTL: Force synchronous refresh (data too old to use)
// Key format: `${chain}:${filter}:${sortBy}:${limit}:${includeInactive}`

interface CacheEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
  timestamp: number;
  refreshing: boolean; // Prevents concurrent background refreshes
}

const discoveryCache = new Map<string, CacheEntry>();
const STALE_THRESHOLD = 30 * 1000; // 30 seconds - return stale, refresh in background
const MAX_TTL = 2 * 60 * 1000; // 2 minutes - force synchronous refresh

// Permanent cache for immutable token fields (name, symbol, decimals)
const tokenInfoCache = new Map<string, { name: string; symbol: string; decimals: number }>();

// Register cache size providers for observability
registerCacheSizeProviders(
  () => discoveryCache.size,
  () => tokenInfoCache.size
);

/**
 * Clear the discovery cache (useful for testing or forcing refresh)
 */
export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

/**
 * Clear the token info cache (useful for testing)
 */
export function clearTokenInfoCache(): void {
  tokenInfoCache.clear();
}

// ============================================================================
// Types
// ============================================================================

export type SupportedChain = 'base' | 'ethereum';

/**
 * Raw CCA token from event scan
 */
export interface CCAToken {
  tokenAddress: Hex;
  auctionAddress: Hex;
  totalSupply: bigint;
  deployBlock: number;
}

/**
 * Enriched CCA auction with on-chain state
 */
export interface EnrichedAuction extends CCAToken {
  tokenName: string;
  tokenSymbol: string;
  clearingPriceEth: number;
  raisedEth: string;
  raisedUSD: number;
  priceUSD: number;
  status: 'live' | 'ended' | 'claimable' | 'graduated';
  graduated: boolean;
  endsIn: string;
  endBlock: number;
  // Linked distributor data (if exists)
  hasDistributor: boolean;
  distributorAddress?: Hex;
  revenueUSD?: number;
  tvlUSD?: number;
  estimatedAPY?: number;
  paybackYears?: number;
}

/**
 * Raw staking distributor from event scan
 */
export interface Distributor {
  tokenAddress: Hex;
  distributorAddress: Hex;
  creatorAddress: Hex;
  deployBlock: number;
}

/**
 * Enriched distributor with calculated APY
 */
export interface EnrichedDistributor extends Distributor {
  tokenName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  totalStakedFormatted: string;
  totalStakedWei: bigint;
  totalRevenueWei: bigint;
  revenueUSD: number;
  tvlUSD: number;
  estimatedAPY: number;
  paybackYears: number;
  tokenPriceEth: number;
}

// ============================================================================
// Contract Addresses & ABIs
// ============================================================================

// Clara factory addresses by chain
// Source: /Users/brianflynn/para-wallet/src/para/cca-addresses.ts
const FACTORY_ADDRESSES: Record<SupportedChain, { liquidityLauncher: Hex; stakingFactory: Hex }> = {
  base: {
    // LiquidityLauncher v1.0.0 - same on all chains (CREATE2 deterministic)
    liquidityLauncher: '0x00000008412db3394C91A5CbD01635c6d140637C' as Hex,
    // Clara StakingRevenueDistributor factory on Base
    stakingFactory: '0x026f02c5556F066718F93345186Cac9E54D96D1b' as Hex,
  },
  ethereum: {
    // LiquidityLauncher - same address on Ethereum
    liquidityLauncher: '0x00000008412db3394C91A5CbD01635c6d140637C' as Hex,
    // Clara staking not deployed on Ethereum yet
    stakingFactory: '0x0000000000000000000000000000000000000000' as Hex,
  },
};

// Block to start scanning from (factory deployment block)
// LiquidityLauncher deployed late 2024, StakingDistributorFactory early 2025
// Conservative values to ensure we capture all events without excess scanning
const FROM_BLOCK: Record<SupportedChain, bigint> = {
  base: 23000000n, // ~Dec 2024 (Base ~43k blocks/day)
  ethereum: 21000000n, // ~Nov 2024
};

// RPC endpoints with fallbacks for reliability
// Priority: ENV var > fallback list (tries each until one works)
// BlastAPI is most reliable of the free RPCs, supports 2k block ranges
// Recommended: Set BASE_RPC_URL to Alchemy/Infura endpoint for production
const RPC_FALLBACKS: Record<SupportedChain, string[]> = {
  base: [
    process.env.BASE_RPC_URL || '',
    'https://base-mainnet.public.blastapi.io', // Most reliable free RPC
    'https://base.llamarpc.com',
    'https://mainnet.base.org',
  ].filter(Boolean),
  ethereum: [
    process.env.ETH_RPC_URL || '',
    'https://eth-mainnet.public.blastapi.io', // Most reliable free RPC
    'https://eth.llamarpc.com',
  ].filter(Boolean),
};

// Track which RPC index to use per chain (for fallback rotation)
const currentRpcIndex: Record<SupportedChain, number> = { base: 0, ethereum: 0 };

// Circuit breaker: fail fast if too many consecutive errors
const MAX_CONSECUTIVE_FAILURES = 5;

// Event signatures
const TOKEN_DISTRIBUTED_EVENT = parseAbiItem(
  'event TokenDistributed(address indexed tokenAddress, address indexed distributionContract, uint256 amount)'
);

const DISTRIBUTOR_CREATED_EVENT = parseAbiItem(
  'event DistributorCreated(address indexed token, address indexed distributor, address indexed creator)'
);

// Minimal ABIs for contract reads
const CCA_ABI = [
  {
    name: 'clearingPrice',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'currencyRaised',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'isGraduated',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'totalCleared',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'config',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'startBlock', type: 'uint256' },
          { name: 'endBlock', type: 'uint256' },
          { name: 'claimBlock', type: 'uint256' },
          { name: 'minRaise', type: 'uint256' },
          { name: 'maxRaise', type: 'uint256' },
        ],
      },
    ],
  },
] as const;

const DISTRIBUTOR_ABI = [
  {
    name: 'token',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'totalStaked',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'totalRevenueDeposited',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const ERC20_ABI = [
  {
    name: 'name',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'totalSupply',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ============================================================================
// Client Creation with Fallback Support
// ============================================================================

// Viem client type - using 'any' to avoid complex chain-specific type incompatibilities
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any;

/**
 * Get the current RPC URL for a chain (respects fallback rotation)
 */
function getCurrentRpcUrl(chain: SupportedChain): string {
  const rpcs = RPC_FALLBACKS[chain];
  const index = currentRpcIndex[chain] % rpcs.length;
  return rpcs[index];
}

/**
 * Rotate to the next fallback RPC for a chain
 */
function rotateToNextRpc(chain: SupportedChain): void {
  const rpcs = RPC_FALLBACKS[chain];
  currentRpcIndex[chain] = (currentRpcIndex[chain] + 1) % rpcs.length;
  logger.warn({ chain, newRpc: getCurrentRpcUrl(chain) }, 'Rotating to fallback RPC');
}

function getClient(chain: SupportedChain): Client {
  const chainConfig = chain === 'base' ? base : mainnet;
  return createPublicClient({
    chain: chainConfig,
    transport: http(getCurrentRpcUrl(chain)),
  });
}

// ============================================================================
// Chunked Log Scanning with Retry
// ============================================================================

// RPC providers often limit log query ranges. Chunk into smaller ranges.
// Note: Free RPCs typically limit to 1k-2k blocks, Alchemy free allows 10k
// Start with 2k to work with most free RPCs, will auto-reduce if needed
let LOG_CHUNK_SIZE = 2000n;
const MIN_CHUNK_SIZE = 500n; // Don't go below this
const REORG_SAFETY_BLOCKS = 20n; // Don't scan the latest 20 blocks (reorg safety)
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an error indicates the RPC is unhealthy (should rotate to fallback)
 */
function isRpcUnhealthy(error: Error): boolean {
  const msg = error.message;
  return (
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('no backend') ||
    msg.includes('unhealthy') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT')
  );
}

/**
 * Check if an error indicates the block range is too large
 */
function isRangeTooLarge(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('range') && msg.includes('large') ||
    msg.includes('exceed') && msg.includes('limit') ||
    msg.includes('max') && msg.includes('block')
  );
}

/**
 * Reduce the global chunk size when RPCs reject our range
 */
function reduceChunkSize(): boolean {
  const newSize = LOG_CHUNK_SIZE / 2n;
  if (newSize < MIN_CHUNK_SIZE) {
    return false; // Can't reduce further
  }
  LOG_CHUNK_SIZE = newSize;
  logger.warn({ newChunkSize: Number(LOG_CHUNK_SIZE) }, 'Reduced log chunk size due to RPC limits');
  return true;
}

/**
 * Fetch logs in chunks with retry, fallback rotation, and circuit breaker
 *
 * This handles:
 * - RPC range limits by chunking into LOG_CHUNK_SIZE blocks
 * - Rate limiting (429) with exponential backoff
 * - RPC failures (503) with automatic fallback rotation
 * - Circuit breaker: fails fast if too many consecutive failures
 * - Reorg safety by stopping at latest - REORG_SAFETY_BLOCKS
 */
async function getLogsChunked(
  chain: SupportedChain,
  client: Client,
  params: {
    address: Hex;
    event: ReturnType<typeof parseAbiItem>;
    fromBlock: bigint;
  }
): Promise<Array<{ args: Record<string, unknown>; blockNumber: bigint }>> {
  let activeClient = client;

  // Get latest block (with fallback rotation on failure)
  let latestBlock: bigint;
  try {
    latestBlock = await activeClient.getBlockNumber();
  } catch (error) {
    // Try rotating RPC if initial connection fails
    rotateToNextRpc(chain);
    activeClient = getClient(chain);
    try {
      latestBlock = await activeClient.getBlockNumber();
    } catch {
      throw new Error(`All RPCs failed for ${chain}. Set ${chain.toUpperCase()}_RPC_URL env var.`);
    }
  }

  const safeToBlock = latestBlock - REORG_SAFETY_BLOCKS;

  // If fromBlock is already past the safe block, return empty
  if (params.fromBlock >= safeToBlock) {
    return [];
  }

  const allLogs: Array<{ args: Record<string, unknown>; blockNumber: bigint }> = [];
  let currentFrom = params.fromBlock;
  let consecutiveFailures = 0;
  let rpcRotations = 0;

  while (currentFrom < safeToBlock) {
    let retries = 0;
    let success = false;
    let chunkReduced = false;

    while (!success && retries < MAX_RETRIES) {
      // Recalculate currentTo each attempt (chunk size may have changed)
      const currentTo =
        currentFrom + LOG_CHUNK_SIZE > safeToBlock ? safeToBlock : currentFrom + LOG_CHUNK_SIZE;

      try {
        const logs = await activeClient.getLogs({
          address: params.address,
          event: params.event,
          fromBlock: currentFrom,
          toBlock: currentTo,
        });

        allLogs.push(...logs);
        success = true;
        consecutiveFailures = 0; // Reset on success
      } catch (error) {
        retries++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        const isUnhealthy = error instanceof Error && isRpcUnhealthy(error);
        const isRateLimit = errorMsg.includes('429') || errorMsg.includes('rate limit');
        const rangeTooLarge = error instanceof Error && isRangeTooLarge(error);

        // If block range is too large, reduce chunk size and retry immediately
        if (rangeTooLarge && !chunkReduced) {
          if (reduceChunkSize()) {
            chunkReduced = true;
            retries = 0; // Reset retries with smaller chunk
            continue;
          }
          // Can't reduce further, will fail after retries
        }

        // If RPC is unhealthy and we have fallbacks, rotate
        if (isUnhealthy && rpcRotations < RPC_FALLBACKS[chain].length - 1) {
          rotateToNextRpc(chain);
          activeClient = getClient(chain);
          rpcRotations++;
          retries = 0; // Reset retries for new RPC
          continue;
        }

        if (retries >= MAX_RETRIES) {
          consecutiveFailures++;
          logger.error(
            { fromBlock: currentFrom.toString(), toBlock: currentTo.toString(), chunkSize: Number(LOG_CHUNK_SIZE), retries, consecutiveFailures, rangeTooLarge, error: errorMsg },
            'Failed to fetch logs after max retries'
          );

          // Circuit breaker: fail fast if too many consecutive failures
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            const failedRpcs = RPC_FALLBACKS[chain].join(', ');
            throw new Error(
              `RPC circuit breaker triggered after ${consecutiveFailures} consecutive failures. ` +
              `Tried: ${failedRpcs}. Set ${chain.toUpperCase()}_RPC_URL to a reliable provider (Alchemy/Infura).`
            );
          }

          // Continue to next chunk
          success = true;
        } else {
          const delay = INITIAL_RETRY_DELAY * Math.pow(2, retries - 1);
          logger.warn(
            { attempt: retries, maxRetries: MAX_RETRIES, isRateLimit, isUnhealthy, rangeTooLarge, delay },
            'Log fetch failed, retrying'
          );
          await sleep(delay);
        }
      }
    }

    // Move to next chunk (recalculate based on current chunk size)
    const currentTo =
      currentFrom + LOG_CHUNK_SIZE > safeToBlock ? safeToBlock : currentFrom + LOG_CHUNK_SIZE;
    currentFrom = currentTo + 1n;
  }

  return allLogs;
}

// ============================================================================
// Event Scanning
// ============================================================================

/**
 * Discover all CCA token launches from LiquidityLauncher events
 */
export async function discoverCCATokens(chain: SupportedChain): Promise<CCAToken[]> {
  const client = getClient(chain);
  const factoryAddress = FACTORY_ADDRESSES[chain].liquidityLauncher;

  // Skip if factory not deployed
  if (factoryAddress === '0x0000000000000000000000000000000000000000') {
    logger.warn({ chain }, 'LiquidityLauncher not deployed');
    return [];
  }

  try {
    const logs = await getLogsChunked(chain, client, {
      address: factoryAddress,
      event: TOKEN_DISTRIBUTED_EVENT,
      fromBlock: FROM_BLOCK[chain],
    });

    // Dedupe by (tokenAddress, auctionAddress) in case of reorgs
    const seen = new Set<string>();
    const dedupedLogs = logs.filter((log) => {
      const key = `${log.args.tokenAddress}:${log.args.distributionContract}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return dedupedLogs.map(
      (log: {
        args: { tokenAddress?: Hex; distributionContract?: Hex; amount?: bigint };
        blockNumber: bigint;
      }) => ({
        tokenAddress: log.args.tokenAddress as Hex,
        auctionAddress: log.args.distributionContract as Hex,
        totalSupply: log.args.amount as bigint,
        deployBlock: Number(log.blockNumber),
      })
    );
  } catch (error) {
    logger.error({ chain, error: error instanceof Error ? error.message : String(error) }, 'Failed to scan CCA events');
    return [];
  }
}

/**
 * Discover all staking distributors from StakingFactory events
 */
export async function discoverStakingDistributors(chain: SupportedChain): Promise<Distributor[]> {
  const client = getClient(chain);
  const factoryAddress = FACTORY_ADDRESSES[chain].stakingFactory;

  // Skip if factory not deployed
  if (factoryAddress === '0x0000000000000000000000000000000000000000') {
    logger.warn({ chain }, 'StakingFactory not deployed');
    return [];
  }

  try {
    const logs = await getLogsChunked(chain, client, {
      address: factoryAddress,
      event: DISTRIBUTOR_CREATED_EVENT,
      fromBlock: FROM_BLOCK[chain],
    });

    // Dedupe by (tokenAddress, distributorAddress) in case of reorgs
    const seen = new Set<string>();
    const dedupedLogs = logs.filter((log) => {
      const key = `${log.args.token}:${log.args.distributor}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return dedupedLogs.map(
      (log: {
        args: { token?: Hex; distributor?: Hex; creator?: Hex };
        blockNumber: bigint;
      }) => ({
        tokenAddress: log.args.token as Hex,
        distributorAddress: log.args.distributor as Hex,
        creatorAddress: log.args.creator as Hex,
        deployBlock: Number(log.blockNumber),
      })
    );
  } catch (error) {
    logger.error({ chain, error: error instanceof Error ? error.message : String(error) }, 'Failed to scan distributor events');
    return [];
  }
}

// ============================================================================
// State Enrichment
// ============================================================================

/**
 * Get token metadata (name, symbol, decimals)
 * Uses permanent cache since these fields never change
 * Uses multicall to batch all 3 reads into a single RPC call
 */
async function getTokenInfo(
  client: Client,
  tokenAddress: Hex
): Promise<{ name: string; symbol: string; decimals: number }> {
  // Check permanent cache first (these fields never change)
  const cacheKey = tokenAddress.toLowerCase();
  const cached = tokenInfoCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    // Batch all ERC20 metadata reads with multicall (single RPC call)
    const { result: multicallResult } = await withTiming(
      'multicall.tokenInfo',
      { tokenAddress },
      async () =>
        client.multicall({
          contracts: [
            { address: tokenAddress, abi: ERC20_ABI, functionName: 'name' },
            { address: tokenAddress, abi: ERC20_ABI, functionName: 'symbol' },
            { address: tokenAddress, abi: ERC20_ABI, functionName: 'decimals' },
          ],
          allowFailure: true,
        })
    );

    // Extract results with fallbacks
    const name = multicallResult[0].status === 'success' ? (multicallResult[0].result as string) : 'Unknown';
    const symbol = multicallResult[1].status === 'success' ? (multicallResult[1].result as string) : '???';
    const decimals = multicallResult[2].status === 'success' ? (multicallResult[2].result as number) : 18;

    const result = { name, symbol, decimals };

    // Cache permanently (immutable fields)
    tokenInfoCache.set(cacheKey, result);

    return result;
  } catch (error) {
    logger.error({ tokenAddress, error: error instanceof Error ? error.message : String(error) }, 'Failed to get token info');
    return { name: 'Unknown', symbol: '???', decimals: 18 };
  }
}

/**
 * Calculate days since a block was mined
 */
async function getBlockAgeDays(client: Client, blockNumber: number): Promise<number> {
  try {
    const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
    const blockTime = Number(block.timestamp) * 1000;
    const now = Date.now();
    return (now - blockTime) / (1000 * 60 * 60 * 24);
  } catch (error) {
    logger.error({ blockNumber, error: error instanceof Error ? error.message : String(error) }, 'Failed to get block');
    return 30; // Default to 30 days
  }
}

/**
 * Format time remaining until a block
 */
async function formatTimeUntilBlock(client: Client, targetBlock: number): Promise<string> {
  try {
    const currentBlock = await client.getBlockNumber();
    const blocksRemaining = targetBlock - Number(currentBlock);

    if (blocksRemaining <= 0) {
      return 'Ended';
    }

    // Assume ~2 second block time on Base
    const secondsRemaining = blocksRemaining * 2;
    const hours = Math.floor(secondsRemaining / 3600);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days} day${days === 1 ? '' : 's'}`;
    }
    if (hours > 0) {
      return `${hours} hr${hours === 1 ? '' : 's'}`;
    }
    const minutes = Math.floor(secondsRemaining / 60);
    return `${minutes} min`;
  } catch {
    return 'Unknown';
  }
}

/**
 * Enrich a CCA auction with on-chain state
 * Uses multicall to batch all contract reads into a single RPC call
 */
export async function enrichAuctionData(
  chain: SupportedChain,
  auction: CCAToken
): Promise<EnrichedAuction> {
  const client = getClient(chain);
  const ethPrice = await getEthPriceUSD();

  try {
    // Batch all auction reads with multicall (single RPC call)
    const { result: multicallResult } = await withTiming(
      'multicall.auction',
      { auctionAddress: auction.auctionAddress },
      async () =>
        client.multicall({
          contracts: [
            { address: auction.auctionAddress, abi: CCA_ABI, functionName: 'clearingPrice' },
            { address: auction.auctionAddress, abi: CCA_ABI, functionName: 'currencyRaised' },
            { address: auction.auctionAddress, abi: CCA_ABI, functionName: 'isGraduated' },
            { address: auction.auctionAddress, abi: CCA_ABI, functionName: 'config' },
          ],
          allowFailure: true,
        })
    );

    // Fetch token info and current block in parallel with multicall
    const [tokenInfo, currentBlock] = await Promise.all([
      getTokenInfo(client, auction.tokenAddress),
      client.getBlockNumber(),
    ]);

    // Extract results (with fallbacks for failed calls)
    const clearingPrice = multicallResult[0].status === 'success' ? (multicallResult[0].result as bigint) : 0n;
    const raised = multicallResult[1].status === 'success' ? (multicallResult[1].result as bigint) : 0n;
    const graduated = multicallResult[2].status === 'success' ? (multicallResult[2].result as boolean) : false;
    const config = multicallResult[3].status === 'success'
      ? (multicallResult[3].result as { startBlock: bigint; endBlock: bigint; claimBlock: bigint; minRaise: bigint; maxRaise: bigint })
      : { startBlock: 0n, endBlock: 0n, claimBlock: 0n, minRaise: 0n, maxRaise: 0n };

    const endBlock = Number(config.endBlock);
    const claimBlock = Number(config.claimBlock);
    const isEnded = Number(currentBlock) > endBlock;
    const isClaimable = Number(currentBlock) > claimBlock;

    // Determine status
    let status: 'live' | 'ended' | 'claimable' | 'graduated';
    if (!isEnded) {
      status = 'live';
    } else if (graduated) {
      status = 'graduated';
    } else if (isClaimable) {
      status = 'claimable';
    } else {
      status = 'ended';
    }

    // Calculate prices (use weiToNumber to avoid BigInt overflow)
    const clearingPriceEth = q96ToDecimal(clearingPrice);
    const raisedEth = weiToNumber(raised, 18);
    const priceUSD = clearingPriceEth * ethPrice;
    const raisedUSD = raisedEth * ethPrice;

    // Format time remaining
    const endsIn = isEnded ? 'Ended' : await formatTimeUntilBlock(client, endBlock);

    return {
      ...auction,
      tokenName: tokenInfo.name,
      tokenSymbol: tokenInfo.symbol,
      clearingPriceEth,
      raisedEth: raisedEth.toFixed(4),
      raisedUSD,
      priceUSD,
      status,
      graduated,
      endsIn,
      endBlock,
      hasDistributor: false,
    };
  } catch (error) {
    logger.error({ auctionAddress: auction.auctionAddress, error: error instanceof Error ? error.message : String(error) }, 'Failed to enrich auction');

    // Return minimal data on error
    return {
      ...auction,
      tokenName: 'Unknown',
      tokenSymbol: '???',
      clearingPriceEth: 0,
      raisedEth: '0',
      raisedUSD: 0,
      priceUSD: 0,
      status: 'ended',
      graduated: false,
      endsIn: 'Unknown',
      endBlock: 0,
      hasDistributor: false,
    };
  }
}

/**
 * Enrich a staking distributor with APY calculations
 * Uses multicall to batch contract reads into a single RPC call
 */
export async function enrichDistributorData(
  chain: SupportedChain,
  dist: Distributor,
  tokenPriceEth: number = 0.001 // Default price if not from auction
): Promise<EnrichedDistributor> {
  const client = getClient(chain);

  try {
    // Batch all distributor reads with multicall (single RPC call)
    const { result: multicallResult } = await withTiming(
      'multicall.distributor',
      { distributorAddress: dist.distributorAddress },
      async () =>
        client.multicall({
          contracts: [
            { address: dist.distributorAddress, abi: DISTRIBUTOR_ABI, functionName: 'totalStaked' },
            { address: dist.distributorAddress, abi: DISTRIBUTOR_ABI, functionName: 'totalRevenueDeposited' },
          ],
          allowFailure: true,
        })
    );

    // Fetch token info and block age in parallel with multicall
    const [tokenInfo, daysSinceCreation] = await Promise.all([
      getTokenInfo(client, dist.tokenAddress),
      getBlockAgeDays(client, dist.deployBlock),
    ]);

    // Extract results (with fallbacks for failed calls)
    const totalStaked = multicallResult[0].status === 'success' ? (multicallResult[0].result as bigint) : 0n;
    const totalRevenue = multicallResult[1].status === 'success' ? (multicallResult[1].result as bigint) : 0n;

    // Calculate APY with correct token decimals
    const apyResult = await calculateAPY(
      totalRevenue,
      totalStaked,
      tokenPriceEth,
      daysSinceCreation,
      tokenInfo.decimals // Pass actual decimals instead of assuming 18
    );

    // Format staked amount using safe conversion
    const stakedTokens = weiToNumber(totalStaked, tokenInfo.decimals);
    const stakedFormatted =
      stakedTokens >= 1_000_000
        ? `${(stakedTokens / 1_000_000).toFixed(1)}M`
        : stakedTokens >= 1_000
          ? `${(stakedTokens / 1_000).toFixed(0)}k`
          : stakedTokens.toFixed(0);

    return {
      ...dist,
      tokenName: tokenInfo.name,
      tokenSymbol: tokenInfo.symbol,
      tokenDecimals: tokenInfo.decimals,
      totalStakedFormatted: stakedFormatted,
      totalStakedWei: totalStaked,
      totalRevenueWei: totalRevenue,
      revenueUSD: apyResult.revenueUSD,
      tvlUSD: apyResult.tvlUSD,
      estimatedAPY: apyResult.apyPercent,
      paybackYears: apyResult.paybackYears,
      tokenPriceEth,
    };
  } catch (error) {
    logger.error({ distributorAddress: dist.distributorAddress, error: error instanceof Error ? error.message : String(error) }, 'Failed to enrich distributor');

    return {
      ...dist,
      tokenName: 'Unknown',
      tokenSymbol: '???',
      tokenDecimals: 18,
      totalStakedFormatted: '0',
      totalStakedWei: 0n,
      totalRevenueWei: 0n,
      revenueUSD: 0,
      tvlUSD: 0,
      estimatedAPY: 0,
      paybackYears: Infinity,
      tokenPriceEth: 0,
    };
  }
}

/**
 * Link auctions to their staking distributors
 *
 * A token can have both an active auction AND a staking distributor
 * if the project set up revenue distribution early.
 */
export function linkAuctionsToDistributors(
  auctions: EnrichedAuction[],
  distributors: EnrichedDistributor[]
): EnrichedAuction[] {
  // Build lookup map: token address → distributor
  const distributorsByToken = new Map<string, EnrichedDistributor>();
  for (const dist of distributors) {
    const tokenAddr = dist.tokenAddress.toLowerCase();
    // If multiple distributors, keep the one with highest TVL
    const existing = distributorsByToken.get(tokenAddr);
    if (!existing || dist.tvlUSD > existing.tvlUSD) {
      distributorsByToken.set(tokenAddr, dist);
    }
  }

  // Enrich auctions with distributor data
  return auctions.map((auction) => {
    const tokenAddr = auction.tokenAddress.toLowerCase();
    const dist = distributorsByToken.get(tokenAddr);

    if (!dist) {
      return auction;
    }

    return {
      ...auction,
      hasDistributor: true,
      distributorAddress: dist.distributorAddress,
      revenueUSD: dist.revenueUSD,
      tvlUSD: dist.tvlUSD,
      estimatedAPY: dist.estimatedAPY,
      paybackYears: dist.paybackYears,
    };
  });
}

// ============================================================================
// Main Discovery Function
// ============================================================================

export type DiscoveryFilter = 'all' | 'auctions' | 'staking';
export type DiscoverySortBy = 'apy' | 'tvl' | 'recent';

export interface DiscoveryResult {
  auctions: EnrichedAuction[];
  distributors: EnrichedDistributor[];
  ethPriceUSD: number;
}

/**
 * Core discovery logic - performs the actual scanning and enrichment
 * This is separated from discoverTokens to support background refresh
 */
async function doDiscovery(
  chain: SupportedChain,
  filter: DiscoveryFilter,
  sortBy: DiscoverySortBy,
  limit: number,
  includeInactive: boolean,
  cacheKey: string
): Promise<DiscoveryResult> {
  const startTime = performance.now();

  logger.info({ chain, filter, sortBy, limit, includeInactive }, 'Starting token discovery');

  const ethPriceUSD = await getEthPriceUSD();

  // Scan events in parallel
  const [rawAuctions, rawDistributors] = await Promise.all([
    filter !== 'staking' ? discoverCCATokens(chain) : Promise.resolve([]),
    filter !== 'auctions' ? discoverStakingDistributors(chain) : Promise.resolve([]),
  ]);

  // First, enrich auctions to get clearing prices (with concurrency limit)
  const enrichedAuctions = await Promise.all(
    rawAuctions.map((a) => rpcLimit(() => enrichAuctionData(chain, a)))
  );

  // Build token → clearingPriceEth map from auctions
  // This gives us real prices for distributors instead of default 0.001
  const tokenPriceMap = new Map<string, number>();
  for (const auction of enrichedAuctions) {
    if (auction.clearingPriceEth > 0) {
      tokenPriceMap.set(auction.tokenAddress.toLowerCase(), auction.clearingPriceEth);
    }
  }

  // Now enrich distributors with real prices from auctions (with concurrency limit)
  const enrichedDistributors = await Promise.all(
    rawDistributors.map((d: Distributor) => {
      const realPrice = tokenPriceMap.get(d.tokenAddress.toLowerCase());
      // Use auction price if available, otherwise default to 0.001 ETH
      return rpcLimit(() => enrichDistributorData(chain, d, realPrice ?? 0.001));
    })
  );

  // Link auctions to distributors
  const linkedAuctions = linkAuctionsToDistributors(enrichedAuctions, enrichedDistributors);

  // Filter opportunities (unless includeInactive is true)
  const activeAuctions = includeInactive
    ? linkedAuctions
    : linkedAuctions.filter((a) => a.status === 'live' || a.status === 'claimable');

  const activeDistributors = includeInactive
    ? enrichedDistributors
    : enrichedDistributors.filter((d) => d.totalRevenueWei > 0n && d.totalStakedWei > 0n);

  // Sort
  const sortedAuctions = [...activeAuctions];
  const sortedDistributors = [...activeDistributors];

  switch (sortBy) {
    case 'apy':
      sortedAuctions.sort((a, b) => (b.estimatedAPY || 0) - (a.estimatedAPY || 0));
      sortedDistributors.sort((a, b) => b.estimatedAPY - a.estimatedAPY);
      break;
    case 'tvl':
      sortedAuctions.sort((a, b) => (b.tvlUSD || 0) - (a.tvlUSD || 0));
      sortedDistributors.sort((a, b) => b.tvlUSD - a.tvlUSD);
      break;
    case 'recent':
      sortedAuctions.sort((a, b) => b.deployBlock - a.deployBlock);
      sortedDistributors.sort((a, b) => b.deployBlock - a.deployBlock);
      break;
  }

  // Apply limit
  const result: DiscoveryResult = {
    auctions: sortedAuctions.slice(0, limit),
    distributors: sortedDistributors.slice(0, limit),
    ethPriceUSD,
  };

  // Cache the result (clear refreshing flag)
  discoveryCache.set(cacheKey, { result, timestamp: Date.now(), refreshing: false });

  const durationMs = Math.round(performance.now() - startTime);
  logger.info(
    {
      chain,
      filter,
      durationMs,
      auctionsFound: result.auctions.length,
      distributorsFound: result.distributors.length,
    },
    'Token discovery completed'
  );

  return result;
}

/**
 * Discover all Clara ecosystem tokens with filtering and sorting
 *
 * Uses stale-while-revalidate (SWR) pattern:
 * - Fresh (< 30s): Return immediately from cache
 * - Stale (30s - 2min): Return stale data, refresh in background
 * - Expired (> 2min): Force synchronous refresh
 *
 * This provides instant perceived latency while keeping data fresh.
 */
export async function discoverTokens(
  chain: SupportedChain,
  filter: DiscoveryFilter = 'all',
  sortBy: DiscoverySortBy = 'apy',
  limit: number = 10,
  includeInactive: boolean = false
): Promise<DiscoveryResult> {
  const cacheKey = `${chain}:${filter}:${sortBy}:${limit}:${includeInactive}`;
  const cached = discoveryCache.get(cacheKey);
  const now = Date.now();

  if (cached) {
    const age = now - cached.timestamp;

    // FRESH: Return immediately (< 30 seconds old)
    if (age < STALE_THRESHOLD) {
      logger.debug({ chain, filter, cacheAge: age, cacheStatus: 'fresh' }, 'Discovery cache fresh');
      return cached.result as DiscoveryResult;
    }

    // STALE but USABLE: Return stale data, trigger background refresh (30s - 2min old)
    if (age < MAX_TTL) {
      logger.debug({ chain, filter, cacheAge: age, cacheStatus: 'stale' }, 'Discovery cache stale, returning + refreshing');

      // Trigger background refresh if not already refreshing
      if (!cached.refreshing) {
        cached.refreshing = true;
        // Fire-and-forget background refresh (don't await)
        doDiscovery(chain, filter, sortBy, limit, includeInactive, cacheKey).catch((error) => {
          logger.error({ chain, filter, error: error instanceof Error ? error.message : String(error) }, 'Background refresh failed');
          // Clear refreshing flag so next request can retry
          const entry = discoveryCache.get(cacheKey);
          if (entry) entry.refreshing = false;
        });
      }

      return cached.result as DiscoveryResult;
    }

    // EXPIRED: Cache too old, must refresh synchronously
    logger.debug({ chain, filter, cacheAge: age, cacheStatus: 'expired' }, 'Discovery cache expired, forcing refresh');
  }

  // No cache or expired: do synchronous discovery
  return doDiscovery(chain, filter, sortBy, limit, includeInactive, cacheKey);
}
