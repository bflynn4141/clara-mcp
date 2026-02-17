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

// ─── ERC-8004 Agent Identity Contracts ────────────────────────────────

export interface AgentContracts {
  identityRegistry: Hex;
}

const AGENT_CONTRACTS: Record<ClaraNetwork, AgentContracts> = {
  testnet: {
    identityRegistry: '0xAee21064f9f7c24fd052CC3598A60Cc50591d1B3',
  },
  mainnet: {
    identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  },
};

export function getAgentContracts(): AgentContracts {
  return AGENT_CONTRACTS[getClaraNetwork()];
}

// ─── ERC-8004 ABI Fragments ─────────────────────────────────────────

export const IDENTITY_REGISTRY_ABI = [
  // ─── Registration (3 overloads per ERC-8004) ────────────────────
  {
    inputs: [{ name: 'agentURI', type: 'string' }],
    name: 'register',
    outputs: [{ name: 'agentId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'register',
    outputs: [{ name: 'agentId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // ─── ERC-721 Core ──────────────────────────────────────────────
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
  // ─── ERC-8004: Agent URI ───────────────────────────────────────
  // On-chain function is `updateURI` (spec says `setAgentURI` but
  // the canonical deployment uses this name)
  {
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newURI', type: 'string' },
    ],
    name: 'updateURI',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // ─── ERC-8004: Metadata Key-Value Store ────────────────────────
  {
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
    ],
    name: 'getMetadata',
    outputs: [{ name: '', type: 'bytes' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
    ],
    name: 'setMetadata',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // ─── ERC-8004: Agent Wallet Delegation ─────────────────────────
  {
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newWallet', type: 'address' },
      { name: 'deadline', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    name: 'setAgentWallet',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'agentId', type: 'uint256' }],
    name: 'getAgentWallet',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
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
      claimableUsdc: formatUnits(claimable as bigint, 6),
      totalStaked: formatUnits(totalStaked as bigint, 18),
      sharePercent: share,
      network: getClaraNetwork(),
    };
  } catch (error) {
    console.error(`[clara] CLARA staking data unavailable: ${error}`);
    return null;
  }
}
