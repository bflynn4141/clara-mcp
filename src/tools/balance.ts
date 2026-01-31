/**
 * Wallet Balance Tool
 *
 * MCP tool for checking wallet balances.
 *
 * Essential for AI agents to know their available funds before
 * attempting x402 payments or other transactions.
 */

import { createPublicClient, http, formatUnits, type Hex, type PublicClient } from 'viem';
import { base } from 'viem/chains';

// USDC contract address on Base
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

// ERC-20 balance ABI (minimal)
const ERC20_BALANCE_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/**
 * Tool definition for wallet_balance
 */
export const balanceToolDefinition = {
  name: 'wallet_balance',
  description: `Check the wallet's ETH and USDC balance on Base.

**Returns:**
- ETH balance (for gas)
- USDC balance (for x402 payments)
- Wallet address

**Essential for:**
- Knowing available funds before x402 payments
- Checking if you need to fund the wallet
- Monitoring spending

**Example:**
\`\`\`json
{}
\`\`\`

No parameters required - uses the configured wallet.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      showAddress: {
        type: 'boolean',
        default: true,
        description: 'Show the wallet address in the response',
      },
    },
  },
};

/**
 * Balance check result
 */
interface BalanceResult {
  address: string;
  ethBalance: string;
  ethBalanceWei: string;
  usdcBalance: string;
  usdcBalanceUnits: string;
}

/**
 * Get wallet balances on Base
 */
export async function getWalletBalance(address: Hex): Promise<BalanceResult> {
  const client = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL || 'https://mainnet.base.org'),
  }) as PublicClient;

  // Fetch ETH and USDC balances in parallel
  const [ethBalance, usdcBalance] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: USDC_BASE,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [address],
    }),
  ]);

  return {
    address,
    ethBalance: formatUnits(ethBalance, 18),
    ethBalanceWei: ethBalance.toString(),
    usdcBalance: formatUnits(usdcBalance as bigint, 6),
    usdcBalanceUnits: (usdcBalance as bigint).toString(),
  };
}

/**
 * Handle wallet_balance requests
 */
export async function handleBalanceRequest(
  args: Record<string, unknown>,
  getAddress: () => Promise<Hex>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const showAddress = args.showAddress !== false;

  try {
    const address = await getAddress();
    const balances = await getWalletBalance(address);

    // Format ETH balance
    const ethNum = parseFloat(balances.ethBalance);
    const ethFormatted = ethNum < 0.0001 
      ? ethNum === 0 ? '0' : '<0.0001'
      : ethNum.toFixed(4);

    // Format USDC balance
    const usdcNum = parseFloat(balances.usdcBalance);
    const usdcFormatted = usdcNum < 0.01 
      ? usdcNum === 0 ? '0.00' : '<0.01'
      : usdcNum.toFixed(2);

    // Determine funding status
    let fundingNote = '';
    if (usdcNum < 0.10) {
      fundingNote = '\n\n⚠️ Low USDC balance! Fund your wallet to use x402 payments.';
      fundingNote += `\n   Send USDC (Base) to: \`${address}\``;
    }
    if (ethNum < 0.0001) {
      fundingNote += '\n\n⚠️ Low ETH balance! You may need ETH for gas fees.';
    }

    const lines = [
      '💰 Wallet Balance (Base)',
      '─────────────────────────',
      '',
      `**USDC:** $${usdcFormatted}`,
      `**ETH:**  ${ethFormatted} ETH`,
    ];

    if (showAddress) {
      lines.push('');
      lines.push(`**Address:** \`${address}\``);
    }

    if (fundingNote) {
      lines.push(fundingNote);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    
    // Check for common errors
    if (errorMsg.includes('CLARA_PROXY_URL') || errorMsg.includes('PARA_WALLET_ID')) {
      return {
        content: [{
          type: 'text',
          text: `❌ Wallet not configured.\n\nSet environment variables:\n- CLARA_PROXY_URL\n- PARA_WALLET_ID\n\nOr run \`wallet_setup\` first.`,
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: `❌ Failed to get balance: ${errorMsg}`,
      }],
      isError: true,
    };
  }
}
