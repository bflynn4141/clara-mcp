/**
 * wallet_call - Call Any Contract Function
 *
 * Two-phase execution pattern:
 * 1. wallet_call prepares and simulates → returns preparedTxId
 * 2. wallet_executePrepared executes → sends the exact same transaction
 *
 * Features:
 * - Function overload resolution (tries each candidate)
 * - AI-friendly type coercion (strings → addresses, numbers → bigint)
 * - Uses cached Herd ABI when available
 * - Returns structured errors for ambiguous/missing functions
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  encodeFunctionData,
  createPublicClient,
  getAddress,
  type Hex,
  type Abi,
  type AbiFunction,
} from 'viem';
import { base, mainnet, arbitrum, optimism, polygon } from 'viem/chains';
import { getProviderRegistry, isHerdEnabled } from '../providers/index.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { getTransport, type SupportedChain, getChainId } from '../config/chains.js';
import { resolveAddress, formatResolved } from '../services/resolve-address.js';
import {
  storePreparedTx,
  formatPreparedTx,
  type PreparedTransaction,
} from '../para/prepared-tx.js';

// Chain mapping for viem
const CHAIN_MAP = {
  ethereum: mainnet,
  base: base,
  arbitrum: arbitrum,
  optimism: optimism,
  polygon: polygon,
} as const;

const CHAIN_IDS: Record<SupportedChain, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
};

/**
 * Tool definition for wallet_call
 */
export const callToolDefinition: Tool = {
  name: 'wallet_call',
  description: `Prepare and simulate a contract function call.

Returns a **preparedTxId** that can be executed with wallet_executePrepared.

**Features:**
- Automatic ABI lookup from Herd
- Function overload resolution
- AI-friendly type coercion (strings to addresses, etc.)
- Simulation before execution

**Examples:**
\`\`\`json
{"contract": "0x...", "function": "claim", "chain": "base"}
{"contract": "0x...", "function": "withdraw(uint256)", "args": ["1000000"], "chain": "base"}
{"contract": "vitalik.eth", "function": "balanceOf", "args": ["0x..."], "chain": "ethereum"}
\`\`\`

**Function name formats:**
- \`"claim"\` - Simple name (must be unambiguous)
- \`"withdraw(uint256)"\` - Full signature (for overloaded functions)

After simulation succeeds, use \`wallet_executePrepared\` with the returned preparedTxId.`,
  inputSchema: {
    type: 'object',
    properties: {
      contract: {
        type: 'string',
        description: 'Contract address (0x...), Clara name (e.g., "brian" for brian.claraid.eth), or ENS name (e.g., "vitalik.eth")',
      },
      function: {
        type: 'string',
        description: 'Function name ("claim") or full signature ("withdraw(uint256)")',
      },
      args: {
        type: 'array',
        items: {},
        description: 'Function arguments in order. Strings will be coerced to appropriate types.',
      },
      value: {
        type: 'string',
        description: 'ETH value to send (in wei). Default: "0"',
      },
      chain: {
        type: 'string',
        enum: ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'],
        description: 'Chain to call on. Default: "base"',
      },
      abi: {
        type: 'array',
        description: 'Optional ABI override. If not provided, fetched from Herd.',
      },
    },
    required: ['contract', 'function'],
  },
};

/**
 * Parse function name to extract signature parts
 */
function parseFunctionName(name: string): { name: string; signature?: string } {
  const match = name.match(/^(\w+)\((.*)\)$/);
  if (match) {
    return { name: match[1], signature: name };
  }
  return { name };
}

/**
 * Find matching function(s) in ABI
 */
function findFunctions(abi: Abi, funcName: string): AbiFunction[] {
  const parsed = parseFunctionName(funcName);

  return (abi as AbiFunction[]).filter((item) => {
    if (item.type !== 'function') return false;
    if (item.name !== parsed.name) return false;

    // If full signature provided, match exactly
    if (parsed.signature) {
      const inputTypes = item.inputs.map((i) => i.type).join(',');
      const itemSig = `${item.name}(${inputTypes})`;
      return itemSig === parsed.signature;
    }

    return true;
  });
}

/**
 * Coerce argument to expected type
 */
function coerceArg(value: unknown, type: string): unknown {
  // Arrays FIRST — must check before scalar types since
  // "uint256[]".startsWith("uint") is true but it's an array type
  if (type.endsWith('[]')) {
    const baseType = type.slice(0, -2);
    if (Array.isArray(value)) {
      return value.map((v) => coerceArg(v, baseType));
    }
    throw new Error(`Expected array for ${type}`);
  }

  // Address coercion
  if (type === 'address') {
    if (typeof value === 'string' && value.startsWith('0x')) {
      return getAddress(value); // Checksum
    }
    throw new Error(`Invalid address: ${value}`);
  }

  // Uint/int coercion
  if (type.startsWith('uint') || type.startsWith('int')) {
    if (typeof value === 'number') {
      return BigInt(value);
    }
    if (typeof value === 'string') {
      // Handle decimal strings
      return BigInt(value);
    }
    if (typeof value === 'bigint') {
      return value;
    }
    throw new Error(`Invalid number for ${type}: ${value}`);
  }

  // Bool coercion
  if (type === 'bool') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`Invalid bool: ${value}`);
  }

  // Bytes coercion
  if (type.startsWith('bytes')) {
    if (typeof value === 'string' && value.startsWith('0x')) {
      return value as Hex;
    }
    throw new Error(`Invalid bytes: ${value}`);
  }

  // Default: return as-is
  return value;
}

/**
 * Try to encode calldata with a specific ABI function
 */
function tryEncode(
  func: AbiFunction,
  args: unknown[]
): { success: true; data: Hex } | { success: false; error: string } {
  try {
    // Coerce args to expected types
    const coercedArgs = func.inputs.map((input, i) => {
      if (i >= args.length) {
        throw new Error(`Missing argument: ${input.name || `arg${i}`}`);
      }
      return coerceArg(args[i], input.type);
    });

    const data = encodeFunctionData({
      abi: [func] as Abi,
      functionName: func.name,
      args: coercedArgs,
    });

    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get function signature string
 */
function getFunctionSignature(func: AbiFunction): string {
  const inputTypes = func.inputs.map((i) => i.type).join(',');
  return `${func.name}(${inputTypes})`;
}

/**
 * Handle wallet_call requests
 */
export async function handleCallRequest(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const contractInput = args.contract as string;
  const funcName = args.function as string;
  const funcArgs = (args.args as unknown[]) || [];
  const value = args.value ? BigInt(args.value as string) : 0n;
  const chain = (args.chain as SupportedChain) || 'base';
  const abiOverride = args.abi as Abi | undefined;

  // Resolve contract: 0x address, Clara name, or ENS name
  let contract: string;
  let resolvedDisplay: string | undefined;
  try {
    const resolved = await resolveAddress(contractInput);
    contract = resolved.address;
    resolvedDisplay = resolved.displayName;
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Cannot resolve contract "${contractInput}": ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }

  try {

    // Get ABI (from override, or from Herd)
    let abi: Abi;
    let contractName: string | undefined = resolvedDisplay; // Show ENS name if resolved

    if (abiOverride) {
      abi = abiOverride;
    } else {
      // Fetch from Herd
      const registry = getProviderRegistry();
      const metadataResult = await registry.getContractMetadata({
        address: contract,
        chain,
        detailLevel: 'full',
        includeAbi: true,
      });

      if (!metadataResult.success || !metadataResult.data?.abi) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Could not fetch ABI for ${contract}. Contract may be unverified.\n\nYou can provide an ABI override using the \`abi\` parameter.`,
            },
          ],
          isError: true,
        };
      }

      abi = metadataResult.data.abi as Abi;
      // Prefer Herd's contract name, but keep resolved ENS name as fallback
      contractName = metadataResult.data.name || contractName;
    }

    // Find matching functions
    const matchingFunctions = findFunctions(abi, funcName);

    if (matchingFunctions.length === 0) {
      // List available functions
      const availableFunctions = (abi as AbiFunction[])
        .filter((f) => f.type === 'function')
        .map((f) => getFunctionSignature(f))
        .slice(0, 20); // Limit to 20

      return {
        content: [
          {
            type: 'text',
            text: `❌ **No matching function:** \`${funcName}\`\n\n**Available functions:**\n${availableFunctions.map((f) => `- \`${f}\``).join('\n')}`,
          },
        ],
        isError: true,
      };
    }

    // Try to encode with each matching function
    const encodeResults = matchingFunctions.map((func) => ({
      func,
      signature: getFunctionSignature(func),
      result: tryEncode(func, funcArgs),
    }));

    const successfulEncodes = encodeResults.filter((r) => r.result.success);

    if (successfulEncodes.length === 0) {
      // None worked - show errors
      const errors = encodeResults
        .map((r) => `- \`${r.signature}\`: ${(r.result as { error: string }).error}`)
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `❌ **Could not encode function call**\n\nTried ${encodeResults.length} overload(s):\n${errors}\n\n**Your args:** ${JSON.stringify(funcArgs)}`,
          },
        ],
        isError: true,
      };
    }

    if (successfulEncodes.length > 1) {
      // Ambiguous - ask user to specify
      const candidates = successfulEncodes.map((r) => `- \`${r.signature}\``).join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `❌ **Ambiguous function call**\n\nMultiple overloads match your arguments:\n${candidates}\n\nPlease use the full signature, e.g.:\n\`"function": "${successfulEncodes[0].signature}"\``,
          },
        ],
        isError: true,
      };
    }

    // Single successful encode
    const { func, signature, result } = successfulEncodes[0];
    const calldata = (result as { success: true; data: Hex }).data;

    // Create public client for simulation
    const viemChain = CHAIN_MAP[chain];
    const publicClient = createPublicClient({
      chain: viemChain,
      transport: getTransport(chain),
    });

    // Simulate the transaction
    let simulation: PreparedTransaction['simulation'];

    try {
      const gasEstimate = await publicClient.estimateGas({
        account: ctx.walletAddress,
        to: contract as Hex,
        data: calldata,
        value,
      });

      simulation = {
        success: true,
        gasEstimate,
        gasEstimateFormatted: gasEstimate.toLocaleString(),
      };

      // Try to get return value via call
      try {
        const callResult = await publicClient.call({
          account: ctx.walletAddress,
          to: contract as Hex,
          data: calldata,
          value,
        });

        if (callResult.data) {
          simulation.returnData = callResult.data;
          // TODO: Decode return data using func.outputs
        }
      } catch {
        // Call failed but gas estimate succeeded - tx might still work
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Parse revert reason
      let reason = message;
      const revertMatch = message.match(/reverted with reason string '([^']+)'/);
      if (revertMatch) {
        reason = revertMatch[1];
      }

      simulation = {
        success: false,
        gasEstimate: 0n,
        gasEstimateFormatted: '0',
        error: reason,
      };
    }

    // Store prepared transaction
    const preparedTxId = storePreparedTx({
      to: contract as Hex,
      data: calldata,
      value,
      chainId: CHAIN_IDS[chain],
      chain,
      contractName,
      functionName: func.name,
      functionSignature: signature,
      args: funcArgs,
      simulation,
    });

    // Get the full prepared tx for display
    const { getPreparedTx } = await import('../para/prepared-tx.js');
    const preparedTx = getPreparedTx(preparedTxId)!;
    const display = formatPreparedTx(preparedTx);

    // Add execution instructions
    const instructions = simulation.success
      ? `\n\n💡 To execute this transaction:\n\`wallet_executePrepared preparedTxId="${preparedTxId}"\``
      : `\n\n⚠️ Simulation failed. Fix the issue before executing.`;

    return {
      content: [{ type: 'text', text: display + instructions }],
      isError: !simulation.success,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `❌ wallet_call failed: ${message}` }],
      isError: true,
    };
  }
}
