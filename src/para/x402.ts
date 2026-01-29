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

import { type Hex, encodePacked, keccak256, toHex } from 'viem';

// Known token addresses
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
export const BASE_CHAIN_ID = 8453;

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
  /** Unique payment identifier */
  paymentId: Hex;
  /** Human-readable description (optional) */
  description?: string;
  /** Original 402 response for debugging */
  rawHeaders: Record<string, string>;
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
 * EIP-712 types for x402 payment authorization
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
   * Parse PAYMENT-REQUIRED header (Coinbase official format)
   * Contains base64-encoded JSON with payment details
   */
  private parsePaymentRequiredHeader(header: string, rawHeaders: Record<string, string>): PaymentDetails | null {
    try {
      const decoded = Buffer.from(header, 'base64').toString('utf-8');
      const data = JSON.parse(decoded);

      // Expected fields: payTo, maxAmountRequired, asset, network, validUntil, paymentId
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

      // Map network to chainId
      const chainIdMap: Record<string, number> = {
        'base': 8453,
        'base-mainnet': 8453,
        'base-sepolia': 84532,
        'ethereum': 1,
        'ethereum-mainnet': 1,
        'arbitrum': 42161,
        'optimism': 10,
      };
      const chainId = chainIdMap[network?.toLowerCase()] || 8453;

      // Parse amount
      let amountBigInt: bigint;
      if (typeof maxAmountRequired === 'string' && maxAmountRequired.includes('.')) {
        amountBigInt = BigInt(Math.floor(parseFloat(maxAmountRequired) * 1_000_000));
      } else {
        amountBigInt = BigInt(maxAmountRequired);
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
   * This signature proves wallet ownership and authorizes the specific payment.
   * The server will verify this signature and execute the payment on-chain.
   */
  async createPaymentSignature(details: PaymentDetails): Promise<Hex> {
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

    return this.signTypedData(domain, X402_TYPES, value);
  }

  /**
   * Create the X-PAYMENT header value
   *
   * Format: base64(JSON({ payer, signature, paymentId }))
   */
  async createPaymentHeader(details: PaymentDetails, signature: Hex): Promise<string> {
    const payer = await this.getAddress();

    const payload = {
      payer,
      signature,
      paymentId: details.paymentId,
    };

    // Base64 encode the JSON payload
    return Buffer.from(JSON.stringify(payload)).toString('base64');
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
      const signature = await this.createPaymentSignature(paymentDetails);
      const paymentHeader = await this.createPaymentHeader(paymentDetails, signature);

      // Retry with payment header
      const paidResponse = await fetch(url, {
        ...options,
        headers: {
          ...options?.headers,
          'X-PAYMENT': paymentHeader,
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
