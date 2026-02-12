/**
 * Para Wallet Client
 *
 * Wraps the Para wallet API for signing operations.
 * Para is a non-custodial wallet infrastructure that enables
 * server-side signing with user-controlled keys.
 *
 * The client communicates with clara-proxy which forwards
 * authenticated requests to the Para API.
 */

import { type Hex, hashTypedData, recoverAddress } from 'viem';
import { proxyFetch } from '../auth/proxy-fetch.js';
import { getCurrentSessionKey } from '../auth/session-key.js';

/**
 * Deep convert BigInt values to strings for JSON serialization
 * Handles nested objects and arrays recursively
 */
function deepConvertBigInt(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(deepConvertBigInt);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, deepConvertBigInt(v)])
    );
  }
  return value;
}

export interface ParaConfig {
  /** Clara proxy URL (e.g., https://clara-proxy.your-domain.workers.dev) */
  proxyUrl: string;
  /** Wallet ID from Para */
  walletId: string;
  /** User ID for Para authentication */
  userId?: string;
}

export interface SignedTypedData {
  signature: Hex;
  hash: Hex;
}

/**
 * Para Wallet Client
 *
 * Provides wallet operations through the Para API:
 * - EIP-712 typed data signing (for x402 payments)
 * - Raw transaction signing (for direct on-chain operations)
 * - Address retrieval
 */
export class ParaClient {
  private config: ParaConfig;
  private cachedAddress?: Hex;

  constructor(config: ParaConfig) {
    this.config = config;
  }

  /**
   * Get the wallet address
   *
   * Caches the address after first retrieval since it doesn't change.
   */
  async getAddress(): Promise<Hex> {
    if (this.cachedAddress) {
      return this.cachedAddress;
    }

    const response = await fetch(`${this.config.proxyUrl}/api/v1/wallets`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get wallet: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { wallets: Array<{ id: string; address: string }> };
    const wallet = data.wallets.find((w) => w.id === this.config.walletId);

    if (!wallet) {
      throw new Error(`Wallet ${this.config.walletId} not found`);
    }

    this.cachedAddress = wallet.address as Hex;
    return this.cachedAddress;
  }

  /**
   * Sign typed data (EIP-712)
   *
   * Used for x402 payment authorization and other typed signatures.
   * EIP-712 provides structured, human-readable signing that wallets
   * can display clearly to users.
   *
   * @see https://eips.ethereum.org/EIPS/eip-712
   */
  async signTypedData(
    domain: {
      name: string;
      version: string;
      chainId?: number;
      verifyingContract?: Hex;
    },
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>
  ): Promise<Hex> {
    // Compute the typed data hash (for verification)
    const hash = hashTypedData({
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId,
        verifyingContract: domain.verifyingContract,
      },
      types,
      primaryType: Object.keys(types)[0],
      message: value,
    });

    // Create the sign request payload
    // Deep convert BigInts to strings for JSON serialization
    const serializableMessage = deepConvertBigInt(value);
    const serializableDomain = deepConvertBigInt(domain);

    // Get primary type (excluding EIP712Domain which is implicit)
    const primaryType = Object.keys(types).find((t) => t !== 'EIP712Domain') || Object.keys(types)[0];

    const signPayload = {
      typedData: {
        domain: serializableDomain,
        types,
        primaryType,
        message: serializableMessage,
      },
    };

    // Get wallet address from session for authentication
    const session = await getSession();
    const walletAddress = session?.address;
    if (!walletAddress) {
      throw new Error('No wallet address found in session. Run wallet_setup first.');
    }

    const response = await proxyFetch(
      `${this.config.proxyUrl}/api/v1/wallets/${this.config.walletId}/sign-typed-data`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signPayload),
      },
      { walletAddress, sessionKey: getCurrentSessionKey() },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to sign typed data: ${response.status} - ${errorText}`);
    }

    const result = await response.json() as { signature: string };
    return result.signature as Hex;
  }

  /**
   * Sign a raw transaction
   *
   * Used for direct on-chain operations when typed data isn't appropriate.
   */
  async signRaw(messageHash: Hex): Promise<Hex> {
    // Get wallet address from session for authentication
    const session = await getSession();
    const walletAddress = session?.address;
    if (!walletAddress) {
      throw new Error('No wallet address found in session. Run wallet_setup first.');
    }

    const response = await proxyFetch(
      `${this.config.proxyUrl}/api/v1/wallets/${this.config.walletId}/sign-raw`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageHash }),
      },
      { walletAddress, sessionKey: getCurrentSessionKey() },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to sign: ${response.status} - ${errorText}`);
    }

    const result = await response.json() as { signature: string };
    return result.signature as Hex;
  }
}

/**
 * Load Para configuration from environment/config file
 */
export function loadParaConfig(): ParaConfig {
  const proxyUrl = process.env.CLARA_PROXY_URL;
  const walletId = process.env.PARA_WALLET_ID;

  if (!proxyUrl) {
    throw new Error('CLARA_PROXY_URL environment variable is required');
  }

  if (!walletId) {
    throw new Error('PARA_WALLET_ID environment variable is required');
  }

  return {
    proxyUrl,
    walletId,
    userId: process.env.PARA_USER_ID,
  };
}

// Import session storage for wallet management
import { getSession, saveSession, clearSession } from '../storage/session.js';

const CLARA_PROXY = process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn-me.workers.dev';

export interface SetupResult {
  isNew: boolean;
  address: string;
  email?: string;
}

export interface WalletStatus {
  authenticated: boolean;
  address?: string;
  email?: string;
  sessionAge?: string;
  chains?: string[];
}

/**
 * Setup or restore a wallet
 *
 * If email is provided, creates/restores a portable wallet.
 * Otherwise creates a machine-specific wallet.
 *
 * Handles the case where a wallet already exists for the email:
 * - 409 response → fetch existing wallet and reconnect
 */
export async function setupWallet(email?: string): Promise<SetupResult> {
  // Check for existing session
  const existingSession = await getSession();
  if (existingSession?.authenticated && existingSession.address) {
    return {
      isNew: false,
      address: existingSession.address,
      email: existingSession.email,
    };
  }

  const identifier = email || `machine:${process.env.USER || 'claude'}:${Date.now()}`;
  const identifierType = email ? 'EMAIL' : 'CUSTOM_ID';

  // Try to create new wallet via proxy
  const response = await fetch(`${CLARA_PROXY}/api/v1/wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'EVM',
      userIdentifier: identifier,
      userIdentifierType: identifierType,
    }),
  });

  // Handle 409 Conflict - wallet already exists, recover via walletId
  if (response.status === 409 && email) {
    console.error('[clara] Wallet exists for email, recovering via walletId...');
    const body = await response.json() as { walletId?: string; message?: string };
    if (body.walletId) {
      return await recoverWalletFromId(body.walletId, email);
    }
    // Fallback to old lookup path if 409 doesn't include walletId
    return await reconnectExistingWallet(email);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Wallet creation failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as {
    wallet?: { id: string; address: string };
    wallets?: Array<{ id: string; address: string }>;
  };

  const wallet = data.wallet || data.wallets?.[0];
  if (!wallet) {
    throw new Error('No wallet returned from API');
  }

  // Save session
  await saveSession({
    authenticated: true,
    walletId: wallet.id,
    address: wallet.address,
    email,
    chains: ['EVM'],
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  });

  return {
    isNew: true,
    address: wallet.address,
    email,
  };
}

/**
 * Recover wallet address from walletId via test-sign + ecrecover
 *
 * When the 409 response includes a walletId, we can derive the address
 * by signing a known hash and recovering the public key. This avoids
 * needing proxy GET endpoints that don't exist.
 */
async function recoverWalletFromId(walletId: string, email: string): Promise<SetupResult> {
  console.error(`[clara] Recovering address for walletId: ${walletId.slice(0, 8)}...`);

  // Sign a known hash with a dummy address (proxy doesn't verify ownership)
  const testHash = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex;
  const dummyAddress = '0x0000000000000000000000000000000000000001';

  const signResponse = await fetch(`${CLARA_PROXY}/api/v1/wallets/${walletId}/sign-raw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Clara-Address': dummyAddress,
    },
    body: JSON.stringify({ data: testHash }),
  });

  if (!signResponse.ok) {
    const errText = await signResponse.text();
    throw new Error(`Cannot recover wallet: sign-raw failed (${signResponse.status}): ${errText}`);
  }

  const { signature } = await signResponse.json() as { signature: string };
  const sig = (signature.startsWith('0x') ? signature : `0x${signature}`) as Hex;

  // Ecrecover the real address from the signature
  const address = await recoverAddress({ hash: testHash, signature: sig });

  console.error(`[clara] Recovered wallet address: ${address}`);

  // Save session
  await saveSession({
    authenticated: true,
    walletId,
    address,
    email,
    chains: ['EVM'],
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  });

  return {
    isNew: false,
    address,
    email,
  };
}

/**
 * Reconnect to an existing wallet by email
 *
 * Used when wallet_setup detects a 409 (wallet already exists).
 * Fetches wallet info from Para API and saves a new session.
 */
async function reconnectExistingWallet(email: string): Promise<SetupResult> {
  // Use the lookup endpoint to get wallet by email
  const lookupResponse = await fetch(
    `${CLARA_PROXY}/api/v1/wallets/lookup?` +
      new URLSearchParams({
        userIdentifier: email,
        userIdentifierType: 'EMAIL',
        walletType: 'EVM',
      }),
    {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    }
  );

  if (!lookupResponse.ok) {
    // If lookup fails, try listing all wallets as fallback
    console.error('[clara] Lookup failed, trying list endpoint...');
    return await reconnectViaWalletList(email);
  }

  const data = await lookupResponse.json() as {
    wallet?: { id: string; address: string };
    wallets?: Array<{ id: string; address: string }>;
  };

  const wallet = data.wallet || data.wallets?.[0];
  if (!wallet) {
    throw new Error('Could not find existing wallet for email. Try wallet_restore instead.');
  }

  // Save session with reconnected wallet
  await saveSession({
    authenticated: true,
    walletId: wallet.id,
    address: wallet.address,
    email,
    chains: ['EVM'],
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  });

  console.error(`[clara] Reconnected to existing wallet: ${wallet.address}`);

  return {
    isNew: false,
    address: wallet.address,
    email,
  };
}

/**
 * Fallback: reconnect by listing all wallets
 *
 * Some Para API versions may not have the /lookup endpoint.
 * This fetches all wallets and finds the one we need.
 */
async function reconnectViaWalletList(email: string): Promise<SetupResult> {
  const listResponse = await fetch(`${CLARA_PROXY}/api/v1/wallets`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!listResponse.ok) {
    throw new Error(
      `Cannot reconnect to existing wallet. ` +
        `The wallet for ${email} exists but we cannot retrieve it. ` +
        `Try clearing the session and using wallet_restore with your email.`
    );
  }

  const data = await listResponse.json() as {
    wallets?: Array<{ id: string; address: string; email?: string }>;
  };

  // Find wallet by email or just use the first EVM wallet
  // (Para typically associates one wallet per email)
  const wallet = data.wallets?.find((w) => w.email === email) || data.wallets?.[0];

  if (!wallet) {
    throw new Error(
      `Wallet exists for ${email} but could not be retrieved. ` +
        `Please contact support or try wallet_restore.`
    );
  }

  // Save session
  await saveSession({
    authenticated: true,
    walletId: wallet.id,
    address: wallet.address,
    email,
    chains: ['EVM'],
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  });

  console.error(`[clara] Reconnected to wallet via list: ${wallet.address}`);

  return {
    isNew: false,
    address: wallet.address,
    email,
  };
}

/**
 * Get current wallet status
 */
export async function getWalletStatus(): Promise<WalletStatus> {
  const session = await getSession();

  if (!session?.authenticated || !session.address) {
    return { authenticated: false };
  }

  // Calculate session age
  const createdAt = new Date(session.createdAt);
  const now = new Date();
  const ageMs = now.getTime() - createdAt.getTime();
  const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
  const ageDays = Math.floor(ageHours / 24);

  let sessionAge: string;
  if (ageDays > 0) {
    sessionAge = `${ageDays} day${ageDays === 1 ? '' : 's'}`;
  } else if (ageHours > 0) {
    sessionAge = `${ageHours} hour${ageHours === 1 ? '' : 's'}`;
  } else {
    const ageMinutes = Math.floor(ageMs / (1000 * 60));
    sessionAge = `${ageMinutes} minute${ageMinutes === 1 ? '' : 's'}`;
  }

  return {
    authenticated: true,
    address: session.address,
    email: session.email,
    sessionAge,
    chains: session.chains || ['EVM'],
  };
}

/**
 * Logout (clear session)
 */
export async function logout(): Promise<void> {
  await clearSession();
}
