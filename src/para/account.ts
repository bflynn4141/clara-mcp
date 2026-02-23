/**
 * Para Custom Account
 *
 * Creates a viem-compatible account that signs via Para's /sign-raw endpoint.
 * This allows using viem's wallet clients for full transaction support:
 * - Gas estimation
 * - Nonce management
 * - Transaction serialization
 * - Broadcasting
 *
 * The account delegates all signing to Para via the clara-proxy.
 */

import {
  type Account,
  type Hex,
  type SignableMessage,
  keccak256,
  hashMessage,
  hashTypedData,
  serializeTransaction,
  type TransactionSerializable,
  hexToNumber,
} from 'viem';
import { toAccount } from 'viem/accounts';
import { getSession } from '../storage/session.js';
import { proxyFetch } from '../auth/proxy-fetch.js';
import { getCurrentSessionKey } from '../auth/session-key.js';

// Para API base URL - uses clara-proxy which injects API key
const PARA_API_BASE = process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn4141.workers.dev';

/**
 * Sign a raw hash via Para's /sign-raw endpoint
 *
 * Para signs any 32-byte hash. The signature is returned in
 * standard Ethereum format (65 bytes: r || s || v).
 */
export async function signRawHash(
  walletId: string,
  hash: Hex,
  userAddress?: string
): Promise<Hex> {
  const response = await proxyFetch(
    `${PARA_API_BASE}/api/v1/wallets/${walletId}/sign-raw`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: hash }),
    },
    {
      walletAddress: userAddress || '',
      sessionKey: getCurrentSessionKey(),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();

    // Parse 402 Payment Required for better error message
    if (response.status === 402) {
      try {
        const errorData = JSON.parse(errorText);
        throw new Error(
          `Payment required. ${errorData.message || 'This operation requires x402 payment.'}\n` +
          `Use wallet_pay_x402 to pay for gated resources.`
        );
      } catch (e) {
        if (e instanceof SyntaxError) {
          throw new Error('Payment required. Ensure your wallet has USDC on Base for x402 auto-payments.');
        }
        throw e;
      }
    }

    throw new Error(`Failed to sign: ${response.status} - ${errorText}`);
  }

  const result = await response.json() as { signature: string };
  // Para returns signatures without 0x prefix - normalize
  const sig = result.signature.startsWith('0x') ? result.signature : `0x${result.signature}`;
  return sig as Hex;
}

/**
 * Parse an Ethereum signature into its components
 *
 * Standard Ethereum signatures are 65 bytes: r (32) || s (32) || v (1)
 * Returns {r, s, v, yParity} for use in transaction serialization.
 *
 * yParity is derived from v:
 * - v = 27 or 0 → yParity = 0
 * - v = 28 or 1 → yParity = 1
 *
 * Note: Para API returns signatures WITHOUT the 0x prefix.
 */
function parseSignatureComponents(signature: string): { r: Hex; s: Hex; v: bigint; yParity: number } {
  // Handle both with and without 0x prefix
  const sig = signature.startsWith('0x') ? signature.slice(2) : signature;
  if (sig.length !== 130) {
    throw new Error(`Invalid signature length: ${sig.length}, expected 130`);
  }

  const r = `0x${sig.slice(0, 64)}` as Hex;
  const s = `0x${sig.slice(64, 128)}` as Hex;
  const vHex = `0x${sig.slice(128, 130)}`;
  const vNum = hexToNumber(vHex as Hex);

  // Convert v to canonical form and yParity
  // v can be: 0, 1, 27, or 28
  let v: bigint;
  let yParity: number;

  if (vNum === 0 || vNum === 27) {
    v = 27n;
    yParity = 0;
  } else if (vNum === 1 || vNum === 28) {
    v = 28n;
    yParity = 1;
  } else {
    // For EIP-155 signatures, v includes chainId
    // yParity = (v - 35) % 2 for legacy, or just the last bit
    yParity = vNum % 2;
    v = BigInt(vNum);
  }

  return { r, s, v, yParity };
}

/**
 * Create a Para-backed viem Account
 *
 * This account uses Para's /sign-raw endpoint for all signing operations.
 * It's compatible with viem's wallet clients for sending transactions.
 *
 * @param address - The wallet's EVM address
 * @param walletId - Para wallet ID (for API calls)
 * @returns A viem Account that signs via Para
 */
export function createParaAccount(address: Hex, walletId: string): Account {
  return toAccount({
    address,

    // Sign a message (personal_sign / eth_sign)
    async signMessage({ message }: { message: SignableMessage }): Promise<Hex> {
      // Hash the message according to EIP-191
      const hash = hashMessage(message);
      console.error(`[para] Signing message hash: ${hash.slice(0, 20)}...`);
      return signRawHash(walletId, hash, address);
    },

    // Sign a transaction
    async signTransaction(transaction: TransactionSerializable): Promise<Hex> {
      // Serialize the unsigned transaction
      const serialized = serializeTransaction(transaction);

      // Hash for signing
      const hash = keccak256(serialized);
      console.error(`[para] Signing transaction hash: ${hash.slice(0, 20)}...`);

      // Get signature from Para
      const signature = await signRawHash(walletId, hash, address);

      // Parse signature into components
      const { r, s, v, yParity } = parseSignatureComponents(signature);

      // Re-serialize with signature
      const signedTx = serializeTransaction(transaction, {
        r,
        s,
        v,
        yParity,
      });

      return signedTx;
    },

    // Sign typed data (EIP-712)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async signTypedData(typedData: any): Promise<Hex> {
      // Hash the typed data according to EIP-712
      const hash = hashTypedData(typedData);
      console.error(`[para] Signing EIP-712 hash: ${hash.slice(0, 20)}...`);
      return signRawHash(walletId, hash, address);
    },
  });
}

/**
 * Create a Para account from the current session
 *
 * Convenience wrapper that reads wallet info from the session.
 * Throws if not authenticated.
 */
export async function createParaAccountFromSession(): Promise<Account> {
  const session = await getSession();

  if (!session?.authenticated || !session.walletId || !session.address) {
    throw new Error('Not authenticated. Run wallet_setup first.');
  }

  return createParaAccount(session.address as Hex, session.walletId);
}
