/**
 * Simulate Tool
 *
 * Simulate transactions before sending to preview outcomes.
 * Uses Tenderly API when available, falls back to eth_call.
 *
 * This is a safety-critical tool - helps prevent irreversible loss.
 */

import {
  createPublicClient,
  http,
  formatUnits,
  decodeFunctionData,
  type Hex,
  type TransactionRequest,
  type Abi,
} from 'viem';
import { getSession, touchSession } from '../storage/session.js';
import { CHAINS, getRpcUrl, isSupportedChain, type SupportedChain, getChainId } from '../config/chains.js';
import { getProviderRegistry } from '../providers/index.js';

// Tenderly API (optional, best simulation quality)
const TENDERLY_API_KEY = process.env.TENDERLY_API_KEY;
const TENDERLY_ACCOUNT = process.env.TENDERLY_ACCOUNT || 'clara';
const TENDERLY_PROJECT = process.env.TENDERLY_PROJECT || 'clara-mcp';

/**
 * Tenderly network names
 */
const TENDERLY_NETWORKS: Record<SupportedChain, string> = {
  base: 'base',
  ethereum: 'mainnet',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  polygon: 'polygon',
};

/**
 * Tool definition for wallet_simulate
 */
export const simulateToolDefinition = {
  name: 'wallet_simulate',
  description: `Simulate a transaction to preview what will happen BEFORE sending.

Shows:
- ✅/❌ Whether the transaction will succeed
- 💰 Token balance changes (what you'll send/receive)
- ⛽ Estimated gas cost
- 📝 Decoded method call
- ⚠️ Potential issues or warnings

**Simulate a swap:**
\`\`\`json
{
  "to": "0x...",
  "data": "0x...",
  "value": "0",
  "chain": "base"
}
\`\`\`

**Simulate before wallet_send:**
\`\`\`json
{
  "to": "0xRecipient",
  "value": "0.1",
  "chain": "base"
}
\`\`\`

⚠️ Always simulate high-value transactions before sending!`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: {
        type: 'string',
        description: 'Target contract or recipient address',
      },
      value: {
        type: 'string',
        default: '0',
        description: 'ETH value to send (in ETH, not wei)',
      },
      data: {
        type: 'string',
        description: 'Transaction calldata (hex). Omit for simple ETH transfer.',
      },
      chain: {
        type: 'string',
        enum: ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'],
        default: 'base',
        description: 'Chain to simulate on',
      },
      from: {
        type: 'string',
        description: 'Sender address (defaults to your wallet address)',
      },
    },
    required: ['to'],
  },
};

/**
 * Common method signatures for decoding
 */
const KNOWN_METHODS: Record<string, string> = {
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x095ea7b3': 'approve(address,uint256)',
  '0x70a08231': 'balanceOf(address)',
  '0x18160ddd': 'totalSupply()',
  '0x313ce567': 'decimals()',
  '0x06fdde03': 'name()',
  '0x95d89b41': 'symbol()',
  '0x38ed1739': 'swapExactTokensForTokens(...)',
  '0x7ff36ab5': 'swapExactETHForTokens(...)',
  '0x18cbafe5': 'swapExactTokensForETH(...)',
  '0xfb3bdb41': 'swapETHForExactTokens(...)',
  '0x8803dbee': 'swapTokensForExactTokens(...)',
  '0x617ba037': 'supply(address,uint256,address,uint16)',
  '0x69328dec': 'withdraw(address,uint256,address)',
  '0xe8eda9df': 'deposit(address,uint256,address,uint16)',
  '0x2e1a7d4d': 'withdraw(uint256)',
  '0xd0e30db0': 'deposit()',
};

/**
 * Decode method selector to human-readable name (basic fallback)
 */
function decodeMethodBasic(data: string | undefined): string {
  if (!data || data === '0x' || data.length < 10) {
    return 'Native Transfer';
  }
  const selector = data.slice(0, 10).toLowerCase();
  return KNOWN_METHODS[selector] || `Unknown (${selector})`;
}

/**
 * Decoded method info with arguments
 */
interface DecodedMethodInfo {
  name: string;
  signature?: string;
  args?: Record<string, unknown>;
  summary?: string;
}

/**
 * Try to decode method using Herd's contract metadata
 */
async function decodeMethodWithHerd(
  to: string,
  data: string | undefined,
  chain: SupportedChain
): Promise<DecodedMethodInfo> {
  if (!data || data === '0x' || data.length < 10) {
    return { name: 'Native Transfer' };
  }

  const selector = data.slice(0, 10).toLowerCase();
  const basicName = KNOWN_METHODS[selector];

  // Try to get full metadata from Herd
  const registry = getProviderRegistry();

  if (!registry.hasCapability('ContractMetadata', chain)) {
    return { name: basicName || `Unknown (${selector})` };
  }

  try {
    const result = await registry.getContractMetadata({
      address: to,
      chain,
      detailLevel: 'functions',
      includeAbi: true,
    });

    if (!result.success || !result.data) {
      return { name: basicName || `Unknown (${selector})` };
    }

    const metadata = result.data;

    // Find the function by selector
    const func = metadata.functions.find(f => {
      // Compute selector from name and inputs
      const sig = `${f.name}(${f.inputs.map(i => i.type).join(',')})`;
      const hash = computeSelector(sig);
      return hash === selector;
    });

    if (!func) {
      return {
        name: basicName || `Unknown (${selector})`,
        summary: metadata.name ? `on ${metadata.name}` : undefined,
      };
    }

    // Try to decode arguments if we have the ABI
    let decodedArgs: Record<string, unknown> | undefined;

    if (metadata.abi && func) {
      try {
        const abi = metadata.abi as Abi;
        const decoded = decodeFunctionData({ abi, data: data as Hex });

        if (decoded.args && func.inputs) {
          decodedArgs = {};
          for (let i = 0; i < func.inputs.length; i++) {
            decodedArgs[func.inputs[i].name || `arg${i}`] = decoded.args[i];
          }
        }
      } catch {
        // ABI decode failed, continue without args
      }
    }

    const signature = `${func.name}(${func.inputs.map(i => `${i.type} ${i.name}`).join(', ')})`;

    return {
      name: func.name,
      signature,
      args: decodedArgs,
      summary: func.summary || (metadata.name ? `on ${metadata.name}` : undefined),
    };
  } catch {
    return { name: basicName || `Unknown (${selector})` };
  }
}

/**
 * Compute function selector (first 4 bytes of keccak256)
 */
function computeSelector(signature: string): string {
  // Simple keccak256 for selector computation
  // In production, use viem's toFunctionSelector
  const { keccak256, toBytes } = require('viem');
  try {
    const hash = keccak256(toBytes(signature));
    return hash.slice(0, 10).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Format argument value for display
 */
function formatArgValue(value: unknown): string {
  if (typeof value === 'string') {
    // Address
    if (value.match(/^0x[a-fA-F0-9]{40}$/)) {
      return `\`${value.slice(0, 10)}...${value.slice(-6)}\``;
    }
    // Hash
    if (value.match(/^0x[a-fA-F0-9]{64}$/)) {
      return `\`${value.slice(0, 14)}...\``;
    }
    // Large number string (likely wei)
    if (value.match(/^[0-9]{10,}$/)) {
      const num = BigInt(value);
      if (num >= BigInt(1e18)) {
        return `${(Number(num) / 1e18).toFixed(4)} (${value} wei)`;
      }
      if (num >= BigInt(1e6)) {
        return `${(Number(num) / 1e6).toFixed(2)} (6 decimals)`;
      }
    }
    return value.length > 50 ? `${value.slice(0, 50)}...` : value;
  }
  if (typeof value === 'bigint') {
    const num = value;
    if (num >= BigInt(1e18)) {
      return `${(Number(num) / 1e18).toFixed(4)} (${num.toString()} wei)`;
    }
    if (num >= BigInt(1e6)) {
      return `${(Number(num) / 1e6).toFixed(2)} (6 decimals)`;
    }
    return num.toString();
  }
  if (Array.isArray(value)) {
    if (value.length > 3) {
      return `[${value.slice(0, 3).map(v => formatArgValue(v)).join(', ')}, ...]`;
    }
    return `[${value.map(v => formatArgValue(v)).join(', ')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value).slice(0, 100);
  }
  return String(value);
}


/**
 * Tenderly simulation response types
 */
interface TenderlyAssetChange {
  token_info?: {
    symbol: string;
    decimals: number;
    contract_address: string;
  };
  type: 'Transfer' | 'Mint' | 'Burn';
  from: string;
  to: string;
  amount: string;
  raw_amount: string;
}

interface TenderlySimulation {
  status: boolean;
  gas_used: number;
  error_message?: string;
  transaction: {
    status: boolean;
    error_info?: {
      error_message: string;
      address?: string;
    };
    transaction_info?: {
      asset_changes?: TenderlyAssetChange[];
    };
  };
}

/**
 * Simulate via Tenderly API
 */
async function simulateWithTenderly(
  tx: { to: Hex; value: string; data?: Hex; from: Hex },
  chain: SupportedChain
): Promise<{
  success: boolean;
  gasUsed: number;
  error?: string;
  assetChanges: Array<{
    type: 'send' | 'receive';
    token: string;
    amount: string;
  }>;
}> {
  const chainConfig = CHAINS[chain];

  const response = await fetch(
    `https://api.tenderly.co/api/v1/account/${TENDERLY_ACCOUNT}/project/${TENDERLY_PROJECT}/simulate`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Key': TENDERLY_API_KEY!,
      },
      body: JSON.stringify({
        network_id: chainConfig.chainId.toString(),
        from: tx.from,
        to: tx.to,
        value: tx.value === '0' ? '0' : `0x${BigInt(Math.floor(parseFloat(tx.value) * 1e18)).toString(16)}`,
        input: tx.data || '0x',
        save: false,
        save_if_fails: false,
        simulation_type: 'quick',
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Tenderly API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json() as { simulation: TenderlySimulation };
  const sim = result.simulation;

  // Parse asset changes
  const assetChanges: Array<{ type: 'send' | 'receive'; token: string; amount: string }> = [];
  const changes = sim.transaction?.transaction_info?.asset_changes || [];

  for (const change of changes) {
    if (!change.token_info) continue;

    const isSend = change.from.toLowerCase() === tx.from.toLowerCase();
    const isReceive = change.to.toLowerCase() === tx.from.toLowerCase();

    if (isSend || isReceive) {
      const amount = formatUnits(
        BigInt(change.raw_amount),
        change.token_info.decimals
      );
      assetChanges.push({
        type: isSend ? 'send' : 'receive',
        token: change.token_info.symbol,
        amount,
      });
    }
  }

  return {
    success: sim.transaction?.status ?? sim.status,
    gasUsed: sim.gas_used,
    error: sim.transaction?.error_info?.error_message || sim.error_message,
    assetChanges,
  };
}

/**
 * Simulate via eth_call (fallback)
 */
async function simulateWithEthCall(
  tx: { to: Hex; value: string; data?: Hex; from: Hex },
  chain: SupportedChain
): Promise<{
  success: boolean;
  gasUsed: number;
  error?: string;
  assetChanges: Array<{ type: 'send' | 'receive'; token: string; amount: string }>;
}> {
  const chainConfig = CHAINS[chain];
  const client = createPublicClient({
    chain: chainConfig.chain,
    transport: http(getRpcUrl(chain)),
  });

  try {
    // Try to estimate gas (this will fail if tx would revert)
    const gasEstimate = await client.estimateGas({
      account: tx.from,
      to: tx.to,
      value: tx.value === '0' ? 0n : BigInt(Math.floor(parseFloat(tx.value) * 1e18)),
      data: tx.data as Hex | undefined,
    });

    // If we get here, the transaction would succeed
    // Note: eth_call doesn't give us asset changes, so we have limited info
    return {
      success: true,
      gasUsed: Number(gasEstimate),
      assetChanges: [], // Can't determine without trace
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Try to extract revert reason
    let revertReason = errorMessage;
    if (errorMessage.includes('execution reverted')) {
      const match = errorMessage.match(/reason: (.+?)(?:\n|$)/);
      if (match) revertReason = match[1];
    }

    return {
      success: false,
      gasUsed: 0,
      error: revertReason,
      assetChanges: [],
    };
  }
}

/**
 * Handle wallet_simulate requests
 */
export async function handleSimulateRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const to = args.to as string;
  const value = (args.value as string) || '0';
  const data = args.data as string | undefined;
  const chainName = (args.chain as string) || 'base';
  const fromOverride = args.from as string | undefined;

  // Validate inputs
  if (!to || !to.startsWith('0x') || to.length !== 42) {
    return {
      content: [{ type: 'text', text: '❌ Invalid target address. Must be a valid 0x address.' }],
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

  // Get session for from address
  const session = await getSession();
  if (!session?.authenticated || !session.address) {
    return {
      content: [{ type: 'text', text: '❌ Wallet not configured. Run `wallet_setup` first.' }],
      isError: true,
    };
  }

  await touchSession();

  const from = (fromOverride || session.address) as Hex;
  const chainConfig = CHAINS[chainName];

  try {
    // Decode method for display (enhanced with Herd)
    const methodInfo = await decodeMethodWithHerd(to, data, chainName);

    // Choose simulation method
    let result: {
      success: boolean;
      gasUsed: number;
      error?: string;
      assetChanges: Array<{ type: 'send' | 'receive'; token: string; amount: string }>;
    };

    let simulationSource: string;

    if (TENDERLY_API_KEY) {
      result = await simulateWithTenderly(
        { to: to as Hex, value, data: data as Hex | undefined, from },
        chainName
      );
      simulationSource = 'Tenderly';
    } else {
      result = await simulateWithEthCall(
        { to: to as Hex, value, data: data as Hex | undefined, from },
        chainName
      );
      simulationSource = 'eth_estimateGas';
    }

    // Format output
    const lines: string[] = [];

    // Status
    if (result.success) {
      lines.push('## ✅ Transaction would SUCCEED');
    } else {
      lines.push('## ❌ Transaction would FAIL');
      if (result.error) {
        lines.push('');
        lines.push(`**Error:** ${result.error}`);
      }
    }

    lines.push('');
    lines.push('### Transaction Details');

    // Method info with signature and arguments
    if (methodInfo.signature) {
      lines.push(`- **Method:** \`${methodInfo.signature}\``);
    } else {
      lines.push(`- **Method:** ${methodInfo.name}`);
    }

    if (methodInfo.summary) {
      lines.push(`  _${methodInfo.summary}_`);
    }

    // Show decoded arguments if available
    if (methodInfo.args && Object.keys(methodInfo.args).length > 0) {
      lines.push('');
      lines.push('**Arguments:**');
      for (const [name, value] of Object.entries(methodInfo.args)) {
        const formatted = formatArgValue(value);
        lines.push(`- \`${name}\`: ${formatted}`);
      }
    }

    lines.push(`- **To:** \`${to}\``);
    lines.push(`- **From:** \`${from}\``);
    lines.push(`- **Chain:** ${chainName}`);

    if (value !== '0') {
      lines.push(`- **Value:** ${value} ETH`);
    }

    // Gas estimate
    if (result.gasUsed > 0) {
      lines.push('');
      lines.push('### ⛽ Gas Estimate');
      lines.push(`- **Gas Units:** ${result.gasUsed.toLocaleString()}`);

      // Rough cost estimate (assuming ~30 gwei, varies by chain)
      const gasPrice = chainName === 'ethereum' ? 30 : chainName === 'polygon' ? 100 : 0.01;
      const costEth = (result.gasUsed * gasPrice) / 1e9;
      const costUsd = costEth * 2500; // Rough ETH price

      if (chainName === 'ethereum') {
        lines.push(`- **Est. Cost:** ~${costEth.toFixed(6)} ETH (~$${costUsd.toFixed(2)})`);
      } else {
        lines.push(`- **Est. Cost:** < $0.01 (L2)`);
      }
    }

    // Asset changes (Tenderly only)
    if (result.assetChanges.length > 0) {
      lines.push('');
      lines.push('### 💰 Balance Changes');

      for (const change of result.assetChanges) {
        const sign = change.type === 'send' ? '-' : '+';
        const emoji = change.type === 'send' ? '📤' : '📥';
        lines.push(`${emoji} ${sign}${change.amount} ${change.token}`);
      }
    } else if (TENDERLY_API_KEY && result.success) {
      lines.push('');
      lines.push('### 💰 Balance Changes');
      lines.push('_No token transfers detected_');
    }

    // Simulation source note
    lines.push('');
    lines.push(`_Simulated via ${simulationSource}_`);

    // Warning for failed transactions
    if (!result.success) {
      lines.push('');
      lines.push('⚠️ **Do not send this transaction** - it will fail and waste gas.');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      isError: !result.success,
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Simulation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
