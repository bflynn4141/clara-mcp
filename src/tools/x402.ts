/**
 * x402 Payment Tool
 *
 * MCP tool for paying HTTP 402-gated resources.
 *
 * When an AI agent encounters a 402 Payment Required response,
 * it can use this tool to:
 * 1. Parse the payment requirements
 * 2. Check against spending limits
 * 3. Sign and submit the payment
 * 4. Return the paid resource
 *
 * The tool enforces spending limits and can require approval
 * for larger payments, keeping the human in control.
 */

/**
 * Tool definition for wallet_pay_x402
 */
export const x402ToolDefinition = {
  name: 'wallet_pay_x402',
  description: `Pay for an HTTP 402-gated resource.

When a resource returns "402 Payment Required", use this tool to handle the payment and retrieve the content.

**How it works:**
1. Makes the initial request to get payment details from 402 response headers
2. Checks the payment amount against your spending limits
3. Signs a payment authorization with your wallet (EIP-712)
4. Retries the request with the payment proof
5. Returns the resource content

**Spending limits:**
- Per-transaction maximum (default: $1.00)
- Daily maximum (default: $10.00)
- Payments above $0.50 require explicit approval

**Supported:**
- Chain: Base (8453)
- Token: USDC

**Example:**
\`\`\`json
{
  "url": "https://api.example.com/premium-data",
  "method": "GET",
  "maxAmountUsd": "0.50"
}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: 'The URL that returned 402 Payment Required',
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'DELETE'],
        default: 'GET',
        description: 'HTTP method',
      },
      body: {
        type: 'string',
        description: 'Request body for POST/PUT',
      },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Additional headers',
      },
      maxAmountUsd: {
        type: 'string',
        default: '1.00',
        description: 'Maximum USD willing to pay',
      },
      skipApprovalCheck: {
        type: 'boolean',
        default: false,
        description: 'Skip approval check for pre-approved payments',
      },
    },
    required: ['url'],
  },
};
