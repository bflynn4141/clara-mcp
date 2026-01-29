/**
 * Token Discovery Tools
 *
 * MCP tools for discovering Clara ecosystem tokens:
 * - wallet_discover_tokens: Find active CCA auctions and staking opportunities
 * - wallet_token_details: Deep dive into a specific token's metrics
 *
 * These tools help users find and evaluate tokens deployed through Clara:
 * - Active CCA auctions to participate in token sales
 * - Staking distributors with yield opportunities
 * - APY calculations and payback period estimates
 *
 * @see https://docs.clara.xyz/discovery
 */

import { z } from 'zod';
import {
  discoverTokens,
  type DiscoveryFilter,
  type DiscoverySortBy,
  type EnrichedAuction,
  type EnrichedDistributor,
  type SupportedChain,
} from '../para/tokenDiscovery.js';
import { formatUSD, formatAPY, formatPayback } from '../para/apy.js';

// ============================================================================
// Input Validation Schemas
// ============================================================================

const discoverTokensInputSchema = z.object({
  filter: z.enum(['all', 'auctions', 'staking']).default('all'),
  chain: z.enum(['base', 'ethereum']).default('base'),
  sortBy: z.enum(['apy', 'tvl', 'recent']).default('apy'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const tokenDetailsInputSchema = z.object({
  token: z.string().min(1, 'Token address or symbol is required'),
  chain: z.enum(['base', 'ethereum']).default('base'),
});

/**
 * Tool definition for wallet_discover_tokens
 */
export const discoverTokensToolDefinition = {
  name: 'wallet_discover_tokens',
  description: `Discover Clara ecosystem tokens with active opportunities.

**Use cases:**
• Find live CCA auctions to bid on
• Find staking opportunities with yield
• Compare APY across tokens
• Assess payback periods

**Filters:**
• \`all\` - Show auctions AND staking (default)
• \`auctions\` - Only live/claimable CCA auctions
• \`staking\` - Only tokens with revenue distribution

**Sort options:**
• \`apy\` - Highest estimated APY first (default)
• \`tvl\` - Highest total value locked first
• \`recent\` - Most recently created first

**Example:**
\`\`\`json
{
  "filter": "staking",
  "sortBy": "apy",
  "chain": "base",
  "limit": 5
}
\`\`\`

Returns markdown tables with token metrics and participation commands.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      filter: {
        type: 'string',
        enum: ['all', 'auctions', 'staking'],
        default: 'all',
        description: 'Filter by opportunity type',
      },
      chain: {
        type: 'string',
        enum: ['base', 'ethereum'],
        default: 'base',
        description: 'Blockchain to scan',
      },
      sortBy: {
        type: 'string',
        enum: ['apy', 'tvl', 'recent'],
        default: 'apy',
        description: 'Sort order for results',
      },
      limit: {
        type: 'number',
        default: 10,
        description: 'Maximum number of results per category',
      },
    },
  },
};

/**
 * Format auction status with emoji
 */
function formatAuctionStatus(status: string): string {
  switch (status) {
    case 'live':
      return '🟢 Live';
    case 'claimable':
      return '🟡 Claiming';
    case 'graduated':
      return '✅ Graduated';
    case 'ended':
      return '⚪ Ended';
    default:
      return status;
  }
}

/**
 * Format auction row for markdown table
 */
function formatAuctionRow(auction: EnrichedAuction): string {
  const status = formatAuctionStatus(auction.status);
  const price = formatUSD(auction.priceUSD);
  const raised = formatUSD(auction.raisedUSD);
  const revenue = auction.hasDistributor && auction.revenueUSD ? formatUSD(auction.revenueUSD) : '—';
  const apy =
    auction.hasDistributor && auction.estimatedAPY ? formatAPY(auction.estimatedAPY) : '—';
  const endsIn = auction.endsIn;

  return `| ${auction.tokenSymbol} | ${status} | ${price} | ${raised} | ${revenue} | ${apy} | ${endsIn} |`;
}

/**
 * Format distributor row for markdown table
 */
function formatDistributorRow(dist: EnrichedDistributor): string {
  const tvl = formatUSD(dist.tvlUSD);
  const revenue = formatUSD(dist.revenueUSD);
  const apy = formatAPY(dist.estimatedAPY);
  const payback = formatPayback(dist.paybackYears);

  return `| ${dist.tokenSymbol} | ${tvl} | ${revenue} | ${apy} | ${payback} |`;
}

/**
 * Handle wallet_discover_tokens requests
 */
export async function handleDiscoverTokensRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  // Validate and normalize inputs with zod
  const parseResult = discoverTokensInputSchema.safeParse(args);

  if (!parseResult.success) {
    const errorMessages = parseResult.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join(', ');
    return {
      content: [{ type: 'text', text: `❌ Invalid input: ${errorMessages}` }],
      isError: true,
    };
  }

  const { filter, chain, sortBy, limit } = parseResult.data;

  try {
    const result = await discoverTokens(chain, filter, sortBy, limit);

    const lines: string[] = [
      '## 🔍 Clara Token Discovery',
      '',
      `*ETH Price: ${formatUSD(result.ethPriceUSD)} | Chain: ${chain.charAt(0).toUpperCase() + chain.slice(1)}*`,
      '',
    ];

    // Auctions section
    if (filter !== 'staking') {
      if (result.auctions.length > 0) {
        lines.push(`### Active Auctions (${result.auctions.length} found)`);
        lines.push('');
        lines.push('| Token | Status | Price (USD) | Raised (USD) | Revenue (USD) | Est. APY | Ends In |');
        lines.push('|-------|--------|-------------|--------------|---------------|----------|---------|');

        for (const auction of result.auctions) {
          lines.push(formatAuctionRow(auction));
        }

        lines.push('');
        lines.push('*Note: Revenue/APY shown when token has an active staking distributor*');
        lines.push('');
      } else {
        lines.push('### Active Auctions');
        lines.push('');
        lines.push('No active CCA auctions found.');
        lines.push('');
      }
    }

    // Staking section
    if (filter !== 'auctions') {
      if (result.distributors.length > 0) {
        lines.push(`### Staking Opportunities (${result.distributors.length} found)`);
        lines.push('');
        lines.push('| Token | TVL (USD) | Revenue (USD) | Est. APY | Payback |');
        lines.push('|-------|-----------|---------------|----------|---------|');

        for (const dist of result.distributors) {
          lines.push(formatDistributorRow(dist));
        }

        lines.push('');
      } else {
        lines.push('### Staking Opportunities');
        lines.push('');
        lines.push('No active staking distributors found.');
        lines.push('');
      }
    }

    // Participation commands
    lines.push('---');
    lines.push('');
    lines.push('**To participate:**');
    lines.push('');

    if (filter !== 'staking' && result.auctions.length > 0) {
      const exampleAuction = result.auctions[0];
      lines.push(
        `• Bid on auction: \`wallet_auction_bid auction="${exampleAuction.auctionAddress}" amount="0.1" maxPrice="0.002"\``
      );
    }

    if (filter !== 'auctions' && result.distributors.length > 0) {
      const exampleDist = result.distributors[0];
      lines.push(
        `• Stake tokens: \`wallet_stake token="${exampleDist.tokenSymbol}" amount="1000"\``
      );
    }

    lines.push('');
    lines.push('*Use `wallet_token_details` for deep dive on any token*');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    console.error('Token discovery error:', error);

    return {
      content: [
        {
          type: 'text',
          text: `❌ Failed to discover tokens: ${error instanceof Error ? error.message : 'Unknown error'}\n\nThis might be a temporary RPC issue. Try again in a moment.`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Tool definition for wallet_token_details
 */
export const tokenDetailsToolDefinition = {
  name: 'wallet_token_details',
  description: `Get detailed information about a specific Clara ecosystem token.

**Returns:**
• Token info (name, symbol, supply, holders)
• Auction history (if any)
• Staking stats (TVL, revenue, APY breakdown)
• Revenue history over time
• Commands to participate

**Example:**
\`\`\`json
{
  "token": "0x1234...",
  "chain": "base"
}
\`\`\`

You can also use the token symbol if it's unique.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      token: {
        type: 'string',
        description: 'Token address or symbol',
      },
      chain: {
        type: 'string',
        enum: ['base', 'ethereum'],
        default: 'base',
        description: 'Blockchain network',
      },
    },
    required: ['token'],
  },
};

/**
 * Handle wallet_token_details requests
 */
export async function handleTokenDetailsRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  // Validate and normalize inputs with zod
  const parseResult = tokenDetailsInputSchema.safeParse(args);

  if (!parseResult.success) {
    const errorMessages = parseResult.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join(', ');
    return {
      content: [{ type: 'text', text: `❌ Invalid input: ${errorMessages}` }],
      isError: true,
    };
  }

  const { token, chain } = parseResult.data;

  // Scan ALL tokens (including inactive) to find the requested one
  // This ensures we can find ended auctions and new tokens without staking
  try {
    const result = await discoverTokens(chain, 'all', 'apy', 100, true /* includeInactive */);

    // Search by symbol or address
    const tokenLower = token.toLowerCase();
    const matchingAuction = result.auctions.find(
      (a) =>
        a.tokenSymbol.toLowerCase() === tokenLower ||
        a.tokenAddress.toLowerCase() === tokenLower
    );

    const matchingDistributor = result.distributors.find(
      (d) =>
        d.tokenSymbol.toLowerCase() === tokenLower ||
        d.tokenAddress.toLowerCase() === tokenLower
    );

    if (!matchingAuction && !matchingDistributor) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Token "${token}" not found in Clara ecosystem on ${chain}.\n\nMake sure the token was launched through Clara's CCA or has a staking distributor.\n\nUse \`wallet_discover_tokens\` to see all available tokens.`,
          },
        ],
        isError: true,
      };
    }

    const lines: string[] = [];

    if (matchingAuction) {
      lines.push(`## 📊 ${matchingAuction.tokenName} (${matchingAuction.tokenSymbol})`);
      lines.push('');
      lines.push(`**Token Address:** \`${matchingAuction.tokenAddress}\``);
      lines.push(`**Chain:** ${chain.charAt(0).toUpperCase() + chain.slice(1)}`);
      lines.push('');
      lines.push('### CCA Auction');
      lines.push('');
      lines.push(`| Metric | Value |`);
      lines.push(`|--------|-------|`);
      lines.push(`| Status | ${formatAuctionStatus(matchingAuction.status)} |`);
      lines.push(`| Clearing Price | ${formatUSD(matchingAuction.priceUSD)} |`);
      lines.push(`| Total Raised | ${formatUSD(matchingAuction.raisedUSD)} |`);
      lines.push(`| Graduated | ${matchingAuction.graduated ? 'Yes ✅' : 'No'} |`);
      lines.push(`| Ends | ${matchingAuction.endsIn} |`);
      lines.push(`| Auction Contract | \`${matchingAuction.auctionAddress}\` |`);
      lines.push('');
    }

    if (matchingDistributor) {
      if (!matchingAuction) {
        lines.push(`## 📊 ${matchingDistributor.tokenName} (${matchingDistributor.tokenSymbol})`);
        lines.push('');
        lines.push(`**Token Address:** \`${matchingDistributor.tokenAddress}\``);
        lines.push(`**Chain:** ${chain.charAt(0).toUpperCase() + chain.slice(1)}`);
        lines.push('');
      }

      lines.push('### Staking Distribution');
      lines.push('');
      lines.push(`| Metric | Value |`);
      lines.push(`|--------|-------|`);
      lines.push(`| Total Staked | ${matchingDistributor.totalStakedFormatted} tokens |`);
      lines.push(`| TVL | ${formatUSD(matchingDistributor.tvlUSD)} |`);
      lines.push(`| Total Revenue | ${formatUSD(matchingDistributor.revenueUSD)} |`);
      lines.push(`| Estimated APY | ${formatAPY(matchingDistributor.estimatedAPY)} |`);
      lines.push(`| Payback Period | ${formatPayback(matchingDistributor.paybackYears)} |`);
      lines.push(`| Distributor Contract | \`${matchingDistributor.distributorAddress}\` |`);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
    lines.push('**Actions:**');

    if (matchingAuction && matchingAuction.status === 'live') {
      lines.push(
        `• Bid: \`wallet_auction_bid auction="${matchingAuction.auctionAddress}" amount="0.1"\``
      );
    }

    if (matchingDistributor) {
      lines.push(
        `• Stake: \`wallet_stake token="${matchingDistributor.tokenSymbol}" amount="1000"\``
      );
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    console.error('Token details error:', error);

    return {
      content: [
        {
          type: 'text',
          text: `❌ Failed to get token details: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Handle token discovery tool requests
 */
export async function handleTokenToolRequest(
  name: string,
  args: Record<string, unknown> | undefined
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean } | null> {
  const safeArgs = args || {};

  if (name === 'wallet_discover_tokens') {
    return await handleDiscoverTokensRequest(safeArgs);
  }

  if (name === 'wallet_token_details') {
    return await handleTokenDetailsRequest(safeArgs);
  }

  return null;
}
