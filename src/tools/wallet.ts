/**
 * Wallet Management Tools
 *
 * Tools for wallet setup, status, and management.
 * These provide the session lifecycle that keeps wallets working.
 */

import { z } from 'zod';
import { setupWallet, getWalletStatus, logout } from '../para/client.js';
import { formatSpendingSummary } from '../storage/spending.js';

/**
 * wallet_setup tool definition
 */
export const setupToolDefinition = {
  name: 'wallet_setup',
  description: `Initialize your Clara wallet.

Two options:
- **Instant wallet** (no email): Creates a machine-specific wallet. Fast but only works on this device.
- **Portable wallet** (with email): Creates a wallet tied to your email. Can be recovered on any device and claimed at getpara.com.

If you already have a wallet configured, this returns the existing wallet.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      email: {
        type: 'string',
        description: 'Optional: Email for portable wallet (can recover on any machine, claim at getpara.com)',
      },
    },
  },
};

/**
 * wallet_status tool definition
 */
export const statusToolDefinition = {
  name: 'wallet_status',
  description: `Check your wallet status. Shows:
- Whether you're authenticated
- Your wallet address
- Supported chains
- Session age
- Current spending limits`,
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

/**
 * wallet_logout tool definition
 */
export const logoutToolDefinition = {
  name: 'wallet_logout',
  description: 'Clear your wallet session. You will need to run wallet_setup again to use wallet features.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

/**
 * Handle wallet tool requests
 */
export async function handleWalletToolRequest(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean } | null> {

  if (name === 'wallet_setup') {
    return handleSetup(args);
  }

  if (name === 'wallet_status') {
    return handleStatus();
  }

  if (name === 'wallet_logout') {
    return handleLogout();
  }

  return null;
}

/**
 * Handle wallet_setup
 */
async function handleSetup(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const email = args.email as string | undefined;

  try {
    const result = await setupWallet(email);

    const lines = [
      result.isNew ? '✅ Wallet created!' : '✅ Wallet ready!',
      '',
      `**Address:** \`${result.address}\``,
    ];

    if (result.email) {
      lines.push(`**Email:** ${result.email}`);
      lines.push('');
      lines.push('💡 *Portable wallet: You can recover this wallet on any device using the same email, or claim full custody at [getpara.com](https://getpara.com).*');
    } else {
      lines.push('');
      lines.push('💡 *Machine-specific wallet: Only accessible on this device. Run `wallet_setup` with an email for a portable wallet.*');
    }

    lines.push('');
    lines.push('**⚡ Get Started:**');
    lines.push('1. **Add credits** - Deposit USDC to use signing operations');
    lines.push('   - Run `wallet_credits` to see deposit instructions');
    lines.push('   - Minimum deposit: $0.10, each operation costs $0.001');
    lines.push('2. **Start using** - `wallet_pay_x402` for payments, `wallet_balance` for balances');
    lines.push('');
    lines.push('**🎯 Recommended next step:**');
    lines.push('Run `wallet_briefing` to get a personalized summary of your wallet activity and opportunities.');
    lines.push('');
    lines.push('**Useful commands:**');
    lines.push('- `wallet_briefing` - Get wallet insights and opportunities');
    lines.push('- `wallet_credits` - Check your credit balance');
    lines.push('- `wallet_status` - View wallet details');
    lines.push('- `wallet_spending_limits` - Configure spending controls');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

/**
 * Handle wallet_status
 */
async function handleStatus(): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  try {
    const status = await getWalletStatus();

    if (!status.authenticated) {
      return {
        content: [{
          type: 'text',
          text: [
            '❌ No wallet configured',
            '',
            'Run `wallet_setup` to create a wallet:',
            '- `wallet_setup` - Create instant (machine-specific) wallet',
            '- `wallet_setup email="you@example.com"` - Create portable wallet',
          ].join('\n'),
        }],
      };
    }

    const lines = [
      '✅ **Wallet Active**',
      '',
      `**Address:** \`${status.address}\``,
    ];

    if (status.email) {
      lines.push(`**Email:** ${status.email}`);
    }

    lines.push(`**Session Age:** ${status.sessionAge}`);
    lines.push(`**Chains:** ${status.chains?.join(', ') || 'EVM'}`);

    // Add spending summary
    lines.push('');
    lines.push('**Spending Limits:**');
    lines.push(formatSpendingSummary());

    // Suggest briefing for intelligence
    lines.push('');
    lines.push('💡 **Tip:** Run `wallet_briefing` for personalized insights on your holdings and opportunities.');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

/**
 * Handle wallet_logout
 */
async function handleLogout(): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  try {
    await logout();

    return {
      content: [{
        type: 'text',
        text: [
          '✅ Logged out',
          '',
          'Your wallet session has been cleared.',
          'Run `wallet_setup` to reconnect.',
        ].join('\n'),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
