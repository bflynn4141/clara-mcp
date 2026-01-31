/**
 * Centralized Token Configuration
 *
 * Single source of truth for token addresses, decimals, and symbols.
 * All tool modules should import from here instead of duplicating.
 */

import { type Hex } from 'viem';
import { type SupportedChain } from './chains.js';

/**
 * Token info
 */
export interface TokenInfo {
  address: Hex;
  decimals: number;
  symbol: string;
}

/**
 * Known token addresses by chain
 *
 * These are the most commonly used tokens across DeFi.
 * Tools can reference these by symbol (e.g., "USDC") instead of addresses.
 */
export const TOKENS: Record<SupportedChain, Record<string, TokenInfo>> = {
  base: {
    USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, symbol: 'USDC' },
    USDT: { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6, symbol: 'USDT' },
    DAI: { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, symbol: 'DAI' },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18, symbol: 'WETH' },
  },
  ethereum: {
    USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, symbol: 'USDC' },
    USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, symbol: 'USDT' },
    DAI: { address: '0x6B175474E89094C44Da98b954EescdeCB5BE3830', decimals: 18, symbol: 'DAI' },
    WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, symbol: 'WETH' },
  },
  arbitrum: {
    USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, symbol: 'USDC' },
    USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, symbol: 'USDT' },
    DAI: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, symbol: 'DAI' },
    WETH: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18, symbol: 'WETH' },
  },
  optimism: {
    USDC: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6, symbol: 'USDC' },
    USDT: { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6, symbol: 'USDT' },
    DAI: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, symbol: 'DAI' },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18, symbol: 'WETH' },
  },
  polygon: {
    USDC: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, symbol: 'USDC' },
    USDT: { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6, symbol: 'USDT' },
    DAI: { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18, symbol: 'DAI' },
    WETH: { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18, symbol: 'WETH' },
  },
};

/**
 * Get token info by symbol or address
 *
 * @param tokenInput - Token symbol (e.g., "USDC") or address (0x...)
 * @param chain - Chain to look up token on
 * @returns Token info or null if not found
 */
export function resolveToken(tokenInput: string, chain: SupportedChain): TokenInfo | null {
  const chainTokens = TOKENS[chain] || {};

  // Check if it's a known symbol
  const upperToken = tokenInput.toUpperCase();
  if (chainTokens[upperToken]) {
    return chainTokens[upperToken];
  }

  // Check if it's a contract address
  if (tokenInput.startsWith('0x') && tokenInput.length === 42) {
    // Check if this address matches a known token
    for (const token of Object.values(chainTokens)) {
      if (token.address.toLowerCase() === tokenInput.toLowerCase()) {
        return token;
      }
    }

    // Return with default decimals for unknown tokens
    return {
      address: tokenInput as Hex,
      decimals: 18, // Default, caller may need to fetch actual decimals
      symbol: 'TOKEN',
    };
  }

  return null;
}

/**
 * Get all tokens for a chain as an array
 */
export function getChainTokens(chain: SupportedChain): TokenInfo[] {
  return Object.values(TOKENS[chain] || {});
}

/**
 * List of common token symbols
 */
export const COMMON_TOKENS = ['USDC', 'USDT', 'DAI', 'WETH'] as const;
