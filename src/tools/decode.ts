/**
 * Decode Tool
 *
 * Decode transaction calldata into human-readable format.
 * Uses 4byte.directory for method signature lookup.
 */

import { type Hex, decodeFunctionData, formatEther, formatUnits } from 'viem';

/**
 * Tool definition for wallet_decode_tx
 */
export const decodeToolDefinition = {
  name: 'wallet_decode_tx',
  description: `Decode transaction calldata into human-readable format.

Shows:
- Method name and parameters
- Value being sent
- Contract being called

**Example:**
\`\`\`json
{
  "data": "0xa9059cbb000000000000000000000000...",
  "value": "0"
}
\`\`\`

Useful for understanding what a transaction will do before signing.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      data: {
        type: 'string',
        description: 'Transaction calldata (hex)',
      },
      value: {
        type: 'string',
        default: '0',
        description: 'ETH value (optional, for context)',
      },
      to: {
        type: 'string',
        description: 'Target contract address (optional, for context)',
      },
    },
    required: ['data'],
  },
};

/**
 * Common method signatures (4-byte selectors)
 * Format: selector -> [methodName, parameterDescriptions]
 */
const KNOWN_METHODS: Record<string, { name: string; params: string[] }> = {
  // ERC-20
  '0xa9059cbb': { name: 'transfer', params: ['recipient (address)', 'amount (uint256)'] },
  '0x23b872dd': { name: 'transferFrom', params: ['from (address)', 'to (address)', 'amount (uint256)'] },
  '0x095ea7b3': { name: 'approve', params: ['spender (address)', 'amount (uint256)'] },
  '0x70a08231': { name: 'balanceOf', params: ['account (address)'] },
  '0xdd62ed3e': { name: 'allowance', params: ['owner (address)', 'spender (address)'] },

  // ERC-721
  '0x42842e0e': { name: 'safeTransferFrom', params: ['from (address)', 'to (address)', 'tokenId (uint256)'] },
  '0xb88d4fde': { name: 'safeTransferFrom', params: ['from (address)', 'to (address)', 'tokenId (uint256)', 'data (bytes)'] },
  '0x6352211e': { name: 'ownerOf', params: ['tokenId (uint256)'] },

  // Uniswap V2/V3 Router
  '0x38ed1739': { name: 'swapExactTokensForTokens', params: ['amountIn (uint256)', 'amountOutMin (uint256)', 'path (address[])', 'to (address)', 'deadline (uint256)'] },
  '0x7ff36ab5': { name: 'swapExactETHForTokens', params: ['amountOutMin (uint256)', 'path (address[])', 'to (address)', 'deadline (uint256)'] },
  '0x18cbafe5': { name: 'swapExactTokensForETH', params: ['amountIn (uint256)', 'amountOutMin (uint256)', 'path (address[])', 'to (address)', 'deadline (uint256)'] },
  '0xfb3bdb41': { name: 'swapETHForExactTokens', params: ['amountOut (uint256)', 'path (address[])', 'to (address)', 'deadline (uint256)'] },

  // Uniswap V3 Swap Router
  '0x414bf389': { name: 'exactInputSingle', params: ['params (struct)'] },
  '0xdb3e2198': { name: 'exactOutputSingle', params: ['params (struct)'] },
  '0xc04b8d59': { name: 'exactInput', params: ['params (struct)'] },
  '0xf28c0498': { name: 'exactOutput', params: ['params (struct)'] },

  // Aave v3
  '0x617ba037': { name: 'supply', params: ['asset (address)', 'amount (uint256)', 'onBehalfOf (address)', 'referralCode (uint16)'] },
  '0x69328dec': { name: 'withdraw', params: ['asset (address)', 'amount (uint256)', 'to (address)'] },
  '0xa415bcad': { name: 'borrow', params: ['asset (address)', 'amount (uint256)', 'interestRateMode (uint256)', 'referralCode (uint16)', 'onBehalfOf (address)'] },
  '0x573ade81': { name: 'repay', params: ['asset (address)', 'amount (uint256)', 'interestRateMode (uint256)', 'onBehalfOf (address)'] },

  // WETH
  '0xd0e30db0': { name: 'deposit', params: [] },
  '0x2e1a7d4d': { name: 'withdraw', params: ['amount (uint256)'] },

  // Multicall
  '0xac9650d8': { name: 'multicall', params: ['data (bytes[])'] },
  '0x5ae401dc': { name: 'multicall', params: ['deadline (uint256)', 'data (bytes[])'] },

  // Permit (EIP-2612)
  '0xd505accf': { name: 'permit', params: ['owner (address)', 'spender (address)', 'value (uint256)', 'deadline (uint256)', 'v (uint8)', 'r (bytes32)', 's (bytes32)'] },

  // Li.Fi
  '0x4630a0d8': { name: 'swapTokensGeneric', params: ['params (struct)'] },
  '0x878863a4': { name: 'startBridgeTokensViaAcross', params: ['params (struct)'] },
};

/**
 * Fetch method signature from 4byte.directory
 */
async function fetchMethodSignature(selector: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://www.4byte.directory/api/v1/signatures/?hex_signature=${selector}`,
      { signal: AbortSignal.timeout(5000) }
    );

    if (!response.ok) return null;

    const data = await response.json() as { results?: Array<{ text_signature: string }> };
    if (data.results && data.results.length > 0) {
      // Return most popular (first) result
      return data.results[0].text_signature;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse hex parameter to readable format
 */
function parseParam(hex: string, index: number): string {
  // Remove leading zeros for readability
  const trimmed = hex.replace(/^0+/, '') || '0';

  // Check if it looks like an address (40 chars after trimming leading zeros)
  if (hex.length === 64 && hex.slice(0, 24) === '000000000000000000000000') {
    return `0x${hex.slice(24)}`;
  }

  // Check if it's a small number
  const num = BigInt('0x' + hex);
  if (num < 1000000n) {
    return num.toString();
  }

  // Check if it might be an amount (6 or 18 decimals)
  if (num > 1000000n && num < BigInt('1' + '0'.repeat(30))) {
    // Try common decimal formats
    const asUsdc = Number(num) / 1e6;
    const asEth = Number(num) / 1e18;

    if (asUsdc >= 0.01 && asUsdc < 1e12) {
      return `${asUsdc.toFixed(2)} (if 6 decimals)`;
    }
    if (asEth >= 0.000001 && asEth < 1e12) {
      return `${asEth.toFixed(6)} (if 18 decimals)`;
    }
  }

  // Return as hex
  return `0x${trimmed}`;
}

/**
 * Handle wallet_decode_tx requests
 */
export async function handleDecodeRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const data = args.data as string;
  const value = (args.value as string) || '0';
  const to = args.to as string | undefined;

  // Validate
  if (!data || !data.startsWith('0x')) {
    return {
      content: [{ type: 'text', text: '❌ Invalid calldata. Must be a hex string starting with 0x.' }],
      isError: true,
    };
  }

  // Handle empty calldata (native transfer)
  if (data === '0x' || data.length < 10) {
    const ethValue = value === '0' ? '0' : formatEther(BigInt(Math.floor(parseFloat(value) * 1e18)));
    return {
      content: [{
        type: 'text',
        text: [
          '## 📝 Transaction Decoded',
          '',
          '**Type:** Native ETH Transfer',
          `**Value:** ${ethValue} ETH`,
          to ? `**To:** \`${to}\`` : '',
          '',
          '_No contract interaction (simple transfer)_',
        ].filter(Boolean).join('\n'),
      }],
    };
  }

  // Extract method selector
  const selector = data.slice(0, 10).toLowerCase();
  const params = data.slice(10);

  // Look up method
  let methodInfo = KNOWN_METHODS[selector];
  let methodSource = 'known signature';

  if (!methodInfo) {
    // Try 4byte.directory
    const sig = await fetchMethodSignature(selector);
    if (sig) {
      const match = sig.match(/^([^(]+)\(([^)]*)\)$/);
      if (match) {
        const [, name, paramStr] = match;
        const paramNames = paramStr ? paramStr.split(',').map(p => p.trim()) : [];
        methodInfo = { name, params: paramNames };
        methodSource = '4byte.directory';
      }
    }
  }

  // Parse parameters
  const paramChunks: string[] = [];
  for (let i = 0; i < params.length; i += 64) {
    paramChunks.push(params.slice(i, i + 64));
  }

  // Build output
  const lines: string[] = [];
  lines.push('## 📝 Transaction Decoded');
  lines.push('');

  if (methodInfo) {
    lines.push(`**Method:** \`${methodInfo.name}\` _(${methodSource})_`);
    lines.push('');

    if (methodInfo.params.length > 0 && paramChunks.length > 0) {
      lines.push('**Parameters:**');
      for (let i = 0; i < Math.min(methodInfo.params.length, paramChunks.length); i++) {
        const paramName = methodInfo.params[i];
        const paramValue = parseParam(paramChunks[i], i);
        lines.push(`- ${paramName}: \`${paramValue}\``);
      }

      // Show extra params if any
      if (paramChunks.length > methodInfo.params.length) {
        for (let i = methodInfo.params.length; i < paramChunks.length; i++) {
          const paramValue = parseParam(paramChunks[i], i);
          lines.push(`- param${i}: \`${paramValue}\``);
        }
      }
    }
  } else {
    lines.push(`**Method Selector:** \`${selector}\` _(unknown)_`);
    lines.push('');

    if (paramChunks.length > 0) {
      lines.push('**Raw Parameters:**');
      for (let i = 0; i < Math.min(paramChunks.length, 10); i++) {
        const paramValue = parseParam(paramChunks[i], i);
        lines.push(`- param${i}: \`${paramValue}\``);
      }
      if (paramChunks.length > 10) {
        lines.push(`_... and ${paramChunks.length - 10} more parameters_`);
      }
    }
  }

  // Add value if non-zero
  if (value !== '0') {
    const ethValue = formatEther(BigInt(Math.floor(parseFloat(value) * 1e18)));
    lines.push('');
    lines.push(`**Value:** ${ethValue} ETH`);
  }

  // Add target
  if (to) {
    lines.push('');
    lines.push(`**Target:** \`${to}\``);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}
