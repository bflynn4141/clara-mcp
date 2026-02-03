/**
 * Wallet Briefing Tool
 *
 * Provides a proactive summary when the user connects their wallet.
 * Auto-runs on session start to show:
 * - Unclaimed rewards
 * - Governance votes
 * - Recent inflows
 *
 * Designed to be called automatically by the LLM at the start
 * of wallet-related sessions.
 */

import { getSession, touchSession } from '../storage/session.js';
import { isSupportedChain, type SupportedChain } from '../config/chains.js';
import { getProviderRegistry } from '../providers/index.js';
import {
  scanForOpportunities,
  type OpportunityScanResult,
  type Opportunity,
} from '../intelligence/index.js';

/**
 * Tool definition for wallet_briefing
 */
export const briefingToolDefinition = {
  name: 'wallet_briefing',
  description: `Get a proactive briefing on your wallet.

**Use this tool to:**
- See what opportunities await you
- Get a quick summary of wallet status
- Identify immediate actions to take

**Best practice:** Call this at the start of any wallet-focused session.

**Returns:**
- High priority items (unclaimed rewards > $10)
- Governance votes available
- New tokens received
- Suggested next actions

**Example:**
\`\`\`json
{"chain": "base"}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      chain: {
        type: 'string',
        enum: ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'],
        default: 'base',
        description: 'Primary chain to brief on (default: base)',
      },
    },
  },
};

/**
 * Handle briefing request
 */
export async function handleBriefingRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const chain = (args.chain as string) || 'base';

  // Validate chain
  if (!isSupportedChain(chain)) {
    return {
      content: [{
        type: 'text',
        text: `❌ Unsupported chain: ${chain}`,
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
          text: '👋 **Welcome!**\n\nNo wallet connected yet. Run `wallet_setup` to get started.',
        }],
      };
    }
    userAddress = session.address;
    await touchSession();
  } catch {
    return {
      content: [{
        type: 'text',
        text: '👋 **Welcome!**\n\nNo wallet connected yet. Run `wallet_setup` to get started.',
      }],
    };
  }

  try {
    // Get user's tokens from recent activity
    const registry = getProviderRegistry();
    const historyResult = await registry.listHistory({
      address: userAddress,
      chain: chain as SupportedChain,
      limit: 30,
    });

    // Extract unique token addresses
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

    const tokenAddresses = Array.from(tokenSet).slice(0, 10); // Limit for speed

    // Scan for opportunities (quick scan)
    const result = await scanForOpportunities(
      userAddress,
      chain as SupportedChain,
      tokenAddresses
    );

    // Format as a briefing
    const briefing = formatBriefing(result, userAddress, chain);

    return {
      content: [{
        type: 'text',
        text: briefing,
      }],
    };
  } catch (error) {
    // Even on error, provide a graceful response
    return {
      content: [{
        type: 'text',
        text: `## Wallet Briefing\n\nConnected: \`${userAddress.slice(0, 10)}...\`\nChain: ${chain}\n\n⚠️ Could not complete full scan. Try \`wallet_opportunities\` for detailed analysis.`,
      }],
    };
  }
}

/**
 * Format scan results as a briefing
 */
function formatBriefing(result: OpportunityScanResult, address: string, chain: string): string {
  const lines: string[] = [];

  // Header
  lines.push('## 🎯 Wallet Briefing');
  lines.push('');
  lines.push(`**Wallet:** \`${address.slice(0, 10)}...${address.slice(-4)}\``);
  lines.push(`**Chain:** ${chain}`);
  lines.push('');

  // High priority items
  const highPriority = result.opportunities.filter(o => o.priority === 'high');
  const mediumPriority = result.opportunities.filter(o => o.priority === 'medium');

  if (highPriority.length > 0) {
    lines.push('### 🔴 Action Required');
    for (const opp of highPriority) {
      lines.push(`- **${opp.title}**`);
      lines.push(`  ${opp.description}`);
    }
    lines.push('');
  }

  if (mediumPriority.length > 0) {
    lines.push('### 🟡 Opportunities');
    for (const opp of mediumPriority.slice(0, 3)) {
      lines.push(`- **${opp.title}**: ${opp.description}`);
    }
    if (mediumPriority.length > 3) {
      lines.push(`- _...and ${mediumPriority.length - 3} more_`);
    }
    lines.push('');
  }

  // No opportunities
  if (result.opportunities.length === 0) {
    lines.push('### ✅ All Clear');
    lines.push('No immediate actions needed. Your wallet is in good shape!');
    lines.push('');
  }

  // Quick actions section - structured for LLM to present as AskUserQuestion options
  lines.push('### 🚀 What would you like to do?');
  lines.push('');

  const suggestedActions: string[] = [];

  if (highPriority.length > 0) {
    const topOpp = highPriority[0];
    suggestedActions.push(`**Claim rewards** - ${topOpp.tokenSymbol || 'Token'} has pending rewards (use \`wallet_execute contract="${topOpp.tokenAddress}" action="claim"\`)`);
  }

  if (mediumPriority.some(o => o.type === 'token_inflow')) {
    const inflow = mediumPriority.find(o => o.type === 'token_inflow');
    suggestedActions.push(`**Analyze ${inflow?.tokenSymbol || 'new token'}** - You received this recently (use \`wallet_analyze_holding token="${inflow?.tokenAddress}"\`)`);
  }

  if (mediumPriority.some(o => o.type === 'governance_vote')) {
    const gov = mediumPriority.find(o => o.type === 'governance_vote');
    suggestedActions.push(`**Delegate voting power** - You have ${gov?.tokenSymbol || 'governance'} tokens (use \`wallet_execute contract="${gov?.tokenAddress}" action="delegate" delegateTo="self"\`)`);
  }

  // Always include these
  suggestedActions.push('**Check my balances** - See all token holdings (`wallet_balance`)');
  suggestedActions.push('**Scan all opportunities** - Deep scan for more actions (`wallet_opportunities`)');

  // Number the actions for easy reference
  suggestedActions.forEach((action, i) => {
    lines.push(`${i + 1}. ${action}`);
  });

  lines.push('');
  lines.push('_Just ask me to do any of these, or tell me what else you need!_');

  return lines.join('\n');
}
