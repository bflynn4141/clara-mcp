# Clara MCP Server

AI agent wallet with x402 payment support for Claude Code.

## What is x402?

HTTP 402 "Payment Required" was reserved in HTTP/1.1 for future use. The [x402 protocol](https://x402.org) finally implements it, enabling AI agents to autonomously pay for resources.

```
1. Agent requests a paid resource
2. Server responds: 402 Payment Required + payment details
3. Agent signs payment authorization (EIP-712)
4. Agent retries with X-PAYMENT header
5. Server verifies, processes payment, returns resource
```

## Installation

```bash
cd clara-mcp
npm install
npm run build
```

## Configuration

Set these environment variables:

```bash
export CLARA_PROXY_URL="https://your-clara-proxy.workers.dev"
export PARA_WALLET_ID="your-para-wallet-id"
```

Or create `~/.clara/config.json`:

```json
{
  "proxyUrl": "https://your-clara-proxy.workers.dev",
  "walletId": "your-para-wallet-id"
}
```

## Claude Code Integration

Add to your Claude Code MCP configuration (`~/.claude/claude_code_config.json`):

```json
{
  "mcpServers": {
    "clara": {
      "command": "node",
      "args": ["/path/to/clara-mcp/dist/index.js"],
      "env": {
        "CLARA_PROXY_URL": "https://your-clara-proxy.workers.dev",
        "PARA_WALLET_ID": "your-wallet-id"
      }
    }
  }
}
```

## Tools

### `wallet_pay_x402`

Pay for an HTTP 402-gated resource.

```json
{
  "url": "https://api.example.com/premium-data",
  "method": "GET",
  "maxAmountUsd": "0.50"
}
```

### `wallet_spending_limits`

View or configure autonomous spending limits.

```json
{
  "action": "set",
  "maxPerTransaction": "2.00",
  "maxPerDay": "20.00",
  "requireApprovalAbove": "1.00"
}
```

### `wallet_spending_history`

View recent autonomous payment history.

```json
{
  "days": 7
}
```

## Spending Limits

Default limits keep you in control:

| Limit | Default | Description |
|-------|---------|-------------|
| Per Transaction | $1.00 | Maximum single payment |
| Per Day | $10.00 | Rolling 24-hour maximum |
| Approval Above | $0.50 | Requires explicit approval |

## Security

- **EIP-712 signing**: Human-readable payment authorization
- **Spending limits**: Hard caps on autonomous spending
- **Approval flow**: Large payments require explicit approval
- **Local storage**: Spending history stored locally (~/.clara/)
- **No custody**: Clara never holds your keys (Para does the signing)

## Development

```bash
# Run in development mode
npm run dev

# Type check
npm run typecheck

# Build for production
npm run build
```

## Architecture

```
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│  Claude Code        │────▶│  Clara MCP Server   │────▶│  clara-proxy    │
│                     │     │  (this project)     │     │  (Cloudflare)   │
└─────────────────────┘     └─────────────────────┘     └─────────────────┘
                                     │
                                     ▼
                            ┌─────────────────────┐
                            │  Para Wallet API    │
                            └─────────────────────┘
                                     │
                                     ▼
                            ┌─────────────────────┐
                            │  Base (x402 payments)│
                            └─────────────────────┘
```

## License

MIT
