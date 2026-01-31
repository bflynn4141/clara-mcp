#!/usr/bin/env npx tsx
/**
 * Clara Admin CLI
 *
 * Internal tool for tracking Clara wallet usage, credits, and spending.
 *
 * Usage:
 *   npx tsx scripts/clara-admin.ts stats           # System overview
 *   npx tsx scripts/clara-admin.ts users           # List all users
 *   npx tsx scripts/clara-admin.ts users --balances  # Include on-chain balances
 *   npx tsx scripts/clara-admin.ts user <address>  # User details
 *   npx tsx scripts/clara-admin.ts export          # Export to CSV
 *
 * Environment:
 *   CLARA_ADMIN_KEY - Admin API key (optional in dev mode)
 *   CLARA_PROXY_URL - Proxy URL (default: https://clara-proxy.bflynn-me.workers.dev)
 */

const PROXY_URL = process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn-me.workers.dev';
const ADMIN_KEY = process.env.CLARA_ADMIN_KEY || '';

interface StatsResponse {
  overview: {
    totalUsers: number;
    freeTierUsers: number;
    paidUsers: number;
    activeUsers24h: number;
  };
  operations: {
    total: number;
    pendingSettlement: number;
  };
  financials: {
    tvlUsdc: string;
    tvlFormatted: string;
    contractAddress: string;
  };
  freeTier: {
    limit: number;
    costEquivalent: string;
  };
  timestamp: string;
}

interface User {
  address: string;
  tier: 'free' | 'paid';
  operations: number;
  pendingOperations?: number;
  lastUsed: string | null;
  onChainBalance?: string;
}

interface UsersResponse {
  count: number;
  users: User[];
  note?: string;
}

interface UserDetailResponse {
  address: string;
  tier: 'free' | 'paid';
  freeTier: {
    used: number;
    limit: number;
    remaining: number;
    exhausted: boolean;
    lastUsed: string | null;
  };
  onChain: {
    balance: string;
    balanceFormatted: string;
    hasCredits: boolean;
    operationsAvailable: number;
  };
  pending: {
    operations: number;
    lastUpdated: string | null;
  };
  canSign: boolean;
}

async function fetchAdmin<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(endpoint, PROXY_URL);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  const response = await fetch(url.toString(), {
    headers: ADMIN_KEY ? { 'X-Admin-Key': ADMIN_KEY } : {},
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`API Error: ${error.error || response.statusText}`);
  }

  return response.json() as Promise<T>;
}

// ============================================
// Commands
// ============================================

async function commandStats() {
  console.log('📊 Clara System Stats\n');

  const stats = await fetchAdmin<StatsResponse>('/admin/stats');

  console.log('┌─────────────────────────────────────────┐');
  console.log('│  OVERVIEW                               │');
  console.log('├─────────────────────────────────────────┤');
  console.log(`│  Total Users:      ${String(stats.overview.totalUsers).padStart(18)} │`);
  console.log(`│  Free Tier:        ${String(stats.overview.freeTierUsers).padStart(18)} │`);
  console.log(`│  Paid Users:       ${String(stats.overview.paidUsers).padStart(18)} │`);
  console.log(`│  Active (24h):     ${String(stats.overview.activeUsers24h).padStart(18)} │`);
  console.log('├─────────────────────────────────────────┤');
  console.log('│  OPERATIONS                             │');
  console.log('├─────────────────────────────────────────┤');
  console.log(`│  Total:            ${String(stats.operations.total).padStart(18)} │`);
  console.log(`│  Pending:          ${String(stats.operations.pendingSettlement).padStart(18)} │`);
  console.log('├─────────────────────────────────────────┤');
  console.log('│  FINANCIALS                             │');
  console.log('├─────────────────────────────────────────┤');
  console.log(`│  TVL:              ${stats.financials.tvlFormatted.padStart(18)} │`);
  console.log(`│  Free Tier Value:  ${stats.freeTier.costEquivalent.padStart(18)} │`);
  console.log('└─────────────────────────────────────────┘');
  console.log(`\nContract: ${stats.financials.contractAddress}`);
  console.log(`Updated: ${new Date(stats.timestamp).toLocaleString()}`);
}

async function commandUsers(includeBalances: boolean) {
  console.log('👥 Clara Users\n');

  const params = includeBalances ? { balances: 'true' } : undefined;
  const data = await fetchAdmin<UsersResponse>('/admin/users', params);

  if (data.count === 0) {
    console.log('No users found.');
    return;
  }

  // Table header
  const headers = includeBalances
    ? ['Address', 'Tier', 'Operations', 'Pending', 'Balance', 'Last Used']
    : ['Address', 'Tier', 'Operations', 'Pending', 'Last Used'];

  console.log(headers.join('\t'));
  console.log('-'.repeat(100));

  for (const user of data.users) {
    const shortAddr = `${user.address.slice(0, 6)}...${user.address.slice(-4)}`;
    const lastUsed = user.lastUsed ? new Date(user.lastUsed).toLocaleDateString() : '-';
    const pending = user.pendingOperations ?? 0;

    if (includeBalances) {
      const balance = user.onChainBalance
        ? `$${(parseInt(user.onChainBalance) / 1e6).toFixed(2)}`
        : '-';
      console.log(`${shortAddr}\t${user.tier}\t${user.operations}\t\t${pending}\t\t${balance}\t\t${lastUsed}`);
    } else {
      console.log(`${shortAddr}\t${user.tier}\t${user.operations}\t\t${pending}\t\t${lastUsed}`);
    }
  }

  console.log(`\nTotal: ${data.count} users`);
  if (data.note) {
    console.log(`Note: ${data.note}`);
  }
}

async function commandUser(address: string) {
  console.log(`👤 User Details: ${address}\n`);

  const data = await fetchAdmin<UserDetailResponse>(`/admin/user/${address}`);

  console.log('┌─────────────────────────────────────────┐');
  console.log(`│  Address: ${data.address.slice(0, 20)}...${data.address.slice(-8)}`);
  console.log(`│  Tier: ${data.tier.toUpperCase()}`);
  console.log(`│  Can Sign: ${data.canSign ? '✅ Yes' : '❌ No'}`);
  console.log('├─────────────────────────────────────────┤');
  console.log('│  FREE TIER                              │');
  console.log('├─────────────────────────────────────────┤');
  console.log(`│  Used:       ${String(data.freeTier.used).padStart(8)} / ${data.freeTier.limit}`);
  console.log(`│  Remaining:  ${String(data.freeTier.remaining).padStart(8)} ops`);
  console.log(`│  Exhausted:  ${data.freeTier.exhausted ? 'Yes' : 'No'}`);
  if (data.freeTier.lastUsed) {
    console.log(`│  Last Used:  ${new Date(data.freeTier.lastUsed).toLocaleString()}`);
  }
  console.log('├─────────────────────────────────────────┤');
  console.log('│  ON-CHAIN CREDITS                       │');
  console.log('├─────────────────────────────────────────┤');
  console.log(`│  Balance:    ${data.onChain.balanceFormatted.padStart(12)}`);
  console.log(`│  Has Credits: ${data.onChain.hasCredits ? 'Yes' : 'No'}`);
  console.log(`│  Ops Available: ${String(data.onChain.operationsAvailable).padStart(8)}`);
  console.log('├─────────────────────────────────────────┤');
  console.log('│  PENDING SETTLEMENT                     │');
  console.log('├─────────────────────────────────────────┤');
  console.log(`│  Operations: ${String(data.pending.operations).padStart(8)}`);
  if (data.pending.lastUpdated) {
    console.log(`│  Last Updated: ${new Date(data.pending.lastUpdated).toLocaleString()}`);
  }
  console.log('└─────────────────────────────────────────┘');
}

async function commandExport() {
  console.log('📁 Exporting Clara data to CSV...\n');

  const data = await fetchAdmin<UsersResponse>('/admin/users', { balances: 'true' });

  // CSV header
  const csv = [
    'address,tier,operations,pending_operations,on_chain_balance_usdc,last_used',
    ...data.users.map((u) => {
      const balance = u.onChainBalance ? (parseInt(u.onChainBalance) / 1e6).toFixed(6) : '0';
      const lastUsed = u.lastUsed || '';
      return `${u.address},${u.tier},${u.operations},${u.pendingOperations || 0},${balance},${lastUsed}`;
    }),
  ].join('\n');

  const filename = `clara-users-${new Date().toISOString().split('T')[0]}.csv`;
  const fs = await import('fs/promises');
  await fs.writeFile(filename, csv);

  console.log(`✅ Exported ${data.count} users to ${filename}`);
}

// ============================================
// Main
// ============================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help') {
    console.log(`
Clara Admin CLI

Usage:
  clara-admin stats              System overview (users, TVL, operations)
  clara-admin users              List all users
  clara-admin users --balances   List users with on-chain balances
  clara-admin user <address>     Detailed user analytics
  clara-admin export             Export all data to CSV

Environment Variables:
  CLARA_ADMIN_KEY    Admin API key (optional if proxy has no ADMIN_KEY set)
  CLARA_PROXY_URL    Proxy URL (default: https://clara-proxy.bflynn-me.workers.dev)
`);
    return;
  }

  try {
    switch (command) {
      case 'stats':
        await commandStats();
        break;

      case 'users':
        const includeBalances = args.includes('--balances');
        await commandUsers(includeBalances);
        break;

      case 'user':
        const address = args[1];
        if (!address) {
          console.error('❌ Missing address. Usage: clara-admin user <address>');
          process.exit(1);
        }
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
          console.error('❌ Invalid Ethereum address format');
          process.exit(1);
        }
        await commandUser(address);
        break;

      case 'export':
        await commandExport();
        break;

      default:
        console.error(`❌ Unknown command: ${command}`);
        console.log('Run "clara-admin help" for usage.');
        process.exit(1);
    }
  } catch (error) {
    console.error(`❌ Error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

main();
