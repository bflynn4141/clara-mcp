/**
 * NFT Position Detection
 *
 * Checks if a wallet holds NFT positions (ERC-721) on specific contracts.
 * Used to detect veNFT locks, Uniswap V3 LP positions, etc.
 *
 * General-purpose: works for ANY ERC-721 contract, not just ve-tokens.
 * Queries `balanceOf(address)` via RPC — no indexer needed.
 */

import { createPublicClient, type Hex } from 'viem';
import { getTransport, CHAINS, type SupportedChain } from '../config/chains.js';

// ============================================================================
// Types
// ============================================================================

export interface NFTPosition {
  /** The NFT contract address */
  contractAddress: string;
  /** Contract name (e.g., "VotingEscrow") */
  contractName: string;
  /** Number of NFTs held by the wallet */
  balance: number;
  /** Protocol name if known */
  protocol?: string;
  /** What kind of position this represents */
  positionType?: string;  // "ve_lock", "lp_position", "staked", etc.
}

// ERC-721 balanceOf ABI fragment
const ERC721_BALANCE_OF_ABI = [
  {
    inputs: [{ name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ============================================================================
// Position Type Mapping
// ============================================================================

/** Map action types to NFT position types */
const ACTION_TO_POSITION: Record<string, string> = {
  vote_escrow: 've_lock',
  staking: 'staked',
  liquidity: 'lp_position',
  gauge: 'gauge_deposit',
  governance: 'governance_nft',
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if a wallet holds NFTs on specific contracts.
 *
 * Takes a list of contract addresses to check and returns positions
 * where balanceOf > 0. Queries are parallelized for speed.
 *
 * @param walletAddress - The wallet to check
 * @param contracts - Contracts to check with metadata
 * @param chain - Which chain to query
 */
export async function checkNFTPositions(
  walletAddress: string,
  contracts: Array<{
    address: string;
    name: string;
    protocol?: string;
    actionType?: string;
  }>,
  chain: SupportedChain,
): Promise<NFTPosition[]> {
  if (contracts.length === 0) return [];

  const chainConfig = CHAINS[chain];
  if (!chainConfig) return [];

  const client = createPublicClient({
    chain: chainConfig.chain,
    transport: getTransport(chain),
  });

  // Query all contracts in parallel
  const results = await Promise.allSettled(
    contracts.map(async (contract) => {
      try {
        const balance = await client.readContract({
          address: contract.address as Hex,
          abi: ERC721_BALANCE_OF_ABI,
          functionName: 'balanceOf',
          args: [walletAddress as Hex],
        });

        const count = Number(balance);
        if (count > 0) {
          const position: NFTPosition = {
            contractAddress: contract.address,
            contractName: contract.name,
            balance: count,
          };
          if (contract.protocol) position.protocol = contract.protocol;
          if (contract.actionType && ACTION_TO_POSITION[contract.actionType]) {
            position.positionType = ACTION_TO_POSITION[contract.actionType];
          }
          return position;
        }
        return null;
      } catch {
        // Contract may not be ERC-721, or call reverted — skip silently
        return null;
      }
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<NFTPosition | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((p): p is NFTPosition => p !== null);
}
