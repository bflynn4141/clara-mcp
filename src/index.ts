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
  spendingHistoryToolDefinition,
  handleSpendingToolRequest,
} from './tools/spending.js';
import {
  discoverToolDefinition,
  browseToolDefinition,
  handleDiscoveryToolRequest,
} from './tools/discovery.js';
import {
  discoverTokensToolDefinition,
  tokenDetailsToolDefinition,
  handleTokenToolRequest,
} from './tools/tokens.js';
import {
  balanceToolDefinition,
  handleBalanceRequest,
} from './tools/balance.js';
import { X402Client } from './para/x402.js';
import { ParaClient, loadParaConfig } from './para/client.js';
import {
  checkSpendingLimits,
  recordSpending,
  formatSpendingSummary,
} from './storage/spending.js';

/**
 * All available tools
 */
const TOOLS = [
  x402ToolDefinition,
  balanceToolDefinition,
  spendingLimitsToolDefinition,
  spendingHistoryToolDefinition,
  discoverToolDefinition,
  browseToolDefinition,
  discoverTokensToolDefinition,
  tokenDetailsToolDefinition,
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
      // Handle spending tools
      const spendingResult = handleSpendingToolRequest(name, args);
      if (spendingResult) {
        return spendingResult;
      }

      // Handle discovery tools (x402 ecosystem)
      const discoveryResult = await handleDiscoveryToolRequest(name, args as Record<string, unknown>);
      if (discoveryResult) {
        return discoveryResult;
      }

      // Handle token discovery tools (Clara ecosystem)
      const tokenResult = await handleTokenToolRequest(name, args as Record<string, unknown>);
      if (tokenResult) {
        return tokenResult;
      }

      // Handle balance tool
      if (name === 'wallet_balance') {
        const paraConfig = loadParaConfig();
        const paraClient = new ParaClient(paraConfig);
        return await handleBalanceRequest(
          args as Record<string, unknown>,
          () => paraClient.getAddress()
        );
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

    // Create x402 client with Para signing
    const x402Client = new X402Client(
      (domain, types, value) => paraClient.signTypedData(domain, types, value),
      () => paraClient.getAddress()
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
 */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  console.error('Clara MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
