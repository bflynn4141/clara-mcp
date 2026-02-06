# Testing Plan: UX Review & Regression Baseline

> **Author:** UX Designer
> **Date:** 2026-02-05
> **Status:** Review Complete
> **Scope:** Existing UX regression baselines, free tier clarifications, CLARA-conditional feature gating

---

## Table of Contents

1. [Overview](#overview)
2. [Current Tool Output Baselines (Regression Reference)](#current-tool-output-baselines)
3. [Answers to QA Engineer's Specialist Questions](#answers-to-qa-engineers-specialist-questions)
4. [Missing Test Cases: "No CLARA" User Journey](#missing-test-cases-no-clara-user-journey)
5. [Missing Test Cases: Free Tier Implementation Detail](#missing-test-cases-free-tier-implementation-detail)
6. [Missing Test Cases: CLARA Feature Gating](#missing-test-cases-clara-feature-gating)
7. [Error State Coverage Gap Analysis](#error-state-coverage-gap-analysis)
8. [Test Case Amendments & Feedback](#test-case-amendments--feedback)
9. [Summary of Additions](#summary-of-additions)

---

## Overview

The #1 priority of this review is ensuring that **the existing Clara MCP user experience does not change for users who do not have CLARA tokens**. Every existing tool must produce identical output, identical error messages, and identical flows.

This document:
- Captures the **exact current output format** of every tool (the regression baseline)
- Answers the QA engineer's specialist questions about free tier, thresholds, and wallet_status
- Adds test cases for user journeys where CLARA is absent
- Identifies error state coverage gaps

---

## Current Tool Output Baselines

These are the EXACT output formats produced by the current tool implementations. Any test asserting "output unchanged" must validate against these baselines.

### BL-001: wallet_setup (with email, new wallet)

**Source:** `src/tools/wallet.ts:101-130`

```
✅ Wallet created!

**Address:** `0xa1b2...c3d4`
**Email:** user@example.com

💡 *Portable wallet: You can recover this wallet on any device using the same email, or claim full custody at [getpara.com](https://getpara.com).*

**⚡ Get Started:**
1. **Add credits** - Deposit USDC to use signing operations
   - Run `wallet_status` to see your credit balance and deposit instructions
   - Minimum deposit: $0.10, each operation costs $0.001
2. **Start using** - `wallet_pay_x402` for payments, `wallet_balance` for balances

**🎯 Recommended next step:**
Run `wallet_briefing` to get a personalized summary of your wallet activity and opportunities.

**Useful commands:**
- `wallet_briefing` - Get wallet insights and opportunities
- `wallet_status` - View wallet details and credit balance
- `wallet_spending_limits` - Configure spending controls
```

**Key assertions:**
- First line is `✅ Wallet created!` (new) or `✅ Wallet ready!` (existing)
- Address and email shown
- Mentions `$0.001` per operation and `$0.10` minimum deposit (ClaraCredits model)
- Recommends `wallet_briefing` as next step
- Does NOT mention CLARA tokens, staking, airdrop, or free tier counter

### BL-002: wallet_setup (without email)

**Source:** `src/tools/wallet.ts:112-113`

```
✅ Wallet created!

**Address:** `0xa1b2...c3d4`

💡 *Machine-specific wallet: Only accessible on this device. Run `wallet_setup` with an email for a portable wallet.*

**⚡ Get Started:**
...
```

**Key assertions:**
- Shows machine-specific warning instead of portable wallet note
- Everything else identical to BL-001

### BL-003: wallet_status (authenticated)

**Source:** `src/tools/wallet.ts:198-252`

```
✅ **Wallet Active**

**Address:** `0x8744baf0...caffd`
**Email:** bflynn4141@gmail.com
**Chain:** Base (8453)
**Wallet Backend:** para
**Session Marker:** <marker>
**Session Age:** 2h 15m

**Supported Chains:**
- Base (8453) <-- selected
- Ethereum (1)
- Arbitrum (42161)
- Optimism (10)
- Polygon (137)

**Spending Limits:**
<formatted spending summary>

**Clara Credits:**
- Balance: $0.0500 USDC
- Available operations: 50
- Cost per operation: $0.001

**Tip:** Run `wallet_briefing` for personalized insights on your holdings and opportunities.
```

**Key assertions:**
- Heading: `✅ **Wallet Active**`
- Shows address, email, chain, wallet backend, session marker, session age
- Lists all 5 supported chains with selection marker
- Shows spending limits
- Shows Clara Credits section with balance, available ops, cost per op
- If credits == 0: shows deposit link to BaseScan
- If credits < 10: shows "Low credits" warning
- Does NOT mention CLARA token, staking, or free tier counter

### BL-004: wallet_status (not authenticated)

**Source:** `src/tools/wallet.ts:186-194`

```
❌ No wallet configured

Run `wallet_setup` to create a wallet:
- `wallet_setup` - Create instant (machine-specific) wallet
- `wallet_setup email="you@example.com"` - Create portable wallet
```

### BL-005: wallet_dashboard (with balances)

**Source:** `src/tools/dashboard.ts:289-385`

```
# 📊 Wallet Dashboard

## Account
**Address:** `0x8744baf0...caffd`
**Email:** bflynn4141@gmail.com
**Session:** Active (1h 23m)

## 💰 Portfolio
**Total Stablecoins:** $127.45

### Base
- **ETH:** 0.142000
- **USDC:** 127.450000 ($127.45)

### Ethereum
- **ETH:** 0.050000

## 🔒 Spending Limits
<formatted spending summary>

## 📜 Recent Payments
- 2026-02-05: $0.01 to api.example.com

## 💡 Actions
- `wallet_balance chain="base"` - Detailed balance for a specific chain
- `wallet_briefing` - AI-powered insights on your holdings
- `wallet_opportunities` - Find yield opportunities for your positions
- `wallet_credits` - Check signing credits

---
```json
{structured data}
```

**Key assertions:**
- Heading: `# 📊 Wallet Dashboard`
- Sections in order: Account, Portfolio, Spending Limits, Recent Payments, Actions
- Portfolio groups tokens by chain, shows native and ERC-20 tokens
- Stablecoins show USD value in parentheses
- Chains with zero balances are OMITTED (unless `includeZeroBalances: true`)
- Does NOT have a "CLARA Staking" section
- Does NOT show free tier counter
- Does NOT mention CLARA tokens anywhere
- Ends with structured JSON block

### BL-006: wallet_dashboard (empty wallet)

```
# 📊 Wallet Dashboard

## Account
**Address:** `0xa1b2...c3d4`
**Session:** Active

## 💰 Portfolio
_No balances found on any chain_

## 🔒 Spending Limits
<formatted spending summary>

## 💡 Actions
- `wallet_balance chain="base"` - Detailed balance for a specific chain
...
```

**Key assertions:**
- Shows `_No balances found on any chain_` (italic markdown)
- No chain subsections
- Actions section still present

### BL-007: wallet_send (success)

**Source:** `src/tools/send.ts:351-369`

```
✅ Transaction sent!

**Amount:** 1.000000 USDC
**To:** `0xdead...beef`
**Chain:** base
**From:** `0x8744baf0...caffd`

**Transaction:** [0x1234abcd...ef567890](https://basescan.org/tx/0x...)
```

**Key assertions:**
- Heading: `✅ Transaction sent!`
- Shows amount with token symbol, to, chain, from
- Transaction hash as clickable explorer link
- If risk warnings exist, appended after `---` separator
- Does NOT mention free tier counter, x402 fees, or CLARA

### BL-008: wallet_send (error - invalid address)

```
❌ Invalid recipient address. Must be a valid 0x address.
```

### BL-009: wallet_send (error - spending limit)

```
🛑 **Send blocked by spending limits**

<reason>

Use `wallet_spending_limits` to view or adjust your limits.
```

### BL-010: wallet_swap (quote)

**Source:** `src/tools/swap.ts:193-252, 373-385`

```
🔄 **Swap Quote on Base** (via UniswapV3)

**Router:** UniswapV3Router
**You send:** 10.0 USDC (~$10.00)
**You receive:** 0.003891 ETH (~$10.52)
**Minimum:** 0.003872 ETH (after slippage)

**Rate:** 1 USDC = 0.000389 ETH
**Price Impact:** 0.05%
**Gas:** ~$0.12

**Router:** `0x3fC9...1a2b`

✅ **Already approved** - ready to execute

**Quote ID:** `q_abc123` (valid for 60 seconds)
**Router Risk:** 🟢 Low
**Will send:** swap (1 transaction)

💡 To execute: `action="execute", quoteId="q_abc123"`
```

**Key assertions:**
- Shows quote details: from/to amounts with USD values, rate, impact, gas
- Router name from Herd (if available)
- Quote ID for route locking
- Router risk level
- Approval status
- Does NOT mention CLARA or free tier

### BL-011: wallet_swap (execute success)

```
🔄 **Swap Quote on Base** (via UniswapV3)
<quote details>

✅ **Swap Submitted!**

**Transaction:** `0xabcd...`
🔗 [View on Explorer](https://basescan.org/tx/0x...)

Your ETH will arrive shortly.
```

### BL-012: wallet_opportunities (standard yield results)

**Source:** `src/tools/opportunities.ts:183-301`

```
## 💰 Opportunities: USDC on base

### Lending

Found 5 yield opportunities (sorted by APY):

| # | Protocol | Chain | APY | Base APY | Reward APY | TVL |
|---|----------|-------|-----|----------|------------|-----|
| 1 | Aave V3  | base  | 4.82% | 4.82% | 0.00% | $2.1B |
| 2 | Compound | base  | 3.91% | 3.91% | 0.00% | $892M |
...

### Protocol Actions (via Herd)

Found 3 protocol-native actions (analyzed 50 top holders):

| # | Action | Protocol | Contract | Supply Locked | Confidence | Your Position |
|---|--------|----------|----------|---------------|------------|---------------|
| 1 | Stake  | Protocol | 0x1234...5678 | 24.00% | high | — |
...

💡 **Stake** (24.00% of supply): ...

---
```json
{structured data}
```

**Key assertions:**
- Heading: `## 💰 Opportunities: <ASSET> on <chain>`
- Section 1: "Lending" with DeFiLlama data in table format
- Section 2: "Protocol Actions (via Herd)" if tokenAddress resolved — table format
- Does NOT have a "CLARA Staking" section
- Does NOT mention CLARA staking, airdrop, or fee sharing
- Ends with structured JSON block

### BL-013: wallet_opportunities (no results)

```
No opportunities found for <ASSET> on <chain>.

💡 Pass `tokenAddress` to also discover protocol-native actions (staking, vote escrow, etc.).
```

### BL-014: wallet_logout

**Source:** `src/tools/wallet.ts:477-484`

```
✅ Logged out

Your wallet session has been cleared.
Run `wallet_setup` to reconnect.
```

---

## Answers to QA Engineer's Specialist Questions

### Q1: Free tier counter location

**Answer:** The free tier counter does NOT exist yet in the current codebase. The UX design document (ux-design.md) recommends one of two options:

- **Option A (recommended):** Store in the **ClaraCredits contract** on-chain. Mint 25 free credits at first wallet creation. When credits hit zero, x402 kicks in.
- **Option B:** Store in **clara-proxy** (server-side, Cloudflare Workers KV or D1).

**Current state:** Today, wallet_setup does NOT show "25 free operations." The ClaraCredits contract at `0x423F...` uses a deposit-then-deduct model ($0.001/operation), not a free tier model. The free tier is a NEW feature that must be implemented.

**Impact on testing:** TC-340 through TC-345 are testing NEW behavior that does not exist today. They must NOT be treated as regression tests. They are NEW feature tests. The regression test is: "wallet_setup output remains identical to BL-001/BL-002 until free tier is implemented."

### Q2: CLARA staking section threshold in opportunities

**Answer:** The "10+ paid operations" threshold for showing CLARA staking in wallet_opportunities (TC-333) is a UX design recommendation, not an implemented feature. The tracking would need to live in the **clara-proxy** (server-side), since:

- On-chain tracking would require a contract call per operation (expensive)
- Client-side tracking is trivially reset
- Proxy already processes every x402 payment and can maintain a counter per wallet address

**For testing:** TC-333 is a NEW feature test. The regression baseline (BL-012) shows that wallet_opportunities today has NO CLARA staking section regardless of user state.

### Q3: Error message exact wording

**Answer:** Tests should validate **semantic content, not exact text**. Reasons:

1. The exact wording in the UX design doc is aspirational — the implementation may differ slightly
2. Minor copy changes (punctuation, capitalization) should not break tests
3. What matters is that the ERROR TYPE is correct and the ACTIONABLE GUIDANCE is present

**Recommended approach:** Use substring/regex matching:
- TC-345 (no USDC, free tier exhausted): Assert contains "USDC", "Base", and a deposit address
- TC-403 (no USDC after free tier): Assert contains "deposit" and wallet address, and that read ops still work
- TC-404 (expired session): Assert contains "expired" and "wallet_setup"
- TC-405 (spending limit): Assert contains "spending limit" and "wallet_spending_limits"
- TC-406 (no rewards): Assert does NOT revert, contains "no rewards" or "0"
- TC-407 (no CLARA to stake): Assert contains "CLARA" and either "swap" or "airdrop"

### Q4: wallet_status CLARA-related additions

**Answer:** `wallet_status` should NOT get CLARA-related additions in the initial release. The UX design doc's appendix ("aha moment" section) mentions it as a FUTURE consideration ("When claimable rewards exceed $1.00, wallet_status should mention it"). This is Phase 2.

**For testing:** wallet_status (TC-301) must remain EXACTLY as BL-003. No CLARA staking info, no claimable rewards, no free tier counter. This is a strict regression test.

---

## Missing Test Cases: "No CLARA" User Journey

The testing plan has TC-401 ("Existing user journey — no CLARA involvement") which is good, but it's a single end-to-end test. We need granular regression tests that assert EXACT output format preservation.

### TC-316: wallet_setup output format is byte-identical (no CLARA user)

```
Category: mcp
Priority: P0-critical
Preconditions: Clara MCP running with CLARA system fully deployed
Steps:
  1. Call wallet_setup with email="newuser@example.com" (user has no CLARA)
  2. Capture full response text
  3. Assert response matches BL-001 baseline pattern:
     - Contains "✅ Wallet created!" or "✅ Wallet ready!"
     - Contains "**Address:**" and "**Email:**"
     - Contains "$0.001" (cost per operation) and "$0.10" (min deposit)
     - Contains "wallet_briefing" recommendation
  4. Assert response does NOT contain: "CLARA", "staking", "airdrop", "free operations", "free tier"
Expected: wallet_setup output is unchanged from pre-CLARA baseline
Notes: This is the single most important regression test. If CLARA integration
  changes wallet_setup for non-CLARA users, the integration is broken.
```

### TC-317: wallet_status output has no CLARA section (no CLARA user)

```
Category: mcp
Priority: P0-critical
Preconditions: Active session, CLARA system deployed, user has no CLARA
Steps:
  1. Call wallet_status
  2. Assert response matches BL-003 baseline:
     - Contains "✅ **Wallet Active**"
     - Contains "Clara Credits:" section
     - Contains "Spending Limits:" section
     - Contains supported chains list
  3. Assert response does NOT contain: "CLARA Staking", "Claimable", "staking rewards"
Expected: wallet_status unchanged for non-CLARA users
Notes: If wallet_status is extended later to show claimable rewards, it must be gated
  behind a "has staked CLARA" check.
```

### TC-318: wallet_dashboard Actions section unchanged (no CLARA user)

```
Category: mcp
Priority: P0-critical
Preconditions: Active session, user has USDC and ETH, no CLARA
Steps:
  1. Call wallet_dashboard
  2. Assert the "💡 Actions" section contains exactly:
     - wallet_balance
     - wallet_briefing
     - wallet_opportunities
     - wallet_credits
  3. Assert "💡 Actions" does NOT contain: "wallet_claim_airdrop", "ClaraStaking", "stake"
  4. Assert no "CLARA Staking" section exists between Spending Limits and Actions
Expected: Dashboard actions list and section ordering unchanged for non-CLARA users
Notes: The CLARA staking section, if added, must be inserted BETWEEN Portfolio and
  Spending Limits — never replacing or altering the existing sections.
```

### TC-319: wallet_send response has no fee or counter line (no CLARA user, current behavior)

```
Category: mcp
Priority: P0-critical
Preconditions: Active session, user has USDC, no CLARA, no free tier implemented
Steps:
  1. Call wallet_send with valid params
  2. Assert response matches BL-007 baseline:
     - Contains "✅ Transaction sent!"
     - Contains Amount, To, Chain, From, Transaction link
  3. Assert response does NOT contain:
     - "Free operations:" or "remaining"
     - "x402 fee:" or "Today:"
     - "CLARA" or "staking"
Expected: Send response is unchanged until free tier is explicitly implemented
Notes: When free tier IS implemented, TC-341 covers the new behavior. But until then,
  the current output must be preserved.
```

---

## Missing Test Cases: Free Tier Implementation Detail

The testing plan's TC-340 through TC-345 test the free tier UX, but they don't address implementation ambiguities.

### TC-346: Free tier counter does NOT appear in wallet_status

```
Category: mcp
Priority: P1-high
Preconditions: New wallet with free tier active
Steps:
  1. Call wallet_status
  2. Assert "Clara Credits" section still shows deposit-based credits
  3. Assert free tier counter appears ONLY in write operation responses (per UX design)
Expected: wallet_status is not the place for the free tier counter. It shows on
  wallet_setup and in write operation response footers.
Notes: The free tier counter and Clara Credits are separate concepts. Credits are
  deposit-based ($0.001/op). Free tier is a one-time 25-op gift. They should not
  be merged in the wallet_status display until the UX design explicitly says to.
```

### TC-347: Read operations during free tier show NO counter

```
Category: mcp
Priority: P1-high
Preconditions: New wallet with 20 free ops remaining
Steps:
  1. Call wallet_dashboard — assert NO "Free operations: 20 remaining" line
  2. Call wallet_history — assert NO counter
  3. Call wallet_opportunities — assert NO counter
  4. Call wallet_status — assert NO counter
Expected: Free tier counter ONLY appears in write operation responses
Notes: Per UX design: "Read operations (dashboard, history, opportunities, analyze)
  are always free." The counter should not pollute read-only responses.
```

### TC-348: Free tier counter does NOT interact with Clara Credits

```
Category: mcp
Priority: P1-high
Preconditions: New wallet with 25 free ops AND $0.50 in Clara Credits
Steps:
  1. Perform write operation
  2. Assert free tier counter decrements (24 remaining)
  3. Assert Clara Credits balance unchanged ($0.50)
  4. Exhaust all 25 free ops
  5. Assert next write op uses x402 (NOT Clara Credits)
Expected: Free tier and Clara Credits are independent systems. Free tier is consumed
  first, then x402 kicks in. Clara Credits ($0.001/op model) is being deprecated
  per UX design recommendations.
Notes: This tests the transition path. If ClaraCredits is being kept alongside the
  free tier, this test ensures they don't interfere with each other.
```

---

## Missing Test Cases: CLARA Feature Gating

The testing plan tests that CLARA features APPEAR for stakers, but needs more tests confirming they are ABSENT for non-stakers.

### TC-334: wallet_dashboard has NO "(unstaked)" label without CLARA in wallet

```
Category: mcp
Priority: P1-high
Preconditions: Active session, user has USDC and ETH, zero CLARA balance
Steps:
  1. Call wallet_dashboard
  2. Assert portfolio section shows USDC and ETH
  3. Assert NO token line contains "(unstaked)" label
  4. Assert NO inline hint about staking
Expected: The "(unstaked)" label and staking hint only appear when user actually
  holds CLARA tokens in their wallet. Zero CLARA = no mention of CLARA at all.
Notes: TC-331 tests that the label APPEARS with CLARA. This test confirms it's
  ABSENT without CLARA. Both are needed.
```

### TC-335: wallet_opportunities NEVER shows CLARA staking for brand-new user

```
Category: mcp
Priority: P0-critical
Preconditions: Brand-new wallet, 0 operations performed, no CLARA, no paid ops
Steps:
  1. Call wallet_opportunities asset="USDC" chain="base"
  2. Assert standard lending yields returned (Aave, Compound, etc.)
  3. Assert NO "CLARA Staking" section
  4. Assert structured JSON does NOT contain "CLARA" or "ClaraStaking"
Expected: A brand-new user sees zero CLARA-related content in opportunities
Notes: The auto-detection triggers are: (a) user has CLARA in wallet, or (b) 10+
  paid operations. A new user meets neither. This test is critical because a
  CLARA mention during first exploration would confuse users who haven't heard
  of CLARA yet.
```

### TC-336: wallet_opportunities CLARA section position is AFTER lending

```
Category: mcp
Priority: P1-high
Preconditions: User has CLARA staked, queries wallet_opportunities asset="USDC"
Steps:
  1. Call wallet_opportunities asset="USDC" chain="base"
  2. Assert "Lending" section appears FIRST
  3. Assert "CLARA Staking" section appears AFTER lending table
  4. Assert lending table content is unchanged (same APYs, same protocols)
Expected: CLARA staking section is APPENDED, never prepended or interleaved
Notes: The lending data must be identical whether or not the user has CLARA. The
  CLARA section is purely additive.
```

---

## Error State Coverage Gap Analysis

Comparing UX design error states (E1-E8) against test cases:

| Error | UX Design Ref | Test Case | Coverage |
|-------|---------------|-----------|----------|
| E1: No USDC, free tier exhausted | ux-design.md E1 | TC-345, TC-403 | Covered |
| E2: USDC balance too low | ux-design.md E2 | Missing | **GAP** |
| E3: Spending limit exceeded | ux-design.md E3 | TC-405 | Covered |
| E4: Expired session | ux-design.md E4 | TC-404 | Covered |
| E5: Transaction failed (insufficient gas) | ux-design.md E5 | Missing | **GAP** |
| E6: Insufficient CLARA to stake | ux-design.md E6 | TC-407 | Covered |
| E7: Claim with no rewards | ux-design.md E7 | TC-406 | Covered |
| E8: Airdrop not eligible | ux-design.md E8 | TC-323 | Covered |

### TC-350: Error E2 — USDC balance too low for x402

```
Category: mcp
Priority: P1-high
Preconditions: User has exhausted free tier, has $0.003 USDC (below $0.01 x402 fee)
Steps:
  1. Attempt wallet_send
  2. Assert error contains: required amount, current balance, "top up"
  3. Assert error does NOT crash or show raw exception
Expected: Clear message showing shortfall and how to fix it
Notes: This is subtly different from E1 (zero USDC). E2 has dust but not enough.
  The error message should show exact amounts.
```

### TC-351: Error E5 — Transaction failed (insufficient gas)

```
Category: mcp
Priority: P1-high
Preconditions: User has USDC but near-zero ETH on Base
Steps:
  1. Attempt wallet_send token="USDC" amount="1" chain="base"
  2. Assert error mentions "gas" and ETH balance
  3. Assert error suggests swap USDC -> ETH or deposit ETH
Expected: Gas error handled gracefully with actionable guidance
Notes: The current code has `requireGas()` pre-flight check (send.ts:231).
  Need to verify the error message from ClaraError matches UX design E5.
```

---

## Test Case Amendments & Feedback

### TC-300 (wallet_setup) — Amendment

The test says "Verify response does NOT mention CLARA tokens or staking." This is correct, but should also assert:
- Response DOES mention ClaraCredits deposit model (current behavior)
- Response DOES recommend wallet_briefing (current behavior)
- Response does NOT mention "free operations" (that's a new feature)

### TC-302 (wallet_dashboard no CLARA section) — Amendment

Good test. Add assertion:
- The structured JSON at the end of the dashboard output must NOT contain any key named "claraStaking", "staked", or "claimable"
- The Actions section must NOT list wallet_claim_airdrop

### TC-314 (wallet_opportunities no CLARA) — Amendment

Good test. Add assertion:
- The structured JSON `protocolActions.actions` array must NOT contain any entry with `type: "clara_staking"` or `contractName` containing "ClaraStaking"
- The "Lending" table must contain the same number of rows and same protocols regardless of CLARA ownership

### TC-330 (dashboard shows CLARA staking section) — Amendment

Add assertion for section ordering:
- The CLARA Staking section must appear AFTER Portfolio and BEFORE Spending Limits
- The section heading should be `## CLARA Staking` (not part of Portfolio)
- The Claimable line must include an inline action hint (`wallet_call`)

### TC-331 (unstaked CLARA with staking hint) — Amendment

Clarify: What does "unstaked CLARA" mean visually? The current dashboard (BL-005) shows tokens like:
```
- **USDC:** 127.450000 ($127.45)
```

The proposed format adds:
```
- **CLARA:** 500.000000 (unstaked)
    → Stake to earn fees: wallet_call target=ClaraStaking action=stake
```

This is a VISUAL FORMAT CHANGE to the portfolio section. Tests must verify:
1. Only CLARA gets the "(unstaked)" annotation — other tokens unchanged
2. The arrow hint (`→`) is ONLY shown for CLARA, never for USDC/ETH/etc.
3. If user has BOTH staked and unstaked CLARA, the portfolio shows the unstaked portion and the CLARA Staking section shows the staked portion

### TC-340 (wallet_setup shows free tier counter) — Amendment

**CRITICAL:** This test describes NEW behavior that conflicts with the current baseline (BL-001). The current wallet_setup output says "Deposit USDC to use signing operations" and "$0.001" per operation. The proposed free tier says "25 free operations. No deposit required."

These CANNOT coexist. Either:
- **Option A:** The free tier replaces the ClaraCredits messaging in wallet_setup entirely
- **Option B:** The free tier is shown alongside ClaraCredits

The test should explicitly state which option is implemented. My recommendation: **Option A** — replace the ClaraCredits onboarding copy with the free tier copy. Show ClaraCredits only in wallet_status for users who have deposited.

### TC-344 (x402 kicks in after free tier exhaustion) — Priority Amendment

This is listed as P0-critical, which is correct. However, the test should also verify:
- The TRANSITION from free to paid is seamless (no error, no extra prompt)
- The x402 fee line (`x402 fee: $0.01 | Today: $0.01/10.00`) appears for the FIRST TIME on this operation
- The "Free operations: 0 remaining" message from the PREVIOUS operation is not shown again

### TC-401 (existing user journey, no CLARA) — Amendment

This is THE critical regression test. Add explicit assertion:
- Count the number of unique tool response formats — they must match the pre-CLARA count
- No new sections, no new footer lines, no new action suggestions
- Performance must not degrade (no extra RPC calls to check CLARA balance when user has none)

---

## Summary of Additions

| Category | New Test Cases | Priority Breakdown |
|----------|---------------|-------------------|
| Regression baselines | TC-316 through TC-319 | 4x P0-critical |
| Free tier detail | TC-346 through TC-348 | 3x P1-high |
| CLARA feature gating | TC-334 through TC-336 | 1x P0-critical, 2x P1-high |
| Error state gaps | TC-350, TC-351 | 2x P1-high |
| **Total additions** | **11** | **5x P0, 7x P1** |

Combined with the existing 92 test cases, the total is now **103 test cases**.

### Critical Findings

1. **The free tier does not exist yet.** TC-340-345 are testing NEW behavior, not regression. The regression baseline (BL-001) shows ClaraCredits deposit model, not free operations.

2. **wallet_status should NOT change.** The UX design appendix hints at adding claimable rewards to wallet_status, but this is Phase 2. TC-301 must enforce the current BL-003 baseline strictly.

3. **ClaraCredits vs Free Tier conflict.** The current wallet_setup tells users to deposit to ClaraCredits ($0.001/op). The free tier proposal eliminates this. The implementation must cleanly replace one with the other, not show both.

4. **Performance gating.** When CLARA features are conditionally displayed (dashboard CLARA section, opportunities CLARA section), the check for "does user have CLARA" must NOT add latency for users who don't have CLARA. Consider caching the CLARA balance check result alongside the existing Herd token discovery call (which already returns all tokens).
