# Clara Architecture

Clara is an AI agent wallet system that enables autonomous payments and blockchain interactions through the Model Context Protocol (MCP).

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER'S MACHINE                                  │
│  ┌─────────────────┐     ┌─────────────────────────────────────────────┐   │
│  │   Claude Code   │     │              Clara MCP Server                │   │
│  │   (AI Agent)    │◄───►│  • wallet_setup    • wallet_send            │   │
│  │                 │ MCP │  • wallet_balance  • wallet_swap            │   │
│  │  "send 0.1 ETH" │     │  • wallet_credits  • wallet_pay_x402        │   │
│  └─────────────────┘     │  • wallet_sign     • wallet_discover_x402   │   │
│                          └──────────────┬──────────────────────────────┘   │
│                                         │                                   │
│                          ┌──────────────▼──────────────┐                   │
│                          │   ~/.clara/session.enc      │                   │
│                          │   (Encrypted wallet state)  │                   │
│                          └─────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          │ HTTPS
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CLARA PROXY (Cloudflare Worker)                      │
│                     https://clara-proxy.bflynn4141.workers.dev                │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         Request Flow                                 │   │
│  │  1. Receive request with X-Clara-Address header                     │   │
│  │  2. Check on-chain credits via ClaraCredits contract                │   │
│  │  3. If has credits → forward to Para API with injected API key      │   │
│  │  4. If no credits → return 402 with deposit instructions            │   │
│  │  5. On success → record usage in KV for later settlement            │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────┐    │
│  │  PARA_API_KEY   │    │  USAGE (KV)     │    │ SETTLEMENT_KEY      │    │
│  │  (Secret)       │    │  (Namespace)    │    │ (Secret)            │    │
│  └─────────────────┘    └─────────────────┘    └─────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
           │                        │                        │
           │                        │                        │
           ▼                        ▼                        ▼
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────────┐
│     Para API        │  │   Base Mainnet      │  │    ClaraCredits         │
│  (MPC Signing)      │  │   (RPC: 1rpc.io)    │  │    Contract             │
│                     │  │                     │  │                         │
│  • /wallets         │  │  • eth_call         │  │  0x423F1275...          │
│  • /sign-raw        │  │  • eth_getBalance   │  │                         │
│  • /sign-typed-data │  │  • eth_sendRawTx    │  │  • deposit()            │
└─────────────────────┘  └─────────────────────┘  │  • hasCredits()         │
                                                   │  • spend()              │
                                                   └─────────────────────────┘
```

## Component Details

### 1. Clara MCP Server (`clara-mcp`)

**Location:** User's machine, runs as Node.js process

**Purpose:** Provides wallet capabilities to AI agents via MCP protocol

**Key Files:**
```
clara-mcp/
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── para/
│   │   ├── account.ts        # Custom viem account for Para signing
│   │   ├── client.ts         # Para API client wrapper
│   │   └── transactions.ts   # Transaction building & submission
│   ├── storage/
│   │   └── session.ts        # Encrypted session management
│   ├── tools/
│   │   ├── wallet.ts         # setup, status, logout
│   │   ├── balance.ts        # Check balances
│   │   ├── send.ts           # Send ETH/tokens
│   │   ├── swap.ts           # Token swaps via LI.FI
│   │   ├── credits.ts        # Check Clara credits
│   │   └── x402.ts           # x402 payment tools
│   └── config/
│       ├── chains.ts         # Chain configurations
│       └── tokens.ts         # Token addresses
└── dist/                     # Compiled JavaScript
```

**Session Storage:**
- Location: `~/.clara/session.enc`
- Encryption: AES-256-GCM
- Contents: walletId, address, email, timestamps
- Expiry: 7 days of inactivity

### 2. Clara Proxy (`clara-proxy`)

**Location:** Cloudflare Workers (edge)

**Purpose:**
- Inject Para API key (keeps it secret)
- Check prepaid credits before allowing signing
- Track usage for settlement

**Routes:**
| Route | Method | Credits | Description |
|-------|--------|---------|-------------|
| `/api/v1/wallets` | POST | Free | Create wallet |
| `/api/v1/wallets` | GET | Free | List wallets |
| `/api/v1/wallets/{id}/sign-raw` | POST | Required | Sign hash |
| `/api/v1/wallets/{id}/sign-typed-data` | POST | Required | EIP-712 signing |
| `/health` | GET | - | Health check |
| `/api/usage` | GET | - | View pending usage |
| `/api/settle` | POST | - | Trigger settlement |

**Credit Check Flow:**
```
1. Extract X-Clara-Address header
2. Call hasCredits(address, 1) on ClaraCredits contract
3. If true → proceed to Para API
4. If false → return HTTP 402 with deposit instructions
```

### 3. ClaraCredits Contract

**Address:** `0x423F12752a7EdbbB17E9d539995e85b921844d8D` (Base Mainnet)

**Purpose:** On-chain prepaid credits for signing operations

**Key Functions:**
```solidity
// User deposits USDC to get credits
function deposit(uint256 amount) external

// Check if user can afford N operations
function hasCredits(address user, uint256 operations) view returns (bool)

// Deduct credits after signing (called by authorized proxy)
function spend(address user, uint256 operations) external

// Batch settlement for efficiency
function batchSpend(address[] users, uint256[] operations) external
```

**Economics:**
- Cost per operation: $0.001 (1,000 USDC units)
- Minimum deposit: $0.10 (100,000 USDC units)
- Settlement: Hourly batch via cron

### 4. Para API

**Provider:** getpara.com (MPC wallet infrastructure)

**Architecture:** Multi-Party Computation (MPC)
- No single party holds the full private key
- User share + Para share = signing capability
- Non-custodial by design

**Key Endpoints (via proxy):**
```
POST /v1/wallets
  → Create new wallet for user identifier

GET /v1/wallets?userIdentifier=...
  → List wallets for identifier

POST /v1/wallets/{id}/sign-raw
  → Sign a 32-byte hash
```

## Data Flow: Sending ETH

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  User    │    │  Claude  │    │  Clara   │    │  Proxy   │    │  Para    │
│          │    │  Code    │    │  MCP     │    │          │    │  API     │
└────┬─────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘
     │               │               │               │               │
     │ "send 0.1 ETH │               │               │               │
     │  to alice.eth"│               │               │               │
     │──────────────►│               │               │               │
     │               │               │               │               │
     │               │ wallet_send   │               │               │
     │               │ {to, amount}  │               │               │
     │               │──────────────►│               │               │
     │               │               │               │               │
     │               │               │ Build tx      │               │
     │               │               │ (nonce, gas)  │               │
     │               │               │               │               │
     │               │               │ Hash tx       │               │
     │               │               │               │               │
     │               │               │ POST /sign-raw│               │
     │               │               │ X-Clara-Addr  │               │
     │               │               │──────────────►│               │
     │               │               │               │               │
     │               │               │               │ hasCredits()  │
     │               │               │               │──────┐        │
     │               │               │               │      │        │
     │               │               │               │◄─────┘        │
     │               │               │               │               │
     │               │               │               │ POST /sign-raw│
     │               │               │               │──────────────►│
     │               │               │               │               │
     │               │               │               │   signature   │
     │               │               │◄──────────────│◄──────────────│
     │               │               │               │               │
     │               │               │ Assemble      │               │
     │               │               │ signed tx     │               │
     │               │               │               │               │
     │               │               │ Broadcast     │               │
     │               │               │ to RPC        │               │
     │               │               │               │               │
     │               │  tx hash      │               │               │
     │               │◄──────────────│               │               │
     │               │               │               │               │
     │  "Sent! tx:   │               │               │               │
     │   0xabc..."   │               │               │               │
     │◄──────────────│               │               │               │
     │               │               │               │               │
```

## Security Model

### What Clara Controls
- Session encryption key (local to user's machine)
- Transaction building (nonce, gas, data)
- Which transactions to sign

### What Para Controls
- Half of the private key (MPC share)
- Rate limiting
- Wallet creation

### What ClaraCredits Controls
- Who can sign (credit balance check)
- Cost per operation
- Settlement accounting

### Trust Assumptions
1. **Para is honest** - They can't sign without user share, but they could refuse to sign
2. **RPC is accurate** - Credit checks depend on accurate chain state
3. **Proxy is available** - Signing requires proxy to be online

## Deployment

### Clara MCP (npm)
```bash
# Global install
npm install -g clara-mcp

# Or via npx
npx clara-mcp
```

### Clara Proxy (Cloudflare)
```bash
cd clara-proxy
wrangler deploy
wrangler secret put PARA_API_KEY
wrangler secret put SETTLEMENT_PRIVATE_KEY
```

### ClaraCredits (Foundry)
```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url https://mainnet.base.org --broadcast
```

## Configuration

### Environment Variables (Clara MCP)
| Variable | Description | Default |
|----------|-------------|---------|
| `CLARA_PROXY_URL` | Proxy endpoint | `https://clara-proxy.bflynn4141.workers.dev` |
| `CLARA_SESSION_PATH` | Session storage dir | `~/.clara` |
| `CHAINSTACK_API_KEY` | Optional RPC key | - |

### Cloudflare Secrets (Proxy)
| Secret | Description |
|--------|-------------|
| `PARA_API_KEY` | Para API authentication |
| `SETTLEMENT_PRIVATE_KEY` | Wallet for calling spend() |

### KV Namespaces (Proxy)
| Binding | Purpose |
|---------|---------|
| `USAGE` | Track signing operations per user |
