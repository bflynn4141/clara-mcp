/**
 * Gas Sponsorship Tool
 *
 * Requests a micro ETH transfer from the Clara proxy to cover
 * gas costs for new users during onboarding (agent registration).
 *
 * The proxy sends ~0.0005 ETH on Base — enough for ~10 transactions.
 * One sponsorship per address, tracked in proxy KV.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { proxyFetch } from '../auth/proxy-fetch.js';

// ─── Config ──────────────────────────────────────────────

const GATEWAY_BASE =
  process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn4141.workers.dev';

// ─── Tool Definition ─────────────────────────────────────

export const sponsorGasToolDefinition: Tool = {
  name: 'wallet_sponsor_gas',
  description: `Request free gas for onboarding. Sends a tiny amount of ETH (~0.0005) to your wallet on Base to cover transaction fees.

This is a one-time benefit for new users. Use it if your wallet has no ETH for gas.

**Example:**
\`\`\`json
{}
\`\`\`

Returns the sponsorship transaction hash on success, or an error if already sponsored.`,
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

// ─── Handler ─────────────────────────────────────────────

export async function handleSponsorGas(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const response = await proxyFetch(
      `${GATEWAY_BASE}/onboard/sponsor-gas`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: ctx.walletAddress }),
      },
      { walletAddress: ctx.walletAddress, sessionKey: ctx.sessionKey },
    );

    const result = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      if (result.error === 'ALREADY_SPONSORED') {
        return {
          content: [{
            type: 'text',
            text: 'Your wallet has already received gas sponsorship. You should have enough ETH for transactions on Base.',
          }],
        };
      }

      if (result.error === 'NOT_CONFIGURED') {
        return {
          content: [{
            type: 'text',
            text: '⚠️ Gas sponsorship is not available right now. You\'ll need a small amount of ETH on Base (~$0.01) to register as an agent.',
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `❌ Gas sponsorship failed: ${result.message || result.error || response.statusText}`,
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: [
          '✅ **Gas sponsored!**',
          '',
          `**Amount:** ${result.amount} ETH on Base`,
          `**Transaction:** \`${(result.txHash as string).slice(0, 14)}...\``,
          '',
          'You now have enough ETH for agent registration and other Base transactions.',
        ].join('\n'),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Failed to request gas sponsorship: ${error instanceof Error ? error.message : 'Network error'}`,
      }],
      isError: true,
    };
  }
}
