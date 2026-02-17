# Clara MCP - Project Guide

## Architecture

Clara MCP is a stdio-based MCP server that provides wallet management tools.
It uses a **provider registry** pattern to route requests to the best available data source.

### Provider Hierarchy

| Data Need | Primary Provider | Fallback |
|-----------|-----------------|----------|
| Token balances | Herd (`TokenDiscovery`) | RPC + hardcoded token list |
| Tx analysis | Herd (`TxAnalysis`) | RPC basic decoding |
| Contract metadata | Herd (`ContractMetadata`) | RPC ABI fetch |
| Tx history | Zerion (`HistoryList`) | None |
| Wallet actions | Para SDK (local) | None |

### Key Files

| File | Purpose |
|------|---------|
| `src/providers/types.ts` | All provider interfaces and capability types |
| `src/providers/herd.ts` | Herd MCP client + all Herd provider implementations |
| `src/providers/registry.ts` | Capability-based routing (singleton `ProviderRegistry`) |
| `src/providers/index.ts` | Provider initialization and registration |
| `src/tools/dashboard.ts` | `wallet_dashboard` tool - uses `TokenDiscovery` with RPC fallback |

---

## Known Issues & Resolutions

### 1. Clara MCP tools not loading in Claude Code

**Symptom:** `/clara` skill says "Clara MCP server not connected" even though `/mcp` shows it as connected.

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

**Resolution:** Always validate response types against the actual Herd API output. Run:
```bash
# Test Herd tool directly
ToolSearch query: "select:mcp__herd__getWalletOverviewTool"
mcp__herd__getWalletOverviewTool walletAddress="0x..." blockchain="base"
```

---

### 4. Server needs restart after rebuild

**Symptom:** Code changes don't take effect after `npm run build`.

**Root cause:** MCP servers run as persistent child processes. The old process keeps running with stale code.

**Resolution:** Restart Claude Code session (close terminal, reopen) or use `/mcp` to restart the server.

---

### 5. Token discovery fallback behavior

The dashboard (`src/tools/dashboard.ts`) tries Herd first for ethereum/base chains:
- **Herd available:** Returns ALL tokens with USD values
- **Herd unavailable:** Falls back to RPC with hardcoded list (USDC, USDT, DAI, WETH only)

This means if Herd is down, users will see fewer tokens. This is expected behavior, not a bug.

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
node dist/index.js     # Start server (needs env vars)
```

### Quick integration test:
```bash
HERD_ENABLED=true HERD_API_URL="https://api.herd.eco/v1/mcp" HERD_API_KEY="herd_mcp_123" \
  node -e "
    const { initProviders, getProviderRegistry } = require('./dist/providers/index.js');
    async function test() {
      await initProviders();
      const r = getProviderRegistry();
      const result = await r.discoverTokens('0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd', 'base');
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }
    test();
  "
```
