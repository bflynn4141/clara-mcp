# Clara MCP Server

> AI agent wallet with x402 payments, spending controls, and token discovery.

Clara enables AI agents to autonomously pay for web resources using the [x402 protocol](https://x402.org), while keeping humans in control through configurable spending limits.

## Quick Start

**1. Add to Claude Code** (`~/.claude/claude_code_config.json`):

```json
{
  "mcpServers": {
    "clara": {
      "command": "npx",
      "args": ["clara-mcp"],
      "env": {
        "CLARA_PROXY_URL": "https://your-clara-proxy.workers.dev",
        "PARA_WALLET_ID": "your-wallet-id",
        "ZERION_API_KEY": "your-zerion-api-key"
      }
    }
  }
}
```

> **Get your API keys:**
> - `ZERION_API_KEY` — Free at [developers.zerion.io](https://developers.zerion.io) (required for `wallet_balance`)

**2. Restart Claude Code** and say: *"browse x402 services"*

That's it! Clara runs via npx — no installation needed.

### Alternative: Global Install

For faster startup (skips npx download each time):

```bash
npm install -g clara-mcp
```

Then use `"command": "clara-mcp"` in your config.

### From Source

```bash
git clone https://github.com/bflynn4141/clara-mcp
cd clara-mcp && npm install && npm run build
```

---

## Features

Clara organizes around three pillars: **Build**, **Use**, and **Earn**.

---

## 🔨 BUILD — Create Paid APIs

The x402 protocol turns HTTP 402 "Payment Required" from a reserved status code into a working payment system. Any API can become monetized by returning 402 responses with payment details.

### How x402 Works

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         x402 Payment Flow                                │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   1. Agent → API:  GET /premium-data                                     │
│                                                                          │
│   2. API → Agent:  402 Payment Required                                  │
│                    X-Payment-Amount: 100000 (0.10 USDC)                  │
│                    X-Payment-Recipient: 0x...                            │
│                    X-Payment-Token: USDC                                 │
│                    X-Payment-Chain: 8453 (Base)                          │
│                                                                          │
│   3. Agent:        Signs EIP-712 payment authorization                   │
│                    (Clara handles this automatically)                    │
│                                                                          │
│   4. Agent → API:  GET /premium-data                                     │
│                    X-Payment: <signed-authorization>                     │
│                                                                          │
│   5. API:          Verifies signature, settles payment on-chain          │
│                                                                          │
│   6. API → Agent:  200 OK + premium content                              │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Discovery Protocol

APIs can advertise their x402 endpoints via a discovery document:

**`GET /.well-known/x402`**

```json
{
  "version": 1,
  "resources": [
    "https://api.example.com/premium",
    "https://api.example.com/data"
  ],
  "instructions": "Premium API access. See docs at..."
}
```

Clara's `wallet_discover_x402` tool checks this endpoint (or a DNS TXT record at `_x402.<domain>`) to find available paid resources.

### Learn More

- [x402.org](https://x402.org) — Protocol specification
- [x402 Ecosystem](https://x402.org/ecosystem) — Live services

---

## 🎯 USE — Consume Paid Resources

Clara provides 5 tools for using x402-enabled services:

### `wallet_pay_x402`

Pay for an HTTP 402-gated resource. Clara handles the entire flow: detect 402, parse payment requirements, check limits, sign authorization, and retrieve content.

```json
{
  "url": "https://api.example.com/premium-data",
  "method": "GET",
  "maxAmountUsd": "0.50"
}
```

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | *required* | The URL to access |
| `method` | string | `"GET"` | HTTP method (GET, POST, PUT, DELETE) |
| `body` | string | — | Request body for POST/PUT |
| `headers` | object | — | Additional headers |
| `maxAmountUsd` | string | `"1.00"` | Maximum USD willing to pay |
| `skipApprovalCheck` | boolean | `false` | Skip approval for pre-approved payments |

**Returns:** The resource content after successful payment, or an approval prompt for larger amounts.

---

### `wallet_discover_x402`

Check if a domain supports x402 payments and list available paid endpoints.

```json
{
  "domain": "api.example.com",
  "probeResources": true
}
```

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `domain` | string | *required* | Domain to check (e.g., "api.example.com") |
| `probeResources` | boolean | `false` | If true, probe each resource for pricing |

**Returns:** Discovery document with available endpoints and optional pricing.

---

### `wallet_browse_x402`

Browse the curated x402 ecosystem catalog to find paid API services.

```json
{
  "category": "ai",
  "search": "image generation",
  "limit": 10
}
```

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `category` | string | `"all"` | Filter: `ai`, `data`, `infra`, `defi`, `all` |
| `search` | string | — | Search term to filter services |
| `limit` | number | `10` | Maximum results (up to 50) |

**Categories:**
- **`ai`** — AI/ML APIs (image generation, LLMs, inference)
- **`data`** — Data feeds (news, social, market data)
- **`infra`** — Infrastructure (IPFS, storage, proxies)
- **`defi`** — DeFi APIs (portfolio, trading, analytics)
- **`all`** — Everything

---

### `wallet_spending_limits`

View or configure autonomous spending limits to stay in control.

```json
{
  "action": "set",
  "maxPerTransaction": "2.00",
  "maxPerDay": "20.00",
  "requireApprovalAbove": "1.00"
}
```

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `action` | string | `"view"` | `view` or `set` |
| `maxPerTransaction` | string | — | New per-transaction limit in USD |
| `maxPerDay` | string | — | New daily limit in USD |
| `requireApprovalAbove` | string | — | USD threshold requiring approval |

**Default Limits:**
| Limit | Default | Description |
|-------|---------|-------------|
| Per Transaction | $1.00 | Maximum single payment |
| Per Day | $10.00 | Rolling 24-hour maximum |
| Approval Threshold | $0.50 | Payments above this require explicit approval |

---

### `wallet_spending_history`

View recent autonomous payment history, grouped by day.

```json
{
  "days": 7
}
```

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `days` | number | `7` | Days of history (1-90) |

---

## 💰 EARN — Token Opportunities

Clara integrates with the Clara token ecosystem to discover yield opportunities:

### `wallet_discover_tokens`

Find active CCA auctions and staking opportunities with yield calculations.

```json
{
  "filter": "staking",
  "sortBy": "apy",
  "chain": "base",
  "limit": 5
}
```

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `filter` | string | `"all"` | `all`, `auctions`, or `staking` |
| `chain` | string | `"base"` | `base` or `ethereum` |
| `sortBy` | string | `"apy"` | `apy`, `tvl`, or `recent` |
| `limit` | number | `10` | Max results per category (1-50) |

**Output includes:**
- Active CCA auctions (status, price, raised amount, time remaining)
- Staking distributors (TVL, revenue, estimated APY, payback period)
- Commands to participate

---

### `wallet_token_details`

Get detailed information about a specific Clara ecosystem token.

```json
{
  "token": "0x1234...",
  "chain": "base"
}
```

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `token` | string | *required* | Token address or symbol |
| `chain` | string | `"base"` | `base` or `ethereum` |

**Returns:**
- Token info (name, symbol, address)
- Auction history (status, clearing price, raised amount)
- Staking stats (TVL, revenue, APY breakdown, payback period)
- Action commands to participate

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CLARA_PROXY_URL` | Yes | URL to your clara-proxy instance |
| `PARA_WALLET_ID` | Yes | Your Para wallet ID |

### Config File (Alternative)

Create `~/.clara/config.json`:

```json
{
  "proxyUrl": "https://your-clara-proxy.workers.dev",
  "walletId": "your-para-wallet-id"
}
```

---

## Wallet Setup & Recovery

### Initial Setup

Clara uses Para wallet infrastructure. Your wallet is identified by email, making it portable across machines.

1. Set up clara-proxy with your Para API key
2. Create a wallet through clara-proxy (email-based)
3. Configure Clara MCP with your wallet ID

### Session Expiration

Sessions expire after 24 hours of inactivity. To restore:

```bash
# 1. Delete expired session
rm ~/.clara/session.enc

# 2. Re-authenticate with same email
# Your wallet (same address, same funds) is restored automatically
```

### Full Custody

To claim complete control of your wallet:

1. Visit [getpara.com](https://getpara.com)
2. Sign in with your setup email
3. Complete verification
4. Export private key or connect hardware wallet

### Important Files

| File | Purpose |
|------|---------|
| `~/.clara/session.enc` | Encrypted wallet session |
| `~/.clara/spending.json` | Spending limits & history |
| `~/.clara/config.json` | Optional configuration |

---

## Security Model

Clara is designed with safety as a priority:

- **EIP-712 Signing** — Human-readable payment authorizations
- **Spending Limits** — Hard caps on autonomous spending
- **Approval Flow** — Large payments require explicit approval
- **Local Storage** — Spending history stored locally (not sent anywhere)
- **No Custody** — Clara never holds your private keys (Para handles signing)

### Approval Flow

When a payment exceeds the approval threshold ($0.50 by default):

1. Clara shows payment details (amount, recipient, URL)
2. User reviews and decides
3. If approved, call the tool again with `skipApprovalCheck: true`

This keeps humans in the loop for significant spending decisions.

---

## Architecture

```
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│  Claude Code        │────▶│  Clara MCP Server   │────▶│  clara-proxy    │
│                     │     │  (this project)     │     │  (Cloudflare)   │
└─────────────────────┘     └─────────────────────┘     └─────────────────┘
                                     │                          │
                                     │                          ▼
                                     │                 ┌─────────────────┐
                                     │                 │  Para Wallet    │
                                     │                 │  (Signing)      │
                                     │                 └─────────────────┘
                                     │
                                     ▼
                            ┌─────────────────────┐
                            │  x402 APIs          │
                            │  (Payment Required) │
                            └─────────────────────┘
                                     │
                                     ▼
                            ┌─────────────────────┐
                            │  Base Mainnet       │
                            │  (USDC Settlement)  │
                            └─────────────────────┘
```

**Components:**

1. **Clara MCP Server** — This project. Handles tool calls, spending limits, and orchestration.
2. **clara-proxy** — Cloudflare Worker that interfaces with Para wallet API. Manages authentication and signing.
3. **Para Wallet** — Third-party wallet infrastructure. Handles private keys and transaction signing.
4. **Base Mainnet** — Where USDC payments settle. x402 payments are real on-chain transactions.

---

## Development

```bash
# Install dependencies
npm install

# Run in development mode (hot reload)
npm run dev

# Type check
npm run typecheck

# Run tests
npm test

# Build for production
npm run build

# Test the CLI locally
npm link
clara-mcp
```

### Publishing to npm

```bash
# Build first
npm run build

# Dry run to check what gets published
npm publish --dry-run

# Publish
npm publish
```

---

## Tool Reference (Quick)

| Tool | Purpose |
|------|---------|
| `wallet_pay_x402` | Pay for 402-gated content |
| `wallet_discover_x402` | Check domain for x402 support |
| `wallet_browse_x402` | Browse x402 ecosystem catalog |
| `wallet_spending_limits` | View/set spending controls |
| `wallet_spending_history` | View payment history |
| `wallet_discover_tokens` | Find auctions & staking yields |
| `wallet_token_details` | Deep dive on a token |

---

## License

MIT
