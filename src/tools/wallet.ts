/**
 * Wallet Management Tools
 *
 * Tools for wallet setup, status, and management.
 * These provide the session lifecycle that keeps wallets working.
 */

import { z } from 'zod';
import { setupWallet, getWalletStatus, logout } from '../para/client.js';
import { formatSpendingSummary } from '../storage/spending.js';
import { getSession, touchSession } from '../storage/session.js';
import {
  resolveIdentity,
  SUPPORTED_CHAIN_IDS,
  CHAIN_NAMES,
  DEFAULT_CHAIN_ID,
  type SupportedChainId,
} from '../identity/resolved-identity.js';
import { getParaApiBase } from '../para/transactions.js';

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
- Your wallet address and identity binding
- Supported chains and session age
- Current spending limits

Use \`debug: true\` to include auth header diagnostics and optional connection test.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      chainId: {
        type: 'number',
        description: `Target chain ID to validate identity for. Defaults to ${DEFAULT_CHAIN_ID} (Base). Supported: ${SUPPORTED_CHAIN_IDS.join(', ')}`,
      },
      debug: {
        type: 'boolean',
        description: 'Include detailed auth debugging info (computed headers, identity binding, Para API base). Defaults to false.',
      },
      testConnection: {
        type: 'boolean',
        description: 'If true (requires debug: true), makes a test request to Para to validate auth. Defaults to false.',
      },
    },
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
 * Handle wallet_setup
 */
export async function handleSetupRequest(
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
    lines.push('**🎯 Next steps:**');
    lines.push('1. **Claim a name** — `wallet_register_name name="yourname"` → get yourname.claraid.eth (free, instant)');
    lines.push('2. **Get gas** — `wallet_sponsor_gas` → free ETH for your first transactions');
    lines.push('3. **Start using** — `wallet_send`, `wallet_swap`, `wallet_call` for DeFi operations');

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
 * Handle wallet_status (consolidated from session-status, debug-auth)
 */
export async function handleStatusRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const chainId = (args.chainId as number) || DEFAULT_CHAIN_ID;
  const debug = (args.debug as boolean) || false;
  const testConnection = (args.testConnection as boolean) || false;

  try {
    const status = await getWalletStatus();
    const session = await getSession();
    await touchSession();

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

    // ── Session identity (from session-status.ts) ──
    const identityResult = await resolveIdentity(chainId);

    if (identityResult.success) {
      const chainName = CHAIN_NAMES[chainId as SupportedChainId] || `chain:${chainId}`;
      lines.push(`**Chain:** ${chainName} (${chainId})`);
      lines.push(`**Wallet Backend:** ${identityResult.identity.walletBackend}`);
      lines.push(`**Session Marker:** ${identityResult.identity.sessionMarker}`);
    }

    // Session age
    if (session?.createdAt) {
      const ageMs = Date.now() - new Date(session.createdAt).getTime();
      lines.push(`**Session Age:** ${formatDuration(ageMs)}`);
    } else {
      lines.push(`**Session Age:** ${status.sessionAge}`);
    }

    // Supported chains
    lines.push('');
    lines.push('**Supported Chains:**');
    for (const id of SUPPORTED_CHAIN_IDS) {
      const marker = id === chainId ? ' <-- selected' : '';
      lines.push(`- ${CHAIN_NAMES[id]} (${id})${marker}`);
    }

    // ── Spending limits ──
    lines.push('');
    lines.push('**Spending Limits:**');
    lines.push(formatSpendingSummary());

    // ── Debug auth (from debug-auth.ts, opt-in) ──
    if (debug) {
      lines.push('');
      lines.push(await formatDebugSection(chainId, session, identityResult, testConnection));
    }

    lines.push('');
    lines.push('**Tip:** Run `wallet_dashboard` for a full portfolio overview, or `wallet_opportunities` to find yield.');

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

// ── Helper: Format debug auth section ──

async function formatDebugSection(
  chainId: number,
  session: Awaited<ReturnType<typeof getSession>>,
  identityResult: Awaited<ReturnType<typeof resolveIdentity>>,
  testConnection: boolean
): Promise<string> {
  const lines = ['## Auth Debug Report', ''];

  // Auth status
  let authStatus: string;
  if (!session?.authenticated) {
    authStatus = '❌ AUTH_MISSING';
  } else if (!identityResult.success && identityResult.errorCode === 'SESSION_EXPIRED') {
    authStatus = '⏰ AUTH_EXPIRED';
  } else if (!identityResult.success) {
    authStatus = '❌ AUTH_MISSING';
  } else {
    authStatus = '✅ AUTH_OK';
  }

  lines.push(`**Status:** ${authStatus}`);
  lines.push('');

  // Computed headers
  const addressHeader = session?.address
    ? redactAddress(session.address)
    : '(not set)';
  lines.push('**Computed Headers:**');
  lines.push('```');
  lines.push(`X-Clara-Address: ${addressHeader}`);
  lines.push(`Content-Type: application/json`);
  lines.push('```');
  lines.push('');

  // Identity binding
  lines.push('**Identity Binding:**');
  lines.push(`- Wallet ID: \`${session?.walletId || '(not set)'}\``);
  lines.push(`- Address: \`${session?.address || '(not set)'}\``);
  lines.push(`- Chain ID: ${chainId}`);
  lines.push(`- Para API: ${getParaApiBase()}`);

  // Hint from identity resolution
  if (!identityResult.success && identityResult.hint) {
    lines.push('');
    lines.push(`**Hint:** ${identityResult.hint}`);
  }

  // Optional connection test
  if (testConnection && identityResult.success) {
    lines.push('');
    const testResult = await testParaConnection(
      identityResult.identity.walletId,
      identityResult.identity.address
    );
    lines.push('**Server Validation:**');
    lines.push(
      testResult.success
        ? `✅ ${testResult.message}`
        : `❌ ${testResult.message}`
    );
  }

  return lines.join('\n');
}

// ── Helper: Test Para connection ──

async function testParaConnection(
  walletId: string,
  address: string
): Promise<{ success: boolean; message: string }> {
  try {
    const paraBase = getParaApiBase();
    const response = await fetch(`${paraBase}/api/v1/wallets`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Clara-Address': address,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        message: `Para API returned ${response.status}: ${text.slice(0, 200)}`,
      };
    }

    const data = await response.json();
    const wallets = Array.isArray(data) ? data : data.wallets || [];
    const ourWallet = wallets.find(
      (w: { id?: string; address?: string }) =>
        w.id === walletId || w.address?.toLowerCase() === address.toLowerCase()
    );

    if (ourWallet) {
      return {
        success: true,
        message: `Wallet ${walletId.slice(0, 8)}... verified with Para`,
      };
    } else {
      return {
        success: false,
        message: `Wallet ${walletId.slice(0, 8)}... not found in Para response`,
      };
    }
  } catch (error) {
    return {
      success: false,
      message: `Connection error: ${error instanceof Error ? error.message : 'Unknown'}`,
    };
  }
}

// ── Helper: Redact address for security ──

function redactAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// ── Helper: Format milliseconds as human-readable duration ──

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Handle wallet_logout
 */
export async function handleLogoutRequest(
  _args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
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
