/**
 * Analyze Contract Tool
 *
 * Provides deep contract intelligence using Herd MCP.
 * Shows functions, events, token info, proxy status, and security flags.
 *
 * Uses:
 * - Herd contractMetadataTool for ABI and metadata
 * - Herd regexCodeAnalysisTool for code search (optional)
 * - Herd diffContractVersions for upgrade history (if proxy)
 */

import { getProviderRegistry, type ContractMetadata, type ContractMetadataSummary } from '../providers/index.js';
import { getCachedSummary } from '../cache/index.js';
import type { SupportedChain } from '../config/chains.js';

// ============================================================================
// Tool Definition
// ============================================================================

export const analyzeContractToolDefinition = {
  name: 'wallet_analyze_contract',
  description: `Analyze a smart contract to understand its functions, events, and security profile.

**Basic analysis:**
\`\`\`json
{"address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"}
\`\`\`

**With detail level:**
\`\`\`json
{"address": "0x...", "chain": "base", "detailLevel": "functions"}
\`\`\`

**Detail levels:**
- \`summary\`: Contract type, token info, key stats (fast, default)
- \`functions\`: All functions with summaries
- \`events\`: All events with summaries
- \`full\`: Everything including ABI

Returns: Contract name, type (ERC-20, etc.), functions, events, proxy status, token details, security flags.

Supported chains: ethereum, base`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      address: {
        type: 'string',
        description: 'Contract address (0x...)',
      },
      chain: {
        type: 'string',
        enum: ['ethereum', 'base'],
        default: 'base',
        description: 'Blockchain (default: base)',
      },
      detailLevel: {
        type: 'string',
        enum: ['summary', 'functions', 'events', 'full'],
        default: 'summary',
        description: 'Level of detail to return',
      },
    },
    required: ['address'],
  },
};

// ============================================================================
// Formatting Helpers
// ============================================================================

/**
 * Format token info
 */
function formatTokenInfo(token: ContractMetadata['token']): string[] {
  if (!token) return [];

  const lines: string[] = [];
  lines.push(`### Token: ${token.symbol}`);
  lines.push(`- **Name:** ${token.name}`);
  lines.push(`- **Type:** ${token.type}`);
  if (token.decimals !== undefined) {
    lines.push(`- **Decimals:** ${token.decimals}`);
  }
  if (token.priceUsd) {
    lines.push(`- **Price:** $${parseFloat(token.priceUsd).toFixed(4)}`);
  }
  if (token.marketCapUsd) {
    const mcap = parseFloat(token.marketCapUsd);
    const formatted = mcap >= 1e9 ? `$${(mcap / 1e9).toFixed(2)}B` :
                      mcap >= 1e6 ? `$${(mcap / 1e6).toFixed(2)}M` :
                      `$${mcap.toFixed(0)}`;
    lines.push(`- **Market Cap:** ${formatted}`);
  }
  if (token.totalSupply) {
    const supply = parseFloat(token.totalSupply);
    const formatted = supply >= 1e9 ? `${(supply / 1e9).toFixed(2)}B` :
                      supply >= 1e6 ? `${(supply / 1e6).toFixed(2)}M` :
                      supply.toFixed(0);
    lines.push(`- **Total Supply:** ${formatted}`);
  }
  return lines;
}

/**
 * Format proxy info
 */
function formatProxyInfo(metadata: ContractMetadata): string[] {
  if (!metadata.proxy?.isProxy) return [];

  const lines: string[] = [];
  lines.push('### Proxy Contract');
  if (metadata.proxy.implementationAddress) {
    lines.push(`- **Implementation:** \`${metadata.proxy.implementationAddress}\``);
  }
  if (metadata.proxy.proxyType) {
    lines.push(`- **Type:** ${metadata.proxy.proxyType.toUpperCase()}`);
  }

  if (metadata.upgrades && metadata.upgrades.length > 1) {
    lines.push(`- **Upgrades:** ${metadata.upgrades.length} versions`);
    // Show last 3 upgrades
    const recent = metadata.upgrades.slice(-3).reverse();
    for (const upgrade of recent) {
      lines.push(`  - v${upgrade.version}: \`${upgrade.implementationAddress.slice(0, 10)}...\``);
      if (upgrade.addedFunctions && upgrade.addedFunctions.length > 0) {
        lines.push(`    Added: ${upgrade.addedFunctions.slice(0, 3).join(', ')}${upgrade.addedFunctions.length > 3 ? '...' : ''}`);
      }
    }
  }

  return lines;
}

/**
 * Format functions list
 */
function formatFunctions(metadata: ContractMetadata, limit?: number): string[] {
  const lines: string[] = [];
  const functions = metadata.functions;

  if (functions.length === 0) {
    lines.push('_No functions found (contract may not be verified)_');
    return lines;
  }

  lines.push(`### Functions (${functions.length} total)`);

  // Separate by mutability
  const writeFunctions = functions.filter(f =>
    f.stateMutability === 'nonpayable' || f.stateMutability === 'payable'
  );
  const readFunctions = functions.filter(f =>
    f.stateMutability === 'view' || f.stateMutability === 'pure'
  );

  // Show write functions
  if (writeFunctions.length > 0) {
    lines.push('');
    lines.push('**Write Functions:**');
    const toShow = limit ? writeFunctions.slice(0, limit) : writeFunctions;
    for (const func of toShow) {
      const payable = func.stateMutability === 'payable' ? ' (payable)' : '';
      lines.push(`- \`${func.name}\`${payable}`);
      if (func.summary) {
        lines.push(`  ${func.summary.slice(0, 100)}${func.summary.length > 100 ? '...' : ''}`);
      }
    }
    if (limit && writeFunctions.length > limit) {
      lines.push(`  _...and ${writeFunctions.length - limit} more_`);
    }
  }

  // Show read functions
  if (readFunctions.length > 0) {
    lines.push('');
    lines.push('**Read Functions:**');
    const toShow = limit ? readFunctions.slice(0, limit) : readFunctions;
    for (const func of toShow) {
      lines.push(`- \`${func.name}\``);
    }
    if (limit && readFunctions.length > limit) {
      lines.push(`  _...and ${readFunctions.length - limit} more_`);
    }
  }

  return lines;
}

/**
 * Format events list
 */
function formatEvents(metadata: ContractMetadata, limit?: number): string[] {
  const lines: string[] = [];
  const events = metadata.events;

  if (events.length === 0) {
    lines.push('_No events found_');
    return lines;
  }

  lines.push(`### Events (${events.length} total)`);

  const toShow = limit ? events.slice(0, limit) : events;
  for (const event of toShow) {
    const params = event.inputs.map(i => `${i.type}${i.indexed ? ' indexed' : ''} ${i.name}`).join(', ');
    lines.push(`- \`${event.name}(${params})\``);
    if (event.summary) {
      lines.push(`  ${event.summary.slice(0, 100)}${event.summary.length > 100 ? '...' : ''}`);
    }
  }
  if (limit && events.length > limit) {
    lines.push(`_...and ${events.length - limit} more_`);
  }

  return lines;
}

/**
 * Generate security flags
 */
function getSecurityFlags(metadata: ContractMetadata): { emoji: string; message: string }[] {
  const flags: { emoji: string; message: string }[] = [];

  // Verified status
  if (!metadata.verified) {
    flags.push({ emoji: '⚠️', message: 'Contract source not verified' });
  } else {
    flags.push({ emoji: '✅', message: 'Source code verified' });
  }

  // Proxy detection
  if (metadata.proxy?.isProxy) {
    flags.push({ emoji: '🔄', message: 'Upgradeable proxy contract' });
  }

  // Admin functions detection
  const adminFunctions = metadata.functions.filter(f =>
    f.name.includes('admin') ||
    f.name.includes('owner') ||
    f.name.includes('pause') ||
    f.name.includes('blacklist') ||
    f.name.includes('mint') && !f.name.includes('permit')
  );
  if (adminFunctions.length > 0) {
    flags.push({ emoji: '👑', message: `Has admin functions (${adminFunctions.map(f => f.name).slice(0, 3).join(', ')})` });
  }

  // Recent deployment
  if (metadata.deployment?.timestamp) {
    const deployDate = new Date(metadata.deployment.timestamp);
    const daysSinceDeploy = (Date.now() - deployDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceDeploy < 7) {
      flags.push({ emoji: '🆕', message: `Deployed ${Math.floor(daysSinceDeploy)} days ago` });
    }
  }

  return flags;
}

/**
 * Format the full analysis output
 */
function formatAnalysis(
  metadata: ContractMetadata,
  detailLevel: string,
  cached: boolean
): string {
  const lines: string[] = [];

  // Header
  lines.push(`## 📋 Contract Analysis: ${metadata.name}`);
  lines.push('');
  lines.push(`**Address:** \`${metadata.address}\``);
  lines.push(`**Chain:** ${metadata.chain} (${metadata.chainId})`);
  if (cached) {
    lines.push('_📦 From cache_');
  }
  lines.push('');

  // Security flags
  const flags = getSecurityFlags(metadata);
  lines.push('### Security');
  for (const flag of flags) {
    lines.push(`${flag.emoji} ${flag.message}`);
  }
  lines.push('');

  // Token info (if applicable)
  const tokenLines = formatTokenInfo(metadata.token);
  if (tokenLines.length > 0) {
    lines.push(...tokenLines);
    lines.push('');
  }

  // Proxy info (if applicable)
  const proxyLines = formatProxyInfo(metadata);
  if (proxyLines.length > 0) {
    lines.push(...proxyLines);
    lines.push('');
  }

  // Contract summary
  if (metadata.summary) {
    lines.push('### Summary');
    lines.push(metadata.summary);
    lines.push('');
  }

  // Functions (based on detail level)
  if (detailLevel === 'functions' || detailLevel === 'full') {
    lines.push(...formatFunctions(metadata));
    lines.push('');
  } else if (detailLevel === 'summary') {
    // Just show count and top functions
    lines.push(`### Functions: ${metadata.functions.length} total`);
    const writeFuncs = metadata.functions.filter(f =>
      f.stateMutability === 'nonpayable' || f.stateMutability === 'payable'
    );
    if (writeFuncs.length > 0) {
      lines.push(`Key: ${writeFuncs.slice(0, 5).map(f => `\`${f.name}\``).join(', ')}`);
    }
    lines.push('');
  }

  // Events (based on detail level)
  if (detailLevel === 'events' || detailLevel === 'full') {
    lines.push(...formatEvents(metadata));
    lines.push('');
  } else if (detailLevel === 'summary') {
    lines.push(`### Events: ${metadata.events.length} total`);
    if (metadata.events.length > 0) {
      lines.push(`Key: ${metadata.events.slice(0, 5).map(e => `\`${e.name}\``).join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Tool Handler
// ============================================================================

export async function handleAnalyzeContract(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const address = args.address as string;
  const chain = (args.chain as SupportedChain) || 'base';
  const detailLevel = (args.detailLevel as string) || 'summary';

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

  // Validate chain
  if (!['ethereum', 'base'].includes(chain)) {
    return {
      content: [{
        type: 'text',
        text: `❌ Chain "${chain}" not supported for contract analysis. Supported: ethereum, base`,
      }],
      isError: true,
    };
  }

  const registry = getProviderRegistry();

  // Check if we have this capability
  if (!registry.hasCapability('ContractMetadata', chain)) {
    return {
      content: [{
        type: 'text',
        text: `❌ Contract analysis not available for ${chain}. Is Herd enabled?`,
      }],
      isError: true,
    };
  }

  try {
    // Get metadata from provider (uses cache internally)
    const result = await registry.getContractMetadata({
      address,
      chain,
      detailLevel: detailLevel as 'summary' | 'functions' | 'events' | 'full',
      includeAbi: detailLevel === 'full',
    });

    if (!result.success || !result.data) {
      return {
        content: [{
          type: 'text',
          text: `❌ Failed to analyze contract: ${result.error || 'Unknown error'}`,
        }],
        isError: true,
      };
    }

    const output = formatAnalysis(result.data, detailLevel, result.cached || false);

    return {
      content: [{ type: 'text', text: output }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error analyzing contract: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
