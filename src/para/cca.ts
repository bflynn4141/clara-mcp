/**
 * CCA (Continuous Clearing Auction) Client
 *
 * Functions for interacting with Uniswap CCA auctions.
 * Used by wallet_cca_bid, wallet_cca_claim, wallet_cca_exit tools.
 *
 * Q96 Format:
 * - Uniswap uses Q96 fixed-point format for prices: value * 2^96
 * - This allows precise decimal representation without floating point
 */

import {
  createPublicClient,
  http,
  type Hex,
  formatEther,
  parseEther,
  encodeFunctionData,
  getAddress,
} from 'viem';
import { base, mainnet } from 'viem/chains';
import { getRpcUrl as getChainsRpcUrl } from '../config/chains.js';

// ============================================================================
// Constants
// ============================================================================

/** Q96 multiplier: 2^96 */
export const Q96 = BigInt(2) ** BigInt(96);

// Canonical addresses (CREATE2 deterministic - same on all chains)
export const CANONICAL_ADDRESSES = {
  liquidityLauncher: '0x00000008412db3394C91A5CbD01635c6d140637C' as Hex,
  ccaFactory: '0xCCccCcCAE7503Cac057829BF2811De42E16e0bD5' as Hex,
  stakingDistributorFactory: '0x026f02c5556F066718F93345186Cac9E54D96D1b' as Hex,
};

// Chain configurations
const CHAIN_CONFIGS = {
  base: { chain: base, blockTime: 2, explorer: 'https://basescan.org' },
  ethereum: { chain: mainnet, blockTime: 12, explorer: 'https://etherscan.io' },
} as const;

export type SupportedCCAChain = keyof typeof CHAIN_CONFIGS;

// ============================================================================
// ABIs
// ============================================================================

export const CCA_AUCTION_ABI = [
  {
    name: 'token',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'currency',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'totalSupply',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'startBlock',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    name: 'endBlock',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    name: 'claimBlock',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint64' }],
  },
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
    name: 'nextBidId',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'bids',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'bidId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'startBlock', type: 'uint64' },
          { name: 'startCumulativeMps', type: 'uint48' },
          { name: 'exitedBlock', type: 'uint64' },
          { name: 'maxPrice', type: 'uint256' },
          { name: 'owner', type: 'address' },
          { name: 'amountQ96', type: 'uint256' },
          { name: 'tokensFilled', type: 'uint128' },
        ],
      },
    ],
  },
  // Write functions
  {
    name: 'submitBid',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'maxPrice', type: 'uint256' },
      { name: 'amount', type: 'uint128' },
      { name: 'owner', type: 'address' },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [{ name: 'bidId', type: 'uint256' }],
  },
  {
    name: 'exitBid',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'bidId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'claimTokensBatch',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'bidIds', type: 'uint256[]' },
    ],
    outputs: [],
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
] as const;

// ============================================================================
// Types
// ============================================================================

export type AuctionState = 'not_started' | 'active' | 'ended_claimable' | 'ended_waiting' | 'failed_refundable';
export type BidStatus = 'active' | 'outbid' | 'filled' | 'exited' | 'claimable';

export interface AuctionStatus {
  address: Hex;
  chain: SupportedCCAChain;
  tokenAddress: Hex;
  tokenSymbol: string;
  tokenName: string;
  clearingPriceEth: string;
  currencyRaisedEth: string;
  isGraduated: boolean;
  totalBids: number;
  state: AuctionState;
  timing: {
    isStarted: boolean;
    isEnded: boolean;
    isClaimable: boolean;
    currentBlock: number;
    blocksRemaining: number;
    estimatedTimeRemaining: string;
  };
}

export interface BidInfo {
  bidId: string;
  owner: Hex;
  maxPriceEth: string;
  amountEth: string;
  tokensFilled: string;
  isExited: boolean;
  status: BidStatus;
}

// ============================================================================
// Helpers
// ============================================================================

function getRpcUrl(chain: SupportedCCAChain): string {
  return getChainsRpcUrl(chain);
}

function getClient(chain: SupportedCCAChain) {
  return createPublicClient({
    chain: CHAIN_CONFIGS[chain].chain,
    transport: http(getRpcUrl(chain)),
  });
}

/**
 * Convert Q96 price to decimal string
 */
export function q96ToDecimal(q96Value: bigint, decimals: number = 18): string {
  if (q96Value === 0n) return '0';
  const scaled = (q96Value * BigInt(10 ** decimals)) / Q96;
  const num = Number(scaled) / 10 ** decimals;
  return num.toFixed(18);
}

/**
 * Convert decimal price to Q96 format
 */
export function decimalToQ96(decimalPrice: string, decimals: number = 18): bigint {
  const wei = parseEther(decimalPrice);
  return (wei * Q96) / BigInt(10 ** decimals);
}

/**
 * Estimate time from blocks
 */
function estimateTimeFromBlocks(chain: SupportedCCAChain, blocks: number): string {
  const blockTime = CHAIN_CONFIGS[chain].blockTime;
  const seconds = blocks * blockTime;

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return '< 1m';
}

export function getExplorerTxUrl(chain: SupportedCCAChain, txHash: string): string {
  return `${CHAIN_CONFIGS[chain].explorer}/tx/${txHash}`;
}

// ============================================================================
// Read Functions
// ============================================================================

/**
 * Get auction status
 */
export async function getAuctionStatus(
  auctionAddress: Hex,
  chain: SupportedCCAChain = 'base'
): Promise<AuctionStatus> {
  const client = getClient(chain);

  // Fetch all data in parallel
  const [
    token,
    startBlock,
    endBlock,
    claimBlock,
    clearingPrice,
    currencyRaised,
    isGraduated,
    nextBidId,
    currentBlock,
  ] = await Promise.all([
    client.readContract({ address: auctionAddress, abi: CCA_AUCTION_ABI, functionName: 'token' }),
    client.readContract({ address: auctionAddress, abi: CCA_AUCTION_ABI, functionName: 'startBlock' }),
    client.readContract({ address: auctionAddress, abi: CCA_AUCTION_ABI, functionName: 'endBlock' }),
    client.readContract({ address: auctionAddress, abi: CCA_AUCTION_ABI, functionName: 'claimBlock' }),
    client.readContract({ address: auctionAddress, abi: CCA_AUCTION_ABI, functionName: 'clearingPrice' }),
    client.readContract({ address: auctionAddress, abi: CCA_AUCTION_ABI, functionName: 'currencyRaised' }),
    client.readContract({ address: auctionAddress, abi: CCA_AUCTION_ABI, functionName: 'isGraduated' }),
    client.readContract({ address: auctionAddress, abi: CCA_AUCTION_ABI, functionName: 'nextBidId' }),
    client.getBlockNumber(),
  ]);

  // Get token info
  const [tokenSymbol, tokenName] = await Promise.all([
    client.readContract({ address: token as Hex, abi: ERC20_ABI, functionName: 'symbol' }),
    client.readContract({ address: token as Hex, abi: ERC20_ABI, functionName: 'name' }),
  ]);

  const currentBlockNum = Number(currentBlock);
  const startBlockNum = Number(startBlock);
  const endBlockNum = Number(endBlock);
  const claimBlockNum = Number(claimBlock);

  const isStarted = currentBlockNum >= startBlockNum;
  const isEnded = currentBlockNum >= endBlockNum;
  const isClaimable = currentBlockNum >= claimBlockNum;
  const blocksRemaining = isEnded ? 0 : endBlockNum - currentBlockNum;

  // Determine state
  let state: AuctionState;
  if (!isStarted) {
    state = 'not_started';
  } else if (!isEnded) {
    state = 'active';
  } else if (!isGraduated) {
    state = 'failed_refundable';
  } else if (isClaimable) {
    state = 'ended_claimable';
  } else {
    state = 'ended_waiting';
  }

  return {
    address: auctionAddress,
    chain,
    tokenAddress: token as Hex,
    tokenSymbol: tokenSymbol as string,
    tokenName: tokenName as string,
    clearingPriceEth: q96ToDecimal(clearingPrice as bigint),
    currencyRaisedEth: formatEther(currencyRaised as bigint),
    isGraduated: isGraduated as boolean,
    totalBids: Number(nextBidId) - 1,
    state,
    timing: {
      isStarted,
      isEnded,
      isClaimable,
      currentBlock: currentBlockNum,
      blocksRemaining,
      estimatedTimeRemaining: estimateTimeFromBlocks(chain, blocksRemaining),
    },
  };
}

/**
 * Get bid information
 */
export async function getBidInfo(
  auctionAddress: Hex,
  bidId: string,
  chain: SupportedCCAChain = 'base'
): Promise<BidInfo> {
  const client = getClient(chain);

  const [bid, clearingPrice, currentBlock, endBlock] = await Promise.all([
    client.readContract({ address: auctionAddress, abi: CCA_AUCTION_ABI, functionName: 'bids', args: [BigInt(bidId)] }),
    client.readContract({ address: auctionAddress, abi: CCA_AUCTION_ABI, functionName: 'clearingPrice' }),
    client.getBlockNumber(),
    client.readContract({ address: auctionAddress, abi: CCA_AUCTION_ABI, functionName: 'endBlock' }),
  ]);

  const isEnded = Number(currentBlock) >= Number(endBlock);
  const isExited = (bid as any).exitedBlock > 0n;

  // Determine status
  let status: BidStatus;
  if (isExited) {
    status = (bid as any).tokensFilled > 0n ? 'claimable' : 'exited';
  } else if ((bid as any).maxPrice >= (clearingPrice as bigint)) {
    status = isEnded ? 'filled' : 'active';
  } else {
    status = 'outbid';
  }

  return {
    bidId,
    owner: (bid as any).owner as Hex,
    maxPriceEth: q96ToDecimal((bid as any).maxPrice),
    amountEth: q96ToDecimal((bid as any).amountQ96),
    tokensFilled: ((bid as any).tokensFilled as bigint).toString(),
    isExited,
    status,
  };
}

// ============================================================================
// Write Function Encoders
// ============================================================================

/**
 * Encode submitBid call data
 */
export function encodeSubmitBid(maxPriceQ96: bigint, amountWei: bigint, owner: Hex): Hex {
  return encodeFunctionData({
    abi: CCA_AUCTION_ABI,
    functionName: 'submitBid',
    args: [maxPriceQ96, amountWei, owner, '0x' as Hex],
  });
}

/**
 * Encode exitBid call data
 */
export function encodeExitBid(bidId: string): Hex {
  return encodeFunctionData({
    abi: CCA_AUCTION_ABI,
    functionName: 'exitBid',
    args: [BigInt(bidId)],
  });
}

/**
 * Encode claimTokensBatch call data
 */
export function encodeClaimTokens(owner: Hex, bidIds: string[]): Hex {
  return encodeFunctionData({
    abi: CCA_AUCTION_ABI,
    functionName: 'claimTokensBatch',
    args: [owner, bidIds.map(id => BigInt(id))],
  });
}

/**
 * Get valid actions for auction state
 */
export function getValidActions(state: AuctionState): string[] {
  switch (state) {
    case 'not_started':
      return ['Wait for auction to start'];
    case 'active':
      return ['bid', 'exit (if outbid)'];
    case 'ended_claimable':
      return ['claim'];
    case 'ended_waiting':
      return ['Wait for claim block'];
    case 'failed_refundable':
      return ['exit (refund)'];
  }
}
