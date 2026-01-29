/**
 * Spending Management Tools
 *
 * MCP tools for viewing and configuring autonomous spending limits.
 *
 * These tools give users transparency and control over how much
 * the AI agent can spend without explicit approval.
 */

import { z } from 'zod';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  getSpendingLimits,
  setSpendingLimits,
  formatSpendingSummary,
  formatSpendingHistory,
  type SpendingLimits,
} from '../storage/spending.js';

/**
 * Input schema for wallet_spending_limits tool
 */
const SpendingLimitsInputSchema = z.object({
  action: z
    .enum(['view', 'set'])
    .default('view')
    .describe('Action to perform: view current limits or set new ones'),
  maxPerTransaction: z
    .string()
    .optional()
    .describe('New per-transaction limit in USD (e.g., "2.00")'),
  maxPerDay: z
    .string()
    .optional()
    .describe('New daily limit in USD (e.g., "20.00")'),
  requireApprovalAbove: z
    .string()
    .optional()
    .describe('New approval threshold in USD (e.g., "1.00")'),
});

/**
 * Input schema for wallet_spending_history tool
 */
const SpendingHistoryInputSchema = z.object({
  days: z
    .number()
    .min(1)
    .max(90)
    .default(7)
    .describe('Number of days of history to show (1-90)'),
});

/**
 * Tool definition for wallet_spending_limits
 */
export const spendingLimitsToolDefinition = {
  name: 'wallet_spending_limits',
  description: `View or configure autonomous spending limits.

**Actions:**
- \`view\`: Show current spending limits and today's usage
- \`set\`: Update one or more spending limits

**Default limits:**
- Per transaction: $1.00
- Per day: $10.00
- Approval required above: $0.50

**Examples:**

View limits:
\`\`\`json
{ "action": "view" }
\`\`\`

Set stricter limits:
\`\`\`json
{
  "action": "set",
  "maxPerTransaction": "0.50",
  "maxPerDay": "5.00",
  "requireApprovalAbove": "0.25"
}
\`\`\``,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['view', 'set'],
        default: 'view',
        description: 'Action: view or set limits',
      },
      maxPerTransaction: {
        type: 'string',
        description: 'Max USD per transaction',
      },
      maxPerDay: {
        type: 'string',
        description: 'Max USD per day',
      },
      requireApprovalAbove: {
        type: 'string',
        description: 'USD threshold requiring approval',
      },
    },
  },
};

/**
 * Tool definition for wallet_spending_history
 */
export const spendingHistoryToolDefinition = {
  name: 'wallet_spending_history',
  description: `View recent autonomous payment history.

Shows all payments made through x402 in the specified time period,
grouped by day with totals.

**Example:**
\`\`\`json
{ "days": 7 }
\`\`\``,
  inputSchema: {
    type: 'object',
    properties: {
      days: {
        type: 'number',
        minimum: 1,
        maximum: 90,
        default: 7,
        description: 'Days of history to show',
      },
    },
  },
};

/**
 * Execute wallet_spending_limits tool
 */
function executeSpendingLimits(
  args: z.infer<typeof SpendingLimitsInputSchema>
): { content: Array<{ type: string; text: string }> } {
  if (args.action === 'view') {
    return {
      content: [
        {
          type: 'text',
          text: formatSpendingSummary(),
        },
      ],
    };
  }

  // Set new limits
  const updates: Partial<SpendingLimits> = {};

  if (args.maxPerTransaction) {
    // Validate it's a valid USD amount
    const amount = parseFloat(args.maxPerTransaction);
    if (isNaN(amount) || amount < 0) {
      return {
        content: [
          {
            type: 'text',
            text: '❌ Invalid maxPerTransaction: must be a positive number',
          },
        ],
      };
    }
    updates.maxPerTransaction = amount.toFixed(2);
  }

  if (args.maxPerDay) {
    const amount = parseFloat(args.maxPerDay);
    if (isNaN(amount) || amount < 0) {
      return {
        content: [
          {
            type: 'text',
            text: '❌ Invalid maxPerDay: must be a positive number',
          },
        ],
      };
    }
    updates.maxPerDay = amount.toFixed(2);
  }

  if (args.requireApprovalAbove) {
    const amount = parseFloat(args.requireApprovalAbove);
    if (isNaN(amount) || amount < 0) {
      return {
        content: [
          {
            type: 'text',
            text: '❌ Invalid requireApprovalAbove: must be a positive number',
          },
        ],
      };
    }
    updates.requireApprovalAbove = amount.toFixed(2);
  }

  if (Object.keys(updates).length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: '⚠️  No changes specified. Provide at least one limit to update.',
        },
      ],
    };
  }

  const newLimits = setSpendingLimits(updates);

  const lines = [
    '✅ Spending limits updated',
    '',
    '⚙️  New Limits:',
    `Per transaction:  $${newLimits.maxPerTransaction}`,
    `Per day:          $${newLimits.maxPerDay}`,
    `Approval above:   $${newLimits.requireApprovalAbove}`,
  ];

  return {
    content: [
      {
        type: 'text',
        text: lines.join('\n'),
      },
    ],
  };
}

/**
 * Execute wallet_spending_history tool
 */
function executeSpendingHistory(
  args: z.infer<typeof SpendingHistoryInputSchema>
): { content: Array<{ type: string; text: string }> } {
  return {
    content: [
      {
        type: 'text',
        text: formatSpendingHistory(args.days),
      },
    ],
  };
}

/**
 * Register spending tools with the MCP server
 */
export function registerSpendingTools(server: Server): void {
  // This would be integrated with the server's tool handling
  // The actual registration depends on the MCP SDK version
}

/**
 * Handle spending tool requests
 */
export function handleSpendingToolRequest(
  toolName: string,
  args: unknown
): { content: Array<{ type: string; text: string }> } | null {
  switch (toolName) {
    case 'wallet_spending_limits':
      return executeSpendingLimits(SpendingLimitsInputSchema.parse(args));
    case 'wallet_spending_history':
      return executeSpendingHistory(SpendingHistoryInputSchema.parse(args));
    default:
      return null;
  }
}
