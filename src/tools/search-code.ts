/**
 * Search Code Tool
 *
 * Search contract source code using AI-powered pattern matching.
 * Powered by Herd's regexCodeAnalysisTool.
 */

import { getProviderRegistry } from '../providers/index.js';
import type { SupportedChain } from '../config/chains.js';

// ============================================================================
// Tool Definition
// ============================================================================

export const searchCodeToolDefinition = {
  name: 'wallet_search_code',
  description: `Search contract source code using natural language queries.

**Use cases:**
- "Find all functions that can pause the contract"
- "Show me the fee calculation logic"
- "Where does this contract check for reentrancy?"
- "Find all external calls"

**Example:**
\`\`\`json
{
  "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "query": "find blacklist functions",
  "chain": "ethereum"
}
\`\`\`

Returns matching code snippets with line numbers.

Supported chains: ethereum, base`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      address: {
        type: 'string',
        description: 'Contract address (0x...)',
      },
      query: {
        type: 'string',
        description: 'Natural language search query',
      },
      chain: {
        type: 'string',
        enum: ['ethereum', 'base'],
        default: 'ethereum',
        description: 'Blockchain (default: ethereum)',
      },
    },
    required: ['address', 'query'],
  },
};

// ============================================================================
// Tool Handler
// ============================================================================

export async function handleSearchCode(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const address = args.address as string;
  const query = args.query as string;
  const chain = (args.chain as SupportedChain) || 'ethereum';

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

  // Validate query
  if (!query || query.trim().length < 3) {
    return {
      content: [{
        type: 'text',
        text: '❌ Search query is too short. Please provide a more specific query.',
      }],
      isError: true,
    };
  }

  const registry = getProviderRegistry();

  // Check if we have code search capability (Herd only)
  if (!registry.hasCapability('CodeSearch', chain)) {
    return {
      content: [{
        type: 'text',
        text: `❌ Code search not available for ${chain}. Is Herd enabled?`,
      }],
      isError: true,
    };
  }

  try {
    const result = await registry.searchCode({
      addresses: [address],
      chain,
      query,
    });

    if (!result.success || !result.data) {
      return {
        content: [{
          type: 'text',
          text: `❌ Code search failed: ${result.error || 'Unknown error'}`,
        }],
        isError: true,
      };
    }

    // result.data is CodeSearchResult[] - flatten all matches from all contracts
    const allMatches = result.data.flatMap(r =>
      r.matches.map(m => ({ ...m, contractName: r.contractName }))
    );

    if (allMatches.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `## 🔍 Code Search: No Results

**Query:** "${query}"
**Contract:** \`${address}\`
**Chain:** ${chain}

No matching code found. Try:
- A different search term
- More specific query
- Checking if the contract is verified`,
        }],
      };
    }

    // Format results
    const lines: string[] = [];
    lines.push(`## 🔍 Code Search Results`);
    lines.push('');
    lines.push(`**Query:** "${query}"`);
    lines.push(`**Contract:** \`${address}\``);
    lines.push(`**Chain:** ${chain}`);
    lines.push(`**Matches:** ${allMatches.length}`);
    lines.push('');

    for (const match of allMatches) {
      lines.push('---');
      lines.push('');

      if (match.functionName) {
        lines.push(`### Function: \`${match.functionName}\``);
      }
      if (match.contractName) {
        lines.push(`**Contract:** ${match.contractName}`);
      }

      if (match.lineNumbers) {
        lines.push(`**Lines:** ${match.lineNumbers}`);
      }

      lines.push('');
      lines.push('```solidity');
      lines.push(match.snippet);
      lines.push('```');
      lines.push('');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error searching code: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
