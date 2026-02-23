# Clara MCP - Project Guide

## Architecture

Clara MCP is a focused **14-tool wallet primitive** — a stdio-based MCP server
that handles session management, balance reading, transaction sending, message
signing, spending limits, and ENS identity. Other MCP servers compose with Clara
via the `wallet_call` + `wallet_executePrepared` two-phase flow.

### Provider Hierarchy

| Data Need | Primary Provider | Fallback |
|-----------|-----------------|----------|
| Token balances | Herd (`TokenDiscovery`) | RPC + hardcoded token list |
| Tx analysis | Herd (`TxAnalysis`) | RPC basic decoding |
| Contract metadata | Herd (`ContractMetadata`) | RPC ABI fetch |
| Tx history | Zerion (`HistoryList`) | None |
| Wallet actions | Para SDK (local) | None |

### 14 Core Tools

| Category | Tools |
|----------|-------|
| Session | `wallet_setup`, `wallet_status`, `wallet_logout` |
| Read | `wallet_dashboard`, `wallet_history` |
| Write | `wallet_send`, `wallet_call`, `wallet_executePrepared` |
| Sign | `wallet_sign_message`, `wallet_sign_typed_data` |
| Safety | `wallet_approvals`, `wallet_spending_limits` |
| Identity | `wallet_register_name`, `wallet_lookup_name` |

### Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Server entry, tool registration (12 tools) |
| `src/tool-registry.ts` | Generic dispatch + middleware pipeline |
| `src/middleware.ts` | Auth, gas preflight, spending checks |
| `src/providers/registry.ts` | Capability-based routing (singleton) |
| `src/providers/herd.ts` | Herd MCP client + provider implementations |
| `src/tools/dashboard.ts` | `wallet_dashboard` — TokenDiscovery with RPC fallback |
| `src/tools/call.ts` | `wallet_call` — the composability interface |
| `src/tools/execute-prepared.ts` | `wallet_executePrepared` — execute prepared txs |
| `src/para/client.ts` | Para API wrapper |
| `src/storage/session.ts` | AES-256-GCM encrypted sessions |
| `src/storage/spending.ts` | Spending limits + history |

---

## Known Issues & Resolutions

### 1. Clara MCP tools not loading in Claude Code

**Symptom:** Clara tools don't appear even though `/mcp` shows it as connected.

**Root cause:** The MCP server may crash during initialization (e.g., missing env vars, Herd connection timeout) but Claude Code still shows it as "connected" because the transport connected briefly.

**Debug steps:**
1. Test server startup manually:
   ```bash
   HERD_ENABLED=true HERD_API_URL="https://api.herd.eco/v1/mcp" HERD_API_KEY="herd_mcp_123" \
     node /Users/brianflynn/clara-mcp/dist/index.js
   ```
2. Check for errors in the output
3. Verify it prints "Clara MCP Server running on stdio"

**Resolution:** Usually an env var issue. Check `~/.mcp.json`.

---

### 2. ~/.mcp.json overrides global config

**Symptom:** Env vars set in `~/.claude.json` mcpServers don't take effect.

**Root cause:** `~/.mcp.json` (project-level) takes precedence over `~/.claude.json` (global). If Clara is configured in both, the project-level config wins - and may be missing env vars.

**Resolution:** Keep Clara config in `~/.mcp.json` with ALL required env vars:
```json
{
  "clara": {
    "type": "stdio",
    "command": "node",
    "args": ["/Users/brianflynn/clara-mcp/dist/index.js"],
    "env": {
      "CLARA_PROXY_URL": "https://clara-proxy.bflynn4141.workers.dev",
      "ZERION_API_KEY": "...",
      "HERD_ENABLED": "true",
      "HERD_API_URL": "https://api.herd.eco/v1/mcp",
      "HERD_API_KEY": "herd_mcp_123"
    }
  }
}
```

---

### 3. Herd response field names

**Symptom:** All tokens show as "native" or balances are `undefined`.

**Root cause:** Herd's `getWalletOverviewTool` returns:
- `address` (not `tokenAddress`) - string, `"native"` for ETH
- `amount` (not `balanceFormatted`) - pre-formatted string
- `valueUsd` - number, USD value from Dune pricing
- `logoUrl` - string or null

---

### 4. Server needs restart after rebuild

**Symptom:** Code changes don't take effect after `npm run build`.

**Resolution:** Restart Claude Code session (close terminal, reopen) or use `/mcp` to restart the server.

---

### 5. Token discovery fallback behavior

The dashboard (`src/tools/dashboard.ts`) tries Herd first for ethereum/base chains:
- **Herd available:** Returns ALL tokens with USD values
- **Herd unavailable:** Falls back to RPC with hardcoded list (USDC, USDT, DAI, WETH only)

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HERD_ENABLED` | Yes | `false` | Enable Herd provider |
| `HERD_API_URL` | If Herd enabled | - | Herd API endpoint |
| `HERD_API_KEY` | If Herd enabled | - | Herd API key |
| `ZERION_API_KEY` | For history | - | Zerion API key |
| `CLARA_PROXY_URL` | For wallet ops | - | Clara proxy worker URL |
| `BASE_RPC_URL` | Optional | Public RPC | Custom Base RPC endpoint |

## Build & Test

```bash
npm run build          # TypeScript → dist/
npm test               # Run tests
node dist/index.js     # Start server (needs env vars)
```

## Composability Pattern

Other MCP servers provide calldata, Clara signs and sends:

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Swap MCP    │  │  Bounty MCP  │  │  Payments MCP│
│  (calldata)  │  │  (calldata)  │  │  (x402)      │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       └─────────────────┼─────────────────┘
                         ▼
         ┌───────────────────────────┐
         │  Clara Wallet (14 tools)  │
         │  wallet_call → Prepared   │
         │  wallet_executePrepared   │
         └───────────┬───────────────┘
                     ▼
         ┌───────────────────────────┐
         │  clara-proxy (CF Worker)  │
         │  Para MPC signing         │
         └───────────────────────────┘
```
