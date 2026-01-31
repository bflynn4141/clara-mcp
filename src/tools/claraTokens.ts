/**
 * Clara Token Tools
 *
 * MCP tools for CCA auctions and staking revenue distributors:
 *
 * CCA Auctions:
 * - wallet_cca_bid: Bid on a CCA auction
 * - wallet_cca_exit: Exit an outbid position (reclaim ETH)
 * - wallet_cca_claim: Claim tokens after auction ends
 *
 * Staking:
 * - wallet_stake: Stake tokens to earn revenue
 * - wallet_unstake: Unstake tokens
 * - wallet_claim_dividends: Claim accumulated ETH revenue
 * - wallet_distribute_revenue: Deposit revenue for stakers (app owners)
 */

import { type Hex, parseEther } from 'viem';
import { getSession, touchSession } from '../storage/session.js';
import {
  getAuctionStatus,
  getBidInfo,
  encodeSubmitBid,
  encodeExitBid,
  encodeClaimTokens,
  getValidActions,
  decimalToQ96,
  getExplorerTxUrl as getCCAExplorerTxUrl,
  type SupportedCCAChain,
} from '../para/cca.js';
import {
  buildStakeBundle,
  buildUnstakeBundle,
  buildClaimBundle,
  buildDepositTransaction,
  getExplorerTxUrl as getStakingExplorerTxUrl,
  type SupportedStakingChain,
} from '../para/staking.js';
import { signAndSendTransaction } from '../para/transactions.js';

// ============================================================================
// Tool Definitions
// ============================================================================

export const ccaBidToolDefinition = {
  name: 'wallet_cca_bid',
  description: `Bid on a Uniswap CCA (Continuous Clearing Auction).

CCA is a fair token launch mechanism where price is discovered through continuous clearing.
You specify a maximum price and amount - if the clearing price ends up below your max,
you receive tokens at the clearing price.

**Example:**
\`\`\`json
{
  "auction": "0x1234...",
  "amount": "0.1",
  "maxPrice": "0.0001",
  "chain": "base"
}
\`\`\`

Returns estimated tokens and transaction confirmation.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      auction: {
        type: 'string',
        description: 'CCA auction contract address',
      },
      amount: {
        type: 'string',
        description: 'ETH amount to bid',
      },
      maxPrice: {
        type: 'string',
        description: 'Maximum price per token in ETH',
      },
      chain: {
        type: 'string',
        enum: ['base', 'ethereum'],
        default: 'base',
        description: 'Chain the auction is on',
      },
    },
    required: ['auction', 'amount', 'maxPrice'],
  },
};

export const ccaExitToolDefinition = {
  name: 'wallet_cca_exit',
  description: `Exit a bid position to reclaim your ETH.

Use when:
- Your bid has been outbid (price moved above your max)
- The auction failed (didn't graduate) - get a refund

**Example:**
\`\`\`json
{
  "auction": "0x1234...",
  "bidId": "42",
  "chain": "base"
}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      auction: {
        type: 'string',
        description: 'CCA auction contract address',
      },
      bidId: {
        type: 'string',
        description: 'Bid ID to exit',
      },
      chain: {
        type: 'string',
        enum: ['base', 'ethereum'],
        default: 'base',
        description: 'Chain the auction is on',
      },
    },
    required: ['auction', 'bidId'],
  },
};

export const ccaClaimToolDefinition = {
  name: 'wallet_cca_claim',
  description: `Claim tokens from a winning bid after the auction ends.

Requirements:
1. Auction must have ended
2. Auction must have graduated (met minimum raise)
3. Claim block must have been reached
4. Your bid must be filled (maxPrice >= clearing price)

**Example:**
\`\`\`json
{
  "auction": "0x1234...",
  "bidId": "42",
  "chain": "base"
}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      auction: {
        type: 'string',
        description: 'CCA auction contract address',
      },
      bidId: {
        type: 'string',
        description: 'Bid ID to claim tokens for',
      },
      chain: {
        type: 'string',
        enum: ['base', 'ethereum'],
        default: 'base',
        description: 'Chain the auction is on',
      },
    },
    required: ['auction', 'bidId'],
  },
};

export const stakeToolDefinition = {
  name: 'wallet_stake',
  description: `Stake tokens in a StakingRevenueDistributor to earn ETH revenue.

Staking earns you a proportional share of ETH revenue deposited by the app owner.
You can unstake at any time.

**Example:**
\`\`\`json
{
  "distributor": "0x1234...",
  "amount": "1000",
  "chain": "base"
}
\`\`\`

Handles token approval automatically.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      distributor: {
        type: 'string',
        description: 'StakingRevenueDistributor contract address',
      },
      amount: {
        type: 'string',
        description: 'Amount of tokens to stake',
      },
      chain: {
        type: 'string',
        enum: ['base', 'ethereum'],
        default: 'base',
        description: 'Chain the distributor is on',
      },
    },
    required: ['distributor', 'amount'],
  },
};

export const unstakeToolDefinition = {
  name: 'wallet_unstake',
  description: `Unstake tokens from a StakingRevenueDistributor.

Any pending revenue is automatically claimed when you unstake.

**Example:**
\`\`\`json
{
  "distributor": "0x1234...",
  "amount": "500",
  "chain": "base"
}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      distributor: {
        type: 'string',
        description: 'StakingRevenueDistributor contract address',
      },
      amount: {
        type: 'string',
        description: 'Amount of tokens to unstake',
      },
      chain: {
        type: 'string',
        enum: ['base', 'ethereum'],
        default: 'base',
        description: 'Chain the distributor is on',
      },
    },
    required: ['distributor', 'amount'],
  },
};

export const claimDividendsToolDefinition = {
  name: 'wallet_claim_dividends',
  description: `Claim your earned ETH revenue from staking.

**Example:**
\`\`\`json
{
  "distributor": "0x1234...",
  "chain": "base"
}
\`\`\`

Shows claimable amount and sends ETH to your wallet.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      distributor: {
        type: 'string',
        description: 'StakingRevenueDistributor contract address',
      },
      chain: {
        type: 'string',
        enum: ['base', 'ethereum'],
        default: 'base',
        description: 'Chain the distributor is on',
      },
    },
    required: ['distributor'],
  },
};

export const distributeRevenueToolDefinition = {
  name: 'wallet_distribute_revenue',
  description: `Deposit ETH revenue for token stakers (for app owners).

The deposited ETH is distributed proportionally to all staked token holders.

**Example:**
\`\`\`json
{
  "distributor": "0x1234...",
  "amount": "0.5",
  "chain": "base"
}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      distributor: {
        type: 'string',
        description: 'StakingRevenueDistributor contract address',
      },
      amount: {
        type: 'string',
        description: 'ETH amount to deposit as revenue',
      },
      chain: {
        type: 'string',
        enum: ['base', 'ethereum'],
        default: 'base',
        description: 'Chain the distributor is on',
      },
    },
    required: ['distributor', 'amount'],
  },
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get authenticated session with wallet info
 */
async function getAuthenticatedSession(): Promise<{ walletId: string; address: Hex } | { error: string }> {
  const session = await getSession();
  if (!session?.authenticated || !session.address || !session.walletId) {
    return { error: '❌ Wallet not configured. Run `wallet_setup` first.' };
  }

  await touchSession();
  return { walletId: session.walletId, address: session.address as Hex };
}

// ============================================================================
// CCA Tool Handlers
// ============================================================================

export async function handleCCABidRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const auction = args.auction as string;
  const amount = args.amount as string;
  const maxPrice = args.maxPrice as string;
  const chain = (args.chain as SupportedCCAChain) || 'base';

  if (!auction || !amount || !maxPrice) {
    return {
      content: [{ type: 'text', text: '❌ Required: auction, amount, maxPrice' }],
      isError: true,
    };
  }

  const sessionResult = await getAuthenticatedSession();
  if ('error' in sessionResult) {
    return { content: [{ type: 'text', text: sessionResult.error }], isError: true };
  }

  const { walletId, address } = sessionResult;

  try {
    // Check auction state
    const status = await getAuctionStatus(auction as Hex, chain);

    if (status.state !== 'active') {
      return {
        content: [{
          type: 'text',
          text: `❌ Cannot bid: Auction is ${status.state.replace('_', ' ')}.\n\n**Valid actions:** ${getValidActions(status.state).join(', ')}`,
        }],
        isError: true,
      };
    }

    // Encode and send transaction
    const amountWei = parseEther(amount);
    const maxPriceQ96 = decimalToQ96(maxPrice);
    const callData = encodeSubmitBid(maxPriceQ96, amountWei, address);

    const { txHash } = await signAndSendTransaction(walletId, {
      to: auction as Hex,
      value: amountWei,
      data: callData,
      chainId: chain === 'base' ? 8453 : 1,
    });

    // Estimate tokens at current clearing price
    const clearingPriceNum = parseFloat(status.clearingPriceEth);
    const estimatedTokens = clearingPriceNum > 0
      ? (parseFloat(amount) / clearingPriceNum).toFixed(2)
      : 'Unknown';

    return {
      content: [{
        type: 'text',
        text: `✅ **Bid Placed**

**Token:** ${status.tokenSymbol} (${status.tokenName})
**Amount:** ${amount} ETH
**Max Price:** ${maxPrice} ETH/token
**Estimated Tokens:** ~${estimatedTokens} (at current clearing price: ${status.clearingPriceEth})

[View Transaction](${getCCAExplorerTxUrl(chain, txHash)})

Use \`wallet_discover_tokens\` to track your bid status.`,
      }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true,
    };
  }
}

export async function handleCCAExitRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const auction = args.auction as string;
  const bidId = args.bidId as string;
  const chain = (args.chain as SupportedCCAChain) || 'base';

  if (!auction || !bidId) {
    return {
      content: [{ type: 'text', text: '❌ Required: auction, bidId' }],
      isError: true,
    };
  }

  const sessionResult = await getAuthenticatedSession();
  if ('error' in sessionResult) {
    return { content: [{ type: 'text', text: sessionResult.error }], isError: true };
  }

  const { walletId } = sessionResult;

  try {
    // Check bid status
    const bid = await getBidInfo(auction as Hex, bidId, chain);

    if (bid.isExited) {
      return {
        content: [{ type: 'text', text: '❌ This bid has already been exited.' }],
        isError: true,
      };
    }

    if (bid.status === 'active' || bid.status === 'filled') {
      return {
        content: [{
          type: 'text',
          text: `❌ Cannot exit: Bid is ${bid.status}.\n\nActive bids cannot be exited until outbid or auction fails.\nFilled bids should use \`wallet_cca_claim\` instead.`,
        }],
        isError: true,
      };
    }

    // Encode and send transaction
    const callData = encodeExitBid(bidId);
    const { txHash } = await signAndSendTransaction(walletId, {
      to: auction as Hex,
      value: 0n,
      data: callData,
      chainId: chain === 'base' ? 8453 : 1,
    });

    return {
      content: [{
        type: 'text',
        text: `✅ **Bid Exited**

**Bid ID:** ${bidId}
**ETH Returned:** ${bid.amountEth} ETH

[View Transaction](${getCCAExplorerTxUrl(chain, txHash)})`,
      }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true,
    };
  }
}

export async function handleCCAClaimRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const auction = args.auction as string;
  const bidId = args.bidId as string;
  const chain = (args.chain as SupportedCCAChain) || 'base';

  if (!auction || !bidId) {
    return {
      content: [{ type: 'text', text: '❌ Required: auction, bidId' }],
      isError: true,
    };
  }

  const sessionResult = await getAuthenticatedSession();
  if ('error' in sessionResult) {
    return { content: [{ type: 'text', text: sessionResult.error }], isError: true };
  }

  const { walletId, address } = sessionResult;

  try {
    // Check auction state
    const status = await getAuctionStatus(auction as Hex, chain);

    if (status.state !== 'ended_claimable') {
      let message = '❌ Cannot claim: ';
      switch (status.state) {
        case 'not_started':
          message += "Auction hasn't started yet.";
          break;
        case 'active':
          message += 'Auction is still active.';
          break;
        case 'ended_waiting':
          message += 'Waiting for claim block.';
          break;
        case 'failed_refundable':
          message += "Auction failed. Use `wallet_cca_exit` to get a refund.";
          break;
      }
      return { content: [{ type: 'text', text: message }], isError: true };
    }

    // Check bid status
    const bid = await getBidInfo(auction as Hex, bidId, chain);

    if (bid.status !== 'claimable' && bid.status !== 'filled') {
      return {
        content: [{
          type: 'text',
          text: `❌ Bid is not claimable. Status: ${bid.status}\n\n${bid.status === 'outbid' ? 'Use `wallet_cca_exit` to reclaim your ETH.' : ''}`,
        }],
        isError: true,
      };
    }

    // Encode and send transaction
    const callData = encodeClaimTokens(address, [bidId]);
    const { txHash } = await signAndSendTransaction(walletId, {
      to: auction as Hex,
      value: 0n,
      data: callData,
      chainId: chain === 'base' ? 8453 : 1,
    });

    return {
      content: [{
        type: 'text',
        text: `✅ **Tokens Claimed**

**Bid ID:** ${bidId}
**Tokens:** ${bid.tokensFilled} ${status.tokenSymbol}

[View Transaction](${getCCAExplorerTxUrl(chain, txHash)})

Your tokens have been sent to your wallet.`,
      }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true,
    };
  }
}

// ============================================================================
// Staking Tool Handlers
// ============================================================================

export async function handleStakeRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const distributor = args.distributor as string;
  const amount = args.amount as string;
  const chain = (args.chain as SupportedStakingChain) || 'base';

  if (!distributor || !amount) {
    return {
      content: [{ type: 'text', text: '❌ Required: distributor, amount' }],
      isError: true,
    };
  }

  const sessionResult = await getAuthenticatedSession();
  if ('error' in sessionResult) {
    return { content: [{ type: 'text', text: sessionResult.error }], isError: true };
  }

  const { walletId, address } = sessionResult;

  try {
    // Build transaction bundle
    const bundle = await buildStakeBundle(distributor as Hex, amount, address, chain);

    if (!bundle.simulationPassed) {
      return {
        content: [{
          type: 'text',
          text: `❌ Cannot stake:\n${bundle.warnings.map(w => `• ${w}`).join('\n')}`,
        }],
        isError: true,
      };
    }

    // Execute all transactions in bundle
    const txHashes: string[] = [];
    for (const tx of bundle.transactions) {
      const { txHash } = await signAndSendTransaction(walletId, {
        to: tx.to,
        value: tx.value,
        data: tx.data,
        chainId: chain === 'base' ? 8453 : 1,
      });
      txHashes.push(txHash);
    }

    const txLinks = txHashes.map(h => `• [${h.slice(0, 10)}...](${getStakingExplorerTxUrl(chain, h)})`).join('\n');

    return {
      content: [{
        type: 'text',
        text: `✅ **Staked ${amount} tokens**

**Transactions:**
${bundle.transactions.map((tx, i) => `${i + 1}. ${tx.description}`).join('\n')}

**Transaction Hashes:**
${txLinks}

Your tokens are now earning revenue! Use \`wallet_token_details\` to check your position.`,
      }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true,
    };
  }
}

export async function handleUnstakeRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const distributor = args.distributor as string;
  const amount = args.amount as string;
  const chain = (args.chain as SupportedStakingChain) || 'base';

  if (!distributor || !amount) {
    return {
      content: [{ type: 'text', text: '❌ Required: distributor, amount' }],
      isError: true,
    };
  }

  const sessionResult = await getAuthenticatedSession();
  if ('error' in sessionResult) {
    return { content: [{ type: 'text', text: sessionResult.error }], isError: true };
  }

  const { walletId, address } = sessionResult;

  try {
    const bundle = await buildUnstakeBundle(distributor as Hex, amount, address, chain);

    if (!bundle.simulationPassed) {
      return {
        content: [{
          type: 'text',
          text: `❌ Cannot unstake:\n${bundle.warnings.map(w => `• ${w}`).join('\n')}`,
        }],
        isError: true,
      };
    }

    const tx = bundle.transactions[0];
    const { txHash } = await signAndSendTransaction(walletId, {
      to: tx.to,
      value: tx.value,
      data: tx.data,
      chainId: chain === 'base' ? 8453 : 1,
    });

    return {
      content: [{
        type: 'text',
        text: `✅ **Unstaked ${amount} tokens**

[View Transaction](${getStakingExplorerTxUrl(chain, txHash)})

Any pending revenue was automatically claimed with your tokens.`,
      }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true,
    };
  }
}

export async function handleClaimDividendsRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const distributor = args.distributor as string;
  const chain = (args.chain as SupportedStakingChain) || 'base';

  if (!distributor) {
    return {
      content: [{ type: 'text', text: '❌ Required: distributor' }],
      isError: true,
    };
  }

  const sessionResult = await getAuthenticatedSession();
  if ('error' in sessionResult) {
    return { content: [{ type: 'text', text: sessionResult.error }], isError: true };
  }

  const { walletId, address } = sessionResult;

  try {
    const result = await buildClaimBundle(distributor as Hex, address, chain);

    if (result.claimableEth === '0' || parseFloat(result.claimableEth) === 0) {
      return {
        content: [{ type: 'text', text: 'No revenue to claim at this time.' }],
      };
    }

    const { txHash } = await signAndSendTransaction(walletId, {
      to: result.transaction.to,
      value: result.transaction.value,
      data: result.transaction.data,
      chainId: chain === 'base' ? 8453 : 1,
    });

    return {
      content: [{
        type: 'text',
        text: `✅ **Claimed ${result.claimableEth} ETH**

[View Transaction](${getStakingExplorerTxUrl(chain, txHash)})

The ETH has been sent to your wallet.`,
      }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true,
    };
  }
}

export async function handleDistributeRevenueRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const distributor = args.distributor as string;
  const amount = args.amount as string;
  const chain = (args.chain as SupportedStakingChain) || 'base';

  if (!distributor || !amount) {
    return {
      content: [{ type: 'text', text: '❌ Required: distributor, amount' }],
      isError: true,
    };
  }

  const sessionResult = await getAuthenticatedSession();
  if ('error' in sessionResult) {
    return { content: [{ type: 'text', text: sessionResult.error }], isError: true };
  }

  const { walletId } = sessionResult;

  try {
    const tx = buildDepositTransaction(distributor as Hex, amount);

    const { txHash } = await signAndSendTransaction(walletId, {
      to: tx.to,
      value: tx.value,
      data: tx.data,
      chainId: chain === 'base' ? 8453 : 1,
    });

    return {
      content: [{
        type: 'text',
        text: `✅ **Deposited ${amount} ETH as revenue**

[View Transaction](${getStakingExplorerTxUrl(chain, txHash)})

Token holders can now claim their share of this revenue.`,
      }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true,
    };
  }
}

// ============================================================================
// Router
// ============================================================================

export async function handleClaraTokenToolRequest(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean } | null> {
  switch (name) {
    case 'wallet_cca_bid':
      return await handleCCABidRequest(args);
    case 'wallet_cca_exit':
      return await handleCCAExitRequest(args);
    case 'wallet_cca_claim':
      return await handleCCAClaimRequest(args);
    case 'wallet_stake':
      return await handleStakeRequest(args);
    case 'wallet_unstake':
      return await handleUnstakeRequest(args);
    case 'wallet_claim_dividends':
      return await handleClaimDividendsRequest(args);
    case 'wallet_distribute_revenue':
      return await handleDistributeRevenueRequest(args);
    default:
      return null;
  }
}
