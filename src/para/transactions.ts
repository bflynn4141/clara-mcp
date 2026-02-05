/**
 * Centralized Transaction Submission
 *
 * Single source of truth for signing and sending transactions via Para.
 * Uses viem's wallet client with a custom Para-backed account.
 *
 * Benefits:
 * - Full transaction support (gas estimation, nonce management)
 * - Consistent error handling and logging
 * - Works with Para's /sign-raw endpoint
 * - Single place to update if API changes
 */

import {
  type Hex,
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
} from 'viem';
import { base, mainnet, arbitrum, optimism, polygon } from 'viem/chains';
import { getSession } from '../storage/session.js';
import { createParaAccount } from './account.js';
import { getRpcUrl, type SupportedChain } from '../config/chains.js';
import { estimateGas } from './gas.js';

// Chain mapping
const CHAIN_MAP: Record<number, Chain> = {
  1: mainnet,
  8453: base,
  42161: arbitrum,
  10: optimism,
  137: polygon,
};

// Chain name to ID mapping
const CHAIN_NAME_TO_ID: Record<SupportedChain, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
};

/**
 * Transaction parameters
 */
export interface TransactionParams {
  to: Hex;
  /** Value as hex string (0x...) or bigint */
  value: string | bigint;
  data?: Hex;
  chainId: number;
  /** Optional nonce override (for cancel/speedup) */
  nonce?: number;
  /** Optional gas limit */
  gas?: bigint;
  /** Optional max fee per gas (EIP-1559) */
  maxFeePerGas?: bigint;
  /** Optional max priority fee (EIP-1559) */
  maxPriorityFeePerGas?: bigint;
}

/**
 * Transaction result
 */
export interface TransactionResult {
  txHash: Hex;
}

/**
 * Get chain name from chain ID
 */
function getChainNameFromId(chainId: number): SupportedChain {
  const entry = Object.entries(CHAIN_NAME_TO_ID).find(([, id]) => id === chainId);
  if (!entry) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }
  return entry[0] as SupportedChain;
}

/**
 * Sign and send a transaction via Para
 *
 * This is the canonical way to submit transactions in clara-mcp.
 * Uses viem's wallet client with a custom Para-backed account that
 * signs via the /sign-raw endpoint.
 *
 * Handles:
 * - Value normalization (bigint -> hex string)
 * - Gas estimation (automatic if not provided)
 * - Nonce management (automatic if not provided)
 * - Transaction signing via Para
 * - Broadcasting to the network
 *
 * @param walletId - Para wallet ID from session
 * @param tx - Transaction parameters
 * @returns Transaction hash
 * @throws Error with descriptive message if transaction fails
 */
export async function signAndSendTransaction(
  walletId: string,
  tx: TransactionParams
): Promise<TransactionResult> {
  // Get session for address
  const session = await getSession();
  if (!session?.address) {
    throw new Error('No wallet address in session. Run wallet_setup first.');
  }

  const address = session.address as Hex;

  // Get chain configuration
  const chain = CHAIN_MAP[tx.chainId];
  if (!chain) {
    throw new Error(`Unsupported chain ID: ${tx.chainId}`);
  }

  const chainName = getChainNameFromId(tx.chainId);
  const rpcUrl = getRpcUrl(chainName);

  console.error(`[para] Preparing transaction on ${chainName} (chainId: ${tx.chainId})`);

  // Create Para-backed account
  const account = createParaAccount(address, walletId);

  // Create public client for reading chain state
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  // Create wallet client for sending transactions
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });

  // Normalize value to bigint
  let value: bigint;
  if (typeof tx.value === 'bigint') {
    value = tx.value;
  } else if (tx.value.startsWith('0x')) {
    value = BigInt(tx.value);
  } else {
    value = BigInt(tx.value);
  }

  try {
    // Build transaction request
    const request: {
      to: Hex;
      value: bigint;
      data?: Hex;
      nonce?: number;
      gas?: bigint;
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
    } = {
      to: tx.to,
      value,
    };

    // Add optional fields
    if (tx.data) {
      request.data = tx.data;
    }
    if (tx.nonce !== undefined) {
      request.nonce = tx.nonce;
    }
    if (tx.gas !== undefined) {
      request.gas = tx.gas;
    }
    if (tx.maxFeePerGas !== undefined) {
      request.maxFeePerGas = tx.maxFeePerGas;
    }
    if (tx.maxPriorityFeePerGas !== undefined) {
      request.maxPriorityFeePerGas = tx.maxPriorityFeePerGas;
    }

    // If gas not provided, estimate it
    if (!request.gas) {
      console.error('[para] Estimating gas...');
      const estimatedGas = await publicClient.estimateGas({
        account: address,
        to: tx.to,
        value,
        data: tx.data,
      });
      // Add 50% buffer for safety (complex contract calls like Morpho need headroom)
      request.gas = (estimatedGas * 150n) / 100n;
      console.error(`[para] Estimated gas: ${estimatedGas}, using: ${request.gas}`);
    }

    // If gas prices not provided, use smart estimation
    if (!request.maxFeePerGas) {
      // Smart gas estimation: samples recent blocks for optimal pricing
      const gasEstimate = await estimateGas(publicClient);
      request.maxFeePerGas = gasEstimate.maxFeePerGas;
      request.maxPriorityFeePerGas = gasEstimate.maxPriorityFeePerGas;

      // Ensure minimum of 0.1 gwei for very low gas chains like Base
      const minMaxFee = 100_000_000n; // 0.1 gwei
      if (request.maxFeePerGas < minMaxFee) {
        request.maxFeePerGas = minMaxFee;
        request.maxPriorityFeePerGas = minMaxFee / 10n;
      }

      console.error(
        `[para] Smart gas estimate: maxFee=${gasEstimate.formatted.maxFeeGwei} gwei, ` +
        `priorityFee=${gasEstimate.formatted.priorityFeeGwei} gwei`
      );
    }

    // Get nonce if not provided
    if (request.nonce === undefined) {
      request.nonce = await publicClient.getTransactionCount({ address });
      console.error(`[para] Nonce: ${request.nonce}`);
    }

    console.error(`[para] Sending transaction to ${tx.to.slice(0, 10)}...`);

    // Send the transaction
    // This will:
    // 1. Serialize the transaction
    // 2. Sign via our custom account (which uses Para)
    // 3. Broadcast to the network
    const txHash = await walletClient.sendTransaction(request);

    console.error(`[para] Transaction sent: ${txHash}`);

    return { txHash };
  } catch (error) {
    // Enhance error message
    const message = error instanceof Error ? error.message : String(error);

    // Check for common errors
    if (message.includes('insufficient funds')) {
      throw new Error(
        `Insufficient funds for transaction. ` +
        `Check your ${chainName} balance at: https://basescan.org/address/${address}`
      );
    }

    if (message.includes('nonce too low')) {
      throw new Error(
        `Nonce too low - a transaction may already be pending. ` +
        `Wait for pending transactions to confirm or specify a higher nonce.`
      );
    }

    if (message.includes('replacement transaction underpriced')) {
      throw new Error(
        `Transaction underpriced - there's already a pending transaction with this nonce. ` +
        `Increase gas price or wait for the pending transaction to confirm.`
      );
    }

    throw new Error(`Transaction failed: ${message}`);
  }
}

/**
 * Convenience wrapper that returns just the hash string
 * (for simpler call sites that don't need the full result object)
 */
export async function sendTransaction(
  walletId: string,
  tx: TransactionParams
): Promise<Hex> {
  const result = await signAndSendTransaction(walletId, tx);
  return result.txHash;
}

/**
 * Get the Para API base URL
 * Exposed for modules that need to make other Para API calls
 */
export function getParaApiBase(): string {
  return process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn-me.workers.dev';
}
