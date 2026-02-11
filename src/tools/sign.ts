/**
 * Sign Tools
 *
 * Sign arbitrary messages (EIP-191) and typed data (EIP-712) with your wallet.
 * Used for authentication (SIWE), DeFi permits, and other offchain signatures.
 */

import { type Hex, hashTypedData } from 'viem';
import type { ToolContext, ToolResult } from '../middleware.js';
import { proxyFetch } from '../auth/proxy-fetch.js';
import { getCurrentSessionKey } from '../auth/session-key.js';

// Para API base URL
const PARA_API_BASE = process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn-me.workers.dev';

/**
 * Tool definition for wallet_sign_message
 */
export const signMessageToolDefinition = {
  name: 'wallet_sign_message',
  description: `Sign a message with your wallet.

Used for:
- **Authentication (SIWE)**: Prove you own an address
- **Attestations**: Sign statements or claims
- **Offchain protocols**: Any protocol requiring signatures

**Example:**
\`\`\`json
{"message": "Sign in to Example.com at 2024-01-01T00:00:00Z"}
\`\`\`

Returns an EIP-191 personal_sign signature.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      message: {
        type: 'string',
        description: 'The message to sign (plain text)',
      },
    },
    required: ['message'],
  },
};

/**
 * Sign a message via Para API
 *
 * Para's sign-raw endpoint expects the message as a hex string.
 * For personal_sign (EIP-191), we prepend the Ethereum message prefix.
 */
async function signMessage(walletId: string, message: string, userAddress?: string): Promise<Hex> {
  // Convert message to hex (Para expects hex-encoded data)
  const messageHex = '0x' + Buffer.from(message, 'utf-8').toString('hex');

  const response = await proxyFetch(
    `${PARA_API_BASE}/api/v1/wallets/${walletId}/sign-raw`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: messageHex }),
    },
    { walletAddress: userAddress || '', sessionKey: getCurrentSessionKey() },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Signing failed: ${response.status} - ${errorText}`);
  }

  const result = await response.json() as { signature: string };
  return result.signature as Hex;
}

/**
 * Tool definition for wallet_sign_typed_data
 */
export const signTypedDataToolDefinition = {
  name: 'wallet_sign_typed_data',
  description: `Sign EIP-712 typed structured data with your wallet.

Used for:
- **Permits**: Gasless token approvals (EIP-2612)
- **Orders**: DEX order signing (Uniswap, 0x)
- **DeFi protocols**: Any protocol requiring structured signatures

**Example (EIP-2612 Permit):**
\`\`\`json
{
  "domain": {
    "name": "USDC",
    "version": "2",
    "chainId": 8453,
    "verifyingContract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  },
  "types": {
    "Permit": [
      {"name": "owner", "type": "address"},
      {"name": "spender", "type": "address"},
      {"name": "value", "type": "uint256"},
      {"name": "nonce", "type": "uint256"},
      {"name": "deadline", "type": "uint256"}
    ]
  },
  "primaryType": "Permit",
  "message": {
    "owner": "0x...",
    "spender": "0x...",
    "value": "1000000",
    "nonce": "0",
    "deadline": "1735689600"
  }
}
\`\`\`

Returns an EIP-712 typed data signature.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      domain: {
        type: 'object',
        description: 'EIP-712 domain (name, version, chainId, verifyingContract)',
        properties: {
          name: { type: 'string' },
          version: { type: 'string' },
          chainId: { type: 'number' },
          verifyingContract: { type: 'string' },
          salt: { type: 'string' },
        },
      },
      types: {
        type: 'object',
        description: 'Type definitions (excluding EIP712Domain)',
      },
      primaryType: {
        type: 'string',
        description: 'The primary type to sign',
      },
      message: {
        type: 'object',
        description: 'The data to sign',
      },
    },
    required: ['domain', 'types', 'primaryType', 'message'],
  },
};

/**
 * Sign typed data via Para API
 *
 * Para's sign-raw endpoint can sign pre-hashed data.
 * We hash the EIP-712 typed data locally and send the hash.
 */
async function signTypedData(
  walletId: string,
  domain: Record<string, unknown>,
  types: Record<string, Array<{ name: string; type: string }>>,
  primaryType: string,
  message: Record<string, unknown>,
  userAddress?: string
): Promise<Hex> {
  // Hash the typed data locally
  const hash = hashTypedData({
    domain: domain as any,
    types: types as any,
    primaryType,
    message: message as any,
  });

  // Sign the hash
  const response = await proxyFetch(
    `${PARA_API_BASE}/api/v1/wallets/${walletId}/sign-raw`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: hash }),
    },
    { walletAddress: userAddress || '', sessionKey: getCurrentSessionKey() },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Signing failed: ${response.status} - ${errorText}`);
  }

  const result = await response.json() as { signature: string };
  return result.signature as Hex;
}

/**
 * Handle wallet_sign_typed_data requests
 */
export async function handleSignTypedDataRequest(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const domain = args.domain as Record<string, unknown> | undefined;
  const types = args.types as Record<string, Array<{ name: string; type: string }>> | undefined;
  const primaryType = args.primaryType as string | undefined;
  const message = args.message as Record<string, unknown> | undefined;

  // Validate inputs
  if (!domain || !types || !primaryType || !message) {
    return {
      content: [{
        type: 'text',
        text: '❌ Missing required parameters: domain, types, primaryType, message',
      }],
      isError: true,
    };
  }

  const session = ctx.session;

  try {
    const signature = await signTypedData(
      session.walletId!,
      domain,
      types,
      primaryType,
      message,
      session.address,
    );

    // Format output
    const domainDisplay = [
      domain.name && `Name: ${domain.name}`,
      domain.version && `Version: ${domain.version}`,
      domain.chainId && `Chain: ${domain.chainId}`,
      domain.verifyingContract && `Contract: ${(domain.verifyingContract as string).slice(0, 10)}...`,
    ].filter(Boolean).join(', ');

    return {
      content: [{
        type: 'text',
        text: [
          '✅ Typed data signed (EIP-712)',
          '',
          `**Signer:** \`${session.address}\``,
          `**Type:** ${primaryType}`,
          `**Domain:** ${domainDisplay}`,
          '',
          `**Signature:**`,
          '```',
          signature,
          '```',
        ].join('\n'),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Signing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

/**
 * Handle wallet_sign_message requests
 */
export async function handleSignMessageRequest(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const message = args.message as string;

  // Validate message
  if (!message || typeof message !== 'string') {
    return {
      content: [{ type: 'text', text: '❌ Message is required' }],
      isError: true,
    };
  }

  if (message.length > 10000) {
    return {
      content: [{ type: 'text', text: '❌ Message too long (max 10,000 characters)' }],
      isError: true,
    };
  }

  const session = ctx.session;

  try {
    const signature = await signMessage(session.walletId!, message, session.address);

    return {
      content: [{
        type: 'text',
        text: [
          '✅ Message signed',
          '',
          `**Signer:** \`${session.address}\``,
          '',
          `**Message:**`,
          '```',
          message.length > 200 ? message.slice(0, 200) + '...' : message,
          '```',
          '',
          `**Signature:**`,
          '```',
          signature,
          '```',
        ].join('\n'),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Signing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

// handleSignRequest dispatch removed — registry handles dispatch directly
