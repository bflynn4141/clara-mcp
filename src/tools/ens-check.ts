/**
 * ENS Check Tool
 *
 * Read-only tool to check ENS name availability and pricing.
 * No wallet auth required — anyone can look up names.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../middleware.js';
import {
  checkAvailability,
  getRentPrice,
  formatPrice,
  validateENSName,
} from '../services/ens.js';

/**
 * Tool definition for wallet_ens_check
 */
export const ensCheckToolDefinition: Tool = {
  name: 'wallet_ens_check',
  description: `Check if an ENS (.eth) name is available and get pricing.

**Examples:**
- Check availability: \`{"name": "clara"}\` → checks clara.eth
- Custom duration: \`{"name": "vitalik", "years": 2}\`
- With .eth suffix: \`{"name": "myname.eth"}\` → also works

Returns availability, current price, and owner info if taken.
ENS names are registered on Ethereum mainnet.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'ENS name to check (e.g., "clara" or "clara.eth")',
      },
      years: {
        type: 'number',
        description: 'Registration duration in years (default: 1)',
        default: 1,
      },
    },
    required: ['name'],
  },
};

/**
 * Handle wallet_ens_check requests
 */
export async function handleEnsCheckRequest(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const rawName = args.name as string;
  const years = (args.years as number) || 1;

  if (!rawName) {
    return {
      content: [{ type: 'text', text: '❌ Missing required parameter: name' }],
      isError: true,
    };
  }

  try {
    // Validate name first (gives a clear error before any RPC calls)
    validateENSName(rawName);

    const durationSeconds = Math.floor(years * 365 * 24 * 60 * 60);

    // Check availability and get price in parallel
    const [availability, price] = await Promise.all([
      checkAvailability(rawName),
      getRentPrice(rawName, durationSeconds),
    ]);

    const lines: string[] = [];

    if (availability.available) {
      lines.push(`✅ **${availability.name}** is available!`);
      lines.push('');
      lines.push(formatPrice(price));
      lines.push('');
      lines.push(
        `💡 To register, use \`wallet_register_ens\` with \`name="${availability.normalizedName}"\``,
      );
    } else {
      lines.push(`❌ **${availability.name}** is taken.`);

      if (availability.currentOwner) {
        lines.push('');
        lines.push(`**Owner:** \`${availability.currentOwner}\``);
      }

      if (availability.resolvedAddress) {
        lines.push(`**Resolves to:** \`${availability.resolvedAddress}\``);
      }

      // Still show price info (useful for renewal or future availability)
      lines.push('');
      lines.push('**Registration price (if it becomes available):**');
      lines.push(formatPrice(price));
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ ENS lookup failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
