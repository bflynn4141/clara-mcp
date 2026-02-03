/**
 * Analyze Holding Tool
 *
 * Deep-dive analysis of any token contract.
 * Uses Herd for contract metadata and pattern matching for classification.
 *
 * Features:
 * - Identifies token type (governance, LP, vault, staking, etc.)
 * - Shows user's balance of the token
 * - Lists available functions (for LLM reasoning)
 * - Finds related contracts (staking, rewards, governance)
 * - Handles proxy contracts (EIP-1967 resolution)
 * - Graceful degradation for unverified contracts
 */

import { getSession, touchSession } from '../storage/session.js';
import { isSupportedChain } from '../config/chains.js';
import { analyzeToken, formatAnalysisForLLM } from '../intelligence/index.js';

/**
 * Tool definition for wallet_analyze_holding
 */
export const analyzeHoldingToolDefinition = {
  name: 'wallet_analyze_holding',
  description: `Analyze any token to understand what it is and what you can do with it.

**What it returns:**
- Token type classification (governance, LP, vault, staking, vesting)
- Your balance of this token
- Available functions (for understanding capabilities)
- Related contracts (staking, rewards, governance)
- Proxy detection and implementation analysis

**Examples:**
\`\`\`json
{"token": "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9", "chain": "ethereum"}
\`\`\`
Analyzes AAVE token on Ethereum.

\`\`\`json
{"token": "0x940181a94A35A4569E4529A3CDfB74e38FD98631", "chain": "base"}
\`\`\`
Analyzes Aerodrome token on Base.

Works with ANY verified contract - no pre-integration needed.
For unverified contracts, returns a warning with limited info.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      token: {
        type: 'string',
        description: 'Token contract address (0x...)',
      },
      chain: {
        type: 'string',
        enum: ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'],
        default: 'base',
        description: 'Blockchain to analyze on (default: base)',
      },
    },
    required: ['token'],
  },
};

/**
 * Handle analyze holding requests
 */
export async function handleAnalyzeHoldingRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  // Safe extraction with type guards
  const token = typeof args.token === 'string' ? args.token : '';
  const chain = typeof args.chain === 'string' ? args.chain : 'base';

  // Validate token address
  if (!token || !token.match(/^0x[a-fA-F0-9]{40}$/)) {
    return {
      content: [{
        type: 'text',
        text: '❌ Invalid token address. Must be a valid Ethereum address (0x... with 40 hex characters).',
      }],
      isError: true,
    };
  }

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

  // Get user address if wallet is connected (for balance lookup)
  let userAddress: string | undefined;
  try {
    const session = await getSession();
    if (session?.authenticated && session.address) {
      userAddress = session.address;
      await touchSession();
    }
  } catch {
    // No session - that's fine, just skip balance
  }

  try {
    // Analyze the token
    const analysis = await analyzeToken(token, chain, userAddress);

    // Format for LLM consumption
    const formatted = formatAnalysisForLLM(analysis);

    // Add suggestions based on classification
    const suggestions = generateSuggestions(analysis);

    const response = suggestions
      ? `${formatted}\n\n---\n\n**Suggested Actions:**\n${suggestions}`
      : formatted;

    return {
      content: [{
        type: 'text',
        text: response,
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Failed to analyze token: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

/**
 * Generate action suggestions based on token classification
 */
function generateSuggestions(analysis: any): string | null {
  if (!analysis.isVerified) {
    return '⚠️ This contract is not verified. Exercise caution before interacting.';
  }

  const suggestions: string[] = [];
  const type = analysis.likelyType;
  const fns = new Set(analysis.availableFunctions.map((f: string) => f.toLowerCase()));

  // Governance token suggestions
  if (type === 'governance') {
    suggestions.push('• You can **delegate** your voting power to yourself or a delegate');
    if (fns.has('vote') || fns.has('castvote')) {
      suggestions.push('• Check for active **governance proposals** to vote on');
    }
  }

  // Staking contract suggestions
  if (type === 'staking') {
    if (fns.has('earned') || fns.has('claimable') || fns.has('claimablereward')) {
      suggestions.push('• Check for **unclaimed rewards** from staking');
    }
    if (fns.has('stake')) {
      suggestions.push('• You can **stake** tokens for rewards');
    }
    if (fns.has('exit')) {
      suggestions.push('• Use **exit** to unstake and claim rewards in one transaction');
    }
  }

  // Vault suggestions
  if (type === 'vault') {
    suggestions.push('• This is a yield-bearing vault - your balance may increase over time');
    if (fns.has('deposit')) {
      suggestions.push('• You can **deposit** more assets to earn yield');
    }
    if (fns.has('withdraw') || fns.has('redeem')) {
      suggestions.push('• You can **withdraw** or **redeem** your position');
    }
  }

  // LP token suggestions
  if (type === 'lpToken') {
    suggestions.push('• This represents a liquidity position in an AMM pool');
    suggestions.push('• Check if there are **staking rewards** available for this LP');
  }

  // Vesting contract suggestions
  if (type === 'vesting') {
    if (fns.has('release') || fns.has('claim')) {
      suggestions.push('• Check if you have **vested tokens** ready to release');
    }
  }

  // Check for interesting functions regardless of type
  if (fns.has('claim') || fns.has('claimreward') || fns.has('getreward')) {
    if (!suggestions.some(s => s.includes('unclaimed'))) {
      suggestions.push('• This contract has a **claim** function - you may have rewards');
    }
  }

  // Related contracts suggestions
  if (analysis.relatedContracts?.length > 0) {
    const highRelevance = analysis.relatedContracts.filter((r: any) => r.relevance === 'high');
    if (highRelevance.length > 0) {
      suggestions.push(`• Found **${highRelevance.length} related contract(s)** that may offer additional actions`);
    }
  }

  return suggestions.length > 0 ? suggestions.join('\n') : null;
}
