/**
 * Gas Pre-flight Check
 *
 * Checks whether the wallet can afford a transaction BEFORE attempting it.
 * Uses the existing EIP-1559 gas estimation from para/gas.ts and combines
 * it with the wallet's ETH balance to determine affordability.
 *
 * Two-function API:
 * - checkGasPreflight() — returns a result object (no side effects)
 * - requireGas() — throws ClaraError if the wallet can't afford the tx
 */

import { createPublicClient, formatEther, http, type Hex, type PublicClient } from 'viem';
import { estimateGas } from './para/gas.js';
import { getRpcUrl, CHAINS, type SupportedChain } from './config/chains.js';
import { ClaraError, ClaraErrorCode } from './errors.js';

export interface GasPreflight {
  canAfford: boolean;
  ethBalance: bigint;
  estimatedGasCost: bigint;
  txValue: bigint;
  totalNeeded: bigint;
  availableAfterGas: bigint;
  breakdown: string;
}

/**
 * Check whether a wallet has enough native token to cover gas + tx value.
 *
 * @param chain - Target chain
 * @param address - Wallet address to check
 * @param options.txValue - ETH value being sent (default 0n)
 * @param options.gasLimit - Gas limit override (default 200_000n)
 */
export async function checkGasPreflight(
  chain: SupportedChain,
  address: Hex,
  options?: {
    txValue?: bigint;
    gasLimit?: bigint;
  },
): Promise<GasPreflight> {
  const txValue = options?.txValue ?? 0n;
  const gasLimit = options?.gasLimit ?? 200_000n;

  const chainConfig = CHAINS[chain];
  const client = createPublicClient({
    chain: chainConfig.chain,
    transport: http(getRpcUrl(chain)),
  });

  // 1. Get ETH balance
  const ethBalance = await client.getBalance({ address });

  // 2. Get gas fee estimate from existing para/gas.ts
  const gasEstimate = await estimateGas(client as PublicClient);

  // 3. Calculate worst-case gas cost: gasLimit * maxFeePerGas
  const estimatedGasCost = gasLimit * gasEstimate.maxFeePerGas;

  // 4. Total needed = gas cost + tx value
  const totalNeeded = estimatedGasCost + txValue;

  const canAfford = ethBalance >= totalNeeded;
  const availableAfterGas = canAfford ? ethBalance - totalNeeded : 0n;

  // Human-readable breakdown
  const symbol = chainConfig.nativeSymbol;
  const breakdown = canAfford
    ? `Balance: ${formatEther(ethBalance)} ${symbol} | Gas: ~${formatEther(estimatedGasCost)} ${symbol} | Available after: ${formatEther(availableAfterGas)} ${symbol}`
    : `Need ~${formatEther(totalNeeded)} ${symbol} (${formatEther(txValue)} value + ${formatEther(estimatedGasCost)} gas). Have: ${formatEther(ethBalance)} ${symbol}`;

  return {
    canAfford,
    ethBalance,
    estimatedGasCost,
    txValue,
    totalNeeded,
    availableAfterGas,
    breakdown,
  };
}

/**
 * Require sufficient gas or throw ClaraError.
 *
 * Convenience wrapper around checkGasPreflight() for use in tool handlers.
 * Call this before signing any transaction.
 */
export async function requireGas(
  chain: SupportedChain,
  address: Hex,
  options?: { txValue?: bigint; gasLimit?: bigint },
): Promise<GasPreflight> {
  const preflight = await checkGasPreflight(chain, address, options);

  if (!preflight.canAfford) {
    const sponsorHint = chain === 'base' && preflight.ethBalance === 0n
      ? ' Run `wallet_sponsor_gas` for free gas on your first transaction.'
      : '';
    throw new ClaraError(
      ClaraErrorCode.INSUFFICIENT_GAS,
      `Not enough ${CHAINS[chain].nativeSymbol} for this transaction.`,
      `Need ~${formatEther(preflight.totalNeeded)} ${CHAINS[chain].nativeSymbol} (${formatEther(preflight.txValue)} value + ${formatEther(preflight.estimatedGasCost)} gas). Have: ${formatEther(preflight.ethBalance)} ${CHAINS[chain].nativeSymbol}.${sponsorHint}`,
      {
        ethBalance: formatEther(preflight.ethBalance),
        gasNeeded: formatEther(preflight.estimatedGasCost),
        txValue: formatEther(preflight.txValue),
        totalNeeded: formatEther(preflight.totalNeeded),
      },
    );
  }

  return preflight;
}

/**
 * Require that an address has contract code deployed.
 *
 * Prevents silent failures: EVM allows calldata to EOAs,
 * so transactions to non-contract addresses succeed but do nothing.
 * Call this before interacting with any contract address.
 */
export async function requireContract(
  chain: SupportedChain,
  address: Hex,
  label?: string,
): Promise<void> {
  const chainConfig = CHAINS[chain];
  const client = createPublicClient({
    chain: chainConfig.chain,
    transport: http(getRpcUrl(chain)),
  });

  const code = await client.getCode({ address });
  if (!code || code === '0x' || code.length <= 2) {
    const name = label || address.slice(0, 10) + '...';
    throw new ClaraError(
      ClaraErrorCode.NO_CONTRACT,
      `No contract found at ${name} on ${chainConfig.name}.`,
      `The address \`${address}\` has no deployed code. This may mean the wrong chain or address was used.`,
      { address, chain },
    );
  }
}
