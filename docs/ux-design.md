# Clara + $CLARA Token: Onboarding UX Design

**Author:** UX Design Agent
**Date:** 2026-02-05
**Status:** Draft for Review

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [User Journey Map](#user-journey-map)
3. [First-Run Script](#first-run-script)
4. [Free Tier Design](#free-tier-design)
5. [Dashboard Mockup](#dashboard-mockup)
6. [Opportunities Mockup](#opportunities-mockup)
7. [Error States](#error-states)
8. [Airdrop Claim Flow](#airdrop-claim-flow)
9. [x402 Fee Communication](#x402-fee-communication)
10. [Things to Throw Out](#things-to-throw-out)
11. [Refined Plan](#refined-plan)

---

## Executive Summary

The goal is to take a user from "just installed Clara MCP" to "staked CLARA and claimed first USDC" in under 10 minutes. The current architecture creates a **three-swap cliff** before staking: get ETH, swap to USDC (for fees), swap to CLARA (for staking). This document proposes collapsing that cliff with a free tier, a funded airdrop, and progressive disclosure that hides staking until the user has organic reasons to discover it.

### Design Principles

1. **Zero-balance-zero-friction.** A new user with an empty wallet should be able to use Clara immediately without depositing anything.
2. **Progressive disclosure.** Staking and tokenomics appear only after a user has used Clara enough to understand why fees exist.
3. **The "aha moment" is earning, not spending.** The first USDC claim from staking should feel like found money, not a rebate.
4. **CLI-native.** Every interaction happens through tool calls in Claude Code. No external websites required for the core flow.

---

## User Journey Map

### Phase 1: Setup (0-2 minutes)

```
Step 1: Install Clara MCP
        ├─ User adds clara to their MCP config
        └─ Friction: NONE

Step 2: wallet_setup email="user@example.com"
        ├─ Wallet created instantly (Para SDK)
        ├─ Email = portable + recoverable
        └─ Friction: NONE (email optional but recommended)

Step 3: First tool call (e.g., wallet_dashboard)
        ├─ Shows empty wallet, but Clara works in read-only
        ├─ Read tools are FREE (dashboard, history, analyze, opportunities)
        └─ "You have 25 free transactions. Use wallet_send, wallet_swap, etc."
```

**Friction points:** None. Read-only tools require no balance.

### Phase 2: First Use (2-5 minutes)

```
Step 4: User tries a write operation (e.g., wallet_send)
        ├─ OPTION A (free tier active): Transaction succeeds, counter decrements
        │   └─ "Transaction sent! (24 free transactions remaining)"
        ├─ OPTION B (free tier exhausted): x402 payment required
        │   └─ "This operation costs $0.01. You need USDC on Base."
        └─ Friction: MODERATE (if no free tier) → LOW (with free tier)

Step 5: User discovers x402 costs (after free tier)
        ├─ wallet_status shows: "x402 fees: $0.01/operation"
        ├─ Clear instruction: "Deposit USDC on Base to continue"
        └─ Friction: MODERATE (requires bridging/buying USDC)
```

**Key design decision:** Free tier absorbs the "cold start" problem. Users experience the product before paying.

### Phase 3: Funding (5-8 minutes, only if needed)

```
Step 6: User funds wallet with USDC
        ├─ Send USDC from another wallet/exchange to their Clara address
        ├─ OR bridge from another chain
        └─ Friction: HIGH for new crypto users, LOW for experienced users

Step 7: Auto-pay kicks in
        ├─ x402 payments happen automatically within spending limits
        ├─ Small toast: "Paid $0.01 | Balance: $4.99"
        └─ Friction: NONE (invisible after setup)
```

### Phase 4: Discovery — the "Aha Moment" (8-10 minutes)

```
Step 8: wallet_opportunities detects CLARA staking
        ├─ Shows CLARA staking as an opportunity
        ├─ "Stake CLARA to earn a share of ALL x402 fees from Clara users"
        ├─ Shows current APY, total staked, fee pool
        └─ Friction: LOW (curiosity-driven)

Step 9: User acquires CLARA
        ├─ OPTION A: Claim airdrop (GitHub/X identity → free CLARA)
        ├─ OPTION B: Swap USDC → CLARA on Aerodrome
        └─ Friction: LOW (airdrop) → MODERATE (swap)

Step 10: User stakes CLARA
        ├─ wallet_call to ClaraStaking.stake()
        ├─ "Staked 1,000 CLARA! You're earning fees from every Clara user."
        └─ Friction: LOW (one transaction)

Step 11: First USDC claim
        ├─ wallet_dashboard shows "Claimable: $0.03 USDC"
        ├─ User claims → money appears in wallet
        ├─ THE AHA MOMENT: "I'm earning money by using a tool I already use"
        └─ Friction: NONE
```

### Journey Friction Summary

| Step | Description | Friction | With Free Tier | With Airdrop |
|------|-------------|----------|----------------|--------------|
| 1-3 | Setup + first read | NONE | NONE | NONE |
| 4 | First write op | MODERATE | **NONE** | NONE |
| 5 | Discover costs | MODERATE | **DEFERRED** | DEFERRED |
| 6 | Fund wallet | HIGH | **DEFERRED** | **DEFERRED** |
| 7 | Auto-pay | NONE | NONE | NONE |
| 8 | Discover CLARA | LOW | LOW | LOW |
| 9 | Acquire CLARA | MODERATE | MODERATE | **NONE** |
| 10 | Stake | LOW | LOW | LOW |
| 11 | First claim | NONE | NONE | NONE |

---

## First-Run Script

This is the exact sequence of tool calls for a new user's first session, written like a screenplay.

### Scene 1: Setup

```
USER: "Set up my wallet"

CLAUDE: [calls wallet_setup email="user@example.com"]

Clara MCP returns:
┌──────────────────────────────────────────────────────┐
│  Wallet Ready                                        │
│                                                      │
│  Address: 0xa1b2...c3d4                              │
│  Email: user@example.com                             │
│                                                      │
│  You have 25 free operations to get started.         │
│  No deposit required.                                │
│                                                      │
│  Try: wallet_dashboard, wallet_swap, wallet_send     │
└──────────────────────────────────────────────────────┘
```

### Scene 2: Explore (free, no balance needed)

```
USER: "Show me my wallet"

CLAUDE: [calls wallet_dashboard]

Clara MCP returns:
┌──────────────────────────────────────────────────────┐
│  Wallet Dashboard                                    │
│                                                      │
│  Address: 0xa1b2...c3d4                              │
│  Session: Active (2m ago)                            │
│                                                      │
│  Portfolio                                           │
│  ──────────                                          │
│  No tokens yet.                                      │
│                                                      │
│  Free Operations: 25 remaining                       │
│  Spending Limits: $1.00/tx, $10.00/day               │
│                                                      │
│  Quick Start                                         │
│  ───────────                                         │
│  Send USDC to 0xa1b2...c3d4 on Base to get started,  │
│  or use your 25 free operations now.                 │
│                                                      │
│  wallet_opportunities → Find yield for your assets   │
│  wallet_swap → Exchange tokens                       │
│  wallet_send → Transfer to another address           │
└──────────────────────────────────────────────────────┘
```

### Scene 3: First Write Operation (uses free tier)

```
USER: "Sign this message to verify my identity"

CLAUDE: [calls wallet_sign_message message="Sign in to app.example.com"]

Clara MCP returns:
┌──────────────────────────────────────────────────────┐
│  Message Signed                                      │
│                                                      │
│  Signer: 0xa1b2...c3d4                               │
│  Signature: 0x7f8e...                                │
│                                                      │
│  Free operations: 24 remaining                       │
└──────────────────────────────────────────────────────┘
```

### Scene 4: Running Low on Free Ops (nudge)

```
USER: [after 20 operations]

CLAUDE: [calls wallet_send ...]

Clara MCP returns:
┌──────────────────────────────────────────────────────┐
│  Transaction Sent!                                   │
│                                                      │
│  Amount: 0.5 USDC                                    │
│  To: 0xdead...beef                                   │
│  TX: 0x1234...                                       │
│                                                      │
│  Free operations: 5 remaining                        │
│                                                      │
│  Running low? Deposit USDC on Base to your address   │
│  to continue after free ops are used up.             │
│  Each operation costs ~$0.01 via x402.               │
└──────────────────────────────────────────────────────┘
```

### Scene 5: Discovery

```
USER: "What can I do with my USDC?"

CLAUDE: [calls wallet_opportunities asset="USDC" chain="base"]

Clara MCP returns:
(Standard lending yields table)

Plus a new section:
┌──────────────────────────────────────────────────────┐
│  CLARA Staking                                       │
│  ─────────────                                       │
│  Earn a share of ALL x402 fees from every Clara      │
│  user. The more you stake, the larger your share.    │
│                                                      │
│  Current Pool: $142.50/day in fees                   │
│  Total Staked: 2.4M CLARA                            │
│  Your Estimated APY: ~18.2%                          │
│                                                      │
│  How to start:                                       │
│  1. Get CLARA: wallet_swap from="USDC" to="CLARA"   │
│  2. Stake: wallet_call to stake your CLARA           │
│  3. Claim USDC rewards anytime                       │
│                                                      │
│  Or claim free CLARA from the developer airdrop:     │
│  wallet_claim_airdrop                                │
└──────────────────────────────────────────────────────┘
```

### Scene 6: The Payoff

```
USER: [After staking, checks dashboard next day]

CLAUDE: [calls wallet_dashboard]

Clara MCP returns:
(See Dashboard Mockup below — shows claimable USDC)

USER: "Claim my rewards"

CLAUDE: [calls wallet_call to ClaraStaking.claimRewards()]

Clara MCP returns:
┌──────────────────────────────────────────────────────┐
│  Rewards Claimed!                                    │
│                                                      │
│  Claimed: $0.47 USDC                                 │
│  Your USDC balance: $4.47                            │
│  Stake: 1,000 CLARA (still earning)                  │
│                                                      │
│  Next claim available anytime rewards accrue.        │
└──────────────────────────────────────────────────────┘
```

---

## Free Tier Design

### Recommendation: 25 Free Operations

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| **Count** | 25 free operations | Enough for 2-3 sessions of real use. Covers setup, exploration, and a few sends/swaps. |
| **Scope** | Write operations only | Read operations (dashboard, history, opportunities, analyze) are always free. No balance needed. |
| **Per-wallet** | Tied to wallet address | Prevents sybil via email-per-wallet binding. Rate-limited by Para SDK. |
| **Expiry** | None | Free ops don't expire. Reduces urgency anxiety. |
| **Refill** | Never | One-time gift. After exhaustion, x402 kicks in permanently. |

### How It's Communicated

**On wallet_setup:**
```
You have 25 free operations to get started. No deposit required.
```

**On every write operation (while free):**
```
Free operations: 24 remaining
```

**At 5 remaining:**
```
Running low on free operations (5 left).
Deposit USDC on Base to continue after they're used.
Each operation costs ~$0.01 via x402.
```

**At 0 remaining (first paid operation):**
```
Your free operations are used up.

To continue, deposit USDC to your wallet on Base:
  Address: 0xa1b2...c3d4

Operations cost ~$0.01 each via x402, paid automatically
from your USDC balance within your spending limits.

Tip: Stake CLARA tokens to earn back a share of all fees.
Run wallet_opportunities to learn more.
```

### Implementation Note

The free tier counter should live in the ClaraCredits contract (on-chain) or in the clara-proxy (server-side), NOT in local storage. Local storage can be reset. On-chain or server-side prevents sybil.

**Recommended approach:** Modify `ClaraCredits` contract to mint 25 free credits on first wallet creation. This keeps the same infrastructure path—when credits hit zero, x402 kicks in naturally.

---

## Dashboard Mockup

### New User (Empty Wallet)

```
# Wallet Dashboard

## Account
Address: 0xa1b2c3d4e5f6...1234
Email: user@example.com
Session: Active (5m)

## Portfolio
No tokens yet.

Send USDC to your address on Base to get started,
or use your 25 free operations.

## Status
Free Operations: 25 remaining
Spending Limits: $1.00/tx | $10.00/day
```

### Active User (With CLARA Staked)

```
# Wallet Dashboard

## Account
Address: 0x8744baf0...caffd
Email: bflynn4141@gmail.com
Session: Active (1h 23m)

## Portfolio
Total Value: $847.23

### Base
- ETH: 0.142000 (~$384.52)
- USDC: 127.450000 ($127.45)
- CLARA: 1,000.00 (staked)

### Ethereum
- ETH: 0.050000 (~$135.26)

## CLARA Staking
Staked: 1,000 CLARA
Share: 0.042% of total stake
Claimable: $2.18 USDC  ←  claim with wallet_call
Earned Total: $14.73 USDC

## Spending (Today)
3 operations | $0.03 spent | $9.97 remaining
Limits: $1.00/tx | $10.00/day

## Actions
- wallet_swap → Swap tokens
- wallet_opportunities → Find yield
- wallet_call → Claim staking rewards
```

### Key Design Decisions for Dashboard

1. **CLARA staking gets its own section** — it's not just another token balance. It shows staked amount, share percentage, claimable USDC, and lifetime earnings.
2. **"Claimable: $X.XX USDC"** with an inline action hint — this is the retention hook. Every time a user checks their dashboard, they see money waiting.
3. **Free operations counter** replaces credits section for new users — simpler mental model.
4. **Spending summary** is one line, not a table — daily total and remaining, that's it.

---

## Opportunities Mockup

### When User Searches for USDC Opportunities

```
## Opportunities: USDC on Base

### Lending
Found 5 yield opportunities (sorted by APY):

| # | Protocol   | Chain | APY   | Base APY | Reward APY | TVL    |
|---|-----------|-------|-------|----------|------------|--------|
| 1 | Aave V3   | base  | 4.82% | 4.82%    | 0.00%      | $2.1B  |
| 2 | Compound  | base  | 3.91% | 3.91%    | 0.00%      | $892M  |
| 3 | Morpho    | base  | 3.45% | 3.45%    | 0.00%      | $445M  |

### CLARA Staking (Earn from Clara Usage)

Stake CLARA tokens to earn a proportional share of x402 fees
from every Clara user worldwide.

How it works:
  1. All Clara write operations pay ~$0.01 USDC in x402 fees
  2. Fees flow to the FeeDistributor contract on Base
  3. CLARA stakers claim their share of accumulated fees

Current Stats:
  Fee Pool (unclaimed):  $342.18 USDC
  Daily Fee Volume:      ~$142/day
  Total CLARA Staked:    2,400,000 CLARA
  Estimated APY:         ~18.2%

If you staked 1,000 CLARA (~$50 at current price):
  Daily earnings:        ~$0.059 USDC
  Monthly earnings:      ~$1.78 USDC
  Annual earnings:       ~$21.30 USDC

Get Started:
  1. Get CLARA → wallet_swap fromToken="USDC" toToken="CLARA" amount="50" chain="base"
  2. Stake    → wallet_call (ClaraStaking.stake)
  3. Claim    → wallet_call (ClaraStaking.claimRewards)

Or claim free CLARA from the developer airdrop:
  wallet_claim_airdrop
```

### When User Searches for CLARA Directly

```
## Opportunities: CLARA on Base

### CLARA Token Info
Address: 0x...CLARA
Price: $0.05
Market Cap: $500K
Circulating: 10M / 100M total

### Staking (Primary Use Case)

Your x402 fees fund the staking pool. By staking CLARA,
you earn a share proportional to your stake.

Current Stats:
  Fee Pool (unclaimed):  $342.18 USDC
  Daily Fee Volume:      ~$142/day
  Total CLARA Staked:    2,400,000 CLARA (24% of supply)
  Estimated APY:         ~18.2%

### Protocol Actions (via Herd)
| # | Action         | Protocol  | Contract  | Supply Locked | Confidence |
|---|----------------|-----------|-----------|---------------|------------|
| 1 | Stake          | Clara     | 0x1a2b.. | 24.00%        | high       |
| 2 | LP (Aerodrome) | Aerodrome | 0x3c4d.. | 8.50%         | high       |

Tip: Staking earns USDC from fees. LP earns trading fees.
     Staking is simpler and lower-risk for most users.
```

---

## Error States

### E1: No USDC, Free Tier Exhausted

```
Your free operations are used up and you don't have
USDC on Base to pay x402 fees.

What to do:
  1. Deposit USDC to 0xa1b2...c3d4 on Base
  2. Or bridge from another chain: wallet_swap

Each operation costs ~$0.01 USDC.
A deposit of $1.00 covers ~100 operations.

Read operations (dashboard, history, analyze) remain free.
```

**Design note:** This is the most critical error. It must be helpful, not punishing. The user should know exactly how much to deposit and what they get for it.

### E2: USDC Balance Too Low for x402

```
Insufficient USDC for this operation.

Required: $0.01 USDC (x402 fee)
Balance:  $0.003 USDC on Base

Top up your balance to continue.
Tip: Even $0.50 covers 50 operations.
```

### E3: Spending Limit Exceeded

```
Blocked by spending limits.

This operation costs: $0.01
Today's spending: $10.00 / $10.00 (daily limit reached)

Options:
  - Wait until tomorrow (limits reset at midnight UTC)
  - Increase limits: wallet_spending_limits action="set" maxPerDay="20.00"
```

### E4: Expired Session

```
Your wallet session has expired.

Run wallet_setup to reconnect.
Your wallet and all funds are safe — sessions just need periodic refresh.
```

### E5: Transaction Failed

```
Transaction failed: insufficient gas.

Your Base ETH balance (0.00001 ETH) is too low for gas fees.

Fix: Send ~0.001 ETH ($0.27) to your address on Base.
Or swap USDC → ETH: wallet_swap fromToken="USDC" toToken="ETH" amount="1" chain="base"
```

### E6: Staking — Insufficient CLARA

```
You need CLARA tokens to stake.

Get CLARA:
  1. Swap: wallet_swap fromToken="USDC" toToken="CLARA" amount="50" chain="base"
  2. Airdrop: wallet_claim_airdrop (for eligible developers)

Current CLARA price: ~$0.05
Minimum stake: 100 CLARA (~$5.00)
```

### E7: Claim — No Rewards Accrued

```
No rewards to claim yet.

Your stake: 1,000 CLARA
Staking since: 2 hours ago
Estimated next reward: ~$0.005 USDC

Rewards accrue continuously based on x402 fee volume.
Check back later or run wallet_dashboard to see when
rewards are available.
```

### E8: Airdrop — Not Eligible

```
You're not eligible for the CLARA airdrop.

Eligibility requires:
  - GitHub account with 1+ public repos, OR
  - X account linked to a crypto builder community

You can still get CLARA by swapping:
  wallet_swap fromToken="USDC" toToken="CLARA" chain="base"
```

---

## Airdrop Claim Flow

### Design: CLI-Native with Web Fallback

The airdrop should be claimable entirely from the CLI. OAuth can be handled via a short-lived verification link.

### Flow

```
Step 1: User calls wallet_claim_airdrop

Clara MCP returns:
┌──────────────────────────────────────────────────────┐
│  CLARA Developer Airdrop                             │
│                                                      │
│  Verify your identity to claim free CLARA tokens.    │
│                                                      │
│  Choose verification method:                         │
│  1. GitHub — Link your GitHub account                │
│  2. X (Twitter) — Link your X account                │
│  3. Both — Claim from both (2x allocation)           │
└──────────────────────────────────────────────────────┘

Step 2: User selects GitHub

Clara MCP returns:
┌──────────────────────────────────────────────────────┐
│  GitHub Verification                                 │
│                                                      │
│  Open this link to connect your GitHub:              │
│  https://clara.dev/verify/gh?token=abc123&addr=0x... │
│                                                      │
│  The link is valid for 10 minutes.                   │
│  After verifying, run wallet_claim_airdrop again     │
│  to receive your CLARA.                              │
└──────────────────────────────────────────────────────┘

Step 3: User opens link, authorizes GitHub OAuth, page shows "Verified!"

Step 4: User calls wallet_claim_airdrop again

Clara MCP returns:
┌──────────────────────────────────────────────────────┐
│  Airdrop Claimed!                                    │
│                                                      │
│  GitHub: @username (verified)                        │
│  Allocation: 500 CLARA                               │
│                                                      │
│  Claimed: 500 CLARA → 0xa1b2...c3d4                  │
│  TX: 0xabcd...                                       │
│                                                      │
│  Want to start earning?                              │
│  Stake your CLARA: wallet_call (ClaraStaking.stake)  │
└──────────────────────────────────────────────────────┘
```

### Allocation Tiers

| Tier | Criteria | CLARA Amount |
|------|----------|-------------|
| GitHub Dev | 1+ public repos | 500 CLARA |
| Active Dev | 10+ repos or 100+ contributions | 1,000 CLARA |
| X Crypto Builder | Account with crypto/dev content | 250 CLARA |
| Both verified | GitHub + X linked | 1.5x combined |

### Key Design Decisions

1. **Web link for OAuth, not CLI OAuth.** CLI-based OAuth flows (device code, etc.) are confusing. A simple "click this link" is understood by everyone.
2. **Idempotent.** Calling `wallet_claim_airdrop` multiple times is safe. It shows status if already claimed.
3. **Immediate delivery.** CLARA is sent to the wallet in the same call, not "pending" or "will arrive later."
4. **Nudge to stake.** The claim confirmation immediately suggests staking — this is the funnel.

---

## x402 Fee Communication

### Philosophy: Transparent but Not Annoying

The x402 fee ($0.01/operation) should be visible but should not require confirmation for every transaction. Think of it like cell phone data charges — you know they exist, you can check your usage, but you don't approve each kilobyte.

### How Fees Appear

**During free tier (first 25 ops):**
Fees don't appear at all. The user sees "Free operations: N remaining" and nothing about x402.

**After free tier, on each write operation:**
```
Transaction sent!
Amount: 0.5 USDC to 0xdead...beef
TX: 0x1234...

x402 fee: $0.01 | Today: $0.05/10.00
```

A single line appended to every write operation result. Shows fee amount and daily running total vs daily limit. That's it.

**On wallet_dashboard:**
```
## Spending (Today)
3 operations | $0.03 spent | $9.97 remaining
```

**On wallet_status:**
```
x402 Fees: $0.01/operation (USDC on Base)
Today: 5 ops | $0.05 spent
Limits: $1.00/tx | $10.00/day
```

### Dynamic Pricing

If fees become dynamic (different operations cost different amounts):

```
x402 fee: $0.01 (send) | Today: $0.08/10.00
```

```
x402 fee: $0.05 (contract call) | Today: $0.13/10.00
```

The operation type in parentheses explains why the cost varies. This maintains trust without overwhelming.

### Approval Flow for Large Fees

For fees over $0.50 (configurable via `wallet_spending_limits`):

```
This operation requires a $0.75 x402 payment.

URL: https://api.premium-data.com/analysis
Amount: $0.75 USDC
Your daily spending: $3.25 / $10.00

Approve? (Re-run with skipApprovalCheck: true to proceed)
```

This already exists in the codebase (`x402-handler.ts:124`) and works well.

---

## Things to Throw Out

### 1. ClaraCredits Contract (Rethink)

The current `ClaraCredits` contract at `0x423F...` uses a deposit-then-deduct model ($0.001/operation). This is **redundant** with x402 payments ($0.01/operation). The user shouldn't need to understand two different payment mechanisms.

**Recommendation:** Merge credits into the free tier system. Use the ClaraCredits contract ONLY for the free tier counter (25 operations on-chain), then transition entirely to x402 for paid operations. Remove the "deposit USDC to ClaraCredits" flow — it's confusing to have deposits go to two different places (wallet for x402 AND credits contract).

### 2. `wallet_briefing` as First Recommended Action

The current `wallet_setup` suggests `wallet_briefing` as the first next step. For a new user with an empty wallet, a "briefing" returns nothing useful.

**Recommendation:** Change the post-setup suggestion to `wallet_dashboard` (shows portfolio + free tier status). Suggest `wallet_briefing` only after the user has tokens.

### 3. Machine-Specific Wallets

`wallet_setup` without email creates a machine-local wallet. This creates a terrible experience when users switch machines or reinstall Claude Code. It should still exist but should be more clearly positioned as a temporary/testing option, not the default path.

**Recommendation:** Make email the default prompt. If no email provided, still create the wallet but add a stronger nudge:
```
Machine-only wallet created. This wallet is NOT recoverable.
Add an email with wallet_setup email="you@example.com" to make
it portable and recoverable.
```

### 4. Multiple Approval Thresholds

The current system has three overlapping concepts: spending limits, approval thresholds, and credits. This is over-engineered for the current user base.

**Recommendation:** Simplify to two concepts:
- **Daily limit** ($10/day default) — hard cap, no overrides without changing settings
- **Per-tx limit** ($1/tx default) — silent approval for small amounts, prompt for large

Remove the separate `requireApprovalAbove` threshold. If it's under the per-tx limit, it's approved. If it's over, it's blocked.

### 5. Chain-by-Chain Balance Display for New Users

The current dashboard iterates through 5 chains (base, ethereum, arbitrum, optimism, polygon). For a new user, most will be empty. Showing "No balances found on any chain" is unhelpful.

**Recommendation:** For new users (total value < $1), show a simplified view:
```
Portfolio: Empty

Get started: Send tokens to 0xa1b2...c3d4 on Base.
Base is Clara's home chain. Most operations happen here.
```

Only expand to multi-chain view when the user actually has tokens on multiple chains.

---

## Refined Plan

### Architecture Changes for Better UX

#### 1. Unified Fee Path (Critical)

Remove the ClaraCredits deposit model. Users should only need USDC in their wallet:

```
Current (confusing):
  wallet → deposit to ClaraCredits → operations deduct from credits
  wallet → x402 fees paid from USDC balance

Proposed (simple):
  wallet → free tier (25 ops, on-chain counter) → x402 fees from USDC balance
```

One path. One balance to manage. The free tier counter lives in a lightweight contract or the clara-proxy backend.

#### 2. Auto-Detection of CLARA in wallet_opportunities

When `wallet_opportunities` is called for any asset on Base, append a CLARA staking section if:
- The user has CLARA in their wallet (staked or unstaked), OR
- The user has used 10+ paid operations (they're generating fees, they should know about staking)

This makes staking discovery organic rather than forced.

#### 3. Claimable USDC on Dashboard (Critical)

Add a "CLARA Staking" section to `wallet_dashboard` that queries the FeeDistributor contract for claimable rewards. This section only appears when the user has staked CLARA.

```typescript
// Pseudocode for dashboard enhancement
if (userHasCLARAStaked) {
  const claimable = await feeDistributor.claimableRewards(address);
  dashboard.addSection('CLARA Staking', {
    staked: userStakedAmount,
    share: userStakedAmount / totalStaked,
    claimable: claimable,
    earnedTotal: lifetimeEarnings,
  });
}
```

#### 4. wallet_claim_airdrop Tool (New)

Add a new MCP tool specifically for the airdrop flow. It handles:
- Generating a verification link
- Checking verification status
- Executing the claim transaction

This keeps the flow inside Clara MCP rather than requiring the user to visit an external dApp.

#### 5. Progressive x402 Fee Display

Modify the tool response formatting to append fee information only after the free tier is exhausted:

```typescript
// In middleware.ts, after any write operation
if (freeOpsRemaining > 0) {
  result.text += `\n\nFree operations: ${freeOpsRemaining} remaining`;
} else {
  result.text += `\n\nx402 fee: $${fee} | Today: $${todayTotal}/${dailyLimit}`;
}
```

#### 6. Collapse the Three-Swap Cliff

The current path to staking requires three swaps (ETH → USDC, USDC → CLARA, CLARA → stake). Propose:

1. **Airdrop eliminates the CLARA acquisition step entirely** for eligible users
2. **wallet_swap supports USDC → CLARA directly** (already works via Li.Fi/Aerodrome)
3. **Consider a "stake" action in wallet_opportunities** that bundles swap + stake into a single user intent, where Clara handles the multi-step execution automatically

#### 7. Stake-from-Dashboard Shortcut

When `wallet_dashboard` shows unstaked CLARA in the portfolio:

```
Base:
  - CLARA: 500.00 (unstaked)
    → Stake to earn fees: wallet_call target=ClaraStaking action=stake
```

Inline action hints reduce the number of tool calls the user needs to discover.

### Revised Architecture Summary

```
BEFORE (3 payment systems):
  ClaraCredits (deposit → deduct) + x402 (auto-pay) + free???

AFTER (1 payment system + free tier):
  Free tier (25 ops) → x402 (auto-pay from USDC balance)

BEFORE (staking discovery):
  User must know to search for CLARA in wallet_opportunities

AFTER (organic discovery):
  wallet_dashboard shows claimable USDC
  wallet_opportunities auto-appends CLARA staking
  wallet_setup mentions airdrop for eligible devs

BEFORE (airdrop):
  External website with wallet connect

AFTER (airdrop):
  wallet_claim_airdrop → verify link → claim in CLI
```

---

## Appendix: The "Aha Moment" Analysis

### What is it?

The moment the user realizes Clara isn't just a tool that costs money — it's a tool that **makes** money.

### When does it happen?

When `wallet_dashboard` shows:
```
Claimable: $2.18 USDC
```

And the user claims it, and real USDC appears in their wallet.

### Why this moment matters

1. **Reframes the relationship.** x402 fees go from "cost of using Clara" to "fees I contribute to a pool I benefit from."
2. **Creates a flywheel.** More usage → more fees → more staking rewards → more users motivated to stake → more demand for CLARA → higher CLARA price → more attractive APY → more staking.
3. **It's real money.** Not points, not rewards tokens, not gamified XP. Actual USDC that can be spent or withdrawn.

### How to maximize the moment

1. **Make dashboard the default landing.** When users ask "check my wallet" or "what do I have," the dashboard should be the first thing they see — and it should show claimable USDC prominently.
2. **Push notification equivalent.** When claimable rewards exceed $1.00, `wallet_status` should mention it:
   ```
   You have $1.23 USDC in staking rewards ready to claim.
   ```
3. **Compare to fees paid.** Show the user that staking rewards offset their costs:
   ```
   This month: $3.20 in x402 fees paid | $4.50 in staking rewards earned
   Net: +$1.30 (you're earning more than you spend)
   ```

---

## Appendix: Answers to the 10 Specific Questions

### Q1: First-run experience
A new user with no USDC and no CLARA gets 25 free write operations. Read operations are always free. They can explore the full product before spending anything.

### Q2: Free tier design
25 free operations, write-only, per-wallet, no expiry, one-time gift. Communicated as a counter on every write op. Nudge at 5 remaining.

### Q3: The swap friction
Collapsed via (a) airdrop for CLARA acquisition, (b) USDC → CLARA direct swap, and (c) potential bundle action. The three-swap cliff becomes one swap or zero swaps.

### Q4: x402 auto-pay UX
Invisible during free tier. After that, one-line footer on every write operation: `x402 fee: $0.01 | Today: $0.05/10.00`. No confirmation for small amounts.

### Q5: Staking discovery
`wallet_opportunities` auto-appends CLARA staking section. `wallet_dashboard` shows claimable USDC for stakers. Both paths make staking discoverable organically.

### Q6: Claim UX
Dashboard shows "Claimable: $X.XX USDC" with inline action hint. No nudge frequency — users claim whenever they want. Rewards accrue continuously.

### Q7: Running out of USDC
Clear error message with exact deposit amount needed. Read operations remain free. No punitive messaging. Suggest minimum deposit ($1 = ~100 operations).

### Q8: Airdrop claim flow
CLI-native: `wallet_claim_airdrop` → web link for OAuth → return to CLI to claim. 3 steps, under 2 minutes. Immediate delivery of CLARA.

### Q9: Pricing transparency
"$0.01 per operation" is the simple answer. Dynamic fees show operation type in parentheses: `$0.01 (send)`, `$0.05 (contract call)`. Daily totals on dashboard.

### Q10: The "aha moment"
Seeing "Claimable: $2.18 USDC" on the dashboard and claiming it. Real money, earned by using a tool they already use. The reframe from "costs money" to "makes money."
