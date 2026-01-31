/**
 * Staking Revenue Distributor Client
 *
 * Functions for interacting with Clara's StakingRevenueDistributor contracts.
 * Used by wallet_stake, wallet_unstake, wallet_claim_dividends tools.
 *
 * Architecture:
 * - Factory deploys distributors for any ERC-20 token
 * - Users stake tokens to earn ETH revenue proportionally
 * - Revenue deposited by app owners is distributed to stakers
 */

import {
  createPublicClient,
  http,
  type Hex,
  formatEther,
  parseEther,
  formatUnits,
  parseUnits,
  encodeFunctionData,
} from 'viem';
import { base, mainnet } from 'viem/chains';
import { getRpcUrl as getChainsRpcUrl } from '../config/chains.js';

// ============================================================================
// Constants
// ============================================================================

export const STAKING_FACTORY_ADDRESSES: Record<SupportedStakingChain, Hex> = {
  base: '0x026f02c5556F066718F93345186Cac9E54D96D1b',
  ethereum: '0x0000000000000000000000000000000000000000', // Not deployed yet
};

const CHAIN_CONFIGS = {
  base: { chain: base, explorer: 'https://basescan.org' },
  ethereum: { chain: mainnet, explorer: 'https://etherscan.io' },
} as const;

export type SupportedStakingChain = 'base' | 'ethereum';

// ============================================================================
// ABIs
// ============================================================================

export const STAKING_DISTRIBUTOR_ABI = [
  // View functions
  {
    name: 'stakingToken',
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
  {
    name: 'stakedBalance',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'withdrawable',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // Write functions
  {
    name: 'stake',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'unstake',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'claim',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
] as const;

export const STAKING_FACTORY_ABI = [
  {
    name: 'createDistributor',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: 'distributor', type: 'address' }],
  },
  {
    name: 'getDistributor',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'DistributorCreated',
    type: 'event',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'distributor', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
    ],
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
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

// ============================================================================
// Types
// ============================================================================

export interface TokenInfo {
  address: Hex;
  name: string;
  symbol: string;
  decimals: number;
}

export interface StakingPosition {
  distributorAddress: Hex;
  tokenInfo: TokenInfo;
  stakedAmount: string;
  stakedAmountFormatted: string;
  claimableEth: string;
  totalStaked: string;
  totalRevenue: string;
  userSharePercent: number;
}

export interface TransactionBundle {
  transactions: Array<{
    to: Hex;
    data: Hex;
    value: bigint;
    description: string;
  }>;
  warnings: string[];
  simulationPassed: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

function getRpcUrl(chain: SupportedStakingChain): string {
  return getChainsRpcUrl(chain);
}

function getClient(chain: SupportedStakingChain) {
  return createPublicClient({
    chain: CHAIN_CONFIGS[chain].chain,
    transport: http(getRpcUrl(chain)),
  });
}

export function getExplorerTxUrl(chain: SupportedStakingChain, txHash: string): string {
  return `${CHAIN_CONFIGS[chain].explorer}/tx/${txHash}`;
}

// ============================================================================
// Read Functions
// ============================================================================

/**
 * Get token info
 */
export async function getTokenInfo(tokenAddress: Hex, chain: SupportedStakingChain): Promise<TokenInfo> {
  const client = getClient(chain);

  const [name, symbol, decimals] = await Promise.all([
    client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'name' }),
    client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'symbol' }),
    client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'decimals' }),
  ]);

  return {
    address: tokenAddress,
    name: name as string,
    symbol: symbol as string,
    decimals: decimals as number,
  };
}

/**
 * Get distributor address for a token
 */
export async function getDistributorForToken(
  tokenAddress: Hex,
  chain: SupportedStakingChain = 'base'
): Promise<Hex | null> {
  const factoryAddress = STAKING_FACTORY_ADDRESSES[chain];
  if (factoryAddress === '0x0000000000000000000000000000000000000000') {
    return null;
  }

  const client = getClient(chain);

  try {
    const distributor = await client.readContract({
      address: factoryAddress,
      abi: STAKING_FACTORY_ABI,
      functionName: 'getDistributor',
      args: [tokenAddress],
    });

    if (distributor === '0x0000000000000000000000000000000000000000') {
      return null;
    }
    return distributor as Hex;
  } catch {
    return null;
  }
}

/**
 * Get user's staking position
 */
export async function getStakingPosition(
  distributorAddress: Hex,
  userAddress: Hex,
  chain: SupportedStakingChain = 'base'
): Promise<StakingPosition> {
  const client = getClient(chain);

  // Get distributor data
  const [stakingToken, stakedBalance, claimable, totalStaked, totalRevenue] = await Promise.all([
    client.readContract({ address: distributorAddress, abi: STAKING_DISTRIBUTOR_ABI, functionName: 'stakingToken' }),
    client.readContract({ address: distributorAddress, abi: STAKING_DISTRIBUTOR_ABI, functionName: 'stakedBalance', args: [userAddress] }),
    client.readContract({ address: distributorAddress, abi: STAKING_DISTRIBUTOR_ABI, functionName: 'withdrawable', args: [userAddress] }),
    client.readContract({ address: distributorAddress, abi: STAKING_DISTRIBUTOR_ABI, functionName: 'totalStaked' }),
    client.readContract({ address: distributorAddress, abi: STAKING_DISTRIBUTOR_ABI, functionName: 'totalRevenueDeposited' }),
  ]);

  const tokenInfo = await getTokenInfo(stakingToken as Hex, chain);

  const stakedBigInt = stakedBalance as bigint;
  const totalStakedBigInt = totalStaked as bigint;
  const userSharePercent = totalStakedBigInt > 0n
    ? Number((stakedBigInt * 10000n) / totalStakedBigInt) / 100
    : 0;

  return {
    distributorAddress,
    tokenInfo,
    stakedAmount: stakedBigInt.toString(),
    stakedAmountFormatted: formatUnits(stakedBigInt, tokenInfo.decimals),
    claimableEth: formatEther(claimable as bigint),
    totalStaked: formatUnits(totalStakedBigInt, tokenInfo.decimals),
    totalRevenue: formatEther(totalRevenue as bigint),
    userSharePercent,
  };
}

/**
 * Check token balance and allowance
 */
export async function checkTokenBalanceAndAllowance(
  tokenAddress: Hex,
  userAddress: Hex,
  spenderAddress: Hex,
  chain: SupportedStakingChain
): Promise<{ balance: bigint; allowance: bigint; decimals: number }> {
  const client = getClient(chain);

  const [balance, allowance, decimals] = await Promise.all([
    client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddress] }),
    client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'allowance', args: [userAddress, spenderAddress] }),
    client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'decimals' }),
  ]);

  return {
    balance: balance as bigint,
    allowance: allowance as bigint,
    decimals: decimals as number,
  };
}

// ============================================================================
// Transaction Builders
// ============================================================================

/**
 * Build stake transaction bundle (includes approval if needed)
 */
export async function buildStakeBundle(
  distributorAddress: Hex,
  amount: string,
  userAddress: Hex,
  chain: SupportedStakingChain = 'base'
): Promise<TransactionBundle> {
  const client = getClient(chain);
  const warnings: string[] = [];

  // Get staking token
  const stakingToken = await client.readContract({
    address: distributorAddress,
    abi: STAKING_DISTRIBUTOR_ABI,
    functionName: 'stakingToken',
  }) as Hex;

  const tokenInfo = await getTokenInfo(stakingToken, chain);
  const amountWei = parseUnits(amount, tokenInfo.decimals);

  // Check balance and allowance
  const { balance, allowance } = await checkTokenBalanceAndAllowance(
    stakingToken,
    userAddress,
    distributorAddress,
    chain
  );

  if (balance < amountWei) {
    warnings.push(`Insufficient balance: have ${formatUnits(balance, tokenInfo.decimals)} ${tokenInfo.symbol}, need ${amount}`);
  }

  const transactions: TransactionBundle['transactions'] = [];

  // Add approval if needed (with USDT-style zero-first if existing allowance)
  if (allowance < amountWei) {
    if (allowance > 0n) {
      // Reset to 0 first (USDT-style)
      transactions.push({
        to: stakingToken,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [distributorAddress, 0n],
        }),
        value: 0n,
        description: `Reset ${tokenInfo.symbol} allowance to 0`,
      });
    }

    transactions.push({
      to: stakingToken,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [distributorAddress, amountWei],
      }),
      value: 0n,
      description: `Approve ${amount} ${tokenInfo.symbol}`,
    });
  }

  // Add stake transaction
  transactions.push({
    to: distributorAddress,
    data: encodeFunctionData({
      abi: STAKING_DISTRIBUTOR_ABI,
      functionName: 'stake',
      args: [amountWei],
    }),
    value: 0n,
    description: `Stake ${amount} ${tokenInfo.symbol}`,
  });

  return {
    transactions,
    warnings,
    simulationPassed: warnings.length === 0,
  };
}

/**
 * Build unstake transaction
 */
export async function buildUnstakeBundle(
  distributorAddress: Hex,
  amount: string,
  userAddress: Hex,
  chain: SupportedStakingChain = 'base'
): Promise<TransactionBundle> {
  const client = getClient(chain);
  const warnings: string[] = [];

  // Get staking token info
  const stakingToken = await client.readContract({
    address: distributorAddress,
    abi: STAKING_DISTRIBUTOR_ABI,
    functionName: 'stakingToken',
  }) as Hex;

  const tokenInfo = await getTokenInfo(stakingToken, chain);
  const amountWei = parseUnits(amount, tokenInfo.decimals);

  // Check staked balance
  const stakedBalance = await client.readContract({
    address: distributorAddress,
    abi: STAKING_DISTRIBUTOR_ABI,
    functionName: 'stakedBalance',
    args: [userAddress],
  }) as bigint;

  if (stakedBalance < amountWei) {
    warnings.push(`Insufficient staked balance: have ${formatUnits(stakedBalance, tokenInfo.decimals)} ${tokenInfo.symbol}, want to unstake ${amount}`);
  }

  return {
    transactions: [{
      to: distributorAddress,
      data: encodeFunctionData({
        abi: STAKING_DISTRIBUTOR_ABI,
        functionName: 'unstake',
        args: [amountWei],
      }),
      value: 0n,
      description: `Unstake ${amount} ${tokenInfo.symbol}`,
    }],
    warnings,
    simulationPassed: warnings.length === 0,
  };
}

/**
 * Build claim transaction
 */
export async function buildClaimBundle(
  distributorAddress: Hex,
  userAddress: Hex,
  chain: SupportedStakingChain = 'base'
): Promise<{ transaction: { to: Hex; data: Hex; value: bigint; description: string }; claimableEth: string; warnings: string[] }> {
  const client = getClient(chain);
  const warnings: string[] = [];

  // Check claimable amount
  const claimable = await client.readContract({
    address: distributorAddress,
    abi: STAKING_DISTRIBUTOR_ABI,
    functionName: 'withdrawable',
    args: [userAddress],
  }) as bigint;

  const claimableEth = formatEther(claimable);

  if (claimable === 0n) {
    warnings.push('No revenue to claim');
  }

  return {
    transaction: {
      to: distributorAddress,
      data: encodeFunctionData({
        abi: STAKING_DISTRIBUTOR_ABI,
        functionName: 'claim',
      }),
      value: 0n,
      description: `Claim ${claimableEth} ETH revenue`,
    },
    claimableEth,
    warnings,
  };
}

/**
 * Build deposit revenue transaction (for app owners)
 */
export function buildDepositTransaction(
  distributorAddress: Hex,
  amountEth: string
): { to: Hex; data: Hex; value: bigint; description: string } {
  const amountWei = parseEther(amountEth);

  return {
    to: distributorAddress,
    data: encodeFunctionData({
      abi: STAKING_DISTRIBUTOR_ABI,
      functionName: 'deposit',
    }),
    value: amountWei,
    description: `Deposit ${amountEth} ETH as revenue`,
  };
}
