#!/usr/bin/env node
/**
 * Clara MCP Server
 *
 * AI agent wallet with x402 payment support.
 *
 * This MCP server provides tools for:
 * - Paying for HTTP 402-gated resources (x402 protocol)
 * - Managing autonomous spending limits
 * - Viewing payment history
 *
 * The server integrates with Para wallet for secure signing
 * and enforces spending limits to keep humans in control.
 *
 * @see https://x402.org - The x402 payment protocol
 * @see https://getpara.com - Para wallet infrastructure
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { registerTool, getAllToolDefinitions, dispatch } from './tool-registry.js';

// Tool definitions and handlers
import {
  setupToolDefinition,
  statusToolDefinition,
  logoutToolDefinition,
  handleSetupRequest,
  handleStatusRequest,
  handleLogoutRequest,
} from './tools/wallet.js';
import { dashboardToolDefinition, handleDashboardRequest } from './tools/dashboard.js';
import { historyToolDefinition, handleHistoryRequest } from './tools/history.js';
import { sendToolDefinition, handleSendRequest } from './tools/send.js';
import {
  signMessageToolDefinition,
  signTypedDataToolDefinition,
  handleSignMessageRequest,
  handleSignTypedDataRequest,
} from './tools/sign.js';
import { approvalsToolDefinition, handleApprovalsRequest } from './tools/approvals.js';
import { x402ToolDefinition } from './tools/x402.js';
import { handleX402PaymentRequest } from './tools/x402-handler.js';
import {
  spendingLimitsToolDefinition,
  handleSpendingLimitsRequest,
} from './tools/spending.js';
import {
  analyzeContractToolDefinition,
  handleAnalyzeContract,
} from './tools/analyze-contract.js';
import { swapToolDefinition, handleSwapRequest } from './tools/swap.js';
import {
  opportunitiesToolDefinition,
  handleOpportunitiesRequest,
} from './tools/opportunities.js';
import { callToolDefinition, handleCallRequest } from './tools/call.js';
import {
  executePreparedToolDefinition,
  handleExecutePreparedRequest,
} from './tools/execute-prepared.js';

// Providers
import { initProviders } from './providers/index.js';

// Gas preflight extractors
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
 * Extract chain from wallet_swap args (only for execute mode).
 * Quotes don't send transactions, so skip preflight.
 */
const swapGasExtractor: GasPreflightExtractor = (args) => {
  const action = (args.action as string) || 'quote';
  if (action !== 'execute') return null;

  const chain = (args.chain as string) || 'base';
  return { chain: chain as SupportedChain, gasLimit: 500_000n };
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

// Wallet Core (public — manage their own session lifecycle)
registerTool(setupToolDefinition, handleSetupRequest, {
  requiresAuth: false,
  touchesSession: false,
});
registerTool(statusToolDefinition, handleStatusRequest, {
  requiresAuth: false,
});
registerTool(logoutToolDefinition, handleLogoutRequest, {
  requiresAuth: false,
  touchesSession: false,
});

// Wallet Operations (auth required)
registerTool(dashboardToolDefinition, handleDashboardRequest);
registerTool(historyToolDefinition, handleHistoryRequest);
registerTool(sendToolDefinition, handleSendRequest, {
  checksSpending: true,
  gasPreflight: 'check',
  gasExtractor: sendGasExtractor,
});

// Signing (auth required)
registerTool(signMessageToolDefinition, handleSignMessageRequest);
registerTool(signTypedDataToolDefinition, handleSignTypedDataRequest);

// Safety (auth required)
registerTool(approvalsToolDefinition, handleApprovalsRequest);

// x402 Payments (auth required)
registerTool(x402ToolDefinition, handleX402PaymentRequest, {
  checksSpending: true,
});

// Spending limits (public — no auth needed to view/set limits)
registerTool(spendingLimitsToolDefinition, handleSpendingLimitsRequest, {
  requiresAuth: false,
  touchesSession: false,
});

// Herd-powered analysis (public — no wallet needed)
registerTool(analyzeContractToolDefinition, handleAnalyzeContract, {
  requiresAuth: false,
  touchesSession: false,
});

// DeFi (auth required for swap, public for opportunities)
registerTool(swapToolDefinition, handleSwapRequest, {
  gasPreflight: 'check',
  gasExtractor: swapGasExtractor,
});
registerTool(opportunitiesToolDefinition, handleOpportunitiesRequest, {
  requiresAuth: false,
  touchesSession: false,
});

// Two-phase contract execution (auth required)
registerTool(callToolDefinition, handleCallRequest, {
  gasPreflight: 'warn',
  gasExtractor: callGasExtractor,
});
registerTool(executePreparedToolDefinition, handleExecutePreparedRequest, {
  gasPreflight: 'check',
  gasExtractor: executePreparedGasExtractor,
});

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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getAllToolDefinitions(),
  }));

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
  // Validate config (warnings only — don't block startup)
  const configErrors = validateConfig();
  for (const err of configErrors) {
    console.error(`[clara] Warning: ${err}`);
  }

  const server = createServer();
  const transport = new StdioServerTransport();

  // Connect FIRST so Claude Code gets tools immediately
  await server.connect(transport);
  console.error('Clara MCP Server running on stdio');

  // Initialize providers in background (non-blocking)
  // Tools that need providers will check isProvidersInitialized()
  initProviders().catch((error) => {
    console.error('Provider initialization error:', error);
    // Don't exit - core wallet tools still work without providers
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
