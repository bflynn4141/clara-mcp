/**
 * ENS Register Tool
 *
 * Multi-step tool for registering .eth names on Ethereum mainnet.
 * Uses the commit-reveal pattern required by ENS:
 *
 * Step 1 (action=commit):   Submit commitment hash (prevents front-running)
 * Step 2 (action=register): Register the name with ETH payment (after 60s wait)
 *
 * Follows the multi-action pattern from src/tools/swap.ts.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Hex } from 'viem';
import { formatEther } from 'viem';
import { signAndSendTransaction } from '../para/transactions.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import { CHAINS, getExplorerTxUrl } from '../config/chains.js';
import {
  ENS_CONTRACTS,
  MIN_COMMITMENT_AGE,
  DEFAULT_REGISTRATION_DURATION,
} from '../config/ens-contracts.js';
import {
  checkAvailability,
  getRentPrice,
  formatPrice,
  prepareCommitment,
  prepareRegistration,
  validateENSName,
} from '../services/ens.js';

/**
 * Tool definition for wallet_register_ens
 */
export const ensRegisterToolDefinition: Tool = {
  name: 'wallet_register_ens',
  description: `Register an ENS (.eth) name on Ethereum mainnet.

ENS registration uses a 2-step commit-reveal process to prevent front-running:

**Step 1 — Commit:**
- \`{"name": "myname", "action": "commit"}\`
- Submits a secret commitment hash (small gas cost)
- Returns a secret and timestamp — SAVE THESE

**Step 2 — Register (after 60+ seconds):**
- \`{"name": "myname", "action": "register", "secret": "0x..."}\`
- Completes registration with ETH payment
- Must use the same secret from step 1

**Options:**
- \`years\`: Registration duration (default: 1 year)
- \`setReverseRecord\`: Set this name as your primary ENS name (default: true)

**Pricing:** 3-char names ~$640/yr, 4-char ~$160/yr, 5+ char ~$5/yr.
Registration is on Ethereum mainnet — requires ETH for gas + registration fee.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'ENS name to register (e.g., "myname" or "myname.eth")',
      },
      action: {
        type: 'string',
        enum: ['commit', 'register'],
        description: 'commit = step 1 (submit commitment), register = step 2 (complete registration)',
      },
      years: {
        type: 'number',
        description: 'Registration duration in years (default: 1)',
        default: 1,
      },
      secret: {
        type: 'string',
        description: 'Secret from the commit step (required for action=register)',
      },
    },
    required: ['name', 'action'],
  },
};

/**
 * Handle wallet_register_ens requests
 */
export async function handleEnsRegisterRequest(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const rawName = args.name as string;
  const action = args.action as string;
  const years = (args.years as number) || 1;
  const secretArg = args.secret as string | undefined;

  if (!rawName) {
    return {
      content: [{ type: 'text', text: '❌ Missing required parameter: name' }],
      isError: true,
    };
  }

  if (!action || !['commit', 'register'].includes(action)) {
    return {
      content: [{
        type: 'text',
        text: '❌ Missing or invalid action. Use "commit" (step 1) or "register" (step 2).',
      }],
      isError: true,
    };
  }

  try {
    // Validate name first
    const name = validateENSName(rawName);
    const durationSeconds = Math.floor(years * 365 * 24 * 60 * 60);
    const session = ctx.session;
    const ownerAddress = ctx.walletAddress;

    // ═══════════════════════════════════════════════════════════════
    // COMMIT ACTION — Step 1: Submit commitment hash
    // ═══════════════════════════════════════════════════════════════
    if (action === 'commit') {
      // Check availability first
      const availability = await checkAvailability(name);
      if (!availability.available) {
        const lines = [`❌ **${name}.eth** is already taken.`];
        if (availability.currentOwner) {
          lines.push(`**Owner:** \`${availability.currentOwner}\``);
        }
        lines.push('', 'Use `wallet_ens_check` to find an available name.');
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          isError: true,
        };
      }

      // Get price estimate
      const price = await getRentPrice(name, durationSeconds);

      // Prepare the commitment
      const commitData = await prepareCommitment(
        name,
        ownerAddress,
        durationSeconds,
      );

      // Submit the commit transaction on Ethereum mainnet
      const result = await signAndSendTransaction(session.walletId!, {
        to: ENS_CONTRACTS.ETH_REGISTRAR_CONTROLLER,
        value: 0n,
        data: commitData.commitCalldata,
        chainId: CHAINS.ethereum.chainId,
      });

      const explorerUrl = getExplorerTxUrl('ethereum', result.txHash);
      const now = Math.floor(Date.now() / 1000);
      const readyAt = now + MIN_COMMITMENT_AGE;

      const lines = [
        `✅ **Commitment submitted for ${name}.eth!**`,
        '',
        `**Transaction:** [${result.txHash.slice(0, 10)}...${result.txHash.slice(-8)}](${explorerUrl})`,
        '',
        '---',
        '',
        '**Next step — Register (after 60 seconds):**',
        '',
        '```',
        `wallet_register_ens name="${name}" action="register" secret="${commitData.secret}"`,
        '```',
        '',
        `**Ready at:** ~${new Date(readyAt * 1000).toISOString()}`,
        '',
        '**Registration cost:**',
        formatPrice(price),
        `+ ~10% buffer for price fluctuation`,
        '',
        `⚠️ **IMPORTANT:** Save the secret above! You need it for step 2.`,
        `The commitment expires in 24 hours.`,
      ];

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // REGISTER ACTION — Step 2: Complete registration with payment
    // ═══════════════════════════════════════════════════════════════
    if (action === 'register') {
      if (!secretArg || !secretArg.startsWith('0x')) {
        return {
          content: [{
            type: 'text',
            text: '❌ Missing or invalid secret. Provide the secret from the commit step.',
          }],
          isError: true,
        };
      }

      // Re-check availability (in case someone else registered it between commit and register)
      const availability = await checkAvailability(name);
      if (!availability.available) {
        return {
          content: [{
            type: 'text',
            text: `❌ **${name}.eth** is no longer available. Someone else registered it before your commitment was completed.`,
          }],
          isError: true,
        };
      }

      // Prepare the register calldata and value
      const registerData = await prepareRegistration(
        name,
        ownerAddress,
        secretArg as Hex,
        durationSeconds,
      );

      // Submit the register transaction with ETH payment
      const result = await signAndSendTransaction(session.walletId!, {
        to: ENS_CONTRACTS.ETH_REGISTRAR_CONTROLLER,
        value: registerData.value,
        data: registerData.registerCalldata,
        chainId: CHAINS.ethereum.chainId,
      });

      const explorerUrl = getExplorerTxUrl('ethereum', result.txHash);
      const price = await getRentPrice(name, durationSeconds);

      const lines = [
        `🎉 **${name}.eth registered!**`,
        '',
        `**Owner:** \`${ownerAddress}\``,
        `**Duration:** ${price.durationLabel}`,
        `**Cost:** ${price.totalPriceEth} ETH`,
        `**Value sent:** ${formatEther(registerData.value)} ETH (includes 10% buffer — excess is refunded)`,
        '',
        `**Transaction:** [${result.txHash.slice(0, 10)}...${result.txHash.slice(-8)}](${explorerUrl})`,
        '',
        `Your reverse record has been set — \`${ownerAddress}\` now resolves to **${name}.eth**.`,
      ];

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }

    // Should never reach here due to validation above
    return {
      content: [{ type: 'text', text: '❌ Invalid action.' }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ ENS registration failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
