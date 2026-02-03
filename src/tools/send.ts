/**
 * Send Tool
 *
 * Send native tokens or ERC-20 tokens to an address.
 * Requires user approval for all transactions.
 */

import {
  parseUnits,
  encodeFunctionData,
  createPublicClient,
  http,
  type Hex,
} from 'viem';
import { getSession, touchSession } from '../storage/session.js';
import { signAndSendTransaction } from '../para/transactions.js';
import {
  CHAINS,
  getExplorerTxUrl,
  getRpcUrl,
  isSupportedChain,
  type SupportedChain,
} from '../config/chains.js';
import { resolveToken } from '../config/tokens.js';
import { assessContractRisk, formatRiskAssessment, quickSafeCheck } from '../services/risk.js';

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
      forceUnsafe: {
        type: 'boolean',
        default: false,
        description: 'Override risk assessment warnings and send anyway. Use with caution.',
      },
    },
    required: ['to', 'amount'],
  },
};

/**
 * Check if address is a contract (has code)
 */
async function isContract(address: string, chain: SupportedChain): Promise<boolean> {
  try {
    const chainConfig = CHAINS[chain];
    const client = createPublicClient({
      chain: chainConfig.chain,
      transport: http(getRpcUrl(chain)),
    });

    const code = await client.getCode({ address: address as Hex });
    return code !== undefined && code !== '0x' && code.length > 2;
  } catch {
    return false;
  }
}

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
  const forceUnsafe = args.forceUnsafe as boolean | undefined;

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
    // -------------------------------------------------------------------------
    // Risk Assessment (for contract recipients)
    // -------------------------------------------------------------------------
    let riskWarnings: string[] = [];

    // Check if recipient is a contract (not sending tokens via ERC-20)
    if (!tokenInput) {
      const recipientIsContract = await isContract(to, chainName);

      if (recipientIsContract) {
        // Quick check for known safe addresses
        if (!quickSafeCheck(to, chainName)) {
          // Full risk assessment for unknown contracts
          const assessment = await assessContractRisk(to, chainName);

          if (assessment.recommendation === 'avoid') {
            // CRITICAL: Block sends to high-risk contracts unless explicitly overridden
            if (!forceUnsafe) {
              const warnings = formatRiskAssessment(assessment);
              return {
                content: [{
                  type: 'text',
                  text: [
                    '🚫 **Transaction Blocked - High Risk Detected**',
                    '',
                    'This contract has been flagged as potentially dangerous:',
                    '',
                    ...warnings,
                    '',
                    '---',
                    '',
                    'To proceed anyway, add `"forceUnsafe": true` to your request.',
                    '⚠️ **This may result in loss of funds.**',
                  ].join('\n'),
                }],
                isError: true,
              };
            }
            // User explicitly overrode - add warnings but proceed
            riskWarnings = ['⚠️ **RISK OVERRIDE ENABLED** - Proceeding despite high-risk assessment', ...formatRiskAssessment(assessment)];
          } else if (assessment.recommendation === 'caution') {
            riskWarnings = formatRiskAssessment(assessment);
          }
        }
      }
    }

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

    const lines = [
      `✅ Transaction sent!`,
      '',
      `**Amount:** ${sentAmount} ${symbol}`,
      `**To:** \`${to}\``,
      `**Chain:** ${chainName}`,
      `**From:** \`${fromAddress}\``,
      '',
      `**Transaction:** [${txHash.slice(0, 10)}...${txHash.slice(-8)}](${explorerUrl})`,
    ];

    // Add risk warnings if any (transaction was still sent, but user should be aware)
    if (riskWarnings.length > 0) {
      lines.push('');
      lines.push('---');
      lines.push('');
      lines.push('### ⚠️ Risk Assessment');
      lines.push(...riskWarnings);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
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
