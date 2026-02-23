/**
 * Centralized Chain Configuration
 *
 * Single source of truth for chain IDs, RPC URLs, and explorer URLs.
 * All tool modules should import from here instead of duplicating.
 */

import { type Hex } from 'viem';
import { base, mainnet, arbitrum, optimism, polygon } from 'viem/chains';

/**
 * Supported chain names
 */
export type SupportedChain = 'base' | 'ethereum' | 'arbitrum' | 'optimism' | 'polygon';

/**
 * Chain configuration
 */
export interface ChainConfig {
  chain: typeof base | typeof mainnet | typeof arbitrum | typeof optimism | typeof polygon;
  chainId: number;
  name: string;
  explorerUrl: string;
  nativeSymbol: string;
  nativeDecimals: number;
}

/**
 * All chain configurations
 */
export const CHAINS: Record<SupportedChain, ChainConfig> = {
  base: {
    chain: base,
    chainId: 8453,
    name: 'Base',
    explorerUrl: 'https://basescan.org',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
  },
  ethereum: {
    chain: mainnet,
    chainId: 1,
    name: 'Ethereum',
    explorerUrl: 'https://etherscan.io',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
  },
  arbitrum: {
    chain: arbitrum,
    chainId: 42161,
    name: 'Arbitrum',
    explorerUrl: 'https://arbiscan.io',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
  },
  optimism: {
    chain: optimism,
    chainId: 10,
    name: 'Optimism',
    explorerUrl: 'https://optimistic.etherscan.io',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
  },
  polygon: {
    chain: polygon,
    chainId: 137,
    name: 'Polygon',
    explorerUrl: 'https://polygonscan.com',
    nativeSymbol: 'MATIC',
    nativeDecimals: 18,
  },
};

/**
 * Chainstack endpoint IDs (used when CHAINSTACK_API_KEY is set)
 *
 * These are the chain-specific endpoint prefixes for Chainstack.
 * Full URL: https://{prefix}.core.chainstack.com/{apiKey}
 *
 * To get your endpoints:
 * 1. Go to https://console.chainstack.com/
 * 2. Create a project → Add a node for each chain
 * 3. Copy the API key from any endpoint URL
 */
const CHAINSTACK_ENDPOINTS: Record<SupportedChain, string> = {
  base: 'base-mainnet',
  ethereum: 'ethereum-mainnet',
  arbitrum: 'arbitrum-mainnet',
  optimism: 'optimism-mainnet',
  polygon: 'polygon-mainnet',
};

/**
 * Fallback public RPC URLs (last resort when no API keys configured)
 *
 * These are rate-limited and may be unreliable for production use.
 */
const FALLBACK_RPCS: Record<SupportedChain, string> = {
  base: 'https://mainnet.base.org',
  ethereum: 'https://eth-mainnet.public.blastapi.io',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  optimism: 'https://mainnet.optimism.io',
  polygon: 'https://polygon-rpc.com',
};

/**
 * Get RPC URL for a chain
 *
 * Priority:
 * 1. Chain-specific env var (e.g., BASE_RPC_URL)
 * 2. Chainstack with CHAINSTACK_API_KEY
 * 3. Fallback public RPC
 */
export function getRpcUrl(chain: SupportedChain): string {
  // 1. Check for chain-specific env var
  const envKey = `${chain.toUpperCase()}_RPC_URL`;
  const envUrl = process.env[envKey];
  if (envUrl) return envUrl;

  // 2. Check for Chainstack API key
  const chainstackKey = process.env.CHAINSTACK_API_KEY;
  if (chainstackKey) {
    const endpoint = CHAINSTACK_ENDPOINTS[chain];
    return `https://${endpoint}.core.chainstack.com/${chainstackKey}`;
  }

  // 3. Fallback to public RPC
  return FALLBACK_RPCS[chain] || FALLBACK_RPCS.base;
}

/**
 * Get explorer URL for a transaction
 */
export function getExplorerTxUrl(chain: SupportedChain, txHash: string): string {
  return `${CHAINS[chain].explorerUrl}/tx/${txHash}`;
}

/**
 * Get chain ID for a supported chain
 */
export function getChainId(chain: SupportedChain): number {
  return CHAINS[chain].chainId;
}

/**
 * Type guard for supported chains
 */
export function isSupportedChain(chain: string): chain is SupportedChain {
  return ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'].includes(chain);
}

/**
 * List of all supported chain names
 */
export const SUPPORTED_CHAINS: SupportedChain[] = ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'];
