/**
 * wallet_opportunities - Find Yield Opportunities
 *
 * Wraps getYieldOpportunities() from yield.ts for MCP tool access.
 * Returns sorted yield opportunities from DeFiLlama.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getYieldOpportunities, type YieldChain } from '../services/yield.js';

const YIELD_CHAINS = ['base', 'ethereum', 'arbitrum', 'optimism'] as const;

export const opportunitiesToolDefinition: Tool = {
  name: 'wallet_opportunities',
  description: `Find yield opportunities for your assets.

Searches DeFiLlama for lending opportunities across supported protocols (Aave v3, Compound v3, Morpho).

**Examples:**
\`\`\`json
{"asset": "USDC"}
{"asset": "USDC", "chain": "base"}
{"asset": "ETH", "chain": "ethereum"}
\`\`\`

Returns opportunities sorted by APY (highest first) with protocol name, chain, APY breakdown, and TVL.`,
  inputSchema: {
    type: 'object',
    properties: {
      asset: {
        type: 'string',
        description: 'Token symbol to find opportunities for (e.g., "USDC", "ETH", "WETH")',
      },
      chain: {
        type: 'string',
        enum: YIELD_CHAINS,
        description: 'Filter to a specific chain (optional, searches all if omitted)',
      },
    },
    required: ['asset'],
  },
};

export async function handleOpportunitiesRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const asset = args.asset as string;
  const chain = args.chain as YieldChain | undefined;

  if (!asset) {
    return {
      content: [{ type: 'text', text: '❌ Missing required parameter: asset' }],
      isError: true,
    };
  }

  try {
    const chains = chain ? [chain] : undefined;
    const opportunities = await getYieldOpportunities(asset, { chains });

    if (opportunities.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No yield opportunities found for ${asset.toUpperCase()}${chain ? ` on ${chain}` : ''}.`,
        }],
      };
    }

    // Build markdown display
    const lines: string[] = [
      `## 💰 Yield Opportunities: ${asset.toUpperCase()}${chain ? ` on ${chain}` : ''}`,
      '',
      `Found ${opportunities.length} opportunities (sorted by APY):`,
      '',
      '| # | Protocol | Chain | APY | Base APY | Reward APY | TVL |',
      '|---|----------|-------|-----|----------|------------|-----|',
    ];

    for (let i = 0; i < opportunities.length; i++) {
      const o = opportunities[i];
      const tvl = o.tvlUsd >= 1e9 ? `$${(o.tvlUsd / 1e9).toFixed(1)}B` :
                  o.tvlUsd >= 1e6 ? `$${(o.tvlUsd / 1e6).toFixed(1)}M` :
                  `$${o.tvlUsd.toFixed(0)}`;
      lines.push(
        `| ${i + 1} | ${o.project} | ${o.chain} | ${o.apy.toFixed(2)}% | ${o.apyBase.toFixed(2)}% | ${o.apyReward.toFixed(2)}% | ${tvl} |`
      );
    }

    // Add structured JSON data
    lines.push('');
    lines.push('---');
    lines.push('```json');
    lines.push(JSON.stringify({
      asset: asset.toUpperCase(),
      chain: chain || 'all',
      count: opportunities.length,
      opportunities: opportunities.map(o => ({
        protocol: o.project,
        chain: o.chain,
        symbol: o.symbol,
        apy: o.apy,
        apyBase: o.apyBase,
        apyReward: o.apyReward,
        tvlUsd: o.tvlUsd,
        pool: o.pool,
      })),
    }, null, 2));
    lines.push('```');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Failed to fetch yield opportunities: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
