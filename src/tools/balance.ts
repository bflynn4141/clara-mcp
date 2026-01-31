/**
 * Balance Tool
 *
 * Get wallet balances for native tokens and major stablecoins.
 * Focuses on Base chain (primary x402 chain) but supports other EVM chains.
 */

import { createPublicClient, http, formatUnits, type Hex } from 'viem';
import { getSession, touchSession } from '../storage/session.js';
import { CHAINS, getRpcUrl, isSupportedChain, type SupportedChain } from '../config/chains.js';

/**
 * Known token addresses by chain
 */
const TOKENS: Record<string, Record<string, { address: Hex; decimals: number; symbol: string }>> = {
  base: {
    USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, symbol: 'USDC' },
    USDT: { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6, symbol: 'USDT' },
    DAI: { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, symbol: 'DAI' },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18, symbol: 'WETH' },
  },
  ethereum: {
    USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, symbol: 'USDC' },
    USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, symbol: 'USDT' },
    DAI: { address: '0x6B175474E89094C44Da98b954EescdeCB5BE3830', decimals: 18, symbol: 'DAI' },
    WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, symbol: 'WETH' },
  },
  arbitrum: {
    USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, symbol: 'USDC' },
    USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, symbol: 'USDT' },
    DAI: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, symbol: 'DAI' },
    WETH: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18, symbol: 'WETH' },
  },
  optimism: {
    USDC: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6, symbol: 'USDC' },
    USDT: { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6, symbol: 'USDT' },
    DAI: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, symbol: 'DAI' },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18, symbol: 'WETH' },
  },
  polygon: {
    USDC: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, symbol: 'USDC' },
    USDT: { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6, symbol: 'USDT' },
    DAI: { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18, symbol: 'DAI' },
    WETH: { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18, symbol: 'WETH' },
  },
};


/**
 * Tool definition for wallet_balance
 */
export const balanceToolDefinition = {
  name: 'wallet_balance',
  description: `Get wallet balances on a specific chain.

Shows native token (ETH/MATIC) and major stablecoins (USDC, USDT, DAI).

**Example:**
\`\`\`json
{"chain": "base"}
\`\`\`

Returns balances with USD values for stablecoins.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      chain: {
        type: 'string',
        enum: ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'],
        default: 'base',
        description: 'Blockchain to check balances on (default: base)',
      },
    },
  },
};

/**
 * ERC-20 balanceOf ABI
 */
const ERC20_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;


/**
 * Handle wallet_balance requests
 */
export async function handleBalanceRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const chainName = (args.chain as string) || 'base';

  // Validate chain
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
  const chainConfig = CHAINS[chainName];
  const tokens = TOKENS[chainName] || {};

  try {
    // Create viem client
    const client = createPublicClient({
      chain: chainConfig.chain,
      transport: http(getRpcUrl(chainName)),
    });

    // Fetch native balance
    const nativeBalance = await client.getBalance({ address });
    const nativeFormatted = formatUnits(nativeBalance, chainConfig.nativeDecimals);

    // Fetch token balances
    const tokenBalances: Array<{ symbol: string; balance: string; usdValue?: string }> = [];

    for (const [symbol, token] of Object.entries(tokens)) {
      try {
        const balance = await client.readContract({
          address: token.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address],
        });

        const formatted = formatUnits(balance, token.decimals);
        const balanceNum = parseFloat(formatted);

        if (balanceNum > 0.0001) {
          // For stablecoins, USD value ≈ balance
          const isStable = ['USDC', 'USDT', 'DAI'].includes(symbol);
          tokenBalances.push({
            symbol,
            balance: formatted,
            usdValue: isStable ? `$${balanceNum.toFixed(2)}` : undefined,
          });
        }
      } catch {
        // Skip tokens that fail to read
      }
    }

    // Format output
    const lines = [
      `## Wallet Balance: ${chainName}`,
      '',
      `**Address:** \`${address}\``,
      '',
      `### Native Token`,
      `- **${chainConfig.nativeSymbol}:** ${parseFloat(nativeFormatted).toFixed(6)}`,
      '',
    ];

    if (tokenBalances.length > 0) {
      lines.push('### Tokens');
      for (const tb of tokenBalances) {
        const usd = tb.usdValue ? ` (${tb.usdValue})` : '';
        lines.push(`- **${tb.symbol}:** ${parseFloat(tb.balance).toFixed(6)}${usd}`);
      }
    } else {
      lines.push('_No token balances found_');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Failed to fetch balances: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
