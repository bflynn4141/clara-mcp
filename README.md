# Clara MCP Server

> AI agent wallet with DeFi intelligence, x402 payments, and contract execution.

Clara gives AI agents a complete on-chain toolkit — manage wallets, swap tokens, execute contract calls, analyze smart contracts, and pay for HTTP 402-gated resources. All through the [Model Context Protocol](https://modelcontextprotocol.io).

## Quick Start

**Add to Claude Code** (`~/.claude/claude_code_config.json`):

```json
{
  "mcpServers": {
    "clara": {
      "command": "npx",
      "args": ["clara-mcp"],
      "env": {
        "CLARA_PROXY_URL": "https://your-clara-proxy.workers.dev",
        "HERD_ENABLED": "true",
        "HERD_API_URL": "https://api.herd.eco/v1/mcp",
        "HERD_API_KEY": "your-herd-api-key"
      }
    }
  }
}
```

Restart Claude Code, then say: *"set up my wallet with email user@example.com"*

That's it — Clara runs via npx, no installation needed.

### Alternative: Global Install

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

## Tool Reference

Clara exposes **16 tools** organized into five categories.

### Wallet Management

| Tool | Description |
|------|-------------|
| `wallet_setup` | Initialize wallet (instant or email-based portable) |
| `wallet_status` | Check auth, session, credits, spending limits |
| `wallet_dashboard` | Multi-chain portfolio with USD values |
| `wallet_logout` | Clear wallet session |

#### `wallet_setup`

Initialize your wallet. Email-based wallets are portable across machines and can be claimed at [getpara.com](https://getpara.com).

```json
{ "email": "user@example.com" }
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `email` | string | No | Email for portable wallet. Omit for instant machine-specific wallet. |

#### `wallet_status`

Check authentication state, supported chains, session age, spending limits, and Clara Credits balance.

```json
{ "debug": true, "testConnection": true }
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `chainId` | number | `8453` | Chain ID to validate identity for. Supported: 8453, 1, 42161, 10, 137 |
| `debug` | boolean | `false` | Include auth header diagnostics |
| `testConnection` | boolean | `false` | Make a test request to Para (requires `debug: true`) |

#### `wallet_dashboard`

Unified view of session status, multi-chain balances (with USD values from Herd), and recent spending.

```json
{}
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `includeZeroBalances` | boolean | `false` | Show chains/tokens with zero balance |

#### `wallet_logout`

Clear your wallet session. Requires `wallet_setup` again to use wallet features.

```json
{}
```

No parameters.

---

### DeFi Actions

| Tool | Description |
|------|-------------|
| `wallet_swap` | DEX aggregation via Li.Fi (quote → execute flow) |
| `wallet_opportunities` | Yield finder + protocol action detection + NFT positions |
| `wallet_call` | Prepare & simulate any contract call (auto ABI from Herd) |
| `wallet_executePrepared` | Execute a previously simulated transaction |

#### `wallet_swap`

Swap tokens using DEX aggregation across Uniswap, Sushiswap, Curve, Aerodrome, and more. Two-step flow: get a quote, then execute it.

```json
{ "fromToken": "ETH", "toToken": "USDC", "amount": "0.1", "chain": "base" }
```

```json
{ "action": "execute", "quoteId": "q_abc123" }
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `fromToken` | string | — | Token to sell (symbol or contract address) |
| `toToken` | string | — | Token to buy (symbol or contract address) |
| `amount` | string | — | Amount of fromToken in human units (e.g., `"0.1"`) |
| `chain` | string | — | Chain: `ethereum`, `base`, `arbitrum`, `optimism`, `polygon` |
| `action` | string | `"quote"` | `quote` = preview, `execute` = perform swap |
| `quoteId` | string | — | Quote ID from a previous quote (locks in the route) |
| `slippage` | number | `0.5` | Max slippage percentage |

#### `wallet_opportunities`

Find yield opportunities from DeFiLlama and protocol-native actions (vote escrow, staking, liquidity) from Herd. Detects existing NFT positions if `walletAddress` is provided.

```json
{ "asset": "AERO", "chain": "base" }
```

```json
{ "asset": "USDC", "chain": "base", "tokenAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `asset` | string | **Yes** | Token symbol (e.g., `"USDC"`, `"ETH"`, `"AERO"`) |
| `chain` | string | No | Filter to chain: `base`, `ethereum`, `arbitrum`, `optimism` |
| `tokenAddress` | string | No | Contract address for protocol action discovery. Auto-resolved from wallet if omitted. |
| `walletAddress` | string | No | Wallet address for NFT position detection |

#### `wallet_call`

Prepare and simulate a contract function call. Returns a `preparedTxId` for execution. Automatically fetches ABI from Herd, resolves function overloads, and coerces argument types.

```json
{ "contract": "0x...", "function": "claim", "chain": "base" }
```

```json
{ "contract": "0x...", "function": "withdraw(uint256)", "args": ["1000000"], "chain": "base" }
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `contract` | string | **Yes** | Contract address |
| `function` | string | **Yes** | Function name (`"claim"`) or full signature (`"withdraw(uint256)"`) |
| `args` | array | No | Function arguments in order |
| `value` | string | No | ETH value in wei (default: `"0"`) |
| `chain` | string | No | Chain (default: `"base"`) |
| `abi` | array | No | ABI override (fetched from Herd if omitted) |

#### `wallet_executePrepared`

Execute a transaction that was previously prepared and simulated by `wallet_call`. Prepared transactions expire after 5 minutes.

```json
{ "preparedTxId": "ptx_abc123_xyz" }
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `preparedTxId` | string | **Yes** | ID from `wallet_call` |
| `force` | boolean | No | Force execution even if simulation failed (dangerous) |

---

### Transfers & Payments

| Tool | Description |
|------|-------------|
| `wallet_send` | Send ETH or ERC-20 tokens with risk assessment |
| `wallet_pay_x402` | Pay for HTTP 402-gated resources |
| `wallet_spending_limits` | View/configure autonomous spending limits |

#### `wallet_send`

Send native tokens or ERC-20s. Includes gas preflight checks and risk assessment.

```json
{ "to": "0x...", "amount": "0.01", "chain": "base" }
```

```json
{ "to": "0x...", "amount": "100", "chain": "base", "token": "USDC" }
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string | **Yes** | Recipient address |
| `amount` | string | **Yes** | Amount in human units (e.g., `"0.1"` ETH, `"100"` USDC) |
| `chain` | string | No | Chain (default: `"base"`). Options: `base`, `ethereum`, `arbitrum`, `optimism`, `polygon` |
| `token` | string | No | Token symbol (`USDC`, `USDT`, `DAI`, `WETH`) or contract address. Omit for native token. |
| `forceUnsafe` | boolean | No | Override risk assessment warnings |

#### `wallet_pay_x402`

Pay for an HTTP 402-gated resource. Clara handles the full flow: detect 402, parse payment headers, check spending limits, sign EIP-712 authorization, and retrieve content.

```json
{ "url": "https://api.example.com/premium-data", "maxAmountUsd": "0.50" }
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | *required* | The URL to access |
| `method` | string | `"GET"` | HTTP method: `GET`, `POST`, `PUT`, `DELETE` |
| `body` | string | — | Request body for POST/PUT |
| `headers` | object | — | Additional headers |
| `maxAmountUsd` | string | `"1.00"` | Maximum USD willing to pay |
| `skipApprovalCheck` | boolean | `false` | Skip approval for pre-approved payments |

#### `wallet_spending_limits`

View or configure autonomous spending limits. Also supports viewing spending history.

```json
{ "action": "view", "showHistory": true, "historyDays": 7 }
```

```json
{ "action": "set", "maxPerTransaction": "2.00", "maxPerDay": "20.00", "requireApprovalAbove": "1.00" }
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `action` | string | `"view"` | `view` or `set` |
| `maxPerTransaction` | string | — | Max USD per transaction |
| `maxPerDay` | string | — | Max USD per day |
| `requireApprovalAbove` | string | — | USD threshold requiring explicit approval |
| `showHistory` | boolean | `false` | Include recent spending history |
| `historyDays` | number | `7` | Days of history (1–90) |

**Default limits:** $1.00 per transaction, $10.00 per day, approval required above $0.50.

---

### Signing & Security

| Tool | Description |
|------|-------------|
| `wallet_sign_message` | EIP-191 personal message signing |
| `wallet_sign_typed_data` | EIP-712 typed data signing |
| `wallet_approvals` | View/revoke ERC-20 token approvals |

#### `wallet_sign_message`

Sign a plain text message (EIP-191). Used for authentication (SIWE), attestations, and offchain protocols.

```json
{ "message": "Sign in to Example.com at 2024-01-01T00:00:00Z" }
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | **Yes** | Plain text message to sign |

#### `wallet_sign_typed_data`

Sign EIP-712 structured data. Used for gasless permits (EIP-2612), DEX order signing, and DeFi protocol interactions.

```json
{
  "domain": {
    "name": "USDC",
    "version": "2",
    "chainId": 8453,
    "verifyingContract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  },
  "types": {
    "Permit": [
      { "name": "owner", "type": "address" },
      { "name": "spender", "type": "address" },
      { "name": "value", "type": "uint256" },
      { "name": "nonce", "type": "uint256" },
      { "name": "deadline", "type": "uint256" }
    ]
  },
  "primaryType": "Permit",
  "message": {
    "owner": "0x...",
    "spender": "0x...",
    "value": "1000000",
    "nonce": "0",
    "deadline": "1735689600"
  }
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `domain` | object | **Yes** | EIP-712 domain (name, version, chainId, verifyingContract) |
| `types` | object | **Yes** | Type definitions (excluding EIP712Domain) |
| `primaryType` | string | **Yes** | The primary type to sign |
| `message` | object | **Yes** | The data to sign |

#### `wallet_approvals`

View and revoke ERC-20 token approvals. Unlimited approvals are a common security risk — use this to audit and clean them up.

```json
{ "action": "view", "chain": "base" }
```

```json
{ "action": "revoke", "token": "USDC", "spender": "0x...", "chain": "base" }
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `action` | string | `"view"` | `view` = list approvals, `revoke` = remove one |
| `chain` | string | `"base"` | Chain: `base`, `ethereum`, `arbitrum`, `optimism`, `polygon` |
| `token` | string | — | Token symbol or address (required for `revoke`) |
| `spender` | string | — | Spender address (required for `revoke`) |

---

### Intelligence

| Tool | Description |
|------|-------------|
| `wallet_analyze_contract` | Deep contract analysis via Herd |
| `wallet_history` | Transaction history via Zerion |

#### `wallet_analyze_contract`

Analyze a smart contract's functions, events, proxy status, token details, and security flags. Powered by Herd — no wallet required.

```json
{ "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "chain": "base" }
```

```json
{ "address": "0x...", "chain": "base", "detailLevel": "functions" }
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `address` | string | *required* | Contract address |
| `chain` | string | `"base"` | `ethereum` or `base` |
| `detailLevel` | string | `"summary"` | `summary`, `functions`, `events`, or `full` |

#### `wallet_history`

View recent transactions with type, amount, status, and hash. Powered by Zerion.

```json
{ "chain": "base", "limit": 10 }
```

```json
{ "chain": "all", "limit": 5 }
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `chain` | string | `"base"` | `base`, `ethereum`, `arbitrum`, `optimism`, `polygon`, or `"all"` |
| `limit` | number | `10` | Number of transactions (max 50) |

---

## Feature Highlights

### Two-Phase Contract Execution

Every contract interaction goes through mandatory simulation before execution. You see exactly what will happen — token balance changes, gas costs, potential reverts — before signing.

```
wallet_call (prepare + simulate)  →  review results  →  wallet_executePrepared (execute)
```

`wallet_call` automatically fetches the contract ABI from Herd, resolves function overloads, and coerces argument types. The returned `preparedTxId` locks in the exact calldata that was simulated, so execution matches the preview.

### Protocol Action Detection

`wallet_opportunities` goes beyond yield APYs. It queries Herd to classify top holders and detect protocol-native actions:

| Detection | Example |
|-----------|---------|
| Vote escrow | AERO → veAERO lock for voting power |
| Staking | Token → staking contract with rewards |
| Liquidity provision | Token → LP pool with fee income |
| Governance | Token → governor contract for proposals |
| NFT positions | Existing Uniswap V3 / Aerodrome LP NFTs |

Combined with DeFiLlama yield data, this gives a complete picture of what you can do with any token.

### x402 Payments

The [x402 protocol](https://x402.org) turns HTTP 402 "Payment Required" into a working payment system. Clara handles the entire flow:

```
1. Agent → API:     GET /premium-data
2. API → Agent:     402 Payment Required (headers: amount, recipient, token, chain)
3. Agent:           Signs EIP-712 payment authorization (Clara handles this)
4. Agent → API:     GET /premium-data + X-Payment header
5. API:             Verifies signature, settles on-chain
6. API → Agent:     200 OK + content
```

Spending limits keep autonomous payments safe — per-transaction caps, daily limits, and approval thresholds.

### Token Swaps via Li.Fi

`wallet_swap` aggregates across major DEXs (Uniswap, Sushiswap, Curve, Aerodrome) to find the best rate. The quote → execute flow ensures you see the exact rate before committing:

1. **Quote:** Get best route, expected output, price impact
2. **Execute:** Use the `quoteId` to lock in the route (valid 60 seconds)

Auto-handles token approvals when needed.

---

## Architecture

```
Claude Code ──▶ Clara MCP Server ──▶ clara-proxy ──▶ Para Wallet (signing)
                       │
                       ├── Herd ─────────── contract metadata, token discovery, protocol actions
                       ├── DeFiLlama ────── yield APYs
                       ├── Li.Fi ────────── DEX aggregation
                       ├── Zerion ───────── transaction history
                       └── Base/Ethereum ── RPC fallback
```

**Components:**

| Component | Role |
|-----------|------|
| **Clara MCP Server** | This project. Tool dispatch, spending limits, orchestration. |
| **clara-proxy** | Cloudflare Worker. Para wallet API, auth, signing. |
| **Para Wallet** | Third-party key management. Handles private keys and tx signing. |
| **Herd** | Contract intelligence. ABI lookup, token discovery, holder analysis. |
| **DeFiLlama** | Yield data. Lending/LP APYs across protocols. |
| **Li.Fi** | DEX aggregation. Cross-DEX routing for best swap rates. |
| **Zerion** | Portfolio data. Transaction history across chains. |

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CLARA_PROXY_URL` | Yes | URL to your clara-proxy Cloudflare Worker |
| `HERD_ENABLED` | Yes | Enable Herd provider (`"true"` / `"false"`) |
| `HERD_API_URL` | If Herd enabled | Herd API endpoint |
| `HERD_API_KEY` | If Herd enabled | Herd API key |
| `ZERION_API_KEY` | For history | Zerion API key (enables `wallet_history`) |
| `BASE_RPC_URL` | No | Custom Base RPC endpoint (uses public RPC if omitted) |

### Supported Chains

| Chain | ID | Native Token |
|-------|----|-------------|
| Base | 8453 | ETH |
| Ethereum | 1 | ETH |
| Arbitrum | 42161 | ETH |
| Optimism | 10 | ETH |
| Polygon | 137 | MATIC |

### Wallet Setup & Recovery

Clara uses [Para](https://getpara.com) wallet infrastructure. Wallets are identified by email, making them portable.

**Session storage:**

| File | Purpose |
|------|---------|
| `~/.clara/session.enc` | Encrypted wallet session (AES-256-GCM) |
| `~/.clara/spending.json` | Spending limits & history |
| `~/.clara/config.json` | Optional configuration |

**Session recovery:** Sessions expire after 24 hours. Delete `~/.clara/session.enc` and run `wallet_setup` with the same email to restore access (same address, same funds).

**Full custody:** Visit [getpara.com](https://getpara.com), sign in with your email, and export your private key or connect a hardware wallet.

---

## Security Model

- **EIP-712 Signing** — Human-readable payment authorizations
- **Spending Limits** — Hard caps on autonomous spending (per-transaction + daily)
- **Approval Flow** — Payments above threshold require explicit confirmation
- **Mandatory Simulation** — Contract calls are simulated before execution via `wallet_call`
- **Gas Preflight** — Transactions check gas availability before attempting
- **Local Storage** — Spending history stored locally, never sent externally
- **No Custody** — Clara never holds private keys (Para handles signing)

### Approval Flow

When a payment exceeds the approval threshold ($0.50 by default):

1. Clara shows payment details (amount, recipient, URL)
2. User reviews and decides
3. If approved, call the tool again with `skipApprovalCheck: true`

---

## Development

```bash
npm install          # Install dependencies
npm run dev          # Development mode (hot reload)
npm run typecheck    # Type check
npm test             # Run tests
npm run build        # Build for production
```

### Test the CLI locally

```bash
npm link
clara-mcp
```

### Publish to npm

```bash
npm run build
npm publish --dry-run   # Check what gets published
npm publish
```

---

## License

MIT
