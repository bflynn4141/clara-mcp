/**
 * Execute Tool
 *
 * Executes DeFi actions with mandatory simulation.
 * This is the final step in the suggest → simulate → confirm → execute flow.
 *
 * Safety is built-in:
 * - Always simulates first
 * - Shows expected balance changes
 * - Displays safety warnings (unverified, new contract, etc.)
 * - Requires explicit confirmation for dangerous actions
 */

import { isAddress } from 'viem';
import { getSession, touchSession } from '../storage/session.js';
import { isSupportedChain, getChainId, type SupportedChain } from '../config/chains.js';
import { analyzeToken } from '../intelligence/classifier.js';
import {
  suggestAction,
  generateClaimAction,
  generateDelegateAction,
  generateExitAction,
  generateReleaseAction,
  formatAction,
  type GeneratedAction,
} from '../intelligence/actions.js';
import {
  simulateWithSafetyChecks,
  formatSimulationResult,
  isSafeToProceed,
  type SimulationSafetyResult,
} from '../intelligence/safety.js';

/**
 * Tool definition for wallet_execute
 */
export const executeToolDefinition = {
  name: 'wallet_execute',
  description: `Execute a DeFi action with mandatory simulation.

**ALWAYS simulates before executing.** Shows expected outcomes and safety warnings.

**Supported actions:**
- \`claim\` - Claim pending rewards
- \`delegate\` - Delegate voting power (requires \`delegateTo\` address)
- \`exit\` - Exit staking position (unstake + claim)
- \`release\` - Release vested tokens

**Example - Claim rewards:**
\`\`\`json
{"contract": "0x...", "action": "claim", "chain": "base"}
\`\`\`

**Example - Delegate to self:**
\`\`\`json
{"contract": "0x...", "action": "delegate", "delegateTo": "self", "chain": "ethereum"}
\`\`\`

**Safety features:**
- Simulates transaction first
- Shows balance changes before execution
- Warns about unverified/new contracts
- Blocks transactions that would revert`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      contract: {
        type: 'string',
        description: 'Contract address to interact with (0x...)',
      },
      action: {
        type: 'string',
        enum: ['claim', 'delegate', 'exit', 'release'],
        description: 'Action to execute',
      },
      delegateTo: {
        type: 'string',
        description: 'For delegate action: address to delegate to (or "self")',
      },
      chain: {
        type: 'string',
        enum: ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'],
        default: 'base',
        description: 'Chain to execute on (default: base)',
      },
      // skipSimulation removed - simulation is now mandatory for safety
      confirmed: {
        type: 'boolean',
        default: false,
        description: 'Set to true after reviewing simulation to execute',
      },
    },
    required: ['contract', 'action'],
  },
};

/**
 * Handle execute request
 */
export async function handleExecuteRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const contract = typeof args.contract === 'string' ? args.contract : '';
  const action = typeof args.action === 'string' ? args.action : '';
  const delegateTo = typeof args.delegateTo === 'string' ? args.delegateTo : undefined;
  const chain = typeof args.chain === 'string' ? args.chain : 'base';
  // skipSimulation removed as a user-facing option (GPT-5.2 security recommendation)
  // Simulation is now mandatory for safety - only skip internally for testing
  const skipSimulation = false;
  const confirmed = args.confirmed === true;

  // Validate inputs
  if (!contract.match(/^0x[a-fA-F0-9]{40}$/)) {
    return {
      content: [{
        type: 'text',
        text: '❌ Invalid contract address. Must be a valid Ethereum address (0x... with 40 hex characters).',
      }],
      isError: true,
    };
  }

  if (!isSupportedChain(chain)) {
    return {
      content: [{
        type: 'text',
        text: `❌ Unsupported chain: ${chain}`,
      }],
      isError: true,
    };
  }

  // Get user session
  let userAddress: string;
  try {
    const session = await getSession();
    if (!session?.authenticated || !session.address) {
      return {
        content: [{
          type: 'text',
          text: '❌ No wallet connected. Run `wallet_setup` first.',
        }],
        isError: true,
      };
    }
    userAddress = session.address;
    await touchSession();
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Session error: ${error instanceof Error ? error.message : 'Unknown'}`,
      }],
      isError: true,
    };
  }

  try {
    // Step 1: Analyze the contract to get available functions
    const analysis = await analyzeToken(contract, chain, userAddress);

    if (!analysis.isVerified) {
      return {
        content: [{
          type: 'text',
          text: `⚠️ **Cannot execute on unverified contract**\n\nContract \`${contract}\` is not verified. We cannot safely generate transaction data without verified source code.\n\nIf you trust this contract, you can use \`wallet_send\` with raw calldata instead.`,
        }],
        isError: true,
      };
    }

    // Step 2: Generate the action
    let generatedAction: GeneratedAction | null = null;

    switch (action) {
      case 'claim':
        generatedAction = generateClaimAction(contract, analysis.availableFunctions, analysis.functionSignatures);
        break;

      case 'delegate':
        // Handle "self" delegation
        const delegateAddress = delegateTo === 'self' || !delegateTo ? userAddress : delegateTo;
        // Validate delegateTo is a valid address (GPT-5.2 security recommendation)
        if (delegateTo && delegateTo !== 'self' && !isAddress(delegateTo)) {
          return {
            content: [{
              type: 'text',
              text: `❌ Invalid delegate address: ${delegateTo}\n\nMust be a valid Ethereum address or "self".`,
            }],
            isError: true,
          };
        }
        generatedAction = generateDelegateAction(contract, delegateAddress, analysis.availableFunctions, analysis.functionSignatures);
        break;

      case 'exit':
        generatedAction = generateExitAction(contract, analysis.availableFunctions, analysis.functionSignatures);
        break;

      case 'release':
        generatedAction = generateReleaseAction(contract, analysis.availableFunctions, analysis.functionSignatures);
        break;

      default:
        return {
          content: [{
            type: 'text',
            text: `❌ Unknown action: ${action}\n\nSupported actions: claim, delegate, exit, release`,
          }],
          isError: true,
        };
    }

    if (!generatedAction) {
      // Provide helpful suggestions based on what functions ARE available
      const availableFns = analysis.availableFunctions.map(f => f.toLowerCase());
      const suggestions: string[] = [];

      if (action === 'claim' && availableFns.includes('exit')) {
        suggestions.push('This contract has `exit()` - use `action="exit"` to unstake and claim together');
      }
      if (action === 'delegate' && !availableFns.includes('delegate')) {
        suggestions.push('This token may not support delegation - try `wallet_analyze_holding` to understand its capabilities');
      }

      return {
        content: [{
          type: 'text',
          text: [
            `❌ Cannot generate \`${action}\` action for this contract.`,
            '',
            'The contract doesn\'t have the required function.',
            '',
            '**Available functions:**',
            ...analysis.availableFunctions.slice(0, 10).map(f => `- \`${f}\``),
            analysis.availableFunctions.length > 10 ? `- _...and ${analysis.availableFunctions.length - 10} more_` : '',
            '',
            suggestions.length > 0 ? '**💡 Suggestions:**' : '',
            ...suggestions.map(s => `- ${s}`),
            '',
            '**Tip:** Run `wallet_analyze_holding` on this contract to see what actions are possible.',
          ].filter(Boolean).join('\n'),
        }],
        isError: true,
      };
    }

    // Step 3: Simulate the transaction
    if (!skipSimulation) {
      const simulationResult = await simulateWithSafetyChecks(
        {
          to: generatedAction.contractAddress,
          data: generatedAction.calldata,
          value: generatedAction.value,
        },
        userAddress,
        chain as SupportedChain
      );

      // If not confirmed yet, show simulation and ask for confirmation
      if (!confirmed) {
        const output = formatSimulationForConfirmation(generatedAction, simulationResult, chain);
        return {
          content: [{
            type: 'text',
            text: output,
          }],
        };
      }

      // If confirmed but simulation shows it would fail, block execution
      if (!isSafeToProceed(simulationResult)) {
        return {
          content: [{
            type: 'text',
            text: `❌ **Execution blocked**\n\n${formatSimulationResult(simulationResult)}\n\n_Cannot proceed with a transaction that would fail or has critical warnings._`,
          }],
          isError: true,
        };
      }
    }

    // Step 4: Re-verify session before returning execution-ready transaction
    // (GPT-5.2 TOCTOU recommendation: user could switch accounts between confirmation)
    if (confirmed) {
      const currentSession = await getSession();
      if (!currentSession?.authenticated || currentSession.address !== userAddress) {
        return {
          content: [{
            type: 'text',
            text: '❌ **Session changed**\n\nYour wallet session has changed since the simulation. Please run the command again to re-simulate with the current account.',
          }],
          isError: true,
        };
      }
    }

    // Return the prepared transaction for execution
    // Includes explicit chainId, from address for signing verification
    return {
      content: [{
        type: 'text',
        text: formatExecutionReady(generatedAction, userAddress, chain),
      }],
    };

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

/**
 * Map internal ActionType to wallet_execute action parameter
 */
const ACTION_TYPE_TO_EXECUTE_ACTION: Record<string, string> = {
  'claim_rewards': 'claim',
  'delegate': 'delegate',
  'stake': 'stake',
  'unstake': 'unstake',
  'withdraw': 'withdraw',
  'release_vesting': 'release',
  'exit': 'exit',
};

/**
 * Format simulation result for user confirmation
 */
function formatSimulationForConfirmation(
  action: GeneratedAction,
  simulation: SimulationSafetyResult,
  chain: string
): string {
  const lines: string[] = [];

  lines.push('## 🔍 Transaction Preview');
  lines.push('');
  lines.push(formatAction(action));
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(formatSimulationResult(simulation));
  lines.push('');
  lines.push('---');
  lines.push('');

  if (simulation.willRevert) {
    lines.push('❌ **Cannot proceed** - Transaction would revert.');
  } else if (simulation.warnings.some(w => w.severity === 'danger')) {
    lines.push('⚠️ **Proceed with caution** - Critical warnings detected.');
    lines.push('');
    lines.push('To execute anyway, run the same command with `confirmed: true`');
  } else {
    lines.push('✅ **Ready to execute**');
    lines.push('');
    lines.push('To proceed, run the same command with `confirmed: true`');
    lines.push('');
    lines.push('```json');
    // Use proper mapping instead of string manipulation
    const executeAction = ACTION_TYPE_TO_EXECUTE_ACTION[action.type] || action.type;
    lines.push(`{"contract": "${action.contractAddress}", "action": "${executeAction}", "chain": "${chain}", "confirmed": true}`);
    lines.push('```');
  }

  return lines.join('\n');
}

/**
 * Format execution-ready message
 */
function formatExecutionReady(
  action: GeneratedAction,
  userAddress: string,
  chain: string
): string {
  const lines: string[] = [];

  lines.push('## ✅ Transaction Ready');
  lines.push('');
  lines.push(`**Action:** ${action.description}`);
  lines.push(`**Contract:** \`${action.contractAddress}\``);
  lines.push(`**Function:** \`${action.functionName}()\``);
  lines.push(`**Chain:** ${chain}`);
  lines.push('');
  lines.push('**Transaction Data:**');
  lines.push('```');
  lines.push(JSON.stringify({
    to: action.contractAddress,
    data: action.calldata,
    value: action.value || '0',
    from: userAddress,
    chainId: getChainId(chain as SupportedChain),
  }, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('Use `wallet_send` with this data to execute, or sign with your wallet directly.');

  return lines.join('\n');
}
