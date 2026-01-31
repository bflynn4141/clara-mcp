/**
 * x402 Payment Client
 *
 * Implements the HTTP 402 Payment Required protocol for AI agent micropayments.
 *
 * Flow:
 * 1. Client requests a paid resource
 * 2. Server responds: 402 Payment Required + payment details in headers
 * 3. Client signs payment with wallet (EIP-712)
 * 4. Client retries with X-PAYMENT header containing signed authorization
 * 5. Server verifies signature, processes payment, returns resource
 *
 * @see https://x402.org for protocol specification
 */

import { type Hex, encodePacked, keccak256, toHex, hexToBytes } from 'viem';
import { randomBytes } from 'crypto';

/**
 * Generate a random bytes32 nonce for EIP-3009
 */
function createNonce(): Hex {
  const bytes = randomBytes(32);
  return ('0x' + bytes.toString('hex')) as Hex;
}

// Known token addresses
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
export const USDC_ETHEREUM = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
export const BASE_CHAIN_ID = 8453;

/**
 * Known EIP-712 domains for tokens that support EIP-3009
 * These are used as fallbacks when the server doesn't provide token domain info
 */
const KNOWN_TOKEN_DOMAINS: Record<string, { name: string; version: string }> = {
  // USDC on Base
  [USDC_BASE.toLowerCase()]: { name: 'USD Coin', version: '2' },
  // USDC on Ethereum
  [USDC_ETHEREUM.toLowerCase()]: { name: 'USD Coin', version: '2' },
};

/**
 * Get the EIP-712 domain for a token, using known defaults if not provided
 */
function getTokenDomain(
  token: string,
  providedDomain?: { name: string; version: string }
): { name: string; version: string } | null {
  // Use provided domain if available
  if (providedDomain) {
    return providedDomain;
  }

  // Fall back to known token domains
  const knownDomain = KNOWN_TOKEN_DOMAINS[token.toLowerCase()];
  if (knownDomain) {
    console.log(`[x402] Using known token domain for ${token.slice(0, 10)}...`);
    return knownDomain;
  }

  // Unknown token - can't sign v2
  return null;
}

// Supported networks and their chain IDs
const SUPPORTED_NETWORKS: Record<string, number> = {
  'base': 8453,
  'base-mainnet': 8453,
  'base-sepolia': 84532,
  'ethereum': 1,
  'ethereum-mainnet': 1,
  'arbitrum': 42161,
  'optimism': 10,
};

// Tokens with known decimals (6 decimals)
const KNOWN_6_DECIMAL_TOKENS = new Set([
  USDC_BASE.toLowerCase(),
  USDC_ETHEREUM.toLowerCase(),
]);

/**
 * Check if a string is a valid EVM address
 */
function isValidEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Payment details extracted from 402 response headers
 */
export interface PaymentDetails {
  /** Payment recipient address */
  recipient: Hex;
  /** Amount in token base units (USDC has 6 decimals, so 1 USDC = 1000000) */
  amount: bigint;
  /** Token contract address */
  token: Hex;
  /** Chain ID (8453 for Base) */
  chainId: number;
  /** Unix timestamp when payment expires */
  validUntil: number;
  /** Unique payment identifier (v1) or generated nonce (v2) */
  paymentId: Hex;
  /** Human-readable description (optional) */
  description?: string;
  /** Original 402 response for debugging */
  rawHeaders: Record<string, string>;
  /** x402 protocol version (1 or 2) */
  x402Version?: number;
  /** Raw accepted payment option (for v2 header construction) */
  rawAccepted?: Record<string, unknown>;
  /** Resource info from v2 response */
  resource?: { url?: string; description?: string; mimeType?: string };
  /** Token EIP-712 domain params (for v2 EIP-3009 signing) */
  tokenDomain?: { name: string; version: string };
}

/**
 * Options for x402 requests
 */
export interface X402Options {
  /** Maximum USD amount willing to pay (default: "1.00") */
  maxAmountUsd?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
}

/**
 * Result of an x402 payment attempt
 */
export interface X402Result {
  /** Whether payment was successful */
  success: boolean;
  /** The response (either paid resource or error) */
  response?: Response;
  /** Payment details if 402 was encountered */
  paymentDetails?: PaymentDetails;
  /** Amount paid in USD (if successful) */
  amountPaidUsd?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * EIP-712 domain for x402 payments
 */
export const X402_DOMAIN = {
  name: 'x402',
  version: '1',
} as const;

/**
 * EIP-712 type definition
 */
export type EIP712TypeDefinition = Record<string, Array<{ name: string; type: string }>>;

/**
 * EIP-712 types for x402 v1 payment authorization (legacy)
 */
export const X402_TYPES: EIP712TypeDefinition = {
  Payment: [
    { name: 'recipient', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'token', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'validUntil', type: 'uint256' },
    { name: 'paymentId', type: 'bytes32' },
  ],
};

/**
 * EIP-3009 TransferWithAuthorization types for x402 v2
 *
 * This is the official x402 v2 signing format. The signature is made against
 * the token contract's EIP-712 domain, authorizing a direct token transfer.
 *
 * @see https://eips.ethereum.org/EIPS/eip-3009
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPES: EIP712TypeDefinition = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

/**
 * x402 Payment Client
 *
 * Handles the full x402 payment flow for HTTP 402 gated resources.
 */
/**
 * Domain type for signing
 */
export interface EIP712Domain {
  name: string;
  version: string;
  chainId?: number;
  verifyingContract?: Hex;
}

export class X402Client {
  constructor(
    private signTypedData: (
      domain: EIP712Domain,
      types: EIP712TypeDefinition,
      value: Record<string, unknown>
    ) => Promise<Hex>,
    private getAddress: () => Promise<Hex>
  ) {}

  /**
   * Parse payment details from a 402 response
   *
   * Supports multiple x402 header formats:
   * 1. www-authenticate: x402 address="...", amount="...", chainId="...", token="..."
   * 2. PAYMENT-REQUIRED header with base64-encoded JSON (Coinbase spec)
   * 3. X-Payment-* individual headers (legacy)
   */
  parsePaymentRequired(response: Response): PaymentDetails | null {
    if (response.status !== 402) {
      return null;
    }

    const headers = response.headers;
    const rawHeaders: Record<string, string> = {};
    headers.forEach((value, key) => {
      rawHeaders[key.toLowerCase()] = value;
    });

    // Try Format 1: www-authenticate header
    const wwwAuth = headers.get('www-authenticate');
    if (wwwAuth && wwwAuth.startsWith('x402')) {
      return this.parseWwwAuthenticate(wwwAuth, rawHeaders);
    }

    // Try Format 2: PAYMENT-REQUIRED header (base64 JSON)
    const paymentRequired = headers.get('payment-required');
    if (paymentRequired) {
      return this.parsePaymentRequiredHeader(paymentRequired, rawHeaders);
    }

    // Try Format 3: X-Payment-* headers (legacy)
    return this.parseXPaymentHeaders(headers, rawHeaders);
  }

  /**
   * Parse www-authenticate: x402 format
   * Example: x402 address="0x...", amount="0.01", chainId="8453", token="0x..."
   */
  private parseWwwAuthenticate(header: string, rawHeaders: Record<string, string>): PaymentDetails | null {
    // Parse key="value" pairs from the header
    const params: Record<string, string> = {};
    const regex = /(\w+)="([^"]+)"/g;
    let match;
    while ((match = regex.exec(header)) !== null) {
      params[match[1]] = match[2];
    }

    const { address, amount, chainId, token } = params;

    if (!address || !amount || !chainId || !token) {
      console.error('Missing required www-authenticate params:', params);
      return null;
    }

    // Generate payment ID from address + timestamp (server should provide this)
    const validUntil = Math.floor(Date.now() / 1000) + 300; // 5 min default
    const paymentId = keccak256(
      encodePacked(['address', 'uint256'], [address as Hex, BigInt(Date.now())])
    );

    // Parse amount - could be decimal (0.01) or base units
    let amountBigInt: bigint;
    if (amount.includes('.')) {
      // Decimal format - convert to base units (assuming USDC 6 decimals)
      amountBigInt = BigInt(Math.floor(parseFloat(amount) * 1_000_000));
    } else {
      amountBigInt = BigInt(amount);
    }

    return {
      recipient: address as Hex,
      amount: amountBigInt,
      token: token as Hex,
      chainId: parseInt(chainId, 10),
      validUntil,
      paymentId,
      description: params.description,
      rawHeaders,
    };
  }

  /**
   * Parse PAYMENT-REQUIRED header (supports v1 and v2 formats)
   * Contains base64-encoded JSON with payment details
   */
  private parsePaymentRequiredHeader(header: string, rawHeaders: Record<string, string>): PaymentDetails | null {
    try {
      const decoded = Buffer.from(header, 'base64').toString('utf-8');
      const data = JSON.parse(decoded);

      // Check for x402 v2 format
      if (data.x402Version === 2 && data.accepts && data.accepts.length > 0) {
        return this.parseX402V2Format(data, rawHeaders);
      }

      // v1 format: Expected fields: payTo, maxAmountRequired, asset, network, validUntil, paymentId
      const {
        payTo,
        maxAmountRequired,
        asset,
        network,
        validUntil,
        paymentId,
        description,
      } = data;

      if (!payTo || !maxAmountRequired || !asset) {
        console.error('Missing required PAYMENT-REQUIRED fields:', data);
        return null;
      }

      // Map network to chainId (v1 allows null network, defaults to Base)
      const chainId = this.parseNetworkToChainId(network) ?? BASE_CHAIN_ID;

      // Parse amount with token awareness
      const amountBigInt = this.parseAmount(maxAmountRequired, asset);
      if (amountBigInt === null) {
        console.error('[x402] Failed to parse v1 amount:', maxAmountRequired);
        return null;
      }

      return {
        recipient: payTo as Hex,
        amount: amountBigInt,
        token: asset as Hex,
        chainId,
        validUntil: validUntil || Math.floor(Date.now() / 1000) + 300,
        paymentId: paymentId || keccak256(encodePacked(['address', 'uint256'], [payTo as Hex, BigInt(Date.now())])),
        description,
        rawHeaders,
      };
    } catch (error) {
      console.error('Failed to parse PAYMENT-REQUIRED header:', error);
      return null;
    }
  }

  /**
   * Parse x402 v2 format
   * v2 uses accepts[] array with scheme, network, amount, asset, payTo
   *
   * Selection logic: Find first supported payment option (Base + known token)
   */
  private parseX402V2Format(data: Record<string, unknown>, rawHeaders: Record<string, string>): PaymentDetails | null {
    // Runtime validation: ensure accepts is an array
    if (!Array.isArray(data.accepts) || data.accepts.length === 0) {
      console.error('[x402] v2 format missing or empty accepts array');
      return null;
    }

    const accepts = data.accepts as Array<{
      scheme?: string;
      network?: string;
      amount?: string;
      asset?: string;
      payTo?: string;
      maxTimeoutSeconds?: number;
      extra?: { name?: string; version?: string; [key: string]: unknown };
    }>;

    // Find the first SUPPORTED payment option (prefer Base + USDC)
    const payment = this.selectBestPaymentOption(accepts);
    if (!payment) {
      console.error('[x402] No supported payment options found in accepts array:', accepts);
      return null;
    }

    const { network, amount, asset, payTo, maxTimeoutSeconds } = payment;

    // Validate required fields
    if (!payTo || !amount || !asset) {
      console.error('[x402] Missing required v2 fields:', payment);
      return null;
    }

    // Validate addresses are valid EVM format
    if (!isValidEvmAddress(payTo)) {
      console.error('[x402] Invalid payTo address:', payTo);
      return null;
    }
    if (!isValidEvmAddress(asset)) {
      console.error('[x402] Invalid asset address:', asset);
      return null;
    }

    // Parse network - fail-closed for unknown networks
    const chainId = this.parseNetworkToChainId(network);
    if (chainId === null) {
      console.error('[x402] Unsupported network:', network);
      return null;
    }

    // Parse amount with token-aware decimals
    const amountBigInt = this.parseAmount(amount, asset);
    if (amountBigInt === null) {
      console.error('[x402] Failed to parse amount:', amount);
      return null;
    }

    // Calculate validUntil from maxTimeoutSeconds (clamp to reasonable max)
    const maxTimeout = Math.min(maxTimeoutSeconds || 300, 3600); // Max 1 hour
    const validUntil = Math.floor(Date.now() / 1000) + maxTimeout;

    // Generate paymentId
    const paymentId = keccak256(
      encodePacked(['address', 'uint256'], [payTo as Hex, BigInt(Date.now())])
    );

    // Get description from resource if available
    const resource = data.resource as { description?: string } | undefined;
    const description = resource?.description;

    // Extract token domain params for v2 EIP-3009 signing
    const extra = payment.extra as { name?: string; version?: string } | undefined;
    const tokenDomain = extra?.name && extra?.version
      ? { name: extra.name, version: extra.version }
      : undefined;

    return {
      recipient: payTo as Hex,
      amount: amountBigInt,
      token: asset as Hex,
      chainId,
      validUntil,
      paymentId,
      description,
      rawHeaders,
      x402Version: 2,
      rawAccepted: payment,
      resource: data.resource as { url?: string; description?: string; mimeType?: string } | undefined,
      tokenDomain,
    };
  }

  /**
   * Select the best payment option from accepts array
   * Priority: 1) Base + USDC, 2) Any supported network + USDC, 3) First supported option
   */
  private selectBestPaymentOption(accepts: Array<{
    scheme?: string;
    network?: string;
    amount?: string;
    asset?: string;
    payTo?: string;
    maxTimeoutSeconds?: number;
    extra?: { name?: string; version?: string; [key: string]: unknown };
  }>): typeof accepts[0] | null {
    // First pass: look for Base + USDC
    for (const option of accepts) {
      const chainId = this.parseNetworkToChainId(option.network);
      if (chainId === BASE_CHAIN_ID && option.asset?.toLowerCase() === USDC_BASE.toLowerCase()) {
        return option;
      }
    }

    // Second pass: any supported network + known stablecoin
    for (const option of accepts) {
      const chainId = this.parseNetworkToChainId(option.network);
      if (chainId !== null && option.asset && KNOWN_6_DECIMAL_TOKENS.has(option.asset.toLowerCase())) {
        return option;
      }
    }

    // Third pass: any supported network
    for (const option of accepts) {
      const chainId = this.parseNetworkToChainId(option.network);
      if (chainId !== null && option.payTo && option.amount && option.asset) {
        return option;
      }
    }

    return null;
  }

  /**
   * Parse network string to chainId
   * Handles both v1 ("base") and v2 ("eip155:8453") formats
   *
   * FAIL-CLOSED: Returns null for unknown networks (don't silently default)
   */
  private parseNetworkToChainId(network?: string): number | null {
    // Missing network defaults to Base (this is intentional for this project)
    if (!network) return BASE_CHAIN_ID;

    // v2 format: "eip155:8453" -> 8453
    if (network.startsWith('eip155:')) {
      const chainIdStr = network.split(':')[1];
      const chainId = parseInt(chainIdStr, 10);
      // Validate it's a real chain ID (positive integer)
      if (isNaN(chainId) || chainId <= 0) {
        console.error('[x402] Invalid eip155 chain ID:', network);
        return null;
      }
      return chainId;
    }

    // v1 format: "base", "ethereum", etc.
    const chainId = SUPPORTED_NETWORKS[network.toLowerCase()];
    if (chainId === undefined) {
      // FAIL-CLOSED: Don't default to Base for unknown networks
      console.error('[x402] Unknown network:', network);
      return null;
    }
    return chainId;
  }

  /**
   * Parse amount string to bigint
   * Handles decimal ("0.01") and base unit ("2000") formats
   *
   * Token-aware: Only allows decimal format for known 6-decimal tokens (USDC)
   * Uses string-based decimal parsing to avoid floating point errors
   */
  private parseAmount(amount: string | number, tokenAddress?: string): bigint | null {
    const amountStr = String(amount);

    // Check for decimal format
    if (amountStr.includes('.')) {
      // Only allow decimal format for known stablecoins with 6 decimals
      if (tokenAddress && !KNOWN_6_DECIMAL_TOKENS.has(tokenAddress.toLowerCase())) {
        console.error('[x402] Decimal amount format not supported for unknown token:', tokenAddress);
        return null;
      }

      // String-based decimal parsing to avoid floating point errors
      const [whole, fraction = ''] = amountStr.split('.');
      // Pad or truncate fraction to 6 decimal places
      const paddedFraction = fraction.slice(0, 6).padEnd(6, '0');
      const baseUnits = whole + paddedFraction;

      try {
        return BigInt(baseUnits);
      } catch {
        console.error('[x402] Failed to parse decimal amount:', amountStr);
        return null;
      }
    }

    // Integer/base unit format
    try {
      return BigInt(amountStr);
    } catch {
      console.error('[x402] Failed to parse amount:', amountStr);
      return null;
    }
  }

  /**
   * Parse X-Payment-* headers (legacy format)
   */
  private parseXPaymentHeaders(headers: Headers, rawHeaders: Record<string, string>): PaymentDetails | null {
    const recipient = headers.get('X-Payment-Recipient');
    const amount = headers.get('X-Payment-Amount');
    const token = headers.get('X-Payment-Token');
    const chainId = headers.get('X-Payment-Chain-Id');
    const validUntil = headers.get('X-Payment-Valid-Until');
    const paymentId = headers.get('X-Payment-Id');
    const description = headers.get('X-Payment-Description');

    if (!recipient || !amount || !token || !chainId || !validUntil || !paymentId) {
      console.error('Missing required X-Payment headers:', {
        recipient: !!recipient,
        amount: !!amount,
        token: !!token,
        chainId: !!chainId,
        validUntil: !!validUntil,
        paymentId: !!paymentId,
      });
      return null;
    }

    return {
      recipient: recipient as Hex,
      amount: BigInt(amount),
      token: token as Hex,
      chainId: parseInt(chainId, 10),
      validUntil: parseInt(validUntil, 10),
      paymentId: paymentId as Hex,
      description: description || undefined,
      rawHeaders,
    };
  }

  /**
   * Create an EIP-712 signature authorizing the payment
   *
   * For v1: Signs a custom Payment type against x402 domain
   * For v2: Signs TransferWithAuthorization against the token contract (EIP-3009)
   *
   * The returned object includes the signature and authorization details for v2.
   */
  async createPaymentSignature(details: PaymentDetails): Promise<{
    signature: Hex;
    authorization?: {
      from: Hex;
      to: Hex;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: Hex;
    };
  }> {
    // v2: Use EIP-3009 TransferWithAuthorization
    if (details.x402Version === 2) {
      // Get token domain - from server or known defaults
      const tokenDomain = getTokenDomain(details.token, details.tokenDomain);

      if (!tokenDomain) {
        throw new Error(
          `Cannot sign x402 v2 payment: unknown token domain for ${details.token}. ` +
          `Server must provide 'extra.name' and 'extra.version', or use a supported token (USDC).`
        );
      }

      const payer = await this.getAddress();
      const now = Math.floor(Date.now() / 1000);
      const nonce = createNonce();

      const authorization = {
        from: payer,
        to: details.recipient,
        value: details.amount,
        validAfter: BigInt(now - 600),  // 10 minutes ago
        validBefore: BigInt(details.validUntil),
        nonce,
      };

      // Sign against the token contract's EIP-712 domain
      const domain = {
        name: tokenDomain.name,
        version: tokenDomain.version,
        chainId: details.chainId,
        verifyingContract: details.token,
      };

      console.log(`[x402] Signing v2 EIP-3009 with domain: ${tokenDomain.name} v${tokenDomain.version}`);

      const signature = await this.signTypedData(
        domain,
        TRANSFER_WITH_AUTHORIZATION_TYPES,
        authorization
      );

      return {
        signature,
        authorization: {
          from: authorization.from,
          to: authorization.to,
          value: authorization.value.toString(),
          validAfter: authorization.validAfter.toString(),
          validBefore: authorization.validBefore.toString(),
          nonce: authorization.nonce,
        },
      };
    }

    // v1: Use custom Payment type (legacy)
    console.log('[x402] Signing v1 legacy format');
    const domain = {
      ...X402_DOMAIN,
      chainId: details.chainId,
    };

    const value = {
      recipient: details.recipient,
      amount: details.amount,
      token: details.token,
      chainId: BigInt(details.chainId),
      validUntil: BigInt(details.validUntil),
      paymentId: details.paymentId,
    };

    const signature = await this.signTypedData(domain, X402_TYPES, value);
    return { signature };
  }

  /**
   * Create the payment header value
   *
   * For v1: X-PAYMENT header with { payer, signature, paymentId }
   * For v2: PAYMENT-SIGNATURE header with full x402 v2 payload
   */
  async createPaymentHeader(
    details: PaymentDetails,
    signatureResult: { signature: Hex; authorization?: Record<string, unknown> }
  ): Promise<{ headerName: string; headerValue: string }> {
    const payer = await this.getAddress();

    // v2: PAYMENT-SIGNATURE with full payload structure
    if (details.x402Version === 2 && signatureResult.authorization) {
      const payload = {
        x402Version: 2,
        resource: details.resource,
        accepted: details.rawAccepted,
        payload: {
          signature: signatureResult.signature,
          authorization: signatureResult.authorization,
        },
      };

      return {
        headerName: 'PAYMENT-SIGNATURE',
        headerValue: Buffer.from(JSON.stringify(payload)).toString('base64'),
      };
    }

    // v1: X-PAYMENT with simple format (legacy)
    const payload = {
      payer,
      signature: signatureResult.signature,
      paymentId: details.paymentId,
    };

    return {
      headerName: 'X-PAYMENT',
      headerValue: Buffer.from(JSON.stringify(payload)).toString('base64'),
    };
  }

  /**
   * Convert token amount to USD for display
   *
   * Assumes USDC (6 decimals) at 1:1 USD peg
   */
  tokenAmountToUsd(amount: bigint, token: Hex): string {
    // USDC has 6 decimals
    if (token.toLowerCase() === USDC_BASE.toLowerCase()) {
      const usd = Number(amount) / 1_000_000;
      return usd.toFixed(2);
    }
    // For unknown tokens, return raw amount
    return amount.toString();
  }

  /**
   * Check if payment amount is within acceptable limits
   */
  isWithinLimit(details: PaymentDetails, maxAmountUsd: string): boolean {
    const amountUsd = this.tokenAmountToUsd(details.amount, details.token);
    return parseFloat(amountUsd) <= parseFloat(maxAmountUsd);
  }

  /**
   * Check if payment is still valid (not expired)
   */
  isPaymentValid(details: PaymentDetails): boolean {
    const now = Math.floor(Date.now() / 1000);
    return details.validUntil > now;
  }

  /**
   * Execute a paid request - handles the full 402 flow
   *
   * 1. Makes initial request
   * 2. If 402, parses payment details
   * 3. Validates amount is within limits
   * 4. Signs payment authorization
   * 5. Retries with X-PAYMENT header
   * 6. Returns the resource
   */
  async payAndFetch(
    url: string,
    options?: RequestInit & X402Options
  ): Promise<X402Result> {
    const maxAmountUsd = options?.maxAmountUsd ?? '1.00';
    const timeout = options?.timeout ?? 30000;

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      // Make initial request
      const initialResponse = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      // If not 402, return as-is
      if (initialResponse.status !== 402) {
        clearTimeout(timeoutId);
        return {
          success: initialResponse.ok,
          response: initialResponse,
        };
      }

      // Parse payment details
      const paymentDetails = this.parsePaymentRequired(initialResponse);
      if (!paymentDetails) {
        clearTimeout(timeoutId);
        return {
          success: false,
          error: 'Failed to parse 402 payment details',
          response: initialResponse,
        };
      }

      // Validate payment is not expired
      if (!this.isPaymentValid(paymentDetails)) {
        clearTimeout(timeoutId);
        return {
          success: false,
          error: 'Payment offer has expired',
          paymentDetails,
        };
      }

      // Check amount is within limits
      if (!this.isWithinLimit(paymentDetails, maxAmountUsd)) {
        const amountUsd = this.tokenAmountToUsd(paymentDetails.amount, paymentDetails.token);
        clearTimeout(timeoutId);
        return {
          success: false,
          error: `Payment amount ($${amountUsd}) exceeds maximum ($${maxAmountUsd})`,
          paymentDetails,
        };
      }

      // Sign payment
      const signatureResult = await this.createPaymentSignature(paymentDetails);
      const { headerName, headerValue } = await this.createPaymentHeader(paymentDetails, signatureResult);

      // Retry with payment header (PAYMENT-SIGNATURE for v2, X-PAYMENT for v1)
      const paidResponse = await fetch(url, {
        ...options,
        headers: {
          ...options?.headers,
          [headerName]: headerValue,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const amountPaidUsd = this.tokenAmountToUsd(paymentDetails.amount, paymentDetails.token);

      return {
        success: paidResponse.ok,
        response: paidResponse,
        paymentDetails,
        amountPaidUsd,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          error: `Request timed out after ${timeout}ms`,
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

/**
 * Helper to create payment ID from request details
 * Used by servers to generate unique payment identifiers
 */
export function createPaymentId(url: string, nonce: string): Hex {
  return keccak256(encodePacked(['string', 'string'], [url, nonce]));
}
