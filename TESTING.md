# Clara MCP Testing Script

Manual testing checklist for all Clara features. Work through each section and note any issues.

---

## Pre-Flight Checks

### 1. Verify Installation
```bash
# Check npm package is accessible
npm view clara-mcp

# Test npx runs (will hang waiting for stdio - that's expected)
# Ctrl+C to exit
npx clara-mcp
```

- [ ] Package shows on npm
- [ ] npx downloads and starts the server

### 2. Verify MCP Configuration
Check your Claude Code config (`~/.claude/claude_code_config.json`):
```json
{
  "mcpServers": {
    "clara": {
      "command": "npx",
      "args": ["clara-mcp"],
      "env": {
        "CLARA_PROXY_URL": "https://your-proxy.workers.dev",
        "PARA_WALLET_ID": "your-wallet-id"
      }
    }
  }
}
```

- [ ] Config file exists
- [ ] Environment variables are set
- [ ] Clara appears in Claude Code's MCP tools

---

## Test 1: Spending Limits (No wallet needed)

These tools work without wallet configuration - they use local storage.

### 1.1 View Default Limits
**Command:** "Show my spending limits"

**Expected:** Should display:
- Per transaction: $1.00
- Per day: $10.00
- Approval above: $0.50
- Today's spending: $0.00

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 1.2 Set Custom Limits
**Command:** "Set my spending limits to $5 per transaction, $50 per day, require approval above $2"

**Expected:** Confirmation with new limits applied

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 1.3 View Updated Limits
**Command:** "Show my spending limits"

**Expected:** Should show the updated values

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 1.4 Reset to Defaults
**Command:** "Reset my spending limits to defaults: $1 per transaction, $10 per day, approval above $0.50"

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

---

## Test 2: Spending History (No wallet needed)

### 2.1 View Empty History
**Command:** "Show my spending history for the last 7 days"

**Expected:** Should show empty history or "No payments recorded"

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 2.2 View Extended History
**Command:** "Show my spending history for the last 30 days"

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

---

## Test 3: Browse x402 Ecosystem (No wallet needed)

### 3.1 Browse All Services
**Command:** "Browse x402 services"

**Expected:** List of services from multiple categories

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 3.2 Browse AI Category
**Command:** "Browse x402 AI services"

**Expected:** Services like Imference, AiMo Network, BlockRun.AI, etc.

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 3.3 Browse Data Category
**Command:** "Browse x402 data services"

**Expected:** Services like Firecrawl, Gloria AI, Neynar, etc.

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 3.4 Browse DeFi Category
**Command:** "Browse x402 defi services"

**Expected:** Services like Elsa x402, AdEx AURA, SLAMai, etc.

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 3.5 Browse Infrastructure Category
**Command:** "Browse x402 infrastructure services"

**Expected:** Services like Pinata, Proxy402, AurraCloud, etc.

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 3.6 Search Within Category
**Command:** "Browse x402 AI services for image generation"

**Expected:** Filtered results matching "image generation"

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

---

## Test 4: Discover x402 Domain (Network required)

### 4.1 Check Known x402 Domain
**Command:** "Check if imference.com supports x402"

**Expected:** Discovery document with resources listed

- [ ] ✅ Pass - Found x402 support
- [ ] ⚠️ Not Found - Domain may not have discovery endpoint
- [ ] ❌ Fail - Issue: _______________

### 4.2 Check Another Known Domain
**Command:** "Check if firecrawl.dev supports x402"

- [ ] ✅ Pass
- [ ] ⚠️ Not Found
- [ ] ❌ Fail - Issue: _______________

### 4.3 Check Non-x402 Domain
**Command:** "Check if google.com supports x402"

**Expected:** "No x402 support found"

- [ ] ✅ Pass (correctly reports no support)
- [ ] ❌ Fail - Issue: _______________

### 4.4 Probe Resources for Pricing
**Command:** "Check imference.com for x402 and probe for pricing"

**Expected:** List of endpoints with pricing if available

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

---

## Test 5: Token Discovery (Network required)

### 5.1 Discover All Tokens
**Command:** "Discover Clara tokens on Base"

**Expected:** Tables showing:
- Active auctions (if any)
- Staking opportunities (if any)

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 5.2 Filter by Auctions Only
**Command:** "Show me active CCA auctions on Base"

**Expected:** Only auction data, no staking section

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 5.3 Filter by Staking Only
**Command:** "Show me staking opportunities on Base"

**Expected:** Only staking data, no auctions section

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 5.4 Sort by APY
**Command:** "Show me staking opportunities sorted by APY"

**Expected:** Results sorted by highest APY first

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 5.5 Sort by TVL
**Command:** "Show me staking opportunities sorted by TVL"

**Expected:** Results sorted by highest TVL first

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

---

## Test 6: Token Details (Network required)

### 6.1 Get Token Details by Symbol
**Command:** "Get details for [TOKEN_SYMBOL] token on Base"

*(Use a token symbol from the discover results)*

**Expected:** Full token info with auction and/or staking stats

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 6.2 Get Token Details by Address
**Command:** "Get details for token 0x..."

*(Use an address from discover results)*

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 6.3 Token Not Found
**Command:** "Get details for NOTAREALTOKEN on Base"

**Expected:** Error message saying token not found

- [ ] ✅ Pass (error handled gracefully)
- [ ] ❌ Fail - Issue: _______________

---

## Test 7: x402 Payment (Wallet required)

⚠️ **These tests require a configured wallet with USDC on Base**

### 7.1 Wallet Not Configured Error
**Command:** (Without wallet configured) "Pay for https://some-x402-api.com/resource"

**Expected:** Clear error about missing wallet configuration

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 7.2 Non-402 URL
**Command:** "Pay for https://httpbin.org/get"

**Expected:** Should return the content directly (no payment needed)

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 7.3 Pay for x402 Resource (Small Amount)
**Command:** "Pay for [x402-url] with max $0.10"

*(Find a real x402 endpoint from browse results)*

**Expected:**
- If under approval threshold: Payment executes
- If over approval threshold: Approval prompt shown

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 7.4 Approval Flow
**Command:** "Pay for [x402-url] with max $1.00"

**Expected:** Approval prompt with payment details

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 7.5 Exceed Max Amount
**Command:** "Pay for [x402-url] with max $0.01"

*(Use a URL that costs more than $0.01)*

**Expected:** Error saying payment exceeds maximum

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 7.6 Spending Limit Exceeded
**Command:** Set daily limit to $0.01, then try to pay

**Expected:** Error about exceeding daily limit

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 7.7 Verify Spending History Updated
**Command:** After successful payment, "Show my spending history"

**Expected:** Payment appears in history

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

---

## Test 8: Integration Scenarios

### 8.1 Full Discovery → Payment Flow
1. "Browse x402 AI services"
2. "Check [domain] for x402"
3. "Pay for [endpoint]"

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

### 8.2 Token Discovery → Details Flow
1. "Discover Clara tokens"
2. "Get details for [token from results]"

- [ ] ✅ Pass
- [ ] ❌ Fail - Issue: _______________

---

## Issue Tracker

### Critical (Blocking)
| # | Issue | Status |
|---|-------|--------|
| 1 | | |

### High (Should Fix)
| # | Issue | Status |
|---|-------|--------|
| 1 | | |

### Medium (Nice to Fix)
| # | Issue | Status |
|---|-------|--------|
| 1 | | |

### Low (Polish)
| # | Issue | Status |
|---|-------|--------|
| 1 | | |

---

## Notes

*Add observations, ideas, and feedback here during testing:*

-

---

## Test Summary

| Category | Passed | Failed | Skipped |
|----------|--------|--------|---------|
| Spending Limits | /4 | | |
| Spending History | /2 | | |
| Browse x402 | /6 | | |
| Discover x402 | /4 | | |
| Token Discovery | /5 | | |
| Token Details | /3 | | |
| x402 Payment | /7 | | |
| Integration | /2 | | |
| **TOTAL** | /33 | | |
