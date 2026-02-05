/**
 * Resolved Wallet Identity
 *
 * Provides a canonical identity object that all wallet tools include in their responses.
 * This ensures auditors can trace every action back to a specific wallet session.
 *
 * @see PRD Section 5 - Unified Wallet Identity (UWI)
 */

import { getSession } from '../storage/session.js';
import type { Hex } from 'viem';

/**
 * Canonical wallet identity bound to a Claude session.
 * Every wallet tool response should include this for traceability.
 */
export interface ResolvedIdentity {
  /** Chain namespace (always 'evm' for now) */
  chainNamespace: 'evm';
  /** Chain ID (e.g., 8453 for Base, 1 for Ethereum) */
  chainId: number;
  /** Wallet address in checksummed format */
  address: string;
  /** Backend that manages this wallet */
  walletBackend: 'para';
  /** Para wallet ID */
  walletId: string;
  /** Session marker for tracing (hash of session creation time) */
  sessionMarker: string;
}

/**
 * Error codes for identity resolution failures
 */
export type IdentityErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'SESSION_EXPIRED'
  | 'WALLET_ID_MISSING'
  | 'ADDRESS_MISSING'
  | 'CHAIN_NOT_SUPPORTED';

/**
 * Result of identity resolution
 */
export type IdentityResult =
  | { success: true; identity: ResolvedIdentity }
  | { success: false; errorCode: IdentityErrorCode; hint: string };

/**
 * Supported chain IDs
 */
export const SUPPORTED_CHAIN_IDS = [1, 8453, 42161, 10, 137] as const;
export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

/**
 * Chain ID to name mapping
 */
export const CHAIN_NAMES: Record<SupportedChainId, string> = {
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum',
  10: 'optimism',
  137: 'polygon',
};

/**
 * Default chain ID when not specified
 */
export const DEFAULT_CHAIN_ID: SupportedChainId = 8453; // Base

/**
 * Resolve the current wallet identity for a given chain.
 *
 * This is the single source of truth for "which wallet is active".
 * All wallet tools should call this to get consistent identity info.
 *
 * @param chainId - Target chain ID (defaults to Base)
 * @returns Resolved identity or error with remediation hint
 */
export async function resolveIdentity(
  chainId: number = DEFAULT_CHAIN_ID
): Promise<IdentityResult> {
  // Get session
  const session = await getSession();

  // Check authentication
  if (!session?.authenticated) {
    return {
      success: false,
      errorCode: 'NOT_AUTHENTICATED',
      hint: 'Run wallet_setup to authenticate your wallet.',
    };
  }

  // Check wallet ID
  if (!session.walletId) {
    return {
      success: false,
      errorCode: 'WALLET_ID_MISSING',
      hint: 'Session is missing wallet ID. Run wallet_setup again.',
    };
  }

  // Check address
  if (!session.address) {
    return {
      success: false,
      errorCode: 'ADDRESS_MISSING',
      hint: 'Session is missing wallet address. Run wallet_setup again.',
    };
  }

  // Check chain support
  if (!SUPPORTED_CHAIN_IDS.includes(chainId as SupportedChainId)) {
    return {
      success: false,
      errorCode: 'CHAIN_NOT_SUPPORTED',
      hint: `Chain ID ${chainId} is not supported. Supported chains: ${SUPPORTED_CHAIN_IDS.join(', ')}`,
    };
  }

  // Check session age (warn if > 23 hours, expire at 24)
  const sessionAge = Date.now() - new Date(session.createdAt).getTime();
  const SESSION_EXPIRE_MS = 24 * 60 * 60 * 1000; // 24 hours

  if (sessionAge > SESSION_EXPIRE_MS) {
    return {
      success: false,
      errorCode: 'SESSION_EXPIRED',
      hint: 'Session has expired. Run wallet_setup to re-authenticate.',
    };
  }

  // Generate session marker (stable hash for tracing)
  const sessionMarker = generateSessionMarker(session.createdAt, session.address);

  return {
    success: true,
    identity: {
      chainNamespace: 'evm',
      chainId,
      address: session.address,
      walletBackend: 'para',
      walletId: session.walletId,
      sessionMarker,
    },
  };
}

/**
 * Get resolved identity or throw with descriptive error.
 * Convenience wrapper for tools that require identity.
 */
export async function requireIdentity(chainId?: number): Promise<ResolvedIdentity> {
  const result = await resolveIdentity(chainId);

  if (!result.success) {
    throw new Error(`Identity resolution failed (${result.errorCode}): ${result.hint}`);
  }

  return result.identity;
}

/**
 * Generate a stable session marker for tracing.
 * This is a short hash that identifies the session without exposing sensitive data.
 */
function generateSessionMarker(createdAt: string, address: string): string {
  // Simple hash: first 8 chars of base64(sha256(createdAt + address))
  // In production, use proper crypto, but for tracing this is sufficient
  const input = `${createdAt}:${address}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36).padStart(8, '0').slice(0, 8);
}

/**
 * Format identity for display in tool responses
 */
export function formatIdentityForResponse(identity: ResolvedIdentity): string {
  const chainName = CHAIN_NAMES[identity.chainId as SupportedChainId] || `chain:${identity.chainId}`;
  const shortAddress = `${identity.address.slice(0, 6)}...${identity.address.slice(-4)}`;
  return `${shortAddress} on ${chainName} (session: ${identity.sessionMarker})`;
}

/**
 * Create a standardized tool response with identity included
 */
export function createToolResponse<T extends Record<string, unknown>>(
  data: T,
  identity: ResolvedIdentity
): T & { resolvedIdentity: ResolvedIdentity } {
  return {
    ...data,
    resolvedIdentity: identity,
  };
}
