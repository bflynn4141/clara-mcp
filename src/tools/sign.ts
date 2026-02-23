/**
 * Sign Tool
 *
 * Sign arbitrary messages (EIP-191) and typed data (EIP-712) with your wallet.
 * Used for authentication (SIWE), DeFi permits, and other offchain signatures.
 *
 * Merged from wallet_sign_message + wallet_sign_typed_data.
 * Dispatches on `kind` param: "message" (default) or "typedData".
 */

import { type Hex, hashTypedData } from 'viem';
import type { ToolContext, ToolResult } from '../middleware.js';
import { proxyFetch } from '../auth/proxy-fetch.js';
import { getCurrentSessionKey } from '../auth/session-key.js';

// Para API base URL
const PARA_API_BASE = process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn4141.workers.dev';

/**
 * wallet_sign tool definition
 *
 * Merged: personal_sign (kind:"message") + EIP-712 (kind:"typedData")
 */
export const signToolDefinition = {
  name: 'wallet_sign',
  description: `Sign a message or typed data with your wallet.

**Kinds:**
- \`"message"\` (default): EIP-191 personal_sign — for SIWE, attestations, offchain protocols
- \`"typedData"\`: EIP-712 structured data — for permits, DEX orders, DeFi protocols

**Examples:**

Personal sign:
\`\`\`json
{"message": "Sign in to Example.com at 2024-01-01T00:00:00Z"}
\`\`\`

EIP-712 Permit:
\`\`\`json
{
  "kind": "typedData",
  "domain": {"name": "USDC", "version": "2", "chainId": 8453, "verifyingContract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"},
  "types": {"Permit": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}, {"name": "value", "type": "uint256"}, {"name": "nonce", "type": "uint256"}, {"name": "deadline", "type": "uint256"}]},
  "primaryType": "Permit",
  "value": {"owner": "0x...", "spender": "0x...", "value": "1000000", "nonce": "0", "deadline": "1735689600"}
}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      kind: {
        type: 'string',
        enum: ['message', 'typedData'],
        description: 'Signing kind. Defaults to "message".',
      },
      message: {
        type: 'string',
        description: 'The message to sign (plain text, for kind:"message")',
      },
      domain: {
        type: 'object',
        description: 'EIP-712 domain (for kind:"typedData")',
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
        description: 'EIP-712 type definitions, excluding EIP712Domain (for kind:"typedData")',
      },
      primaryType: {
        type: 'string',
        description: 'The primary type to sign (for kind:"typedData")',
      },
      value: {
        type: 'object',
        description: 'The structured data to sign (for kind:"typedData")',
      },
    },
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
    if (response.status === 500) {
      throw new Error(
        `Signing failed: ${response.status} - ${errorText}\n\n` +
        `This may indicate a corrupted wallet session. ` +
        `Try running \`wallet_session action:"logout"\` then \`wallet_setup\` to create a fresh wallet.`
      );
    }
    throw new Error(`Signing failed: ${response.status} - ${errorText}`);
  }

  const result = await response.json() as { signature: string };
  return result.signature as Hex;
}

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
    if (response.status === 500) {
      throw new Error(
        `Signing failed: ${response.status} - ${errorText}\n\n` +
        `This may indicate a corrupted wallet session. ` +
        `Try running \`wallet_session action:"logout"\` then \`wallet_setup\` to create a fresh wallet.`
      );
    }
    throw new Error(`Signing failed: ${response.status} - ${errorText}`);
  }

  const result = await response.json() as { signature: string };
  return result.signature as Hex;
}

/**
 * Handle wallet_sign — dispatches on kind param
 */
export async function handleSignRequest(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const kind = (args.kind as string) || 'message';

  switch (kind) {
    case 'message':
      return handleSignMessage(args, ctx);
    case 'typedData':
      return handleSignTypedData(args, ctx);
    default:
      return {
        content: [{
          type: 'text',
          text: `❌ Unknown kind: "${kind}". Use "message" or "typedData".`,
        }],
        isError: true,
      };
  }
}

/**
 * Handle personal_sign (kind: "message")
 */
async function handleSignMessage(
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

/**
 * Handle EIP-712 typed data (kind: "typedData")
 */
async function handleSignTypedData(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const domain = args.domain as Record<string, unknown> | undefined;
  const types = args.types as Record<string, Array<{ name: string; type: string }>> | undefined;
  const primaryType = args.primaryType as string | undefined;
  const value = args.value as Record<string, unknown> | undefined;

  // Validate inputs
  if (!domain || !types || !primaryType || !value) {
    return {
      content: [{
        type: 'text',
        text: '❌ Missing required parameters: domain, types, primaryType, value',
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
      value,
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
