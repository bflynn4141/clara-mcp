/**
 * ENS Resolution Tool
 *
 * Resolve ENS names to addresses and vice versa.
 * Uses viem's ENS functions with mainnet RPC.
 */

import {
  createPublicClient,
  http,
  type Hex,
} from 'viem';
import { normalize } from 'viem/ens';
import { mainnet } from 'viem/chains';
import { getRpcUrl } from '../config/chains.js';

/**
 * Tool definition for wallet_resolve_ens
 */
export const ensToolDefinition = {
  name: 'wallet_resolve_ens',
  description: `Resolve ENS names to addresses and vice versa.

**Resolve name to address:**
\`\`\`json
{"name": "vitalik.eth"}
\`\`\`

**Reverse lookup (address to name):**
\`\`\`json
{"address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"}
\`\`\`

Also fetches avatar, description, and other records when available.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: {
        type: 'string',
        description: 'ENS name to resolve (e.g., "vitalik.eth")',
      },
      address: {
        type: 'string',
        description: 'Address for reverse lookup',
      },
    },
    required: [],
  },
};

/**
 * Handle wallet_resolve_ens requests
 */
export async function handleEnsRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const name = args.name as string | undefined;
  const address = args.address as string | undefined;

  if (!name && !address) {
    return {
      content: [{
        type: 'text',
        text: '❌ Either `name` or `address` is required.\n\nExamples:\n- `{"name": "vitalik.eth"}`\n- `{"address": "0x..."}`',
      }],
      isError: true,
    };
  }

  try {
    const client = createPublicClient({
      chain: mainnet,
      transport: http(getRpcUrl('ethereum')),
    });

    if (name) {
      // Forward resolution: name -> address
      const normalizedName = normalize(name);

      const resolvedAddress = await client.getEnsAddress({
        name: normalizedName,
      });

      if (!resolvedAddress) {
        return {
          content: [{
            type: 'text',
            text: `❌ ENS name \`${name}\` not found or not registered.`,
          }],
          isError: true,
        };
      }

      // Try to get additional records
      let avatar: string | null = null;
      let description: string | null = null;
      let twitter: string | null = null;
      let url: string | null = null;

      try {
        avatar = await client.getEnsAvatar({ name: normalizedName });
      } catch {}

      try {
        description = await client.getEnsText({ name: normalizedName, key: 'description' });
      } catch {}

      try {
        twitter = await client.getEnsText({ name: normalizedName, key: 'com.twitter' });
      } catch {}

      try {
        url = await client.getEnsText({ name: normalizedName, key: 'url' });
      } catch {}

      // Build output
      const lines: string[] = [];
      lines.push('## 🏷️ ENS Resolution');
      lines.push('');
      lines.push(`**Name:** ${name}`);
      lines.push(`**Address:** \`${resolvedAddress}\``);

      if (avatar || description || twitter || url) {
        lines.push('');
        lines.push('### Records');
        if (avatar) lines.push(`- **Avatar:** ${avatar}`);
        if (description) lines.push(`- **Description:** ${description}`);
        if (twitter) lines.push(`- **Twitter:** @${twitter}`);
        if (url) lines.push(`- **URL:** ${url}`);
      }

      // Add explorer link
      lines.push('');
      lines.push(`[View on Etherscan](https://etherscan.io/address/${resolvedAddress})`);

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }

    // Reverse resolution: address -> name
    if (address) {
      if (!address.startsWith('0x') || address.length !== 42) {
        return {
          content: [{
            type: 'text',
            text: '❌ Invalid address format. Must be a 42-character hex string starting with 0x.',
          }],
          isError: true,
        };
      }

      const ensName = await client.getEnsName({
        address: address as Hex,
      });

      if (!ensName) {
        return {
          content: [{
            type: 'text',
            text: [
              '## 🏷️ ENS Reverse Lookup',
              '',
              `**Address:** \`${address}\``,
              '**ENS Name:** _Not set_',
              '',
              'This address has no primary ENS name configured.',
            ].join('\n'),
          }],
        };
      }

      // Get additional records for the found name
      let avatar: string | null = null;

      try {
        avatar = await client.getEnsAvatar({ name: ensName });
      } catch {}

      const lines: string[] = [];
      lines.push('## 🏷️ ENS Reverse Lookup');
      lines.push('');
      lines.push(`**Address:** \`${address}\``);
      lines.push(`**ENS Name:** ${ensName}`);

      if (avatar) {
        lines.push(`**Avatar:** ${avatar}`);
      }

      lines.push('');
      lines.push(`[View on ENS](https://app.ens.domains/${ensName})`);

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }

    return {
      content: [{ type: 'text', text: '❌ Unexpected error' }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ ENS resolution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
