/**
 * CLARA Token Contract Configuration
 *
 * Centralized addresses, ABI fragments, and helpers for CLARA token,
 * staking, and MerkleDrop contracts. Supports testnet (Base Sepolia)
 * and mainnet (Base) via CLARA_NETWORK env var.
 *
 * Used by: dashboard.ts, claim-airdrop.ts, opportunities.ts
 */

import { createPublicClient, http, formatUnits, type Hex } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { getRpcUrl } from './chains.js';

// ─── Network Configuration ──────────────────────────────────────────

type ClaraNetwork = 'testnet' | 'mainnet';

interface ClaraContracts {
  claraToken: Hex;
  claraStaking: Hex;
  merkleDrop: Hex;
  chainId: number;
  rpcUrl: string;
}

const NETWORKS: Record<ClaraNetwork, ClaraContracts> = {
  testnet: {
    claraToken: '0x514228D83ab8dcf1c0370Fca88444f2F85c6Ef55',
    claraStaking: '0x297BddB4284DC9a78de615D2F2CfB9DB922b4712',
    merkleDrop: '0xd626652314825C4D73fffc5B2b2C925DA0ad1bEc',
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
  },
  mainnet: {
    // Placeholder — filled after mainnet deploy
    claraToken: '0x0000000000000000000000000000000000000000',
    claraStaking: '0x0000000000000000000000000000000000000000',
    merkleDrop: '0x0000000000000000000000000000000000000000',
    chainId: 8453,
    rpcUrl: getRpcUrl('base'),
  },
};

export function getClaraNetwork(): ClaraNetwork {
  const env = process.env.CLARA_NETWORK?.toLowerCase();
  if (env === 'testnet') return 'testnet';
  return 'mainnet'; // Default to mainnet (real ERC-8004 agents)
}

export function getClaraContracts(): ClaraContracts {
  return NETWORKS[getClaraNetwork()];
}

// ─── ABI Fragments (view-only) ──────────────────────────────────────

export const CLARA_TOKEN_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const CLARA_STAKING_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'stakedBalance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'getClaimable',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalStaked',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const MERKLE_DROP_ABI = [
  {
    inputs: [{ name: 'index', type: 'uint256' }],
    name: 'isClaimed',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'index', type: 'uint256' },
      { name: 'account', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'proof', type: 'bytes32[]' },
    ],
    name: 'claim',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'deadline',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ─── ERC-8004 Bounty System Contracts ─────────────────────────────────

export interface BountyContracts {
  identityRegistry: Hex;
  reputationRegistry: Hex;
  bountyFactory: Hex;
}

const BOUNTY_CONTRACTS: Record<ClaraNetwork, BountyContracts> = {
  testnet: {
    identityRegistry: '0x949EaAD64Db780D1af71C07d5F124aa8A0e19B6c',  // MockIdentityRegistry on Sepolia
    reputationRegistry: '0x3ea0a857251b15fF8A176abf188bF5100a7e00dC',  // MockReputationRegistry on Sepolia
    bountyFactory: '0xfe92C74A3c1d81fE2927f0Bfd116D956dee6bCA7',
  },
  mainnet: {
    identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    bountyFactory: '0x4fDd9E7014959503B91e4C21c0B25f1955413C75',
  },
};

export function getBountyContracts(): BountyContracts {
  return BOUNTY_CONTRACTS[getClaraNetwork()];
}

// ─── ERC-8004 ABI Fragments ─────────────────────────────────────────

export const IDENTITY_REGISTRY_ABI = [
  {
    inputs: [{ name: 'agentURI', type: 'string' }],
    name: 'register',
    outputs: [{ name: 'agentId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'tokenURI',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const REPUTATION_REGISTRY_ABI = [
  {
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'endpoint', type: 'string' },
      { name: 'feedbackURI', type: 'string' },
      { name: 'feedbackHash', type: 'bytes32' },
    ],
    name: 'giveFeedback',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
    ],
    name: 'getSummary',
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'summaryValue', type: 'int128' },
      { name: 'summaryValueDecimals', type: 'uint8' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const BOUNTY_FACTORY_ABI = [
  {
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'taskURI', type: 'string' },
      { name: 'skillTags', type: 'string[]' },
    ],
    name: 'createBounty',
    outputs: [{ name: 'bountyAddress', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export const BOUNTY_ABI = [
  {
    inputs: [{ name: 'agentId', type: 'uint256' }],
    name: 'claim',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'claimerAgentId',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'proofURI', type: 'string' }],
    name: 'submitWork',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'approve',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'cancel',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'expire',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'poster',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'claimer',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'amount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'token',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'deadline',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'status',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'taskURI',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'proofURI',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * ERC-20 approve ABI fragment (used by work_post for token approval)
 */
export const ERC20_APPROVE_ABI = [
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// ─── Factory Deploy Block ──────────────────────────────────────────

/** First block to scan for BountyCreated events, per network */
const FACTORY_DEPLOY_BLOCKS: Record<ClaraNetwork, bigint> = {
  testnet: 37897669n,   // Base Sepolia deployment
  mainnet: 41844986n,   // Base mainnet deployment (0x27e80fa)
};

export const FACTORY_DEPLOY_BLOCK = FACTORY_DEPLOY_BLOCKS[getClaraNetwork()];

// ─── Event ABI Fragments ──────────────────────────────────────────

/**
 * BountyFactory events — emitted when a new bounty clone is created.
 * Used by the embedded indexer to discover new bounty addresses.
 */
export const BOUNTY_FACTORY_EVENTS = [
  {
    type: 'event' as const,
    name: 'BountyCreated',
    inputs: [
      { name: 'bountyAddress', type: 'address', indexed: true },
      { name: 'poster', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'deadline', type: 'uint256', indexed: false },
      { name: 'taskURI', type: 'string', indexed: false },
      { name: 'skillTags', type: 'string[]', indexed: false },
    ],
  },
] as const;

/**
 * Bounty clone lifecycle events — emitted by individual bounty proxies.
 * Used by the indexer to track status transitions.
 */
export const BOUNTY_EVENTS = [
  {
    type: 'event' as const,
    name: 'BountyClaimed',
    inputs: [
      { name: 'claimer', type: 'address', indexed: true },
      { name: 'agentId', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event' as const,
    name: 'WorkSubmitted',
    inputs: [
      { name: 'claimer', type: 'address', indexed: true },
      { name: 'proofURI', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event' as const,
    name: 'BountyApproved',
    inputs: [
      { name: 'claimer', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event' as const,
    name: 'BountyExpired',
    inputs: [
      { name: 'poster', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event' as const,
    name: 'BountyCancelled',
    inputs: [
      { name: 'poster', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const;

// ─── Public Client Helper ───────────────────────────────────────────

export function getClaraPublicClient() {
  const contracts = getClaraContracts();
  return createPublicClient({
    chain: contracts.chainId === 84532 ? baseSepolia : base,
    transport: http(contracts.rpcUrl),
  });
}

// ─── Shared Staking Data Fetcher ────────────────────────────────────

export interface ClaraStakingData {
  claraBalance: string;
  stakedBalance: string;
  claimableUsdc: string;
  totalStaked: string;
  sharePercent: number;
  network: string;
}

/**
 * Fetch CLARA staking data for an address.
 * Returns null on any failure (graceful degradation).
 */
export async function fetchClaraStakingData(address: Hex): Promise<ClaraStakingData | null> {
  try {
    const contracts = getClaraContracts();
    const client = getClaraPublicClient();

    const [claraBalance, stakedBalance, claimable, totalStaked] = await Promise.all([
      client.readContract({
        address: contracts.claraToken,
        abi: CLARA_TOKEN_ABI,
        functionName: 'balanceOf',
        args: [address],
      }),
      client.readContract({
        address: contracts.claraStaking,
        abi: CLARA_STAKING_ABI,
        functionName: 'stakedBalance',
        args: [address],
      }),
      client.readContract({
        address: contracts.claraStaking,
        abi: CLARA_STAKING_ABI,
        functionName: 'getClaimable',
        args: [address],
      }),
      client.readContract({
        address: contracts.claraStaking,
        abi: CLARA_STAKING_ABI,
        functionName: 'totalStaked',
      }),
    ]);

    const stakedNum = parseFloat(formatUnits(stakedBalance as bigint, 18));
    const totalNum = parseFloat(formatUnits(totalStaked as bigint, 18));
    const share = totalNum > 0 ? (stakedNum / totalNum) * 100 : 0;

    return {
      claraBalance: formatUnits(claraBalance as bigint, 18),
      stakedBalance: formatUnits(stakedBalance as bigint, 18),
      claimableUsdc: formatUnits(claimable as bigint, 6), // USDC has 6 decimals
      totalStaked: formatUnits(totalStaked as bigint, 18),
      sharePercent: share,
      network: getClaraNetwork(),
    };
  } catch (error) {
    console.error(`[clara] CLARA staking data unavailable: ${error}`);
    return null;
  }
}
