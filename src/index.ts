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

import { x402ToolDefinition } from './tools/x402.js';
import {
  spendingLimitsToolDefinition,
  handleSpendingToolRequest,
} from './tools/spending.js';
import { X402Client } from './para/x402.js';
import { ParaClient, loadParaConfig } from './para/client.js';
import {
  checkSpendingLimits,
  recordSpending,
  formatSpendingSummary,
} from './storage/spending.js';
import { getSession } from './storage/session.js';
import type { Hex } from 'viem';

// Wallet core tools
import {
  setupToolDefinition,
  statusToolDefinition,
  logoutToolDefinition,
  handleWalletToolRequest,
} from './tools/wallet.js';
import { dashboardToolDefinition, handleDashboardRequest } from './tools/dashboard.js';
import { historyToolDefinition, handleHistoryRequest } from './tools/history.js';
import { sendToolDefinition, handleSendRequest } from './tools/send.js';
import {
  signMessageToolDefinition,
  signTypedDataToolDefinition,
  handleSignRequest,
} from './tools/sign.js';
import { approvalsToolDefinition, handleApprovalsRequest } from './tools/approvals.js';

// Herd-powered analysis tools
import { initProviders } from './providers/index.js';
import {
  analyzeContractToolDefinition,
  handleAnalyzeContract,
} from './tools/analyze-contract.js';
import {
  swapToolDefinition,
  handleSwapRequest,
} from './tools/swap.js';
import {
  opportunitiesToolDefinition,
  handleOpportunitiesRequest,
} from './tools/opportunities.js';

// Two-phase contract execution (wallet_call + wallet_executePrepared)
import {
  callToolDefinition,
  handleCallRequest,
} from './tools/call.js';
import {
  executePreparedToolDefinition,
  handleExecutePreparedRequest,
} from './tools/execute-prepared.js';

/**
 * All available tools
 */
const TOOLS = [
  // Wallet Core (session + identity)
  setupToolDefinition,
  statusToolDefinition,
  logoutToolDefinition,
  // Wallet Operations
  dashboardToolDefinition,
  historyToolDefinition,
  sendToolDefinition,
  // Signing
  signMessageToolDefinition,
  signTypedDataToolDefinition,
  // Safety
  approvalsToolDefinition,
  // x402 Payments (Clara's core)
  x402ToolDefinition,
  spendingLimitsToolDefinition,
  // Herd-powered analysis
  analyzeContractToolDefinition,
  // DeFi
  swapToolDefinition,
  opportunitiesToolDefinition,
  // Two-phase contract execution
  callToolDefinition,
  executePreparedToolDefinition,
];

/**
 * Create and configure the MCP server
 */
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
    }
  );

  // Handle tool listing
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOLS,
    };
  });

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      // Handle wallet core tools (setup, status, logout)
      const walletResult = await handleWalletToolRequest(name, args as Record<string, unknown>);
      if (walletResult) {
        return walletResult;
      }

      // Handle dashboard
      if (name === 'wallet_dashboard') {
        return await handleDashboardRequest(args as Record<string, unknown>);
      }

      // Handle history
      if (name === 'wallet_history') {
        return await handleHistoryRequest(args as Record<string, unknown>);
      }

      // Handle send
      if (name === 'wallet_send') {
        return await handleSendRequest(args as Record<string, unknown>);
      }

      // Handle signing tools
      const signResult = await handleSignRequest(name, args as Record<string, unknown>);
      if (signResult) {
        return signResult;
      }

      // Handle approvals
      if (name === 'wallet_approvals') {
        return await handleApprovalsRequest(args as Record<string, unknown>);
      }

      // Handle spending tools
      const spendingResult = handleSpendingToolRequest(name, args);
      if (spendingResult) {
        return spendingResult;
      }

      // Handle Herd-powered analysis
      if (name === 'wallet_analyze_contract') {
        return await handleAnalyzeContract(args as Record<string, unknown>);
      }

      // Handle swap
      if (name === 'wallet_swap') {
        return await handleSwapRequest(args as Record<string, unknown>);
      }

      // Handle yield opportunities
      if (name === 'wallet_opportunities') {
        return await handleOpportunitiesRequest(args as Record<string, unknown>);
      }

      // Handle two-phase contract execution
      if (name === 'wallet_call') {
        return await handleCallRequest(args as Record<string, unknown>);
      }
      if (name === 'wallet_executePrepared') {
        return await handleExecutePreparedRequest(args as Record<string, unknown>);
      }

      // Handle x402 payment tool
      if (name === 'wallet_pay_x402') {
        return await handleX402Payment(args as Record<string, unknown>);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Unknown tool: ${name}`,
          },
        ],
        isError: true,
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Handle x402 payment requests
 */
async function handleX402Payment(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const url = args.url as string;
  const method = (args.method as string) || 'GET';
  const body = args.body as string | undefined;
  const headers = args.headers as Record<string, string> | undefined;
  const maxAmountUsd = (args.maxAmountUsd as string) || '1.00';
  const skipApprovalCheck = (args.skipApprovalCheck as boolean) || false;

  if (!url) {
    return {
      content: [{ type: 'text', text: '❌ Error: url is required' }],
      isError: true,
    };
  }

  try {
    // Load Para client
    let paraClient: ParaClient;
    try {
      const paraConfig = loadParaConfig();
      paraClient = new ParaClient(paraConfig);
    } catch (configError) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Wallet not configured.\n\nSet these environment variables:\n- CLARA_PROXY_URL: Your clara-proxy URL\n- PARA_WALLET_ID: Your Para wallet ID\n\nError: ${configError instanceof Error ? configError.message : 'Unknown'}`,
          },
        ],
        isError: true,
      };
    }

    // Get wallet address from session (more reliable than API call)
    const session = await getSession();
    if (!session?.authenticated || !session.address) {
      return {
        content: [{
          type: 'text',
          text: '❌ No wallet session found. Run `wallet_setup` first.',
        }],
        isError: true,
      };
    }
    const walletAddress = session.address as Hex;

    // Create x402 client with Para signing
    const x402Client = new X402Client(
      (domain, types, value) => paraClient.signTypedData(domain, types, value),
      async () => walletAddress
    );

    // Make initial request to check if it's 402
    const initialResponse = await fetch(url, {
      method,
      headers,
      body,
    });

    // If not 402, return the response directly
    if (initialResponse.status !== 402) {
      const content = await initialResponse.text();
      return {
        content: [
          {
            type: 'text',
            text: initialResponse.ok
              ? content
              : `Response (${initialResponse.status}):\n\n${content}`,
          },
        ],
        isError: !initialResponse.ok,
      };
    }

    // Parse payment details from 402 response
    const paymentDetails = x402Client.parsePaymentRequired(initialResponse);
    if (!paymentDetails) {
      return {
        content: [
          {
            type: 'text',
            text: '❌ Received 402 response but could not parse payment details.\n\nThe server may not be using the x402 protocol.',
          },
        ],
        isError: true,
      };
    }

    // Convert amount to USD
    const amountUsd = x402Client.tokenAmountToUsd(
      paymentDetails.amount,
      paymentDetails.token
    );

    // Check spending limits
    const limitCheck = checkSpendingLimits(amountUsd);

    if (!limitCheck.allowed) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Payment blocked: ${limitCheck.reason}\n\n${formatSpendingSummary()}\n\nTo proceed, increase your spending limits with wallet_spending_limits.`,
          },
        ],
        isError: true,
      };
    }

    // Check if approval is required
    if (limitCheck.requiresApproval && !skipApprovalCheck) {
      const details = [
        `💰 Payment Required: $${amountUsd} USDC`,
        '',
        `URL: ${url}`,
        `Recipient: ${paymentDetails.recipient}`,
        `Description: ${paymentDetails.description || 'None provided'}`,
        `Chain: Base (${paymentDetails.chainId})`,
        '',
        `Today's spending: $${limitCheck.todayTotal.toFixed(2)}`,
        `Remaining today: $${limitCheck.remainingToday.toFixed(2)}`,
        '',
        '⚠️  This payment requires approval because it exceeds $0.50.',
        '',
        'To approve, run this tool again with `skipApprovalCheck: true`',
      ];

      return {
        content: [{ type: 'text', text: details.join('\n') }],
        isError: false,
      };
    }

    // Check max amount specified by caller
    if (parseFloat(amountUsd) > parseFloat(maxAmountUsd)) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Payment amount ($${amountUsd}) exceeds your specified maximum ($${maxAmountUsd}).\n\nIncrease maxAmountUsd to proceed.`,
          },
        ],
        isError: true,
      };
    }

    // Execute payment
    const result = await x402Client.payAndFetch(url, {
      method,
      headers,
      body,
      maxAmountUsd,
    });

    if (!result.success) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Payment failed: ${result.error}`,
          },
        ],
        isError: true,
      };
    }

    // Record the spending
    recordSpending({
      timestamp: new Date().toISOString(),
      amountUsd,
      recipient: paymentDetails.recipient,
      description: paymentDetails.description || url,
      url,
      chainId: paymentDetails.chainId,
      paymentId: paymentDetails.paymentId,
    });

    // Get response content
    const responseContent = result.response
      ? await result.response.text()
      : '';

    return {
      content: [
        {
          type: 'text',
          text: `✅ Payment successful: $${amountUsd} USDC\n\n---\n\n${responseContent}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Main entry point
 *
 * IMPORTANT: Connect to stdio FIRST, then initialize providers.
 * This ensures Claude Code receives the tool list immediately,
 * even if provider initialization is slow (network calls, etc.).
 */
async function main(): Promise<void> {
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
