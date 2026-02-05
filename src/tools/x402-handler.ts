/**
 * x402 Payment Handler
 *
 * Handles HTTP 402-gated resource payments.
 * Extracted from index.ts into a proper tool handler for the registry.
 */

import { X402Client } from '../para/x402.js';
import { ParaClient, loadParaConfig } from '../para/client.js';
import {
  checkSpendingLimits,
  recordSpending,
  formatSpendingSummary,
} from '../storage/spending.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import type { Hex } from 'viem';

/**
 * Handle x402 payment requests
 */
export async function handleX402PaymentRequest(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
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

    const walletAddress = ctx.walletAddress;

    // Create x402 client with Para signing
    const x402Client = new X402Client(
      (domain, types, value) => paraClient.signTypedData(domain, types, value),
      async () => walletAddress,
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
      paymentDetails.token,
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
