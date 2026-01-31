/**
 * Approvals Tool
 *
 * View and revoke ERC-20 token approvals.
 * Helps protect against unlimited approval vulnerabilities.
 *
 * Note: Token approvals are not enumerable on-chain. This tool checks
 * known spenders (DEXs, bridges) rather than discovering all approvals.
 */

import {
  createPublicClient,
  http,
  formatUnits,
  encodeFunctionData,
  type Hex,
} from 'viem';
import { getSession, touchSession } from '../storage/session.js';
import { signAndSendTransaction } from '../para/transactions.js';
import { CHAINS, getRpcUrl, isSupportedChain, type SupportedChain } from '../config/chains.js';

/**
 * Known tokens to check approvals for
 */
const TOKENS: Record<SupportedChain, Array<{ address: Hex; symbol: string; decimals: number }>> = {
  base: [
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', decimals: 18 },
  ],
  ethereum: [
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
    { address: '0x6B175474E89094C44Da98b954EescdeCB5BE3830', symbol: 'DAI', decimals: 18 },
    { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
  ],
  arbitrum: [
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
    { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 },
  ],
  optimism: [
    { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', decimals: 6 },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
  ],
  polygon: [
    { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', decimals: 6 },
    { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', symbol: 'WETH', decimals: 18 },
  ],
};

/**
 * Known spender addresses (DEXs, bridges, protocols)
 */
const KNOWN_SPENDERS: Record<SupportedChain, Array<{ address: Hex; name: string }>> = {
  base: [
    { address: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', name: 'Li.Fi Diamond' },
    { address: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', name: 'Aave v3 Pool' },
    { address: '0x2626664c2603336E57B271c5C0b26F421741e481', name: 'Uniswap Router' },
    { address: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86', name: 'Stargate Router' },
  ],
  ethereum: [
    { address: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', name: 'Li.Fi Diamond' },
    { address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', name: 'Aave v3 Pool' },
    { address: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', name: 'Uniswap Router V2' },
    { address: '0xEf1c6E67703c7BD7107eed8303Fbe6EC2554BF6B', name: 'Uniswap Universal Router' },
    { address: '0x1111111254EEB25477B68fb85Ed929f73A960582', name: '1inch Router v5' },
  ],
  arbitrum: [
    { address: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', name: 'Li.Fi Diamond' },
    { address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', name: 'Aave v3 Pool' },
    { address: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', name: 'Uniswap Router V2' },
  ],
  optimism: [
    { address: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', name: 'Li.Fi Diamond' },
    { address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', name: 'Aave v3 Pool' },
    { address: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', name: 'Uniswap Router V2' },
  ],
  polygon: [
    { address: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', name: 'Li.Fi Diamond' },
    { address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', name: 'Aave v3 Pool' },
    { address: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', name: 'Uniswap Router V2' },
  ],
};

/**
 * Tool definition for wallet_approvals
 */
export const approvalsToolDefinition = {
  name: 'wallet_approvals',
  description: `View and revoke ERC-20 token approvals to protect your wallet.

**View approvals:**
\`\`\`json
{"action": "view", "chain": "base"}
\`\`\`

**Revoke an approval:**
\`\`\`json
{"action": "revoke", "token": "USDC", "spender": "0x...", "chain": "base"}
\`\`\`

⚠️ Unlimited approvals are a security risk. Consider revoking approvals you no longer need.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['view', 'revoke'],
        default: 'view',
        description: 'view = list approvals, revoke = remove an approval',
      },
      chain: {
        type: 'string',
        enum: ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'],
        default: 'base',
        description: 'Chain to check/revoke on',
      },
      token: {
        type: 'string',
        description: 'Token symbol (USDC, WETH) or address. Required for revoke.',
      },
      spender: {
        type: 'string',
        description: 'Spender address to revoke. Required for revoke.',
      },
    },
    required: [],
  },
};

/**
 * ERC-20 allowance ABI
 */
const ALLOWANCE_ABI = [
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * ERC-20 approve ABI
 */
const APPROVE_ABI = [
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;


/**
 * Format large allowance amounts
 */
function formatAllowance(amount: bigint, decimals: number): string {
  // Max uint256 is "unlimited"
  const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
  if (amount >= MAX_UINT256 / 2n) {
    return '∞ (Unlimited)';
  }

  const formatted = formatUnits(amount, decimals);
  const num = parseFloat(formatted);

  if (num >= 1_000_000_000) {
    return `${(num / 1_000_000_000).toFixed(1)}B`;
  } else if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  } else if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
  } else {
    return num.toFixed(2);
  }
}

/**
 * Handle wallet_approvals requests
 */
export async function handleApprovalsRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const action = (args.action as string) || 'view';
  const chainName = (args.chain as string) || 'base';
  const tokenInput = args.token as string | undefined;
  const spenderInput = args.spender as string | undefined;

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

  const owner = session.address as Hex;
  const chainConfig = CHAINS[chainName];
  const tokens = TOKENS[chainName];
  const spenders = KNOWN_SPENDERS[chainName];

  try {
    const client = createPublicClient({
      chain: chainConfig.chain,
      transport: http(getRpcUrl(chainName)),
    });

    if (action === 'view') {
      // Check all token/spender combinations
      const approvals: Array<{
        token: string;
        tokenAddress: Hex;
        spender: string;
        spenderAddress: Hex;
        allowance: string;
        isUnlimited: boolean;
      }> = [];

      for (const token of tokens) {
        for (const spender of spenders) {
          try {
            const allowance = await client.readContract({
              address: token.address,
              abi: ALLOWANCE_ABI,
              functionName: 'allowance',
              args: [owner, spender.address],
            });

            if (allowance > 0n) {
              const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
              approvals.push({
                token: token.symbol,
                tokenAddress: token.address,
                spender: spender.name,
                spenderAddress: spender.address,
                allowance: formatAllowance(allowance, token.decimals),
                isUnlimited: allowance >= MAX_UINT256 / 2n,
              });
            }
          } catch {
            // Skip failed reads (some tokens may not exist on chain)
          }
        }
      }

      // Format output
      const lines: string[] = [];
      lines.push(`## 🔐 Token Approvals on ${chainName}`);
      lines.push('');

      if (approvals.length === 0) {
        lines.push('✅ **No active approvals found**');
        lines.push('');
        lines.push('_Checked common tokens (USDC, WETH, DAI) for known spenders (Uniswap, Aave, Li.Fi)_');
      } else {
        // Group by token
        const byToken = new Map<string, typeof approvals>();
        for (const a of approvals) {
          const existing = byToken.get(a.token) || [];
          existing.push(a);
          byToken.set(a.token, existing);
        }

        for (const [token, tokenApprovals] of byToken) {
          lines.push(`### ${token}`);
          for (const a of tokenApprovals) {
            const warning = a.isUnlimited ? ' ⚠️' : '';
            lines.push(`- **${a.spender}**: ${a.allowance}${warning}`);
            lines.push(`  \`${a.spenderAddress}\``);
          }
          lines.push('');
        }

        // Security note
        const unlimitedCount = approvals.filter(a => a.isUnlimited).length;
        if (unlimitedCount > 0) {
          lines.push(`⚠️ **${unlimitedCount} unlimited approval${unlimitedCount > 1 ? 's' : ''} detected**`);
          lines.push('');
          lines.push('Consider revoking unlimited approvals you no longer need:');
          lines.push('```json');
          lines.push(`{"action": "revoke", "token": "${approvals.find(a => a.isUnlimited)?.token}", "spender": "${approvals.find(a => a.isUnlimited)?.spenderAddress}", "chain": "${chainName}"}`);
          lines.push('```');
        }
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }

    // Action: revoke
    if (action === 'revoke') {
      if (!tokenInput || !spenderInput) {
        return {
          content: [{
            type: 'text',
            text: '❌ Missing parameters. `token` and `spender` are required for revoke.\n\nExample: `{"action": "revoke", "token": "USDC", "spender": "0x...", "chain": "base"}`',
          }],
          isError: true,
        };
      }

      // Resolve token
      let tokenAddress: Hex;
      let tokenSymbol: string;

      if (tokenInput.startsWith('0x') && tokenInput.length === 42) {
        tokenAddress = tokenInput as Hex;
        tokenSymbol = 'TOKEN';
      } else {
        const found = tokens.find(t => t.symbol.toLowerCase() === tokenInput.toLowerCase());
        if (!found) {
          return {
            content: [{
              type: 'text',
              text: `❌ Unknown token: ${tokenInput}\n\nSupported: ${tokens.map(t => t.symbol).join(', ')} (or provide contract address)`,
            }],
            isError: true,
          };
        }
        tokenAddress = found.address;
        tokenSymbol = found.symbol;
      }

      // Validate spender
      if (!spenderInput.startsWith('0x') || spenderInput.length !== 42) {
        return {
          content: [{
            type: 'text',
            text: '❌ Invalid spender address. Must be a valid 0x address.',
          }],
          isError: true,
        };
      }

      const spenderAddress = spenderInput as Hex;

      // Encode approve(spender, 0)
      const data = encodeFunctionData({
        abi: APPROVE_ABI,
        functionName: 'approve',
        args: [spenderAddress, 0n],
      });

      // Send revoke transaction
      const result = await signAndSendTransaction(session.walletId, {
        to: tokenAddress,
        value: 0n,
        data,
        chainId: chainConfig.chainId,
      });

      const explorerUrl = `${chainConfig.explorerUrl}/tx/${result.txHash}`;

      // Find spender name
      const spenderName = spenders.find(s => s.address.toLowerCase() === spenderAddress.toLowerCase())?.name || spenderAddress.slice(0, 10) + '...';

      return {
        content: [{
          type: 'text',
          text: [
            '✅ **Approval Revoked!**',
            '',
            `**Token:** ${tokenSymbol}`,
            `**Spender:** ${spenderName}`,
            `**Chain:** ${chainName}`,
            '',
            `**Transaction:** [${result.txHash.slice(0, 10)}...](${explorerUrl})`,
          ].join('\n'),
        }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: `❌ Unknown action: ${action}\n\nValid actions: view, revoke`,
      }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Approvals check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
