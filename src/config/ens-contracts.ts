/**
 * ENS Contract Configuration
 *
 * Addresses and ABI fragments for ENS name registration on Ethereum mainnet.
 * Uses raw viem encodeFunctionData with ABI fragments instead of the ensjs SDK
 * to avoid adding a new dependency.
 *
 * ENS Registration Flow:
 * 1. Check availability via ETHRegistrarController.available(name)
 * 2. Get price via ETHRegistrarController.rentPrice(name, duration)
 * 3. Generate commitment via makeCommitment(...)
 * 4. Submit commitment (tx 1) — commit(commitment)
 * 5. Wait MIN_COMMITMENT_AGE (60s)
 * 6. Register with ETH payment (tx 2) — register(...)
 *
 * @see https://docs.ens.domains/registry/eth
 */

import type { Hex } from 'viem';

// ─── Contract Addresses (Ethereum Mainnet) ──────────────────────────

export const ENS_CONTRACTS = {
  /** ETHRegistrarController — handles .eth name registration and renewal */
  ETH_REGISTRAR_CONTROLLER: '0x253553366Da8546fC250F225fe3d25d0C782303b' as Hex,

  /** NameWrapper — wraps ENS names as ERC-1155 tokens */
  NAME_WRAPPER: '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401' as Hex,

  /** PublicResolver — default resolver for forward/reverse resolution */
  PUBLIC_RESOLVER: '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63' as Hex,

  /** ReverseRegistrar — manages reverse records (address → name) */
  REVERSE_REGISTRAR: '0xa58E81fe9b61B5c3fE2AFD33CF304c454AbFc7Cb' as Hex,

  /** ENS Registry — core registry of all .eth names */
  REGISTRY: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e' as Hex,
} as const;

// ─── Registration Constants ─────────────────────────────────────────

/** Minimum wait between commit and register (seconds) */
export const MIN_COMMITMENT_AGE = 60;

/** Maximum time a commitment is valid (seconds) */
export const MAX_COMMITMENT_AGE = 86400; // 24 hours

/** Minimum registration duration (seconds) — 28 days */
export const MIN_REGISTRATION_DURATION = 28 * 24 * 60 * 60;

/** Default registration duration (seconds) — 1 year */
export const DEFAULT_REGISTRATION_DURATION = 365 * 24 * 60 * 60;

/** Fuses value for unwrapped names (no restrictions) */
export const NO_FUSES = 0;

// ─── ABI Fragments ──────────────────────────────────────────────────
// Minimal ABI fragments for viem's encodeFunctionData / decodeFunctionResult.
// Only the functions we actually call are included.

/**
 * ETHRegistrarController ABI fragments
 */
export const ETH_REGISTRAR_CONTROLLER_ABI = [
  // Read: Check if a name is available
  {
    inputs: [{ name: 'name', type: 'string' }],
    name: 'available',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Read: Get rent price for name + duration
  {
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'duration', type: 'uint256' },
    ],
    name: 'rentPrice',
    outputs: [
      {
        components: [
          { name: 'base', type: 'uint256' },
          { name: 'premium', type: 'uint256' },
        ],
        name: 'price',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  // Read: Generate a commitment hash
  {
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'owner', type: 'address' },
      { name: 'duration', type: 'uint256' },
      { name: 'secret', type: 'bytes32' },
      { name: 'resolver', type: 'address' },
      { name: 'data', type: 'bytes[]' },
      { name: 'reverseRecord', type: 'bool' },
      { name: 'ownerControlledFuses', type: 'uint16' },
    ],
    name: 'makeCommitment',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'pure',
    type: 'function',
  },
  // Write: Submit a commitment (tx 1 of 2)
  {
    inputs: [{ name: 'commitment', type: 'bytes32' }],
    name: 'commit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // Write: Register the name with ETH payment (tx 2 of 2)
  {
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'owner', type: 'address' },
      { name: 'duration', type: 'uint256' },
      { name: 'secret', type: 'bytes32' },
      { name: 'resolver', type: 'address' },
      { name: 'data', type: 'bytes[]' },
      { name: 'reverseRecord', type: 'bool' },
      { name: 'ownerControlledFuses', type: 'uint16' },
    ],
    name: 'register',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  // Write: Renew an existing name
  {
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'duration', type: 'uint256' },
    ],
    name: 'renew',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

/**
 * ENS Registry ABI fragments (for checking name ownership)
 */
export const ENS_REGISTRY_ABI = [
  {
    inputs: [{ name: 'node', type: 'bytes32' }],
    name: 'owner',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'node', type: 'bytes32' }],
    name: 'resolver',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * PublicResolver ABI fragments (for reading/setting records)
 */
export const PUBLIC_RESOLVER_ABI = [
  // Read: Get the address a name resolves to
  {
    inputs: [{ name: 'node', type: 'bytes32' }],
    name: 'addr',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Read: Get a text record
  {
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
    ],
    name: 'text',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;
