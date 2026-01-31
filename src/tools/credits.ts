/**
 * Credits Tool
 *
 * Check Clara Credits balance for signing operations.
 * Credits are prepaid USDC deposited to the ClaraCredits contract on Base.
 */

import { createPublicClient, http, formatUnits, type Hex } from 'viem';
import { base } from 'viem/chains';
import { getSession, touchSession } from '../storage/session.js';

// ClaraCredits contract on Base Mainnet
const CLARA_CREDITS_ADDRESS: Hex = '0x423F12752a7EdbbB17E9d539995e85b921844d8D';

// Base USDC for deposit reference
const USDC_ADDRESS: Hex = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Base RPC
const BASE_RPC = 'https://mainnet.base.org';

// Contract constants (matching ClaraCredits.sol)
const COST_PER_OPERATION = 1000n; // $0.001 in 6-decimal USDC
const MIN_DEPOSIT = 100000n; // $0.10 in 6-decimal USDC

/**
 * ClaraCredits contract ABI (view functions only)
 */
const CREDITS_ABI = [
  {
    inputs: [{ name: 'user', type: 'address' }],
    name: 'credits',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'user', type: 'address' }],
    name: 'availableOperations',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'user', type: 'address' }, { name: 'operations', type: 'uint256' }],
    name: 'hasCredits',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * Tool definition for wallet_credits
 */
export const creditsToolDefinition = {
  name: 'wallet_credits',
  description: `Check your Clara Credits balance for signing operations.

Clara uses prepaid credits for API operations. Each signing operation costs $0.001 USDC.

**Usage:**
\`\`\`json
{}
\`\`\`

Returns:
- Current credit balance (in USDC)
- Available signing operations
- Deposit instructions if balance is low

**To add credits:** Deposit USDC to the ClaraCredits contract on Base from any wallet (Coinbase, MetaMask, etc.)`,
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

/**
 * Handle wallet_credits requests
 */
export async function handleCreditsRequest(
  _args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  // Check session
  const session = await getSession();
  if (!session?.authenticated || !session.address) {
    return {
      content: [{
        type: 'text',
        text: '❌ Wallet not configured. Run `wallet_setup` first.',
      }],
      isError: true,
    };
  }

  await touchSession();

  const address = session.address as Hex;

  // Check if contract is deployed
  if (CLARA_CREDITS_ADDRESS === '0x0000000000000000000000000000000000000000') {
    return {
      content: [{
        type: 'text',
        text: `## Clara Credits

**Status:** Contract not yet deployed

Clara Credits is coming soon! Once deployed, you'll be able to:
- Deposit USDC to get signing credits
- Each signing operation costs $0.001
- Minimum deposit: $0.10

**Current mode:** All signing operations are free during beta.

**Your wallet:** \`${address}\``,
      }],
    };
  }

  try {
    // Create viem client for Base
    const client = createPublicClient({
      chain: base,
      transport: http(BASE_RPC),
    });

    // Fetch credit balance and available operations
    const [creditBalance, availableOps] = await Promise.all([
      client.readContract({
        address: CLARA_CREDITS_ADDRESS,
        abi: CREDITS_ABI,
        functionName: 'credits',
        args: [address],
      }),
      client.readContract({
        address: CLARA_CREDITS_ADDRESS,
        abi: CREDITS_ABI,
        functionName: 'availableOperations',
        args: [address],
      }),
    ]);

    // Format balance (6 decimals like USDC)
    const balanceUSD = formatUnits(creditBalance, 6);
    const balanceNum = parseFloat(balanceUSD);

    // Build response
    const lines = [
      '## Clara Credits',
      '',
      `**Address:** \`${address}\``,
      '',
      '### Balance',
      `- **Credits:** $${balanceNum.toFixed(4)} USDC`,
      `- **Available operations:** ${availableOps.toLocaleString()}`,
      `- **Cost per operation:** $0.001`,
      '',
    ];

    // Add status and recommendations
    if (creditBalance === 0n) {
      lines.push('### ⚠️ No Credits');
      lines.push('');
      lines.push('You need to deposit USDC to use signing operations.');
      lines.push('');
      lines.push('**How to deposit:**');
      lines.push(`1. Send USDC to the ClaraCredits contract on Base`);
      lines.push(`2. Call \`deposit(amount)\` or \`depositFor(yourAddress, amount)\``);
      lines.push('');
      lines.push(`**Contract:** \`${CLARA_CREDITS_ADDRESS}\``);
      lines.push(`**Minimum deposit:** $0.10 (${formatUnits(MIN_DEPOSIT, 6)} USDC)`);
      lines.push('');
      lines.push(`**Quick link:** [Deposit on BaseScan](https://basescan.org/address/${CLARA_CREDITS_ADDRESS}#writeContract)`);
    } else if (availableOps < 10n) {
      lines.push('### ⚠️ Low Credits');
      lines.push('');
      lines.push(`You have ${availableOps} operations remaining. Consider adding more credits.`);
      lines.push('');
      lines.push(`**Contract:** \`${CLARA_CREDITS_ADDRESS}\``);
      lines.push(`**Quick link:** [Add credits on BaseScan](https://basescan.org/address/${CLARA_CREDITS_ADDRESS}#writeContract)`);
    } else {
      lines.push('### ✅ Credits Active');
      lines.push('');
      lines.push(`You have enough credits for ${availableOps.toLocaleString()} signing operations.`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Failed to fetch credits: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
