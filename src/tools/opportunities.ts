/**
 * wallet_opportunities - Find Yield & Protocol Action Opportunities
 *
 * Three data sources:
 * 1. DeFiLlama yields (lending APYs) — always available
 * 2. Herd protocol actions (vote escrow, staking, liquidity) — when token address known
 * 3. NFT position detection (via RPC) — checks if user has positions in action contracts
 *
 * Auto-resolves tokenAddress from wallet holdings when not provided.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getYieldOpportunities, type YieldChain } from '../services/yield.js';
import {
  getTokenActions,
  ACTION_LABELS,
  type TokenActionsResult,
} from '../services/token-actions.js';
import { checkNFTPositions, type NFTPosition } from '../services/nft-positions.js';
import type { SupportedChain } from '../config/chains.js';
import { getProviderRegistry } from '../providers/index.js';
import { isProvidersInitialized } from '../providers/index.js';

const YIELD_CHAINS = ['base', 'ethereum', 'arbitrum', 'optimism'] as const;

export const opportunitiesToolDefinition: Tool = {
  name: 'wallet_opportunities',
  description: `Find yield opportunities and protocol-native actions for your assets.

Searches DeFiLlama for lending yields AND analyzes on-chain data (via Herd) for protocol actions like vote escrow, staking, and liquidity provision.

**Examples:**
\`\`\`json
{"asset": "USDC"}
{"asset": "USDC", "chain": "base"}
{"asset": "AERO", "chain": "base"}
{"asset": "AERO", "chain": "base", "tokenAddress": "0x940181a94A35A4569E4529A3CDfB74e38FD98631"}
\`\`\`

If \`tokenAddress\` is provided (or can be resolved from your wallet holdings), also returns protocol-native actions (vote escrow, staking, liquidity, governance) and detects existing NFT positions.

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
      tokenAddress: {
        type: 'string',
        description: 'Token contract address for protocol action discovery (optional). Auto-resolved from wallet holdings if omitted.',
      },
      walletAddress: {
        type: 'string',
        description: 'Wallet address for NFT position detection (optional). Used to check if you already have positions in detected action contracts.',
      },
    },
    required: ['asset'],
  },
};

/**
 * Try to resolve a token address from wallet holdings via TokenDiscovery provider.
 * Returns undefined if not found or providers not ready.
 */
async function resolveTokenAddress(
  symbol: string,
  chain: SupportedChain,
): Promise<{ address: string; walletAddress: string } | undefined> {
  if (!isProvidersInitialized()) return undefined;

  const registry = getProviderRegistry();
  if (!registry.hasCapability('TokenDiscovery', chain)) return undefined;

  // We need the wallet address to query holdings — check for the session
  // This is a best-effort lookup; if wallet isn't set up, skip silently
  try {
    // Import getActiveSession dynamically to avoid circular deps
    const { getSession } = await import('../storage/session.js');
    const session = await getSession();
    if (!session?.address) return undefined;

    const walletAddress = session.address;
    const result = await registry.discoverTokens(walletAddress, chain);
    if (!result.success || !result.data) return undefined;

    // Find matching token by symbol (case-insensitive)
    const upperSymbol = symbol.toUpperCase();
    const match = result.data.balances.find(
      b => b.symbol.toUpperCase() === upperSymbol && b.address !== 'native'
    );

    if (match) {
      return { address: match.address, walletAddress };
    }
  } catch (err) {
    console.warn('[opportunities] Token auto-resolve failed:', err instanceof Error ? err.message : err);
  }

  return undefined;
}

/**
 * Try to get the connected wallet address from session.
 * Best-effort — returns undefined if no session.
 */
async function resolveWalletAddress(): Promise<string | undefined> {
  try {
    const { getSession } = await import('../storage/session.js');
    const session = await getSession();
    return session?.address || undefined;
  } catch (err) {
    console.warn('[opportunities] Failed to resolve wallet address from session:', err instanceof Error ? err.message : err);
    return undefined;
  }
}

export async function handleOpportunitiesRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const asset = args.asset as string;
  const chain = args.chain as YieldChain | undefined;
  let tokenAddress = args.tokenAddress as string | undefined;
  let walletAddress = args.walletAddress as string | undefined;

  if (!asset) {
    return {
      content: [{ type: 'text', text: '❌ Missing required parameter: asset' }],
      isError: true,
    };
  }

  try {
    // Auto-resolve tokenAddress if not provided
    let autoResolved = false;
    if (!tokenAddress && chain) {
      const resolved = await resolveTokenAddress(asset, chain as SupportedChain);
      if (resolved) {
        tokenAddress = resolved.address;
        walletAddress = walletAddress || resolved.walletAddress;
        autoResolved = true;
      }
    }

    // Fetch yields and protocol actions in parallel
    const chains = chain ? [chain] : undefined;
    const [opportunities, actionsResult] = await Promise.all([
      getYieldOpportunities(asset, { chains }),
      tokenAddress && chain
        ? getTokenActions(tokenAddress, chain as SupportedChain, asset)
        : Promise.resolve({ actions: [], source: 'unavailable', holdersAnalyzed: 0, tokenAddress: '', chain: (chain || 'base') as SupportedChain } as TokenActionsResult),
    ]);

    const protocolActions = actionsResult.actions;

    // Check NFT positions on action contracts (if wallet address known)
    let nftPositions: NFTPosition[] = [];
    if (walletAddress && protocolActions.length > 0 && chain) {
      const nftContracts = protocolActions.map(a => ({
        address: a.contractAddress,
        name: a.contractName,
        protocol: a.protocol,
        actionType: a.type,
      }));
      nftPositions = await checkNFTPositions(walletAddress, nftContracts, chain as SupportedChain);
    }

    const hasYields = opportunities.length > 0;
    const hasActions = protocolActions.length > 0;

    if (!hasYields && !hasActions) {
      const tips: string[] = [];
      if (!tokenAddress) {
        tips.push('Pass `tokenAddress` to also discover protocol-native actions (staking, vote escrow, etc.).');
      }
      if (actionsResult.source === 'unavailable') {
        tips.push('Herd provider not available for this chain.');
      } else if (actionsResult.holdersAnalyzed === 0 && tokenAddress) {
        tips.push('No top holder data available for this token.');
      }
      return {
        content: [{
          type: 'text',
          text: `No opportunities found for ${asset.toUpperCase()}${chain ? ` on ${chain}` : ''}.${
            tips.length > 0 ? '\n\n💡 ' + tips.join(' ') : ''
          }`,
        }],
      };
    }

    // Build markdown display
    const lines: string[] = [
      `## 💰 Opportunities: ${asset.toUpperCase()}${chain ? ` on ${chain}` : ''}`,
      '',
    ];

    // ── Section 1: Lending Yields ──
    if (hasYields) {
      lines.push(`### Lending`);
      lines.push('');
      lines.push(`Found ${opportunities.length} yield opportunities (sorted by APY):`);
      lines.push('');
      lines.push('| # | Protocol | Chain | APY | Base APY | Reward APY | TVL |');
      lines.push('|---|----------|-------|-----|----------|------------|-----|');

      for (let i = 0; i < opportunities.length; i++) {
        const o = opportunities[i];
        const tvl = o.tvlUsd >= 1e9 ? `$${(o.tvlUsd / 1e9).toFixed(1)}B` :
                    o.tvlUsd >= 1e6 ? `$${(o.tvlUsd / 1e6).toFixed(1)}M` :
                    `$${o.tvlUsd.toFixed(0)}`;
        lines.push(
          `| ${i + 1} | ${o.project} | ${o.chain} | ${o.apy.toFixed(2)}% | ${o.apyBase.toFixed(2)}% | ${o.apyReward.toFixed(2)}% | ${tvl} |`
        );
      }
    } else {
      lines.push(`### Lending`);
      lines.push('');
      lines.push(`No lending opportunities found for ${asset.toUpperCase()}.`);
    }

    // ── Section 2: Protocol Actions ──
    if (hasActions) {
      lines.push('');
      lines.push(`### Protocol Actions (via Herd)`);
      lines.push('');
      lines.push(`Found ${protocolActions.length} protocol-native actions (analyzed ${actionsResult.holdersAnalyzed} top holders):`);
      lines.push('');
      lines.push('| # | Action | Protocol | Contract | Supply Locked | Confidence | Your Position |');
      lines.push('|---|--------|----------|----------|---------------|------------|---------------|');

      for (let i = 0; i < protocolActions.length; i++) {
        const a = protocolActions[i];
        const shortAddr = `${a.contractAddress.slice(0, 6)}...${a.contractAddress.slice(-4)}`;
        const nft = nftPositions.find(n => n.contractAddress.toLowerCase() === a.contractAddress.toLowerCase());
        const positionStr = nft ? `✅ ${nft.balance} NFT${nft.balance > 1 ? 's' : ''}` : '—';
        lines.push(
          `| ${i + 1} | ${ACTION_LABELS[a.type]} | ${a.protocol || '—'} | ${shortAddr} | ${a.sharePercentage.toFixed(2)}% | ${a.confidence} | ${positionStr} |`
        );
      }

      // Add context for the top action
      const top = protocolActions[0];
      lines.push('');
      lines.push(`💡 **${ACTION_LABELS[top.type]}** (${top.sharePercentage.toFixed(2)}% of supply): ${top.description}.`);

      // Show existing positions
      if (nftPositions.length > 0) {
        lines.push('');
        lines.push(`📍 **Your positions:** You hold NFTs in ${nftPositions.map(n => `${n.contractName} (${n.balance})`).join(', ')}.`);
      }
    } else if (tokenAddress) {
      lines.push('');
      lines.push(`### Protocol Actions`);
      lines.push('');
      if (actionsResult.holdersAnalyzed > 0) {
        lines.push(`Analyzed ${actionsResult.holdersAnalyzed} top holders — no actionable protocol contracts detected.`);
      } else {
        lines.push(`No protocol-native actions detected for ${asset.toUpperCase()}.`);
      }
    }

    // ── Auto-resolve note ──
    if (autoResolved && tokenAddress) {
      lines.push('');
      lines.push(`> 📎 Token address auto-resolved from wallet holdings: \`${tokenAddress}\``);
    }

    // ── Structured JSON ──
    lines.push('');
    lines.push('---');
    lines.push('```json');
    lines.push(JSON.stringify({
      asset: asset.toUpperCase(),
      chain: chain || 'all',
      tokenAddress: tokenAddress || null,
      autoResolved,
      yields: {
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
      },
      protocolActions: {
        source: actionsResult.source,
        holdersAnalyzed: actionsResult.holdersAnalyzed,
        actions: protocolActions.map(a => ({
          type: a.type,
          contractAddress: a.contractAddress,
          contractName: a.contractName,
          protocol: a.protocol,
          description: a.description,
          sharePercentage: a.sharePercentage,
          confidence: a.confidence,
        })),
      },
      nftPositions: nftPositions.map(n => ({
        contractAddress: n.contractAddress,
        contractName: n.contractName,
        balance: n.balance,
        protocol: n.protocol,
        positionType: n.positionType,
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
        text: `❌ Failed to fetch opportunities: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
