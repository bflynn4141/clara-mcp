/**
 * Send Tool
 *
 * Send native tokens or ERC-20 tokens to an address.
 * Requires user approval for all transactions.
 */

import {
  parseUnits,
  encodeFunctionData,
  type Hex,
} from 'viem';
import { getSession, touchSession } from '../storage/session.js';
import { signAndSendTransaction } from '../para/transactions.js';
import {
  CHAINS,
  getExplorerTxUrl,
  isSupportedChain,
  type SupportedChain,
} from '../config/chains.js';
import { resolveToken } from '../config/tokens.js';

/**
 * Tool definition for wallet_send
 */
export const sendToolDefinition = {
  name: 'wallet_send',
  description: `Send native tokens or ERC-20 tokens to an address.

**Examples:**
- Send ETH: \`{"to": "0x...", "amount": "0.01", "chain": "base"}\`
- Send USDC: \`{"to": "0x...", "amount": "10", "chain": "base", "token": "USDC"}\`

Supported tokens: USDC, USDT, DAI, WETH (or provide contract address).

⚠️ This tool sends real money. Double-check the recipient address.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: {
        type: 'string',
        description: 'Recipient address (0x...)',
      },
      amount: {
        type: 'string',
        description: 'Amount to send in human units (e.g., "0.1" for 0.1 ETH, "100" for 100 USDC)',
      },
      chain: {
        type: 'string',
        enum: ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'],
        default: 'base',
        description: 'Blockchain to send on (default: base)',
      },
      token: {
        type: 'string',
        description: 'Token symbol (USDC, USDT, DAI, WETH) or contract address. Omit for native token.',
      },
    },
    required: ['to', 'amount'],
  },
};

/**
 * ERC-20 transfer ABI
 */
const ERC20_TRANSFER_ABI = [
  {
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

/**
 * Handle wallet_send requests
 */
export async function handleSendRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const to = args.to as string;
  const amount = args.amount as string;
  const chainName = (args.chain as string) || 'base';
  const tokenInput = args.token as string | undefined;

  // Validate inputs
  if (!to || !to.startsWith('0x') || to.length !== 42) {
    return {
      content: [{ type: 'text', text: '❌ Invalid recipient address. Must be a valid 0x address.' }],
      isError: true,
    };
  }

  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return {
      content: [{ type: 'text', text: '❌ Invalid amount. Must be a positive number.' }],
      isError: true,
    };
  }

  if (!isSupportedChain(chainName)) {
    return {
      content: [{
        type: 'text',
        text: `❌ Unsupported chain: ${chainName}\n\nSupported: base, ethereum, arbitrum, optimism, polygon`,
      }],
      isError: true,
    };
  }

  // Check session
  const session = await getSession();
  if (!session?.authenticated || !session.walletId || !session.address) {
    return {
      content: [{ type: 'text', text: '❌ Wallet not configured. Run `wallet_setup` first.' }],
      isError: true,
    };
  }

  await touchSession();

  const chainConfig = CHAINS[chainName];
  const fromAddress = session.address as Hex;

  try {
    let txHash: Hex;
    let symbol: string;
    let sentAmount: string;

    if (tokenInput) {
      // ERC-20 transfer
      const token = resolveToken(tokenInput, chainName);
      if (!token) {
        return {
          content: [{
            type: 'text',
            text: `❌ Unknown token: ${tokenInput}\n\nSupported: USDC, USDT, DAI, WETH (or provide contract address)`,
          }],
          isError: true,
        };
      }

      symbol = token.symbol;
      sentAmount = amount;

      // Parse amount with correct decimals
      const amountWei = parseUnits(amount, token.decimals);

      // Encode transfer call
      const data = encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [to as Hex, amountWei],
      });

      // Send to token contract with transfer data
      const result = await signAndSendTransaction(session.walletId, {
        to: token.address,
        value: 0n,
        data,
        chainId: chainConfig.chainId,
      });

      txHash = result.txHash;
    } else {
      // Native token transfer
      symbol = chainConfig.nativeSymbol;
      sentAmount = amount;

      // Parse amount to wei
      const amountWei = parseUnits(amount, 18);

      const result = await signAndSendTransaction(session.walletId, {
        to: to as Hex,
        value: amountWei,
        chainId: chainConfig.chainId,
      });

      txHash = result.txHash;
    }

    // Success response
    const explorerUrl = getExplorerTxUrl(chainName, txHash);

    return {
      content: [{
        type: 'text',
        text: [
          `✅ Transaction sent!`,
          '',
          `**Amount:** ${sentAmount} ${symbol}`,
          `**To:** \`${to}\``,
          `**Chain:** ${chainName}`,
          `**From:** \`${fromAddress}\``,
          '',
          `**Transaction:** [${txHash.slice(0, 10)}...${txHash.slice(-8)}](${explorerUrl})`,
        ].join('\n'),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Send failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
