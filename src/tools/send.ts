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
  type Hex,
} from 'viem';
import { signAndSendTransaction } from '../para/transactions.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import {
  CHAINS,
  getExplorerTxUrl,
  getTransport,
  isSupportedChain,
  type SupportedChain,
} from '../config/chains.js';
import { resolveToken } from '../config/tokens.js';
import { assessContractRisk, formatRiskAssessment, quickSafeCheck } from '../services/risk.js';
import { resolveAddress, formatResolved } from '../services/resolve-address.js';
import { checkSpendingLimits, recordSpending } from '../storage/spending.js';
import { requireGas } from '../gas-preflight.js';
import { ClaraError, ClaraErrorCode } from '../errors.js';

/**
 * Tool definition for wallet_send
 */
export const sendToolDefinition = {
  name: 'wallet_send',
  description: `Send native tokens or ERC-20 tokens to an address.

**Examples:**
- Send ETH: \`{"to": "0x...", "amount": "0.01", "chain": "base"}\`
- Send USDC: \`{"to": "0x...", "amount": "10", "chain": "base", "token": "USDC"}\`
- Send by name: \`{"to": "brian", "amount": "10", "token": "USDC"}\` (resolves brian.claraid.eth)
- Send to ENS: \`{"to": "vitalik.eth", "amount": "0.01"}\`

Supported tokens: USDC, USDT, DAI, WETH (or provide contract address).

⚠️ This tool sends real money. Double-check the recipient address.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: {
        type: 'string',
        description: 'Recipient: 0x address, Clara name (e.g., "brian" for brian.claraid.eth), or ENS name (e.g., "vitalik.eth")',
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
      transport: getTransport(chain),
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
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const toInput = args.to as string;
  const amount = args.amount as string;
  const chainName = (args.chain as string) || 'base';
  let tokenInput = args.token as string | undefined;
  const forceUnsafe = args.forceUnsafe as boolean | undefined;

  // Treat native token names (ETH, MATIC, etc.) as native sends
  if (tokenInput && isSupportedChain(chainName)) {
    const nativeSymbol = CHAINS[chainName].nativeSymbol;
    if (tokenInput.toUpperCase() === nativeSymbol.toUpperCase()) {
      tokenInput = undefined; // Use native send path
    }
  }

  // Resolve recipient: 0x address, Clara name, or ENS name
  let to: string;
  let resolvedDisplay: string | undefined;
  try {
    const resolved = await resolveAddress(toInput);
    to = resolved.address;
    resolvedDisplay = resolved.displayName;
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Cannot resolve recipient "${toInput}": ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
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

  const session = ctx.session;
  const chainConfig = CHAINS[chainName];
  const fromAddress = ctx.walletAddress;

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

    // -------------------------------------------------------------------------
    // Spending Limit Check
    // -------------------------------------------------------------------------
    // Estimate USD value: stablecoins (USDC/USDT/DAI) ≈ 1:1 USD.
    // For native tokens (ETH, MATIC) we skip the check since gas limits
    // handle those, and we don't have a price oracle here.
    const STABLECOINS = ['USDC', 'USDT', 'DAI'];
    const tokenSymbolUpper = tokenInput?.toUpperCase();
    let estimatedUsd: number | null = null;

    if (tokenSymbolUpper && STABLECOINS.includes(tokenSymbolUpper)) {
      estimatedUsd = parseFloat(amount);
    }

    if (estimatedUsd !== null && estimatedUsd > 0) {
      const spendCheck = checkSpendingLimits(estimatedUsd.toFixed(2));
      if (!spendCheck.allowed) {
        return {
          content: [{
            type: 'text',
            text: `🛑 **Send blocked by spending limits**\n\n${spendCheck.reason}\n\nUse \`wallet_spending_limits\` to view or adjust your limits.`,
          }],
          isError: true,
        };
      }
    }

    // -------------------------------------------------------------------------
    // Gas Pre-flight Check
    // -------------------------------------------------------------------------
    if (tokenInput) {
      // ERC-20 transfer: only need gas (no ETH value sent)
      await requireGas(chainName, fromAddress);
    } else {
      // Native transfer: need gas + the ETH value being sent
      await requireGas(chainName, fromAddress, {
        txValue: parseUnits(amount, 18),
      });
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

      // Simulate the ERC-20 transfer before signing
      const client = createPublicClient({
        chain: chainConfig.chain,
        transport: getTransport(chainName),
      });
      try {
        await client.call({
          account: ctx.walletAddress,
          to: token.address as Hex,
          data,
          value: 0n,
        });
      } catch (simError: any) {
        throw new ClaraError(
          ClaraErrorCode.SIMULATION_FAILED,
          `Transaction would fail: ${simError.shortMessage || simError.message}`,
          'Check the recipient address and your token balance.',
        );
      }

      // Send to token contract with transfer data
      const result = await signAndSendTransaction(session.walletId!, {
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

      // Simulate the native transfer before signing
      const client = createPublicClient({
        chain: chainConfig.chain,
        transport: getTransport(chainName),
      });
      try {
        await client.call({
          account: ctx.walletAddress,
          to: to as Hex,
          value: amountWei,
        });
      } catch (simError: any) {
        throw new ClaraError(
          ClaraErrorCode.SIMULATION_FAILED,
          `Transaction would fail: ${simError.shortMessage || simError.message}`,
          'Check the recipient address and your balance.',
        );
      }

      const result = await signAndSendTransaction(session.walletId!, {
        to: to as Hex,
        value: amountWei,
        chainId: chainConfig.chainId,
      });

      txHash = result.txHash;
    }

    // Wait for transaction confirmation and verify success
    console.error(`[clara] Waiting for send confirmation: ${txHash}`);
    const publicClient = createPublicClient({
      chain: chainConfig.chain,
      transport: getTransport(chainName),
    });

    let receipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 120_000, // 2 minutes
      });
    } catch (waitError) {
      // Timeout or other error waiting for receipt
      throw new Error(
        `Transaction submitted but confirmation timed out. ` +
        `Check status: ${getExplorerTxUrl(chainName, txHash)}`
      );
    }

    if (receipt.status !== 'success') {
      throw new Error(
        `Transaction failed on-chain. ` +
        `Check details: ${getExplorerTxUrl(chainName, txHash)}`
      );
    }

    console.error(`[clara] Send confirmed: ${txHash}`);

    // Record spending for limit tracking (stablecoins only)
    if (estimatedUsd !== null && estimatedUsd > 0) {
      recordSpending({
        timestamp: new Date().toISOString(),
        amountUsd: estimatedUsd.toFixed(2),
        recipient: to,
        description: `Send ${sentAmount} ${symbol} on ${chainName}`,
        url: '',
        chainId: chainConfig.chainId,
        txHash,
        paymentId: `send-${txHash.slice(0, 10)}`,
      });
    }

    // Success response
    const explorerUrl = getExplorerTxUrl(chainName, txHash);

    const lines = [
      `✅ Transaction confirmed!`,
      '',
      `**Amount:** ${sentAmount} ${symbol}`,
      `**To:** ${resolvedDisplay ? `${resolvedDisplay} (\`${to}\`)` : `\`${to}\``}`,
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
