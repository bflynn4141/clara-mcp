/**
 * Monitor Events Tool
 *
 * Get recent events for a contract using Herd's getLatestTransactionsTool.
 * Can monitor specific event types (Transfer, Swap, Mint, etc.)
 */

import { getProviderRegistry, type EventOccurrence, type ContractMetadata } from '../providers/index.js';
import type { SupportedChain } from '../config/chains.js';

// ============================================================================
// Tool Definition
// ============================================================================

export const monitorEventsToolDefinition = {
  name: 'wallet_monitor_events',
  description: `Get recent events for a smart contract.

**Monitor all events:**
\`\`\`json
{"address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"}
\`\`\`

**Monitor specific event:**
\`\`\`json
{"address": "0x...", "eventName": "Transfer", "limit": 20}
\`\`\`

**Common events:**
- \`Transfer\` - Token transfers (ERC-20, ERC-721)
- \`Swap\` - DEX swaps
- \`Mint\` / \`Burn\` - Token minting/burning
- \`Approval\` - Token approvals

Returns: Recent event occurrences with decoded parameters.

Supported chains: ethereum, base`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      address: {
        type: 'string',
        description: 'Contract address to monitor',
      },
      eventName: {
        type: 'string',
        description: 'Specific event to monitor (e.g., "Transfer", "Swap")',
      },
      chain: {
        type: 'string',
        enum: ['ethereum', 'base'],
        default: 'base',
        description: 'Blockchain',
      },
      limit: {
        type: 'number',
        default: 10,
        description: 'Number of events to return (max 50)',
      },
    },
    required: ['address'],
  },
};

// ============================================================================
// Helpers
// ============================================================================

const CHAIN_EXPLORERS: Record<SupportedChain, string> = {
  ethereum: 'https://etherscan.io',
  base: 'https://basescan.org',
  arbitrum: 'https://arbiscan.io',
  optimism: 'https://optimistic.etherscan.io',
  polygon: 'https://polygonscan.com',
};

/**
 * Find event signature from contract metadata
 */
function findEventSignature(metadata: ContractMetadata, eventName: string): string | null {
  const event = metadata.events.find(
    e => e.name.toLowerCase() === eventName.toLowerCase()
  );
  return event?.signature || null;
}

/**
 * Format value for display
 */
function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    if (value.match(/^0x[a-fA-F0-9]{40}$/)) {
      return `\`${value.slice(0, 10)}...${value.slice(-6)}\``;
    }
    if (value.match(/^0x[a-fA-F0-9]{64}$/)) {
      return `\`${value.slice(0, 10)}...\``;
    }
    // Large numbers (likely token amounts)
    if (value.match(/^[0-9]{10,}$/)) {
      const num = BigInt(value);
      if (num >= BigInt(1e18)) {
        return `${(Number(num) / 1e18).toFixed(4)}`;
      }
      if (num >= BigInt(1e6)) {
        return `${(Number(num) / 1e6).toFixed(2)}`;
      }
    }
    return value.length > 40 ? `${value.slice(0, 40)}...` : value;
  }
  if (typeof value === 'bigint') {
    const num = value;
    if (num >= BigInt(1e18)) {
      return `${(Number(num) / 1e18).toFixed(4)}`;
    }
    return value.toString();
  }
  return String(value);
}

/**
 * Format an event occurrence
 */
function formatEvent(event: EventOccurrence, index: number): string[] {
  const lines: string[] = [];

  const time = new Date(event.timestamp);
  const timeStr = time.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  // Header
  lines.push(`**${index + 1}. ${event.event.eventName}** — ${timeStr}`);

  // Arguments
  const args = Object.entries(event.event.args);
  if (args.length > 0) {
    for (const [name, value] of args.slice(0, 5)) {
      lines.push(`   - \`${name}\`: ${formatValue(value)}`);
    }
    if (args.length > 5) {
      lines.push(`   - _...and ${args.length - 5} more_`);
    }
  }

  // Link
  const shortHash = event.txHash.slice(0, 10);
  lines.push(`   [View tx](${event.explorerUrl}) \`${shortHash}...\``);

  return lines;
}

/**
 * Format events list
 */
function formatEventsList(
  events: EventOccurrence[],
  eventName: string | undefined,
  address: string,
  chain: SupportedChain
): string {
  const lines: string[] = [];

  // Header
  const eventFilter = eventName ? `${eventName} ` : '';
  lines.push(`## 📡 Recent ${eventFilter}Events`);
  lines.push('');
  lines.push(`**Contract:** \`${address.slice(0, 10)}...${address.slice(-6)}\``);
  lines.push(`**Chain:** ${chain}`);
  lines.push('');

  if (events.length === 0) {
    lines.push('_No recent events found_');
    if (eventName) {
      lines.push('');
      lines.push(`Try a different event name, or omit \`eventName\` to see all events.`);
    }
    return lines.join('\n');
  }

  lines.push(`Found **${events.length}** recent events:`);
  lines.push('');

  for (let i = 0; i < events.length; i++) {
    lines.push(...formatEvent(events[i], i));
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Tool Handler
// ============================================================================

export async function handleMonitorEvents(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const address = args.address as string;
  const eventName = args.eventName as string | undefined;
  const chain = (args.chain as SupportedChain) || 'base';
  const limit = Math.min((args.limit as number) || 10, 50);

  // Validate address
  if (!address || !address.match(/^0x[a-fA-F0-9]{40}$/)) {
    return {
      content: [{
        type: 'text',
        text: '❌ Invalid contract address',
      }],
      isError: true,
    };
  }

  // Validate chain
  if (!['ethereum', 'base'].includes(chain)) {
    return {
      content: [{
        type: 'text',
        text: `❌ Chain "${chain}" not supported. Supported: ethereum, base`,
      }],
      isError: true,
    };
  }

  const registry = getProviderRegistry();

  // Check capabilities
  if (!registry.hasCapability('EventMonitor', chain)) {
    return {
      content: [{
        type: 'text',
        text: `❌ Event monitoring not available for ${chain}. Is Herd enabled?`,
      }],
      isError: true,
    };
  }

  try {
    let eventSignature: string | undefined;

    // If event name specified, get its signature from contract metadata
    if (eventName) {
      const metadataResult = await registry.getContractMetadata({
        address,
        chain,
        detailLevel: 'events',
      });

      if (!metadataResult.success || !metadataResult.data) {
        return {
          content: [{
            type: 'text',
            text: `❌ Could not fetch contract metadata: ${metadataResult.error}`,
          }],
          isError: true,
        };
      }

      eventSignature = findEventSignature(metadataResult.data, eventName) || undefined;

      if (!eventSignature) {
        // List available events
        const availableEvents = metadataResult.data.events.map(e => e.name).slice(0, 10);
        return {
          content: [{
            type: 'text',
            text: [
              `❌ Event "${eventName}" not found on this contract.`,
              '',
              'Available events:',
              ...availableEvents.map(e => `- ${e}`),
              availableEvents.length < metadataResult.data.events.length
                ? `_...and ${metadataResult.data.events.length - 10} more_`
                : '',
            ].join('\n'),
          }],
          isError: true,
        };
      }
    }

    // If no event name, we need to pick a common one or list options
    if (!eventSignature) {
      // Try to get contract metadata to find events
      const metadataResult = await registry.getContractMetadata({
        address,
        chain,
        detailLevel: 'events',
      });

      if (metadataResult.success && metadataResult.data && metadataResult.data.events.length > 0) {
        // Use first event as default
        const firstEvent = metadataResult.data.events[0];
        eventSignature = firstEvent.signature;

        // Show what events are available
        const availableEvents = metadataResult.data.events.map(e => e.name).slice(0, 5);
        console.error(`Using default event: ${firstEvent.name}. Available: ${availableEvents.join(', ')}`);
      } else {
        return {
          content: [{
            type: 'text',
            text: '❌ Could not determine events for this contract. Please specify an eventName.',
          }],
          isError: true,
        };
      }
    }

    // Get recent events
    const result = await registry.getRecentEvents({
      filter: {
        address,
        eventSignature,
        chain,
      },
      limit,
    });

    if (!result.success) {
      return {
        content: [{
          type: 'text',
          text: `❌ Failed to fetch events: ${result.error}`,
        }],
        isError: true,
      };
    }

    const output = formatEventsList(result.data || [], eventName, address, chain);

    return {
      content: [{ type: 'text', text: output }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
