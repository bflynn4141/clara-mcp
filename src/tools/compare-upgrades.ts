/**
 * Compare Upgrades Tool
 *
 * Compare proxy contract implementation versions to identify changes.
 * Powered by Herd's diffContractVersions.
 */

import { getProviderRegistry } from '../providers/index.js';
import type { SupportedChain } from '../config/chains.js';

// ============================================================================
// Tool Definition
// ============================================================================

export const compareUpgradesToolDefinition = {
  name: 'wallet_compare_upgrades',
  description: `Compare proxy contract implementation versions to see what changed.

**Use cases:**
- Security audit: "What functions were added in the last upgrade?"
- Due diligence: "Were any critical functions modified?"
- Research: "How has this contract evolved?"

**Example:**
\`\`\`json
{
  "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "chain": "ethereum"
}
\`\`\`

Returns diff showing added, removed, and modified functions/events.

Supported chains: ethereum, base`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      address: {
        type: 'string',
        description: 'Proxy contract address (0x...)',
      },
      chain: {
        type: 'string',
        enum: ['ethereum', 'base'],
        default: 'ethereum',
        description: 'Blockchain (default: ethereum)',
      },
      compareAll: {
        type: 'boolean',
        default: false,
        description: 'Compare all versions (default: only last 2)',
      },
    },
    required: ['address'],
  },
};

// ============================================================================
// Tool Handler
// ============================================================================

export async function handleCompareUpgrades(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const address = args.address as string;
  const chain = (args.chain as SupportedChain) || 'ethereum';
  const compareAll = args.compareAll as boolean || false;

  // Validate address
  if (!address || !address.match(/^0x[a-fA-F0-9]{40}$/)) {
    return {
      content: [{
        type: 'text',
        text: '❌ Invalid contract address. Must be a valid Ethereum address (0x...)',
      }],
      isError: true,
    };
  }

  const registry = getProviderRegistry();

  // Check if we have diff capability (Herd only)
  if (!registry.hasCapability('ContractDiff', chain)) {
    return {
      content: [{
        type: 'text',
        text: `❌ Upgrade comparison not available for ${chain}. Is Herd enabled?`,
      }],
      isError: true,
    };
  }

  try {
    const result = await registry.diffContractVersions({
      address,
      chain,
      compareAllVersions: compareAll,
    });

    if (!result.success || !result.data) {
      return {
        content: [{
          type: 'text',
          text: `❌ Failed to compare versions: ${result.error || 'Unknown error'}`,
        }],
        isError: true,
      };
    }

    // result.data is ContractDiff[] directly
    const diffs = result.data;

    if (diffs.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `## 📊 Upgrade Comparison

**Contract:** \`${address}\`
**Chain:** ${chain}

This contract has no upgrade history, or is not a proxy contract.`,
        }],
      };
    }

    // Format results
    const lines: string[] = [];
    lines.push(`## 📊 Upgrade Comparison`);
    lines.push('');
    lines.push(`**Contract:** \`${address}\``);
    lines.push(`**Chain:** ${chain}`);
    lines.push(`**Upgrades Found:** ${diffs.length}`);
    lines.push('');

    for (const diff of diffs) {
      lines.push('---');
      lines.push('');
      lines.push(`### Upgrade v${diff.fromVersion} → v${diff.toVersion}`);
      lines.push(`\`${diff.fromAddress.slice(0, 10)}...\` → \`${diff.toAddress.slice(0, 10)}...\``);
      lines.push('');

      // Added functions
      if (diff.added.length > 0) {
        lines.push('**➕ Added:**');
        for (const item of diff.added) {
          lines.push(`- \`${item.name}\` (${item.type})`);
          lines.push(`  \`${item.signature}\``);
        }
        lines.push('');
      }

      // Removed functions
      if (diff.removed.length > 0) {
        lines.push('**➖ Removed:**');
        for (const item of diff.removed) {
          lines.push(`- \`${item.name}\` (${item.type})`);
          lines.push(`  \`${item.signature}\``);
        }
        lines.push('');
      }

      // Modified functions
      if (diff.modified.length > 0) {
        lines.push('**🔄 Modified:**');
        for (const item of diff.modified) {
          lines.push(`- \`${item.name}\` (${item.type})`);
          lines.push(`  ${item.changes}`);
        }
        lines.push('');
      }

      if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) {
        lines.push('_No functional changes detected_');
        lines.push('');
      }
    }

    // Add security notes
    lines.push('---');
    lines.push('');
    lines.push('### ⚠️ Security Notes');
    lines.push('');
    lines.push('When reviewing upgrades, pay attention to:');
    lines.push('- New admin functions that could be exploited');
    lines.push('- Removed safety checks or access controls');
    lines.push('- Modified core logic (transfer, approve, etc.)');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error comparing upgrades: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
