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
import {
  claimAirdropToolDefinition,
  handleClaimAirdropRequest,
} from './tools/claim-airdrop.js';

// ENS Tools
import { ensCheckToolDefinition, handleEnsCheckRequest } from './tools/ens-check.js';
import { ensRegisterToolDefinition, handleEnsRegisterRequest } from './tools/ens-register.js';
import {
  registerNameToolDefinition, handleRegisterNameRequest,
  lookupNameToolDefinition, handleLookupNameRequest,
} from './tools/ens-name.js';

// Messaging
import {
  messageToolDefinition, handleMessageRequest,
  inboxToolDefinition, handleInboxRequest,
  threadToolDefinition, handleThreadRequest,
} from './tools/messaging.js';

// Onboarding
import { sponsorGasToolDefinition, handleSponsorGas } from './tools/sponsor-gas.js';

// Work/Bounty Tools (ERC-8004)
import { workRegisterToolDefinition, handleWorkRegister } from './tools/work-register.js';
import { workPostToolDefinition, handleWorkPost } from './tools/work-post.js';
import { workBrowseToolDefinition, handleWorkBrowse } from './tools/work-browse.js';
import { workClaimToolDefinition, handleWorkClaim } from './tools/work-claim.js';
import { workSubmitToolDefinition, handleWorkSubmit } from './tools/work-submit.js';
import { workApproveToolDefinition, handleWorkApprove } from './tools/work-approve.js';
import { workCancelToolDefinition, handleWorkCancel } from './tools/work-cancel.js';
import { workRejectToolDefinition, handleWorkReject } from './tools/work-reject.js';
import { workListToolDefinition, handleWorkList } from './tools/work-list.js';
import { workReputationToolDefinition, handleWorkReputation } from './tools/work-reputation.js';
import { workRateToolDefinition, handleWorkRate } from './tools/work-rate.js';
import { workFindToolDefinition, handleWorkFind } from './tools/work-find.js';
import { workProfileToolDefinition, handleWorkProfile } from './tools/work-profile.js';

// Challenge Tools (ERC-8004 Challenges)
import { challengeBrowseToolDefinition, handleChallengeBrowse } from './tools/challenge-browse.js';
import { challengeDetailToolDefinition, handleChallengeDetail } from './tools/challenge-detail.js';
import { challengeSubmitToolDefinition, handleChallengeSubmit } from './tools/challenge-submit.js';
import { challengeScoreToolDefinition, handleChallengeScore } from './tools/challenge-score.js';
import { challengeLeaderboardToolDefinition, handleChallengeLeaderboard } from './tools/challenge-leaderboard.js';
import { challengePostToolDefinition, handleChallengePost } from './tools/challenge-post.js';
import { challengeClaimToolDefinition, handleChallengeClaim } from './tools/challenge-claim.js';

// Providers
import { initProviders } from './providers/index.js';

// Bounty Indexer
import { initIndexer } from './indexer/index.js';

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

// CLARA Airdrop (auth required — uses wallet address for claim)
registerTool(claimAirdropToolDefinition, handleClaimAirdropRequest, {
  gasPreflight: 'check',
  gasExtractor: () => ({ chain: 'base' as SupportedChain, gasLimit: 100_000n }),
});

// ─── ENS Tools ───────────────────────────────────────────────────────

// ENS name lookup (public — no auth needed)
registerTool(ensCheckToolDefinition, handleEnsCheckRequest, {
  requiresAuth: false,
  touchesSession: false,
});

// ENS name registration (auth required, on Ethereum mainnet)
registerTool(ensRegisterToolDefinition, handleEnsRegisterRequest, {
  gasPreflight: 'check',
  gasExtractor: (args) => {
    const action = (args.action as string) || 'commit';
    // commit tx is cheap (just stores a hash), register tx sends ETH
    if (action === 'commit') {
      return { chain: 'ethereum' as SupportedChain, gasLimit: 100_000n };
    }
    // register tx: ~300k gas + the ETH value for the name price
    return { chain: 'ethereum' as SupportedChain, gasLimit: 300_000n };
  },
});

// Claim a free subname (auth required, no gas — offchain via CCIP-Read)
registerTool(registerNameToolDefinition, handleRegisterNameRequest, {
  requiresAuth: true,
  touchesSession: true,
});

// Look up a subname or reverse-resolve (public — no auth)
registerTool(lookupNameToolDefinition, handleLookupNameRequest, {
  requiresAuth: false,
  touchesSession: false,
});

// ─── Onboarding ──────────────────────────────────────────────────────

// Gas sponsorship for new users (auth required, calls proxy)
registerTool(sponsorGasToolDefinition, handleSponsorGas, {
  requiresAuth: true,
  touchesSession: true,
});

// ─── Messaging ───────────────────────────────────────────────────────

// Send a DM (auth required, touches session)
registerTool(messageToolDefinition, handleMessageRequest, {
  requiresAuth: true,
  checksSpending: false,
  touchesSession: true,
});

// Check inbox (auth required, read-only)
registerTool(inboxToolDefinition, handleInboxRequest, {
  requiresAuth: true,
  checksSpending: false,
  touchesSession: false,
});

// Open thread (auth required, read-only)
registerTool(threadToolDefinition, handleThreadRequest, {
  requiresAuth: true,
  checksSpending: false,
  touchesSession: false,
});

// ─── Work/Bounty Tools (ERC-8004) ────────────────────────────────────

// Agent registration (auth, on-chain tx)
registerTool(workRegisterToolDefinition, handleWorkRegister, {
  gasPreflight: 'check',
  gasExtractor: () => ({ chain: 'base' as SupportedChain, gasLimit: 200_000n }),
});

// Post bounty (auth, spending check, on-chain tx)
registerTool(workPostToolDefinition, handleWorkPost, {
  checksSpending: true,
  gasPreflight: 'check',
  gasExtractor: () => ({ chain: 'base' as SupportedChain, gasLimit: 300_000n }),
});

// Claim bounty (auth, on-chain tx)
registerTool(workClaimToolDefinition, handleWorkClaim, {
  gasPreflight: 'check',
  gasExtractor: () => ({ chain: 'base' as SupportedChain, gasLimit: 100_000n }),
});

// Submit work (auth, on-chain tx)
registerTool(workSubmitToolDefinition, handleWorkSubmit, {
  gasPreflight: 'check',
  gasExtractor: () => ({ chain: 'base' as SupportedChain, gasLimit: 100_000n }),
});

// Approve submission (auth, on-chain tx + reputation)
registerTool(workApproveToolDefinition, handleWorkApprove, {
  gasPreflight: 'check',
  gasExtractor: () => ({ chain: 'base' as SupportedChain, gasLimit: 200_000n }),
});

// Cancel bounty (auth, on-chain tx)
registerTool(workCancelToolDefinition, handleWorkCancel, {
  gasPreflight: 'check',
  gasExtractor: () => ({ chain: 'base' as SupportedChain, gasLimit: 100_000n }),
});

// Reject submission (auth, on-chain tx)
registerTool(workRejectToolDefinition, handleWorkReject, {
  gasPreflight: 'check',
  gasExtractor: () => ({ chain: 'base' as SupportedChain, gasLimit: 150_000n }),
});

// List your bounties (auth needed for wallet address, no gas)
registerTool(workListToolDefinition, handleWorkList, {
  gasPreflight: 'none',
});

// Rate an agent (auth, on-chain tx)
registerTool(workRateToolDefinition, handleWorkRate, {
  gasPreflight: 'check',
  gasExtractor: () => ({ chain: 'base' as SupportedChain, gasLimit: 150_000n }),
});

// Browse bounties (public)
registerTool(workBrowseToolDefinition, handleWorkBrowse, {
  requiresAuth: false,
  touchesSession: false,
});

// Search agent directory (public)
registerTool(workFindToolDefinition, handleWorkFind, {
  requiresAuth: false,
  touchesSession: false,
});

// View agent profile (public)
registerTool(workProfileToolDefinition, handleWorkProfile, {
  requiresAuth: false,
  touchesSession: false,
});

// View agent reputation (public)
registerTool(workReputationToolDefinition, handleWorkReputation, {
  requiresAuth: false,
  touchesSession: false,
});

// ─── Challenge Tools (ERC-8004 Challenges) ──────────────────────────

// Browse challenges (public)
registerTool(challengeBrowseToolDefinition, handleChallengeBrowse, {
  requiresAuth: false,
  touchesSession: false,
});

// View challenge details (public)
registerTool(challengeDetailToolDefinition, handleChallengeDetail, {
  requiresAuth: false,
  touchesSession: false,
});

// View challenge leaderboard (public)
registerTool(challengeLeaderboardToolDefinition, handleChallengeLeaderboard, {
  requiresAuth: false,
  touchesSession: false,
});

// Submit solution (auth, on-chain tx)
registerTool(challengeSubmitToolDefinition, handleChallengeSubmit, {
  gasPreflight: 'check',
  gasExtractor: () => ({ chain: 'base' as SupportedChain, gasLimit: 200_000n }),
});

// Check your score (auth, read-only)
registerTool(challengeScoreToolDefinition, handleChallengeScore, {
  gasPreflight: 'none',
});

// Post challenge (auth, spending check, on-chain two-tx)
registerTool(challengePostToolDefinition, handleChallengePost, {
  checksSpending: true,
  gasPreflight: 'check',
  gasExtractor: () => ({ chain: 'base' as SupportedChain, gasLimit: 400_000n }),
});

// Claim prize (auth, on-chain tx)
registerTool(challengeClaimToolDefinition, handleChallengeClaim, {
  gasPreflight: 'check',
  gasExtractor: () => ({ chain: 'base' as SupportedChain, gasLimit: 100_000n }),
});

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

  // Initialize bounty indexer in background (non-blocking)
  // Syncs BountyFactory + Bounty events from chain, then polls every 15s.
  // If this fails, work_browse/work_list return empty results (not errors).
  initIndexer().catch((error) => {
    console.error('[indexer] Initialization error:', error);
    debugLog(`INDEXER_INIT_ERROR: ${error instanceof Error ? error.message : error}`);
  });
}

main().catch((error) => {
  debugLog(`FATAL: ${error.message}\n${error.stack}`);
  console.error('Fatal error:', error);
  process.exit(1);
});
