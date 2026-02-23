/**
 * CLI Onboarding Wizard for Clara
 *
 * Interactive setup wizard that runs once after install.
 * Handles wallet creation, recovery email, health check,
 * and MCP config guidance.
 *
 * Usage:
 *   clara-mcp setup                    # Interactive wizard
 *   clara-mcp setup --email user@x.com # Non-interactive with email
 *   clara-mcp setup --device-only      # Non-interactive, no email
 *   clara-mcp status                   # Quick status check
 *   clara-mcp logout                   # Clear wallet session
 *   clara-mcp name register <label>    # Register a .claraid.eth subname
 *   clara-mcp name lookup <label>      # Look up a subname
 *   clara-mcp name reverse <address>   # Reverse lookup an address
 *
 * @clack/prompts provides the interactive UI (intro, outro, text, confirm, spinner, note)
 * picocolors provides lightweight terminal coloring (3.8kb, zero deps)
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

import { setupWallet, getWalletStatus, logout } from '../para/client.js';
import { getSession } from '../storage/session.js';

const GATEWAY_BASE =
  process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn4141.workers.dev';
const PARENT_DOMAIN = 'claraid.eth';

// ─── Flag Parsing ───────────────────────────────────────────────────

interface CliFlags {
  email?: string;
  deviceOnly: boolean;
}

/**
 * Parse --email and --device-only from argv.
 * Simple loop instead of a dep (only 2 flags).
 */
function parseFlags(): CliFlags {
  const args = process.argv.slice(3); // skip: node, script, 'setup'
  const flags: CliFlags = { deviceOnly: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email' && args[i + 1]) {
      flags.email = args[i + 1];
      i++; // skip value
    } else if (args[i] === '--device-only') {
      flags.deviceOnly = true;
    }
  }

  return flags;
}

// ─── Helpers ────────────────────────────────────────────────────────

function shortAddr(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function validateEmail(value: string | undefined): string | undefined {
  if (!value) return undefined; // Empty = skip (device-only escape hatch)
  if (!/@.*\./.test(value)) return 'Please enter a valid email address';
  return undefined;
}

/**
 * Check if ~/.mcp.json already has Clara configured.
 * Looks for both top-level "clara" key and nested "mcpServers.clara".
 */
async function checkMcpConfig(): Promise<boolean> {
  try {
    const mcpPath = join(homedir(), '.mcp.json');
    const content = await readFile(mcpPath, 'utf-8');
    const config = JSON.parse(content);
    return !!config.clara || !!config?.mcpServers?.clara;
  } catch {
    return false;
  }
}

// ─── Health Check ───────────────────────────────────────────────────

interface HealthResult {
  wallet: boolean;
  walletAddress?: string;
  proxy: boolean;
  session: boolean;
}

async function runHealthCheck(): Promise<HealthResult> {
  const result: HealthResult = { wallet: false, proxy: false, session: false };

  // Check wallet status
  try {
    const status = await getWalletStatus();
    result.wallet = status.authenticated;
    result.walletAddress = status.address;
    result.session = status.authenticated;
  } catch {
    // Wallet check failed — not fatal
  }

  // Check proxy connectivity
  const proxyUrl = process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn4141.workers.dev';
  try {
    const resp = await fetch(`${proxyUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    result.proxy = resp.ok;
  } catch {
    // Proxy unreachable — not fatal
  }

  return result;
}

// ─── Interactive Wizard ─────────────────────────────────────────────

export async function runSetupWizard(): Promise<void> {
  const flags = parseFlags();

  // Non-interactive modes
  if (flags.email || flags.deviceOnly) {
    await runNonInteractive(flags);
    return;
  }

  // Interactive mode
  p.intro(pc.bgCyan(pc.black(' Clara Wallet Setup ')));

  // Step 0: Check existing session
  const existingSession = await getSession();
  if (existingSession?.authenticated && existingSession.address) {
    const authExpired =
      !existingSession.authExpiresAt ||
      new Date(existingSession.authExpiresAt).getTime() < Date.now();

    if (!authExpired) {
      p.log.info(
        `Existing wallet found: ${pc.cyan(shortAddr(existingSession.address))}`
      );
      if (existingSession.email) {
        p.log.info(`Recovery: ${existingSession.email}`);
      }

      const continueExisting = await p.confirm({
        message: 'Continue with existing wallet?',
        initialValue: true,
      });

      if (p.isCancel(continueExisting)) {
        p.cancel('Setup cancelled.');
        process.exit(0);
      }

      if (continueExisting) {
        // Skip to health check + summary
        await showHealthCheck();
        await showDepositInfo(existingSession.address);
        await showMcpConfig();
        showSummary(existingSession.address, existingSession.email);
        return;
      }
      // User wants to switch — fall through to email input
    }
  }

  // Step 1: Email input (email-first design — default path collects email)
  const emailInput = await p.text({
    message: 'Enter your recovery email:',
    placeholder: 'you@example.com (press Enter to skip)',
    validate: validateEmail,
  });

  if (p.isCancel(emailInput)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  const email = emailInput.trim() || undefined;

  if (!email) {
    p.log.warn(
      'Device-only wallet. Not recoverable if you switch machines.'
    );
    p.log.info(`Add email later: ${pc.cyan('clara-mcp setup')}`);
  }

  // Step 2: Create/recover wallet
  const s = p.spinner();
  s.start(email ? 'Creating wallet...' : 'Creating device wallet...');

  try {
    const result = await setupWallet(email, true);

    if (result.isNew) {
      s.stop(`Wallet created: ${pc.cyan(shortAddr(result.address))}`);
    } else {
      s.stop(`Connected to: ${pc.cyan(shortAddr(result.address))}`);
      if (email) {
        p.log.info('Wallet already exists for this email.');
      }
    }

    // Step 3: Health check
    await showHealthCheck();

    // Step 4: Deposit info
    await showDepositInfo(result.address);

    // Step 5: MCP config
    await showMcpConfig();

    // Step 6: Summary
    showSummary(result.address, result.email);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    s.stop(`Setup failed: ${msg}`);
    p.log.error(`Try again: ${pc.cyan('clara-mcp setup')}`);
    process.exit(1);
  }
}

// ─── Sub-steps ──────────────────────────────────────────────────────

async function showHealthCheck(): Promise<void> {
  const s = p.spinner();
  s.start('Running health check...');

  const health = await runHealthCheck();

  s.stop('Health check complete');

  if (health.wallet && health.walletAddress) {
    p.log.success(`Wallet address: ${health.walletAddress}`);
  } else {
    p.log.warn('Wallet: not authenticated');
  }

  if (health.proxy) {
    p.log.success('Clara proxy: reachable');
  } else {
    p.log.warn('Clara proxy: unreachable (check CLARA_PROXY_URL)');
  }

  if (health.session) {
    p.log.success('Session: active');
  } else {
    p.log.warn('Session: inactive');
  }
}

async function showDepositInfo(address: string): Promise<void> {
  const showDeposit = await p.confirm({
    message: 'Want to see how to fund your wallet?',
    initialValue: false,
  });

  if (p.isCancel(showDeposit) || !showDeposit) return;

  p.note(
    [
      `Address: ${address}`,
      `Chain:   Base (recommended)`,
      '',
      'Send ETH or USDC to your address on',
      'Base to get started.',
      '',
      'Bridge:  https://bridge.base.org',
      'Custody: https://getpara.com',
    ].join('\n'),
    'Fund Your Wallet'
  );
}

async function showMcpConfig(): Promise<void> {
  const hasMcpConfig = await checkMcpConfig();

  if (hasMcpConfig) {
    p.log.success('MCP config detected in ~/.mcp.json');
    return;
  }

  p.note(
    [
      'Add to ~/.mcp.json:',
      '',
      '{',
      '  "clara": {',
      '    "type": "stdio",',
      '    "command": "npx",',
      '    "args": ["clara-mcp"]',
      '  }',
      '}',
    ].join('\n'),
    'Claude Code MCP Config'
  );
}

function showSummary(address: string, email?: string): void {
  p.note(
    [
      `Address:  ${address}`,
      `Recovery: ${email || 'none (device-only)'}`,
      `Chain:    Base`,
      `Config:   ~/.clara/session.enc`,
    ].join('\n'),
    'Setup Complete'
  );

  p.outro(
    [
      'Your wallet is ready!',
      '',
      `  Check status:  ${pc.cyan('clara-mcp status')}`,
      `  Reset wallet:  ${pc.cyan('clara-mcp setup --device-only')}`,
      `  Full custody:  ${pc.cyan('https://getpara.com')}`,
    ].join('\n')
  );
}

// ─── Non-Interactive Mode ───────────────────────────────────────────

async function runNonInteractive(flags: CliFlags): Promise<void> {
  const email = flags.deviceOnly ? undefined : flags.email;

  console.log(pc.cyan('Clara Wallet Setup (non-interactive)'));
  console.log('');

  if (!email) {
    console.log(
      pc.yellow('! Device-only wallet (not recoverable across machines)')
    );
  }

  try {
    const result = await setupWallet(email, true);

    if (result.isNew) {
      console.log(pc.green(`✔ Wallet created: ${result.address}`));
    } else {
      console.log(pc.green(`✔ Connected to: ${result.address}`));
    }

    if (result.email) {
      console.log(`  Recovery: ${result.email}`);
    }

    // Health check
    const health = await runHealthCheck();
    console.log('');
    console.log(
      health.proxy
        ? pc.green('✔ Clara proxy: reachable')
        : pc.yellow('! Clara proxy: unreachable')
    );
    console.log(
      health.session
        ? pc.green('✔ Session: active')
        : pc.yellow('! Session: inactive')
    );

    // Summary
    console.log('');
    console.log(`Address:  ${result.address}`);
    console.log(`Recovery: ${result.email || 'none (device-only)'}`);
    console.log(`Chain:    Base`);
    console.log(`Config:   ~/.clara/session.enc`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(pc.red(`✗ Setup failed: ${msg}`));
    console.error('  Try again: clara-mcp setup');
    process.exit(1);
  }
}

// ─── Status Check ───────────────────────────────────────────────────

export async function runStatusCheck(): Promise<void> {
  console.log(pc.cyan('Clara Wallet Status'));
  console.log('');

  const status = await getWalletStatus();

  if (!status.authenticated) {
    console.log(pc.yellow('! No active wallet session'));
    console.log(`  Run ${pc.cyan('clara-mcp setup')} to create one.`);
    return;
  }

  console.log(pc.green('✔ Authenticated'));
  console.log(`  Address:  ${status.address}`);

  if (status.email) {
    console.log(`  Recovery: ${status.email}`);
  } else {
    console.log(pc.yellow('  Recovery: none (device-only)'));
  }

  console.log(`  Session:  ${status.sessionAge}`);
  console.log(`  Chains:   ${status.chains?.join(', ') || 'EVM'}`);

  // Quick proxy check
  const proxyUrl =
    process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn4141.workers.dev';
  try {
    const resp = await fetch(`${proxyUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    console.log(
      resp.ok
        ? pc.green('  Proxy:    reachable')
        : pc.yellow('  Proxy:    unhealthy')
    );
  } catch {
    console.log(pc.yellow('  Proxy:    unreachable'));
  }

  // MCP config check
  const hasMcp = await checkMcpConfig();
  console.log(
    hasMcp
      ? pc.green('  MCP:      configured')
      : pc.yellow('  MCP:      not configured')
  );
}

// ─── Logout Command ─────────────────────────────────────────────────

export async function runLogoutCommand(): Promise<void> {
  try {
    await logout();
    console.log(pc.green('✔ Logged out'));
    console.log(`  Run ${pc.cyan('clara-mcp setup')} to reconnect.`);
  } catch (error) {
    console.error(
      pc.red(`✗ ${error instanceof Error ? error.message : 'Unknown error'}`)
    );
    process.exit(1);
  }
}

// ─── Name Command ───────────────────────────────────────────────────

/**
 * Manage .claraid.eth ENS subnames from the CLI.
 *
 * Migrated from MCP wallet_name tool — these are simple HTTP calls
 * to the CCIP-Read gateway with no gas or money involved.
 *
 * Usage:
 *   clara-mcp name register <label> [--agent-id <id>]
 *   clara-mcp name lookup <label>
 *   clara-mcp name reverse <address>
 */
export async function runNameCommand(): Promise<void> {
  const action = process.argv[3]; // register, lookup, reverse
  const value = process.argv[4]; // name or address

  if (!action || !['register', 'lookup', 'reverse'].includes(action)) {
    console.log(pc.cyan(`Clara ENS Names (.${PARENT_DOMAIN})`));
    console.log('');
    console.log('Usage:');
    console.log(
      `  clara-mcp name register <label>     Register a .${PARENT_DOMAIN} subname`
    );
    console.log(
      `  clara-mcp name lookup <label>        Look up a subname`
    );
    console.log(
      `  clara-mcp name reverse <address>     Reverse lookup an address`
    );
    console.log('');
    console.log('Options:');
    console.log(
      '  --agent-id <id>                      Link an ERC-8004 agent ID (register only)'
    );
    return;
  }

  if (!value) {
    const expected = action === 'reverse' ? 'address' : 'label';
    console.error(
      pc.red(`✗ Missing argument: clara-mcp name ${action} <${expected}>`)
    );
    process.exit(1);
  }

  switch (action) {
    case 'register':
      await handleNameRegister(value);
      break;
    case 'lookup':
      await handleNameLookup(value);
      break;
    case 'reverse':
      await handleNameReverse(value);
      break;
  }
}

async function handleNameRegister(label: string): Promise<void> {
  // Parse optional --agent-id flag
  let agentId: number | null = null;
  const agentIdIdx = process.argv.indexOf('--agent-id');
  if (agentIdIdx !== -1 && process.argv[agentIdIdx + 1]) {
    agentId = parseInt(process.argv[agentIdIdx + 1], 10);
  }

  // Need auth for register
  const session = await getSession();
  if (!session?.authenticated || !session.address) {
    console.error(
      pc.red('✗ No wallet configured. Run `clara-mcp setup` first.')
    );
    process.exit(1);
  }

  console.log(`Registering ${pc.cyan(`${label}.${PARENT_DOMAIN}`)}...`);

  try {
    const response = await fetch(`${GATEWAY_BASE}/ens/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Clara-Address': session.address,
      },
      body: JSON.stringify({
        name: label,
        address: session.address,
        agentId,
      }),
    });

    const result = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      if (result.error === 'name_taken') {
        console.error(
          pc.red(`✗ ${label}.${PARENT_DOMAIN} is already taken`)
        );
        console.log(`  Owner: ${result.owner}`);
      } else if (result.error === 'address_has_name') {
        console.error(
          pc.red(
            `✗ Your wallet already has a name: ${result.existingName}.${PARENT_DOMAIN}`
          )
        );
      } else {
        console.error(
          pc.red(
            `✗ Registration failed: ${result.error || result.message || response.statusText}`
          )
        );
      }
      process.exit(1);
    }

    console.log(pc.green(`✔ ${result.fullName} registered!`));
    console.log(`  Address: ${result.address}`);
    if (agentId) console.log(`  Agent ID: ${agentId}`);
  } catch (error) {
    console.error(
      pc.red(`✗ ${error instanceof Error ? error.message : 'Network error'}`)
    );
    process.exit(1);
  }
}

async function handleNameLookup(label: string): Promise<void> {
  try {
    const response = await fetch(
      `${GATEWAY_BASE}/ens/lookup/${encodeURIComponent(label)}`
    );
    const result = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      if (response.status === 404) {
        console.log(`${label}.${PARENT_DOMAIN} is not registered.`);
        console.log(
          `  Claim it: ${pc.cyan(`clara-mcp name register ${label}`)}`
        );
      } else {
        console.error(
          pc.red(
            `✗ Lookup failed: ${result.error || response.statusText}`
          )
        );
      }
      return;
    }

    console.log(pc.green(`✔ ${result.fullName}`));
    console.log(`  Address: ${result.address}`);
    if (result.agentId) console.log(`  Agent ID: ${result.agentId}`);
    if (result.registeredAt) console.log(`  Registered: ${result.registeredAt}`);
  } catch (error) {
    console.error(
      pc.red(`✗ ${error instanceof Error ? error.message : 'Network error'}`)
    );
    process.exit(1);
  }
}

async function handleNameReverse(address: string): Promise<void> {
  try {
    const response = await fetch(
      `${GATEWAY_BASE}/ens/reverse/${encodeURIComponent(address)}`
    );
    const result = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      if (response.status === 404) {
        console.log(`No .${PARENT_DOMAIN} name found for ${address}`);
      } else {
        console.error(
          pc.red(
            `✗ Reverse lookup failed: ${result.error || response.statusText}`
          )
        );
      }
      return;
    }

    console.log(pc.green(`✔ ${result.fullName}`));
    console.log(`  Address: ${result.address}`);
    if (result.agentId) console.log(`  Agent ID: ${result.agentId}`);
  } catch (error) {
    console.error(
      pc.red(`✗ ${error instanceof Error ? error.message : 'Network error'}`)
    );
    process.exit(1);
  }
}
