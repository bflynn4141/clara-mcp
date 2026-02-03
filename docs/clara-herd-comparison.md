# Clara MCP vs Herd MCP Tool Comparison

## Tool Inventories

### Herd MCP Tools (5 total)
| Tool | Description |
|------|-------------|
| `contractMetadataTool` | Full contract metadata: ABI, functions, events, proxy history, token info |
| `queryTransactionTool` | Deep tx analysis with traces, balance changes, decoded logs |
| `getLatestTransactionsTool` | Recent txs for specific function/event signature |
| `regexCodeAnalysisTool` | AI-powered code search with natural language |
| `diffContractVersions` | Compare proxy implementation versions |

### Clara MCP Tools (35 total)
| Category | Tools |
|----------|-------|
| **Wallet Core** | `wallet_setup`, `wallet_status`, `wallet_logout`, `wallet_balance`, `wallet_dashboard` |
| **Transactions** | `wallet_send`, `wallet_swap`, `wallet_bridge`, `wallet_simulate`, `wallet_sign_message`, `wallet_sign_typed_data` |
| **Tx Management** | `wallet_speed_up`, `wallet_cancel`, `wallet_history` |
| **Analysis** | `wallet_analyze_contract`, `wallet_analyze_tx`, `wallet_decode_tx`, `wallet_monitor_events` |
| **DeFi** | `wallet_earn`, `wallet_approvals` |
| **Clara Ecosystem** | `wallet_discover_tokens`, `wallet_token_details`, `wallet_cca_bid`, `wallet_cca_claim`, `wallet_cca_exit`, `wallet_stake`, `wallet_unstake`, `wallet_claim_dividends`, `wallet_distribute_revenue` |
| **x402 Payments** | `wallet_pay_x402`, `wallet_discover_x402`, `wallet_browse_x402`, `wallet_spending_limits`, `wallet_spending_history`, `wallet_credits` |
| **Utilities** | `wallet_resolve_ens` |

---

## Overlap Analysis

### 🔄 DIRECT OVERLAPS (Herd should be primary)

| Clara Tool | Herd Tool | Recommendation |
|------------|-----------|----------------|
| `wallet_analyze_contract` | `contractMetadataTool` | **Use Herd** - Richer data (proxy history, AI summaries) |
| `wallet_analyze_tx` | `queryTransactionTool` | **Use Herd** - Deeper analysis (traces, balance changes) |
| `wallet_decode_tx` | `queryTransactionTool` | **Merge into analyze_tx** - Redundant tool |

### ⚡ PARTIAL OVERLAPS (Clara extends Herd)

| Clara Tool | Herd Tool | Relationship |
|------------|-----------|--------------|
| `wallet_monitor_events` | `getLatestTransactionsTool` | Clara adds real-time monitoring; Herd is historical query |
| `wallet_history` | `queryTransactionTool` | Clara uses Zerion for portfolio history; Herd for single tx deep-dive |

### ✅ NO OVERLAP (Clara-specific features)

These tools have no Herd equivalent and are Clara's unique value:

**Wallet Operations:**
- `wallet_setup/status/logout` - Wallet management
- `wallet_send/swap/bridge` - Transaction execution
- `wallet_simulate` - Pre-execution simulation
- `wallet_sign_*` - Signature operations

**DeFi Actions:**
- `wallet_earn` - Yield discovery and deposit
- `wallet_approvals` - Token approval management

**Clara Ecosystem:**
- `wallet_discover_tokens` - Clara token discovery
- `wallet_cca_*` - Auction participation
- `wallet_stake/unstake` - Clara staking
- `wallet_claim_dividends` - Revenue claims

**x402 Payments:**
- `wallet_pay_x402` - Payment execution
- `wallet_spending_*` - Spending controls

### ❌ NO OVERLAP (Herd-specific features)

These Herd tools have no Clara equivalent (opportunities for new tools):

| Herd Tool | Potential Clara Tool | Use Case |
|-----------|---------------------|----------|
| `regexCodeAnalysisTool` | `wallet_search_code` | "Find all reentrancy guards in this contract" |
| `diffContractVersions` | `wallet_compare_versions` | "What changed in USDC's last upgrade?" |

---

## Recommendations

### 1. Simplify by Removing Redundancy

```
BEFORE:
  wallet_analyze_contract → (basic RPC fallback)
  wallet_analyze_tx → (basic RPC fallback)
  wallet_decode_tx → (basic decoding)

AFTER:
  wallet_analyze_contract → Herd contractMetadataTool (rich data)
  wallet_analyze_tx → Herd queryTransactionTool (traces + decode)
  wallet_decode_tx → REMOVE (merged into analyze_tx)
```

### 2. Current Architecture (Already Correct ✅)

Clara already uses Herd as the **primary provider** with RPC as fallback:

```typescript
// src/providers/herd.ts
export const herdProvider: ContractIntelProvider = {
  name: 'herd',
  priority: 1,  // Highest priority
  // ...
};

// src/providers/rpc.ts
export const rpcProvider: ContractIntelProvider = {
  name: 'rpc',
  priority: 10,  // Fallback only
  // ...
};
```

### 3. Tools to Add (Leverage Herd More)

| New Tool | Herd Backend | Value |
|----------|--------------|-------|
| `wallet_search_code` | `regexCodeAnalysisTool` | "How does this contract handle fees?" |
| `wallet_compare_upgrades` | `diffContractVersions` | Security audit for proxy upgrades |
| `wallet_research` | `researchTool` (if available) | AI-powered protocol research |

### 4. Tools to Remove/Merge

| Tool | Action | Reason |
|------|--------|--------|
| `wallet_decode_tx` | Merge into `wallet_analyze_tx` | Redundant - analyze_tx already decodes |

---

## Final Tool Count

| Category | Before | After | Change |
|----------|--------|-------|--------|
| Clara tools | 35 | 34 | -1 (merge decode_tx) |
| Herd-backed | 3 | 5 | +2 (search_code, compare_upgrades) |
| Clara-only | 32 | 29 | (no change to unique features) |

---

## Summary

**Herd provides:** Deep blockchain intelligence (contract analysis, tx decoding, code search)

**Clara provides:** Wallet operations, DeFi actions, Clara ecosystem, x402 payments

**Integration is already correct:** Clara uses Herd as primary provider with graceful fallback.

**Opportunities:**
1. Remove `wallet_decode_tx` (redundant)
2. Add `wallet_search_code` (new capability from Herd)
3. Add `wallet_compare_upgrades` (new capability from Herd)
