/**
 * Analyze Transaction Tool
 *
 * Provides deep transaction analysis using Herd MCP.
 * Shows decoded function calls, balance changes, and events.
 *
 * Uses:
 * - Herd queryTransactionTool for full transaction analysis
 */

import { getProviderRegistry, type TransactionAnalysis, type DecodedCall, type DecodedEvent, type BalanceChange } from '../providers/index.js';
import type { SupportedChain } from '../config/chains.js';

// ============================================================================
// Tool Definition
// ============================================================================

export const analyzeTxToolDefinition = {
  name: 'wallet_analyze_tx',
  description: `Analyze a transaction to understand what happened.

**Basic usage:**
\`\`\`json
{"txHash": "0x..."}
\`\`\`

**With chain specified:**
\`\`\`json
{"txHash": "0x...", "chain": "base"}
\`\`\`

Returns: Decoded function call, balance changes, events emitted, gas used, and a human-readable summary.

Supported chains: ethereum, base`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      txHash: {
        type: 'string',
        description: 'Transaction hash (0x...)',
      },
      chain: {
        type: 'string',
        enum: ['ethereum', 'base'],
        description: 'Blockchain (auto-detected if not specified)',
      },
    },
    required: ['txHash'],
  },
};

// ============================================================================
// Formatting Helpers
// ============================================================================

const CHAIN_EXPLORERS: Record<SupportedChain, string> = {
  ethereum: 'https://etherscan.io',
  base: 'https://basescan.org',
  arbitrum: 'https://arbiscan.io',
  optimism: 'https://optimistic.etherscan.io',
  polygon: 'https://polygonscan.com',
};

/**
 * Format a decoded function call
 */
function formatCall(call: DecodedCall): string[] {
  const lines: string[] = [];

  lines.push('### Function Called');
  lines.push(`**\`${call.functionName}\`** on \`${call.contractAddress.slice(0, 10)}...\``);

  if (call.contractName) {
    lines.push(`Contract: ${call.contractName}`);
  }

  // Format arguments
  const args = Object.entries(call.args);
  if (args.length > 0) {
    lines.push('');
    lines.push('**Arguments:**');
    for (const [name, value] of args) {
      const formatted = formatValue(value);
      lines.push(`- \`${name}\`: ${formatted}`);
    }
  }

  if (call.readable && call.readable !== `Transaction ${call.contractAddress}`) {
    lines.push('');
    lines.push(`_${call.readable}_`);
  }

  return lines;
}

/**
 * Format a value for display
 */
function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    // Check if it's an address
    if (value.match(/^0x[a-fA-F0-9]{40}$/)) {
      return `\`${value.slice(0, 10)}...${value.slice(-6)}\``;
    }
    // Check if it's a hash
    if (value.match(/^0x[a-fA-F0-9]{64}$/)) {
      return `\`${value.slice(0, 14)}...\``;
    }
    // Check if it's a large number (likely wei)
    if (value.match(/^[0-9]{10,}$/)) {
      const num = BigInt(value);
      if (num >= BigInt(1e18)) {
        return `${(Number(num) / 1e18).toFixed(4)} (raw: ${value})`;
      }
      if (num >= BigInt(1e6)) {
        return `${(Number(num) / 1e6).toFixed(2)} (raw: ${value})`;
      }
    }
    return value.length > 50 ? `${value.slice(0, 50)}...` : value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    if (value.length > 3) {
      return `[${value.slice(0, 3).map(v => formatValue(v)).join(', ')}, ...]`;
    }
    return `[${value.map(v => formatValue(v)).join(', ')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value).slice(0, 100);
  }
  return String(value);
}

/**
 * Format balance changes
 */
function formatBalanceChanges(changes: BalanceChange[]): string[] {
  const lines: string[] = [];

  if (changes.length === 0) {
    return ['_No balance changes detected_'];
  }

  lines.push('### Balance Changes');

  for (const change of changes) {
    const symbol = change.token.symbol || 'TOKEN';
    const changeNum = parseFloat(change.change);
    const direction = changeNum >= 0 ? '📥' : '📤';
    const sign = changeNum >= 0 ? '+' : '';

    let changeLine = `${direction} **${sign}${change.change} ${symbol}**`;
    if (change.changeUsd) {
      changeLine += ` ($${change.changeUsd})`;
    }

    lines.push(changeLine);

    // Show address (shortened)
    const addr = `\`${change.address.slice(0, 10)}...${change.address.slice(-6)}\``;
    lines.push(`   ${addr}`);
  }

  return lines;
}

/**
 * Format events
 */
function formatEvents(events: DecodedEvent[], limit = 10): string[] {
  const lines: string[] = [];

  if (events.length === 0) {
    return ['_No events emitted_'];
  }

  lines.push(`### Events (${events.length} total)`);

  const toShow = events.slice(0, limit);
  for (const event of toShow) {
    const contract = event.contractName || `${event.contractAddress.slice(0, 10)}...`;
    lines.push(`- **${event.eventName}** from ${contract}`);

    // Show key arguments (max 3)
    const args = Object.entries(event.args).slice(0, 3);
    if (args.length > 0) {
      for (const [name, value] of args) {
        lines.push(`  - \`${name}\`: ${formatValue(value)}`);
      }
      if (Object.keys(event.args).length > 3) {
        lines.push(`  - _...and ${Object.keys(event.args).length - 3} more args_`);
      }
    }
  }

  if (events.length > limit) {
    lines.push(`_...and ${events.length - limit} more events_`);
  }

  return lines;
}

/**
 * Generate intent summary from analysis
 */
function generateIntentSummary(analysis: TransactionAnalysis): string {
  const { call, events, balanceChanges } = analysis;

  // Check for common patterns
  const eventNames = events.map(e => e.eventName.toLowerCase());

  // Swap detection
  if (eventNames.includes('swap') || call.functionName.toLowerCase().includes('swap')) {
    const transfers = events.filter(e => e.eventName === 'Transfer');
    if (transfers.length >= 2) {
      return 'Token swap transaction';
    }
  }

  // Transfer detection
  if (call.functionName === 'transfer' || call.functionName === 'transferFrom') {
    const amount = call.args.amount || call.args.value || call.args._value;
    const to = call.args.to || call.args._to || call.args.recipient;
    if (amount && to) {
      return `Transfer of tokens to ${formatValue(to)}`;
    }
  }

  // Approval detection
  if (call.functionName === 'approve') {
    return 'Token approval for spending';
  }

  // Mint detection
  if (call.functionName.toLowerCase().includes('mint')) {
    return 'Token minting transaction';
  }

  // Default to function name
  return `${call.functionName} call on ${call.contractName || 'contract'}`;
}

/**
 * Format the full analysis output
 */
function formatAnalysis(analysis: TransactionAnalysis): string {
  const lines: string[] = [];

  // Header
  const statusEmoji = analysis.status === 'confirmed' ? '✅' : '❌';
  lines.push(`## ${statusEmoji} Transaction Analysis`);
  lines.push('');

  // Summary box
  lines.push(`**Hash:** [\`${analysis.hash.slice(0, 14)}...\`](${CHAIN_EXPLORERS[analysis.chain]}/tx/${analysis.hash})`);
  lines.push(`**Chain:** ${analysis.chain} | **Block:** ${analysis.blockNumber}`);
  lines.push(`**Time:** ${new Date(analysis.timestamp).toLocaleString()}`);
  lines.push(`**Status:** ${analysis.status}`);
  if (analysis.gasUsed && analysis.gasUsed !== '0') {
    const gasLine = analysis.gasCostUsd
      ? `${analysis.gasUsed} gas ($${analysis.gasCostUsd})`
      : `${analysis.gasUsed} gas`;
    lines.push(`**Gas:** ${gasLine}`);
  }
  lines.push('');

  // Intent summary
  const intent = analysis.intentSummary || generateIntentSummary(analysis);
  lines.push(`> **Summary:** ${intent}`);
  lines.push('');

  // Decoded call
  if (analysis.call.functionName !== 'unknown') {
    lines.push(...formatCall(analysis.call));
    lines.push('');
  }

  // Balance changes
  if (analysis.balanceChanges.length > 0) {
    lines.push(...formatBalanceChanges(analysis.balanceChanges));
    lines.push('');
  }

  // Events
  if (analysis.events.length > 0) {
    lines.push(...formatEvents(analysis.events));
    lines.push('');
  }

  // Internal calls (if any)
  if (analysis.internalCalls && analysis.internalCalls.length > 0) {
    lines.push(`### Internal Calls (${analysis.internalCalls.length})`);
    for (const call of analysis.internalCalls.slice(0, 5)) {
      lines.push(`- \`${call.functionName}\` on ${call.contractName || call.contractAddress.slice(0, 10)}`);
    }
    if (analysis.internalCalls.length > 5) {
      lines.push(`_...and ${analysis.internalCalls.length - 5} more_`);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Tool Handler
// ============================================================================

export async function handleAnalyzeTx(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const txHash = args.txHash as string;
  const chain = args.chain as SupportedChain | undefined;

  // Validate tx hash
  if (!txHash || !txHash.match(/^0x[a-fA-F0-9]{64}$/)) {
    return {
      content: [{
        type: 'text',
        text: '❌ Invalid transaction hash. Must be 64 hex characters (0x...)',
      }],
      isError: true,
    };
  }

  // If chain specified, validate it
  if (chain && !['ethereum', 'base'].includes(chain)) {
    return {
      content: [{
        type: 'text',
        text: `❌ Chain "${chain}" not supported for transaction analysis. Supported: ethereum, base`,
      }],
      isError: true,
    };
  }

  const registry = getProviderRegistry();

  // Default to ethereum if not specified, or try to detect
  const targetChain = chain || 'ethereum';

  // Check if we have this capability
  if (!registry.hasCapability('TxAnalysis', targetChain)) {
    return {
      content: [{
        type: 'text',
        text: `❌ Transaction analysis not available for ${targetChain}. Is Herd enabled?`,
      }],
      isError: true,
    };
  }

  try {
    const result = await registry.analyzeTransaction({
      txHash,
      chain: targetChain,
      includeInternalCalls: true,
    });

    if (!result.success || !result.data) {
      return {
        content: [{
          type: 'text',
          text: `❌ Failed to analyze transaction: ${result.error || 'Unknown error'}`,
        }],
        isError: true,
      };
    }

    const output = formatAnalysis(result.data);

    return {
      content: [{ type: 'text', text: output }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error analyzing transaction: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
