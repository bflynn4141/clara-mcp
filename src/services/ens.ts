/**
 * ENS Service Layer
 *
 * Core ENS operations used by the ens-check and ens-register tools.
 * Uses raw viem calls with ABI fragments from config/ens-contracts.ts
 * instead of the ensjs SDK to avoid adding a dependency.
 *
 * All read operations use a public client on Ethereum mainnet.
 * Write operations return encoded calldata for signAndSendTransaction.
 */

import {
  createPublicClient,
  encodeFunctionData,
  namehash,
  formatEther,
  type Hex,
} from 'viem';
import { normalize } from 'viem/ens';
import { mainnet } from 'viem/chains';
import { getTransport } from '../config/chains.js';
import {
  ENS_CONTRACTS,
  ETH_REGISTRAR_CONTROLLER_ABI,
  ENS_REGISTRY_ABI,
  PUBLIC_RESOLVER_ABI,
  DEFAULT_REGISTRATION_DURATION,
  NO_FUSES,
} from '../config/ens-contracts.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface ENSAvailabilityResult {
  name: string;
  normalizedName: string;
  available: boolean;
  /** Current owner address if name is taken (zero address if available) */
  currentOwner?: string;
  /** Address the name resolves to (if registered) */
  resolvedAddress?: string;
  /** Expiry info if registered (from NameWrapper — not yet implemented) */
}

export interface ENSPriceResult {
  /** Base price in wei */
  basePrice: bigint;
  /** Premium price in wei (for recently expired names) */
  premium: bigint;
  /** Total price in wei (base + premium) */
  totalPrice: bigint;
  /** Total price formatted in ETH */
  totalPriceEth: string;
  /** Duration in seconds */
  duration: number;
  /** Duration in human-readable form */
  durationLabel: string;
}

export interface ENSCommitmentData {
  /** The commitment hash to submit on-chain */
  commitment: Hex;
  /** The secret used (must be saved for the register step) */
  secret: Hex;
  /** Encoded calldata for the commit transaction */
  commitCalldata: Hex;
  /** The name being registered */
  name: string;
  /** Registration duration in seconds */
  duration: number;
}

export interface ENSRegisterData {
  /** Encoded calldata for the register transaction */
  registerCalldata: Hex;
  /** ETH value to send with the register transaction (price + 10% buffer) */
  value: bigint;
  /** The name being registered */
  name: string;
}

// ─── Ethereum Public Client ─────────────────────────────────────────

function getEthereumClient() {
  return createPublicClient({
    chain: mainnet,
    transport: getTransport('ethereum'),
  });
}

// ─── Name Validation ────────────────────────────────────────────────

/**
 * Validate and normalize an ENS name input.
 * Strips ".eth" suffix if present and normalizes using UTS-46.
 *
 * @throws Error if name is invalid (too short, invalid chars, etc.)
 */
export function validateENSName(input: string): string {
  // Strip .eth suffix if user included it
  let name = input.trim().toLowerCase();
  if (name.endsWith('.eth')) {
    name = name.slice(0, -4);
  }

  // Must be at least 3 characters for .eth registration
  if (name.length < 3) {
    throw new Error(
      `ENS name "${name}" is too short. Names must be at least 3 characters.`,
    );
  }

  // Normalize using UTS-46 (handles unicode, emojis, etc.)
  try {
    normalize(`${name}.eth`);
  } catch {
    throw new Error(
      `ENS name "${name}" contains invalid characters. Names must be valid UTS-46.`,
    );
  }

  return name;
}

// ─── Read Operations ────────────────────────────────────────────────

/**
 * Check if an ENS name is available for registration.
 * Also resolves the current owner and address if taken.
 */
export async function checkAvailability(
  rawName: string,
): Promise<ENSAvailabilityResult> {
  const name = validateENSName(rawName);
  const client = getEthereumClient();

  // Check availability on the ETHRegistrarController
  const available = await client.readContract({
    address: ENS_CONTRACTS.ETH_REGISTRAR_CONTROLLER,
    abi: ETH_REGISTRAR_CONTROLLER_ABI,
    functionName: 'available',
    args: [name],
  });

  const result: ENSAvailabilityResult = {
    name: `${name}.eth`,
    normalizedName: name,
    available: available as boolean,
  };

  // If taken, look up ownership and resolution
  if (!available) {
    const node = namehash(`${name}.eth`);

    // Get owner from ENS Registry
    try {
      const owner = await client.readContract({
        address: ENS_CONTRACTS.REGISTRY,
        abi: ENS_REGISTRY_ABI,
        functionName: 'owner',
        args: [node],
      });
      const ownerAddr = owner as string;
      if (ownerAddr !== '0x0000000000000000000000000000000000000000') {
        result.currentOwner = ownerAddr;
      }
    } catch {
      // Owner lookup failed — non-critical
    }

    // Get resolved address from PublicResolver
    try {
      const resolved = await client.readContract({
        address: ENS_CONTRACTS.PUBLIC_RESOLVER,
        abi: PUBLIC_RESOLVER_ABI,
        functionName: 'addr',
        args: [node],
      });
      const resolvedAddr = resolved as string;
      if (resolvedAddr !== '0x0000000000000000000000000000000000000000') {
        result.resolvedAddress = resolvedAddr;
      }
    } catch {
      // Resolution failed — name may not have a resolver set
    }
  }

  return result;
}

/**
 * Get the registration price for a name and duration.
 */
export async function getRentPrice(
  rawName: string,
  durationSeconds: number = DEFAULT_REGISTRATION_DURATION,
): Promise<ENSPriceResult> {
  const name = validateENSName(rawName);
  const client = getEthereumClient();

  const priceResult = await client.readContract({
    address: ENS_CONTRACTS.ETH_REGISTRAR_CONTROLLER,
    abi: ETH_REGISTRAR_CONTROLLER_ABI,
    functionName: 'rentPrice',
    args: [name, BigInt(durationSeconds)],
  });

  const price = priceResult as { base: bigint; premium: bigint };
  const totalPrice = price.base + price.premium;

  // Human-readable duration
  const years = Math.floor(durationSeconds / (365 * 24 * 60 * 60));
  const days = Math.floor((durationSeconds % (365 * 24 * 60 * 60)) / (86400));
  let durationLabel: string;
  if (years > 0 && days > 0) {
    durationLabel = `${years} year${years > 1 ? 's' : ''} ${days} day${days > 1 ? 's' : ''}`;
  } else if (years > 0) {
    durationLabel = `${years} year${years > 1 ? 's' : ''}`;
  } else {
    durationLabel = `${days} day${days > 1 ? 's' : ''}`;
  }

  return {
    basePrice: price.base,
    premium: price.premium,
    totalPrice,
    totalPriceEth: formatEther(totalPrice),
    duration: durationSeconds,
    durationLabel,
  };
}

// ─── Write Operation Helpers ────────────────────────────────────────

/**
 * Generate a commitment for ENS registration (step 1 of 2).
 *
 * Returns the commitment hash, secret, and encoded commit calldata.
 * The secret MUST be stored and re-used in the register step.
 */
export async function prepareCommitment(
  rawName: string,
  ownerAddress: Hex,
  durationSeconds: number = DEFAULT_REGISTRATION_DURATION,
): Promise<ENSCommitmentData> {
  const name = validateENSName(rawName);
  const client = getEthereumClient();

  // Generate a random 32-byte secret
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const secret = `0x${Array.from(secretBytes).map(b => b.toString(16).padStart(2, '0')).join('')}` as Hex;

  // Call makeCommitment on-chain to get the hash
  const commitment = await client.readContract({
    address: ENS_CONTRACTS.ETH_REGISTRAR_CONTROLLER,
    abi: ETH_REGISTRAR_CONTROLLER_ABI,
    functionName: 'makeCommitment',
    args: [
      name,
      ownerAddress,
      BigInt(durationSeconds),
      secret,
      ENS_CONTRACTS.PUBLIC_RESOLVER,
      [], // no additional data
      true, // set reverse record
      NO_FUSES,
    ],
  });

  // Encode the commit transaction calldata
  const commitCalldata = encodeFunctionData({
    abi: ETH_REGISTRAR_CONTROLLER_ABI,
    functionName: 'commit',
    args: [commitment as Hex],
  });

  return {
    commitment: commitment as Hex,
    secret,
    commitCalldata,
    name,
    duration: durationSeconds,
  };
}

/**
 * Generate the register calldata and value (step 2 of 2).
 *
 * Must be called after the commitment has been mined and
 * MIN_COMMITMENT_AGE (60s) has elapsed.
 */
export async function prepareRegistration(
  rawName: string,
  ownerAddress: Hex,
  secret: Hex,
  durationSeconds: number = DEFAULT_REGISTRATION_DURATION,
): Promise<ENSRegisterData> {
  const name = validateENSName(rawName);

  // Get current price to determine value
  const price = await getRentPrice(name, durationSeconds);

  // Add 10% buffer to cover potential price fluctuation
  const valueWithBuffer = price.totalPrice + price.totalPrice / 10n;

  // Encode the register transaction calldata
  const registerCalldata = encodeFunctionData({
    abi: ETH_REGISTRAR_CONTROLLER_ABI,
    functionName: 'register',
    args: [
      name,
      ownerAddress,
      BigInt(durationSeconds),
      secret,
      ENS_CONTRACTS.PUBLIC_RESOLVER,
      [], // no additional data
      true, // set reverse record
      NO_FUSES,
    ],
  });

  return {
    registerCalldata,
    value: valueWithBuffer,
    name,
  };
}

/**
 * Format a price result for display
 */
export function formatPrice(price: ENSPriceResult): string {
  const lines: string[] = [];

  lines.push(`**Price:** ${price.totalPriceEth} ETH`);
  lines.push(`**Duration:** ${price.durationLabel}`);

  if (price.premium > 0n) {
    lines.push(`**Base:** ${formatEther(price.basePrice)} ETH`);
    lines.push(`**Premium:** ${formatEther(price.premium)} ETH (recently expired name)`);
  }

  return lines.join('\n');
}
