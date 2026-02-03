/**
 * Opportunities Tool
 *
 * Scans user's holdings for actionable opportunities:
 * - Unclaimed staking rewards
 * - Governance votes available
 * - Recent token inflows
 *
 * This tool enables proactive wallet management.
 */

import { getSession, touchSession } from '../storage/session.js';
import { isSupportedChain, type SupportedChain } from '../config/chains.js';
import { getProviderRegistry } from '../providers/index.js';
import { scanForOpportunities, formatOpportunitiesForLLM } from '../intelligence/index.js';

/**
 * Tool definition for wallet_opportunities
 */
export const opportunitiesToolDefinition = {
  name: 'wallet_opportunities',
  description: `Scan your wallet for actionable opportunities.

**What it detects:**
- Unclaimed staking rewards ready to claim
- Governance proposals you can vote on
- Recent token inflows to investigate
- Vesting tokens ready to release

**Examples:**
\`\`\`json
{"chain": "base"}
\`\`\`
Scans all Base holdings for opportunities.

\`\`\`json
{"chain": "ethereum", "tokens": ["0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9"]}
\`\`\`
Scans specific tokens only.

Returns prioritized list of actions you should take.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      chain: {
        type: 'string',
        enum: ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'],
        default: 'base',
        description: 'Chain to scan (default: base)',
      },
      tokens: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional: specific token addresses to scan. If omitted, scans all holdings.',
      },
    },
  },
};

/**
 * Handle opportunities request
 */
export async function handleOpportunitiesRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const chain = (args.chain as string) || 'base';
  const specificTokens = args.tokens as string[] | undefined;

  // Validate chain
  if (!isSupportedChain(chain)) {
    return {
      content: [{
        type: 'text',
        text: `❌ Unsupported chain: ${chain}\n\nSupported chains: ethereum, base, arbitrum, optimism, polygon`,
      }],
      isError: true,
    };
  }

  // Get user session
  let userAddress: string;
  try {
    const session = await getSession();
    if (!session?.authenticated || !session.address) {
      return {
        content: [{
          type: 'text',
          text: '❌ No wallet connected. Run `wallet_setup` first to connect your wallet.',
        }],
        isError: true,
      };
    }
    userAddress = session.address;
    await touchSession();
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Session error: ${error instanceof Error ? error.message : 'Unknown'}`,
      }],
      isError: true,
    };
  }

  try {
    let tokenAddresses: string[];

    if (specificTokens && specificTokens.length > 0) {
      // Use provided tokens
      tokenAddresses = specificTokens;
    } else {
      // Get all holdings from Zerion
      const registry = getProviderRegistry();
      const historyResult = await registry.listHistory({
        address: userAddress,
        chain: chain as SupportedChain,
        limit: 50,
      });

      // Extract unique token addresses from transaction history
      const tokenSet = new Set<string>();

      if (historyResult.success && historyResult.data) {
        for (const tx of historyResult.data.transactions) {
          for (const transfer of tx.transfers) {
            if (transfer.token.address) {
              tokenSet.add(transfer.token.address.toLowerCase());
            }
          }
        }
      }

      tokenAddresses = Array.from(tokenSet);

      if (tokenAddresses.length === 0) {
        return {
          content: [{
            type: 'text',
            text: [
              '## No Token Activity Found',
              '',
              `No recent token transactions found on ${chain}.`,
              '',
              '**Possible reasons:**',
              '- You haven\'t transacted on this chain recently',
              '- This is a new wallet with no history',
              '',
              '**What you can do:**',
              '1. Check a different chain: `wallet_opportunities chain="ethereum"`',
              '2. Scan specific tokens: `wallet_opportunities tokens=["0x..."]`',
              '3. Check your balances: `wallet_balance`',
              '4. Analyze a specific holding: `wallet_analyze_holding token="0x..."`',
            ].join('\n'),
          }],
        };
      }
    }

    // Scan for opportunities
    const result = await scanForOpportunities(
      userAddress,
      chain as SupportedChain,
      tokenAddresses
    );

    // Format for LLM
    const formatted = formatOpportunitiesForLLM(result);

    return {
      content: [{
        type: 'text',
        text: formatted,
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Scan failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
