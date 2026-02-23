/**
 * Address Resolution Service
 *
 * Resolves human-readable names to Ethereum addresses.
 * Priority:
 *   1. Raw 0x address → pass through
 *   2. Bare name ("brian") → claraid.eth subname lookup (HTTP)
 *   3. "*.claraid.eth" → strip suffix, gateway lookup (HTTP)
 *   4. "*.eth" → on-chain ENS resolution (RPC)
 *   5. Anything else → error
 *
 * Clara names are the default namespace: sending to "brian"
 * resolves brian.claraid.eth automatically.
 */

import { createPublicClient, http, type Hex, isAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
import { getRpcUrl } from '../config/chains.js';

// ─── Config ──────────────────────────────────────────────

const GATEWAY_BASE =
  process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn4141.workers.dev';

const PARENT_DOMAIN = 'claraid.eth';

// ─── Types ───────────────────────────────────────────────

export interface ResolvedAddress {
  /** The resolved 0x address */
  address: Hex;
  /** How it was resolved */
  source: 'raw' | 'clara' | 'ens';
  /** Display name (e.g., "brian.claraid.eth" or "vitalik.eth") */
  displayName?: string;
}

// ─── Main Resolver ───────────────────────────────────────

/**
 * Resolve a name or address input to a validated 0x address.
 *
 * @param input - A raw 0x address, bare name, or ENS name
 * @returns Resolved address with metadata
 * @throws Error if resolution fails
 *
 * @example
 *   resolveAddress("0x8744...") → pass through
 *   resolveAddress("brian")     → brian.claraid.eth → 0x8744...
 *   resolveAddress("brian.claraid.eth") → 0x8744...
 *   resolveAddress("vitalik.eth") → on-chain ENS → 0xd8dA...
 */
export async function resolveAddress(input: string): Promise<ResolvedAddress> {
  if (!input || typeof input !== 'string') {
    throw new Error('Address or name is required');
  }

  const trimmed = input.trim();

  // 1. Raw 0x address — pass through
  if (trimmed.startsWith('0x')) {
    if (!isAddress(trimmed)) {
      throw new Error(`Invalid address format: ${trimmed}`);
    }
    return { address: trimmed as Hex, source: 'raw' };
  }

  const lower = trimmed.toLowerCase();

  // 2. *.claraid.eth — strip suffix, query gateway
  if (lower.endsWith(`.${PARENT_DOMAIN}`)) {
    const label = lower.slice(0, -(PARENT_DOMAIN.length + 1));
    return resolveClaraName(label);
  }

  // 3. Any other .eth name — on-chain ENS resolution
  if (lower.endsWith('.eth')) {
    return resolveEnsName(trimmed);
  }

  // 4. Bare name (no dots, no 0x) — try Clara namespace first
  if (!lower.includes('.')) {
    return resolveClaraName(lower);
  }

  // 5. Other dotted names (not .eth) — not supported
  throw new Error(
    `Cannot resolve "${trimmed}". Use a 0x address, a .eth name, or a Clara name (e.g., "brian" for brian.${PARENT_DOMAIN}).`,
  );
}

// ─── Clara Gateway Resolution ────────────────────────────

async function resolveClaraName(label: string): Promise<ResolvedAddress> {
  const fullName = `${label}.${PARENT_DOMAIN}`;

  try {
    const response = await fetch(
      `${GATEWAY_BASE}/ens/lookup/${encodeURIComponent(label)}`,
    );

    if (response.status === 404) {
      throw new Error(
        `"${fullName}" is not registered. The name is available — claim it with \`wallet_register_name\`.`,
      );
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(
        `Clara name lookup failed: ${body.error || response.statusText}`,
      );
    }

    const data = (await response.json()) as { address: string };

    if (!data.address || !isAddress(data.address)) {
      throw new Error(`Clara name "${fullName}" has an invalid address record`);
    }

    return {
      address: data.address as Hex,
      source: 'clara',
      displayName: fullName,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('is not registered')) {
      throw error; // Re-throw our own errors
    }
    throw new Error(
      `Failed to resolve Clara name "${fullName}": ${error instanceof Error ? error.message : 'Network error'}`,
    );
  }
}

// ─── On-Chain ENS Resolution ─────────────────────────────

async function resolveEnsName(name: string): Promise<ResolvedAddress> {
  try {
    // Normalize the ENS name (UTS-46)
    const normalized = normalize(name);

    const client = createPublicClient({
      chain: mainnet,
      transport: http(getRpcUrl('ethereum')),
    });

    const address = await client.getEnsAddress({ name: normalized });

    if (!address) {
      throw new Error(`ENS name "${name}" does not resolve to an address`);
    }

    return {
      address,
      source: 'ens',
      displayName: normalized,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('does not resolve')) {
      throw error;
    }
    throw new Error(
      `Failed to resolve ENS name "${name}": ${error instanceof Error ? error.message : 'RPC error'}`,
    );
  }
}

// ─── Display Helper ──────────────────────────────────────

/**
 * Format a resolved address for display in tool output.
 * Shows the name → address mapping if a name was resolved.
 */
export function formatResolved(resolved: ResolvedAddress): string {
  if (resolved.displayName) {
    return `${resolved.displayName} → \`${resolved.address}\``;
  }
  return `\`${resolved.address}\``;
}
