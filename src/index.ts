#!/usr/bin/env node
/**
 * Clara MCP Server
 *
 * A focused wallet primitive — 8 tools for session management,
 * reading balances, sending transactions, signing messages, and
 * managing ENS identity.
 *
 * Other MCP servers compose with Clara via wallet_call + wallet_executePrepared.
 *
 * @see https://getpara.com - Para wallet infrastructure
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { registerTool, getAllToolDefinitions, dispatch } from './tool-registry.js';

// ─── Debug Trace Logging ──────────────────────────────────────────────
// Writes to ~/.clara/mcp-debug.log to diagnose stdio loading issues.
// This file can be checked after a fresh session to see if the server
// started, received initialize, and responded to tools/list.

const DEBUG_LOG = join(homedir(), '.clara', 'mcp-debug.log');

function debugLog(msg: string): void {
  try {
    mkdirSync(join(homedir(), '.clara'), { recursive: true });
    const ts = new Date().toISOString();
    appendFileSync(DEBUG_LOG, `[${ts}] [pid:${process.pid}] ${msg}\n`);
  } catch {
    // Silently ignore — debug logging must never break the server
  }
}

// Log process startup immediately (before any imports could fail)
debugLog(`STARTUP cwd=${process.cwd()} argv=${process.argv.join(' ')} node=${process.version}`);

// Catch fatal errors
process.on('uncaughtException', (err) => {
  debugLog(`UNCAUGHT_EXCEPTION: ${err.message}\n${err.stack}`);
  console.error('[clara] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  debugLog(`UNHANDLED_REJECTION: ${reason}`);
  console.error('[clara] Unhandled rejection:', reason);
});

// ─── Tool Imports ────────────────────────────────────────────────────

// Session management (reauth only — full setup is CLI)
import {
  reauthToolDefinition,
  handleReauthRequest,
} from './tools/wallet.js';

// Read
import { dashboardToolDefinition, handleDashboardRequest } from './tools/dashboard.js';

// Write
import { sendToolDefinition, handleSendRequest } from './tools/send.js';
import { callToolDefinition, handleCallRequest } from './tools/call.js';
import {
  executePreparedToolDefinition,
  handleExecutePreparedRequest,
} from './tools/execute-prepared.js';

// Sign
import { signToolDefinition, handleSignRequest } from './tools/sign.js';

// Identity: wallet_name moved to CLI (clara-mcp name register/lookup/reverse)

// Providers
import { initProviders } from './providers/index.js';

// ─── Gas Preflight Extractors ────────────────────────────────────────

import { parseUnits } from 'viem';
import type { GasPreflightExtractor } from './middleware.js';
import type { SupportedChain } from './config/chains.js';

/**
 * Extract chain and value from wallet_send args for gas estimation.
 * Native transfers: gasLimit 21k + txValue. ERC-20: gasLimit 200k.
 */
const sendGasExtractor: GasPreflightExtractor = (args) => {
  const chain = (args.chain as string) || 'base';
  const amount = args.amount as string | undefined;
  const token = args.token as string | undefined;

  // Only native transfers have txValue; ERC-20 transfers are just gas
  const txValue = !token && amount ? parseUnits(amount, 18) : 0n;
  const gasLimit = token ? 200_000n : 21_000n;

  return { chain: chain as SupportedChain, txValue, gasLimit };
};

/**
 * Extract chain from wallet_executePrepared (always check).
 * Best-effort: defaults to 'base' since chain is stored in prepared tx.
 */
const executePreparedGasExtractor: GasPreflightExtractor = () => {
  return { chain: 'base', gasLimit: 300_000n };
};

/**
 * Extract chain from wallet_call args (warn only — simulation may fail).
 */
const callGasExtractor: GasPreflightExtractor = (args) => {
  const chain = (args.chain as string) || 'base';
  const value = args.value ? BigInt(args.value as string) : 0n;
  return { chain: chain as SupportedChain, txValue: value, gasLimit: 300_000n };
};

// ─── Tool Registration ──────────────────────────────────────────────
// Each tool is registered with its definition, handler, and middleware config.
// Auth-required tools receive a ToolContext with pre-validated session.
// Public tools handle sessions internally.

// Reauth (public — refreshes expired sessions, directs to CLI for setup)
registerTool(reauthToolDefinition, handleReauthRequest, {
  requiresAuth: false,
  touchesSession: false,
});

// Read (auth required)
registerTool(dashboardToolDefinition, handleDashboardRequest);

// Write (auth required)
registerTool(sendToolDefinition, handleSendRequest, {
  checksSpending: true,
  gasPreflight: 'check',
  gasExtractor: sendGasExtractor,
});
registerTool(callToolDefinition, handleCallRequest, {
  gasPreflight: 'warn',
  gasExtractor: callGasExtractor,
});
registerTool(executePreparedToolDefinition, handleExecutePreparedRequest, {
  gasPreflight: 'check',
  gasExtractor: executePreparedGasExtractor,
});

// Sign (auth required)
registerTool(signToolDefinition, handleSignRequest);

debugLog(`TOOLS_REGISTERED count=${getAllToolDefinitions().length}`);

// ─── Config Validation ──────────────────────────────────────────────

function validateConfig(): string[] {
  const errors: string[] = [];
  if (!process.env.CLARA_PROXY_URL) errors.push('Missing CLARA_PROXY_URL');
  if (process.env.HERD_ENABLED === 'true') {
    if (!process.env.HERD_API_URL) errors.push('HERD_ENABLED=true but HERD_API_URL not set');
    if (!process.env.HERD_API_KEY) errors.push('HERD_ENABLED=true but HERD_API_KEY not set');
  }

  return errors;
}

// ─── Server Setup ───────────────────────────────────────────────────

function createServer(): Server {
  const server = new Server(
    {
      name: 'clara-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = getAllToolDefinitions();
    debugLog(`TOOLS_LIST requested — returning ${tools.length} tools`);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return dispatch(name, args as Record<string, unknown>);
  });

  return server;
}

/**
 * Main entry point
 *
 * IMPORTANT: Connect to stdio FIRST, then initialize providers.
 * This ensures Claude Code receives the tool list immediately,
 * even if provider initialization is slow (network calls, etc.).
 */
async function main(): Promise<void> {
  // ─── CLI Command Routing ────────────────────────────────────────
  // Dynamic imports keep @clack/prompts and picocolors out of MCP server runtime.
  const cmd = process.argv[2];

  if (cmd === 'setup') {
    const { runSetupWizard } = await import('./cli/setup.js');
    await runSetupWizard();
    process.exit(0);
  }

  if (cmd === 'status') {
    const { runStatusCheck } = await import('./cli/setup.js');
    await runStatusCheck();
    process.exit(0);
  }

  if (cmd === 'logout') {
    const { runLogoutCommand } = await import('./cli/setup.js');
    await runLogoutCommand();
    process.exit(0);
  }

  if (cmd === 'name') {
    const { runNameCommand } = await import('./cli/setup.js');
    await runNameCommand();
    process.exit(0);
  }

  // ─── MCP Server (default — no args) ─────────────────────────────

  // Validate config (warnings only — don't block startup)
  const configErrors = validateConfig();
  for (const err of configErrors) {
    console.error(`[clara] Warning: ${err}`);
  }

  debugLog('CREATING server and transport');
  const server = createServer();
  const transport = new StdioServerTransport();

  // Connect FIRST so Claude Code gets tools immediately
  debugLog('CONNECTING to stdio transport...');
  await server.connect(transport);
  debugLog('CONNECTED to stdio — server ready');
  console.error('Clara MCP Server running on stdio');

  // Initialize providers in background (non-blocking)
  // Tools that need providers will check isProvidersInitialized()
  initProviders().catch((error) => {
    console.error('Provider initialization error:', error);
    // Don't exit - core wallet tools still work without providers
  });
}

main().catch((error) => {
  debugLog(`FATAL: ${error.message}\n${error.stack}`);
  console.error('Fatal error:', error);
  process.exit(1);
});
