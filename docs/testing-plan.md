# CLARA Token System: Comprehensive Testing Plan

> **Author:** QA Engineer
> **Date:** 2026-02-05
> **Status:** Draft (pending specialist review)
> **Scope:** Pre-mainnet testing for ClaraToken, ClaraStaking, MerkleDrop, and Clara MCP integration

---

## Table of Contents

1. [Overview](#overview)
2. [Test Categories & Priorities](#test-categories--priorities)
3. [Smart Contract Unit Tests (Foundry)](#1-smart-contract-unit-tests-foundry)
4. [Smart Contract Integration Tests (Foundry)](#2-smart-contract-integration-tests-foundry)
5. [Smart Contract Security Tests (Foundry)](#3-smart-contract-security-tests-foundry)
6. [Clara MCP Integration Tests](#4-clara-mcp-integration-tests)
7. [End-to-End Scenario Tests](#5-end-to-end-scenario-tests)
8. [x402 Fee Flow Tests](#6-x402-fee-flow-tests)
9. [Areas Needing Specialist Input](#areas-needing-specialist-input)

---

## Overview

This testing plan covers the full $CLARA token system before mainnet deployment. The system consists of:

- **ClaraToken**: Fixed-supply ERC-20 with ERC-2612 permit (immutable, no proxy per solidity-architecture.md refined plan)
- **ClaraStaking**: Stake CLARA, earn proportional USDC from x402 fees (UUPS + 7-day timelock)
- **MerkleDrop**: Merkle distributor for developer airdrop (immutable)
- **Clara MCP**: The existing MCP server with modified/new tools for CLARA integration

### Critical Constraint: Regression Safety

**The existing Clara MCP user experience MUST NOT change.** All existing tools (`wallet_setup`, `wallet_dashboard`, `wallet_send`, `wallet_swap`, `wallet_call`, `wallet_executePrepared`, `wallet_sign_message`, `wallet_sign_typed_data`, `wallet_approvals`, `wallet_history`, `wallet_pay_x402`, `wallet_spending_limits`, `wallet_logout`, `wallet_opportunities`, `wallet_analyze_contract`, `wallet_status`) must work identically for users who do not have CLARA tokens. New features are additions, not replacements.

### Architecture References

| Document | Path |
|----------|------|
| Consolidated plan | `docs/CLARA-TOKEN-PLAN.md` |
| Security review | `docs/security-review.md` |
| Solidity architecture | `docs/solidity-architecture.md` |
| UX design | `docs/ux-design.md` |

### Existing Test Infrastructure

The Clara MCP codebase uses **Vitest** for TypeScript tests. Existing tests:

| Test File | Coverage |
|-----------|----------|
| `src/__tests__/regression-bugbash.test.ts` | Gas estimation buffer, MCP config precedence, Herd field names |
| `src/__tests__/mcp-stdio.test.ts` | MCP protocol purity (no stdout pollution), handshake, tools/list |
| `src/__tests__/gas.test.ts` | Gas estimation logic |
| `src/__tests__/tools/history.test.ts` | History tool |
| `src/__tests__/tools/approvals.test.ts` | Approvals tool |
| `src/__tests__/tools/swap.test.ts` | Swap tool |
| `src/__tests__/tools/wallet.test.ts` | Wallet setup/status/logout |
| `src/__tests__/tools/send.test.ts` | Send tool |
| `src/__tests__/x402-v2.test.ts` | x402 payment handler |

Smart contract tests will use **Foundry** (forge test) with Solidity test files.

---

## Test Categories & Priorities

| Priority | Meaning | Count |
|----------|---------|-------|
| P0-critical | Must pass before any mainnet deploy. Blocking. | 28 |
| P1-high | Must pass before public launch. Can deploy to testnet without. | 31 |
| P2-medium | Should pass before public launch. Non-blocking for testnet. | 22 |
| P3-low | Nice to have. Can ship without. | 10 |
| **Total** | | **91** |

---

## 1. Smart Contract Unit Tests (Foundry)

### 1.1 ClaraToken

```
TC-001: ClaraToken deploys with correct name and symbol
Category: unit
Priority: P0-critical
Preconditions: Foundry environment configured, OZ contracts available
Steps:
  1. Deploy ClaraToken
  2. Call name()
  3. Call symbol()
Expected: name() returns "Clara", symbol() returns "CLARA"
Notes: Verifies ERC20Upgradeable init params from solidity-architecture.md Section 2
```

```
TC-002: ClaraToken mints exactly 100M to treasury at initialization
Category: unit
Priority: P0-critical
Preconditions: ClaraToken deployed
Steps:
  1. Deploy ClaraToken with initialize(treasury)
  2. Call totalSupply()
  3. Call balanceOf(treasury)
Expected: totalSupply() == 100_000_000e18, balanceOf(treasury) == 100_000_000e18
Notes: MAX_SUPPLY constant is 100_000_000e18
```

```
TC-003: ClaraToken has no mint function
Category: unit
Priority: P0-critical
Preconditions: ClaraToken deployed
Steps:
  1. Attempt to call any function that could mint tokens (e.g., mint, _mint via external call)
  2. Verify no public/external mint function exists via interface inspection
Expected: No public mint function exists. Total supply is immutable after initialization.
Notes: Security-critical — fixed supply is core property (security-review.md C1 mitigation)
```

```
TC-004: ClaraToken standard ERC-20 transfer works
Category: unit
Priority: P0-critical
Preconditions: ClaraToken deployed, treasury has 100M CLARA
Steps:
  1. Treasury approves spender for 1000e18
  2. Spender calls transferFrom(treasury, recipient, 1000e18)
  3. Check balanceOf(recipient) == 1000e18
  4. Check balanceOf(treasury) == 100M - 1000e18
Expected: Transfer succeeds, balances update correctly
Notes: Standard ERC-20 behavior
```

```
TC-005: ClaraToken ERC-2612 permit works
Category: unit
Priority: P1-high
Preconditions: ClaraToken deployed, user has CLARA
Steps:
  1. Generate permit signature for (owner, spender, value, deadline, nonce)
  2. Call permit(owner, spender, value, deadline, v, r, s)
  3. Check allowance(owner, spender) == value
Expected: Allowance set without on-chain approve transaction
Notes: Enables gasless staking flow via stakeWithPermit() (solidity-architecture.md Section 8)
```

```
TC-006: ClaraToken permit rejects expired deadline
Category: unit
Priority: P1-high
Preconditions: ClaraToken deployed
Steps:
  1. Generate permit with deadline in the past
  2. Call permit()
Expected: Reverts with "ERC2612ExpiredSignature" or equivalent
Notes: Standard ERC-2612 deadline enforcement
```

```
TC-007: ClaraToken permit rejects invalid signature
Category: unit
Priority: P1-high
Preconditions: ClaraToken deployed
Steps:
  1. Generate permit signature from wrong signer
  2. Call permit()
Expected: Reverts with "ERC2612InvalidSigner" or equivalent
Notes: Standard ERC-2612 signature verification
```

```
TC-008: ClaraToken has 18 decimals
Category: unit
Priority: P1-high
Preconditions: ClaraToken deployed
Steps:
  1. Call decimals()
Expected: Returns 18
Notes: Critical for reward math — CLARA(18) vs USDC(6) precision (solidity-architecture.md Section 5)
```

### 1.2 ClaraStaking

```
TC-010: ClaraStaking initializes with correct parameters
Category: unit
Priority: P0-critical
Preconditions: ClaraToken and USDC deployed
Steps:
  1. Deploy ClaraStaking proxy with initialize(claraToken, usdc, feeSource)
  2. Read claraToken(), usdc(), feeSource()
Expected: All three addresses match constructor args
Notes: None
```

```
TC-011: ClaraStaking stake() works with approved CLARA
Category: unit
Priority: P0-critical
Preconditions: ClaraStaking deployed, user has 1000 CLARA and approved staking contract
Steps:
  1. User calls stake(1000e18)
  2. Check stakedBalance(user) == 1000e18
  3. Check totalStaked == 1000e18
  4. Check CLARA balance of ClaraStaking contract == 1000e18
Expected: Stake succeeds, all balances correct, Staked event emitted
Notes: Core staking operation
```

```
TC-012: ClaraStaking stake() reverts on zero amount
Category: unit
Priority: P1-high
Preconditions: ClaraStaking deployed
Steps:
  1. User calls stake(0)
Expected: Reverts with "Cannot stake 0"
Notes: Input validation
```

```
TC-013: ClaraStaking stake() reverts without approval
Category: unit
Priority: P1-high
Preconditions: ClaraStaking deployed, user has CLARA but no approval
Steps:
  1. User calls stake(1000e18) without prior approve()
Expected: Reverts (SafeERC20 transferFrom failure)
Notes: Standard ERC-20 approval requirement
```

```
TC-014: ClaraStaking unstake() returns CLARA to user
Category: unit
Priority: P0-critical
Preconditions: User has staked 1000 CLARA
Steps:
  1. User calls unstake(500e18)
  2. Check stakedBalance(user) == 500e18
  3. Check totalStaked decreased by 500e18
  4. Check user CLARA balance increased by 500e18
Expected: Unstake succeeds, all balances correct, Unstaked event emitted
Notes: None
```

```
TC-015: ClaraStaking unstake() reverts on insufficient staked balance
Category: unit
Priority: P1-high
Preconditions: User has staked 1000 CLARA
Steps:
  1. User calls unstake(2000e18)
Expected: Reverts with "Insufficient staked balance"
Notes: None
```

```
TC-016: ClaraStaking unstake() reverts on zero amount
Category: unit
Priority: P1-high
Preconditions: ClaraStaking deployed
Steps:
  1. User calls unstake(0)
Expected: Reverts with "Cannot unstake 0"
Notes: Input validation
```

```
TC-017: ClaraStaking claim() sends USDC to staker
Category: unit
Priority: P0-critical
Preconditions: User has staked CLARA, feeSource has deposited USDC
Steps:
  1. FeeSource calls deposit(100e6) (100 USDC)
  2. User calls claim()
  3. Check user USDC balance increased
  4. Check rewards(user) == 0
Expected: USDC transferred to user, RewardsClaimed event emitted
Notes: Core reward distribution — the "aha moment" depends on this
```

```
TC-018: ClaraStaking claim() with no rewards does nothing
Category: unit
Priority: P2-medium
Preconditions: User has staked but no deposits have occurred
Steps:
  1. User calls claim()
Expected: No USDC transferred, no event emitted (or event with 0 amount)
Notes: Graceful no-op, not a revert
```

```
TC-019: ClaraStaking exit() unstakes all and claims all
Category: unit
Priority: P0-critical
Preconditions: User has 1000 CLARA staked and 10 USDC claimable
Steps:
  1. User calls exit()
  2. Check stakedBalance(user) == 0
  3. Check totalStaked decreased by 1000e18
  4. Check user received 1000 CLARA back
  5. Check user received 10 USDC
Expected: Both unstake and claim succeed in single tx
Notes: Convenience function for full withdrawal
```

```
TC-020: ClaraStaking deposit() updates rewardPerTokenStored correctly
Category: unit
Priority: P0-critical
Preconditions: 1000 CLARA total staked
Steps:
  1. FeeSource calls deposit(100e6) (100 USDC)
  2. Check rewardPerTokenStored == (100e6 * 1e18) / 1000e18 == 100e6
  3. FeeSource calls deposit(200e6)
  4. Check rewardPerTokenStored == 100e6 + (200e6 * 1e18) / 1000e18 == 300e6
Expected: rewardPerTokenStored increases monotonically with correct math
Notes: Core of Synthetix pattern (solidity-architecture.md Section 5)
```

```
TC-021: ClaraStaking deposit() restricted to feeSource only
Category: unit
Priority: P0-critical
Preconditions: ClaraStaking deployed
Steps:
  1. Non-feeSource address calls deposit(100e6)
Expected: Reverts with "Only fee source"
Notes: Security-critical — prevents unauthorized reward injection
```

```
TC-022: ClaraStaking deposit() reverts on zero amount
Category: unit
Priority: P2-medium
Preconditions: ClaraStaking deployed
Steps:
  1. FeeSource calls deposit(0)
Expected: Reverts with "Cannot deposit 0"
Notes: Input validation
```

```
TC-023: ClaraStaking earned() returns correct reward amount
Category: unit
Priority: P0-critical
Preconditions: User staked 500e18 CLARA out of 1000e18 total, 100 USDC deposited
Steps:
  1. Check earned(user) == 50e6 (50% of 100 USDC)
Expected: Returns proportional share of deposited rewards
Notes: View function — no gas cost. Used by dashboard to show "Claimable: $X.XX"
```

```
TC-024: ClaraStaking getClaimable() aliases earned()
Category: unit
Priority: P2-medium
Preconditions: Same as TC-023
Steps:
  1. Check getClaimable(user) == earned(user)
Expected: Both return identical values
Notes: Herd-legible alias (solidity-architecture.md Section 13)
```

```
TC-025: ClaraStaking stakeWithPermit() combines approve and stake
Category: unit
Priority: P1-high
Preconditions: ClaraToken has permit, user has 1000 CLARA
Steps:
  1. User signs ERC-2612 permit for ClaraStaking contract
  2. User calls stakeWithPermit(amount, deadline, v, r, s)
  3. Check stakedBalance(user) == amount
  4. Check CLARA transferred to staking contract
Expected: Stake succeeds without separate approve() transaction
Notes: One-tx staking flow (solidity-architecture.md Section 15, point 3)
```

```
TC-026: ClaraStaking setFeeSource() updates authorized depositor
Category: unit
Priority: P1-high
Preconditions: ClaraStaking deployed, caller is owner
Steps:
  1. Owner calls setFeeSource(newAddress)
  2. Check feeSource() == newAddress
  3. Old feeSource calls deposit() — reverts
  4. New feeSource calls deposit() — succeeds
Expected: FeeSource updated, event emitted
Notes: Admin function — owner should be timelock
```

```
TC-027: ClaraStaking setFeeSource() rejected from non-owner
Category: unit
Priority: P1-high
Preconditions: ClaraStaking deployed
Steps:
  1. Non-owner calls setFeeSource(newAddress)
Expected: Reverts with OwnableUnauthorizedAccount
Notes: Access control
```

```
TC-028: ClaraStaking recoverERC20() recovers accidental tokens
Category: unit
Priority: P2-medium
Preconditions: Random ERC-20 accidentally sent to ClaraStaking
Steps:
  1. Send 100 DAI to ClaraStaking address
  2. Owner calls recoverERC20(DAI_ADDRESS, 100e18)
  3. Check owner received 100 DAI
Expected: Recovery succeeds
Notes: Emergency function for misrouted tokens
```

```
TC-029: ClaraStaking recoverERC20() cannot recover staked CLARA
Category: unit
Priority: P0-critical
Preconditions: Users have staked CLARA
Steps:
  1. Owner calls recoverERC20(CLARA_TOKEN_ADDRESS, 100e18)
Expected: Reverts with "Cannot recover staked token"
Notes: Protects user deposits from admin drain (CLARA-TOKEN-PLAN.md security checklist)
```

```
TC-030: ClaraStaking events emitted correctly
Category: unit
Priority: P2-medium
Preconditions: ClaraStaking deployed
Steps:
  1. Perform stake() — verify Staked event
  2. Perform unstake() — verify Unstaked event
  3. Perform claim() — verify RewardsClaimed event
  4. Perform deposit() — verify FeesDeposited event
  5. Perform setFeeSource() — verify FeeSourceUpdated event
Expected: All events emitted with correct parameters
Notes: Required for Herd classification and monitoring (solidity-architecture.md Section 13)
```

### 1.3 MerkleDrop

```
TC-040: MerkleDrop deploys with correct root and deadline
Category: unit
Priority: P0-critical
Preconditions: Merkle tree computed, root hash available
Steps:
  1. Deploy MerkleDrop(root, deadline, claraToken)
  2. Read root(), deadline(), token()
Expected: All values match constructor args
Notes: Root is immutable — set once in constructor (security-review.md L4)
```

```
TC-041: MerkleDrop claim succeeds with valid proof
Category: unit
Priority: P0-critical
Preconditions: MerkleDrop deployed and funded, user in Merkle tree
Steps:
  1. Generate Merkle proof for user's (index, address, amount) leaf
  2. User calls claim(index, address, amount, proof)
  3. Check user received CLARA
Expected: Claim succeeds, tokens transferred
Notes: Core airdrop functionality
```

```
TC-042: MerkleDrop prevents double-claim
Category: unit
Priority: P0-critical
Preconditions: User has already claimed
Steps:
  1. User claims successfully (first time)
  2. User calls claim() again with same params
Expected: Second call reverts (e.g., "Already claimed")
Notes: Bitmap-based tracking (security-review.md Section 3, Airdrop requirements)
```

```
TC-043: MerkleDrop rejects invalid proof
Category: unit
Priority: P0-critical
Preconditions: MerkleDrop deployed
Steps:
  1. Generate proof for user A
  2. User B calls claim() with user A's proof but user B's address
Expected: Reverts (proof verification fails)
Notes: Merkle proof integrity
```

```
TC-044: MerkleDrop rejects claim after deadline
Category: unit
Priority: P1-high
Preconditions: MerkleDrop deployed with deadline in the past (or warp time past deadline)
Steps:
  1. Warp block.timestamp past deadline
  2. Eligible user calls claim()
Expected: Reverts (e.g., "Claim deadline passed")
Notes: 6-month claim window (CLARA-TOKEN-PLAN.md)
```

```
TC-045: MerkleDrop claim works just before deadline
Category: unit
Priority: P2-medium
Preconditions: MerkleDrop deployed
Steps:
  1. Warp block.timestamp to deadline - 1 second
  2. Eligible user calls claim()
Expected: Claim succeeds
Notes: Boundary condition
```

```
TC-046: MerkleDrop rejects claim with wrong amount
Category: unit
Priority: P1-high
Preconditions: MerkleDrop deployed, user eligible for 500 CLARA
Steps:
  1. User calls claim() with amount=1000 CLARA (double actual allocation)
Expected: Reverts (proof mismatch)
Notes: Amount is part of the Merkle leaf
```

---

## 2. Smart Contract Integration Tests (Foundry)

### 2.1 Full Lifecycle

```
TC-100: Full lifecycle — deploy, stake, deposit, claim, unstake
Category: integration
Priority: P0-critical
Preconditions: All contracts deployed
Steps:
  1. Deploy ClaraToken, mint 100M to treasury
  2. Deploy ClaraStaking, initialize with (token, USDC, feeSource)
  3. Treasury transfers 10_000 CLARA to userA
  4. UserA approves ClaraStaking for 10_000e18
  5. UserA calls stake(10_000e18)
  6. FeeSource approves ClaraStaking for 100 USDC
  7. FeeSource calls deposit(100e6)
  8. Check userA earned(userA) == 100e6
  9. UserA calls claim() — receives 100 USDC
  10. UserA calls unstake(10_000e18) — receives CLARA back
  11. Verify all balances correct
Expected: Complete lifecycle works end-to-end
Notes: The most important integration test. Maps to deployment plan Phase 1-2.
```

```
TC-101: Multiple deposits accumulate correctly
Category: integration
Priority: P0-critical
Preconditions: One user staked
Steps:
  1. UserA stakes 1000 CLARA
  2. FeeSource deposits 10 USDC
  3. FeeSource deposits 20 USDC
  4. FeeSource deposits 30 USDC
  5. Check earned(userA) == 60 USDC total
Expected: Multiple deposits accumulate without loss
Notes: Simulates daily settlement batches
```

```
TC-102: Multi-user proportional distribution (3 stakers)
Category: integration
Priority: P0-critical
Preconditions: ClaraStaking deployed
Steps:
  1. UserA stakes 500 CLARA (50%)
  2. UserB stakes 300 CLARA (30%)
  3. UserC stakes 200 CLARA (20%)
  4. FeeSource deposits 100 USDC
  5. Check earned(userA) == 50 USDC
  6. Check earned(userB) == 30 USDC
  7. Check earned(userC) == 20 USDC
Expected: Rewards split proportionally to stake
Notes: Validates core Synthetix math with >2 participants
```

```
TC-103: Staker joins after deposit — receives no prior rewards
Category: integration
Priority: P1-high
Preconditions: ClaraStaking deployed
Steps:
  1. UserA stakes 1000 CLARA
  2. FeeSource deposits 100 USDC
  3. UserB stakes 1000 CLARA (50/50 split now)
  4. FeeSource deposits 100 USDC
  5. Check earned(userA) == 100 + 50 = 150 USDC
  6. Check earned(userB) == 50 USDC (only from second deposit)
Expected: UserB earns nothing from deposits before joining
Notes: Critical for fairness — validates updateReward modifier timing
```

```
TC-104: Staker exits mid-stream — claimable frozen correctly
Category: integration
Priority: P1-high
Preconditions: ClaraStaking deployed
Steps:
  1. UserA and UserB each stake 500 CLARA
  2. FeeSource deposits 100 USDC (each earned 50)
  3. UserA unstakes all 500 CLARA
  4. FeeSource deposits 100 USDC
  5. Check earned(UserA) == 50 USDC (frozen at unstake)
  6. Check earned(UserB) == 50 + 100 = 150 USDC (gets all of second deposit)
Expected: Exited staker's rewards freeze, remaining stakers get full share
Notes: None
```

```
TC-105: Partial unstake preserves proportional rewards
Category: integration
Priority: P1-high
Preconditions: ClaraStaking deployed
Steps:
  1. UserA stakes 1000 CLARA (sole staker)
  2. FeeSource deposits 50 USDC
  3. UserA unstakes 500 CLARA (now has 500 staked)
  4. UserB stakes 500 CLARA (now 50/50)
  5. FeeSource deposits 100 USDC
  6. Check earned(UserA) == 50 + 50 = 100 USDC
  7. Check earned(UserB) == 50 USDC
Expected: Partial unstake adjusts share correctly
Notes: None
```

```
TC-106: Claim does not affect staked balance
Category: integration
Priority: P1-high
Preconditions: User has staked and earned rewards
Steps:
  1. UserA stakes 1000 CLARA
  2. FeeSource deposits 100 USDC
  3. UserA calls claim()
  4. Check stakedBalance(UserA) == 1000e18 (unchanged)
  5. FeeSource deposits 100 USDC
  6. Check earned(UserA) == 100 USDC (earns from new deposit)
Expected: Claiming rewards does not unstake — user continues earning
Notes: Important UX property — claim is non-destructive
```

### 2.2 Aerodrome LP Integration

```
TC-110: Create CLARA/USDC volatile pool on Aerodrome
Category: integration
Priority: P1-high
Preconditions: ClaraToken deployed, USDC available, Aerodrome Router accessible (fork test)
Steps:
  1. Approve CLARA and USDC on Aerodrome Router
  2. Call Router.createPool(CLARA, USDC, false) — volatile pool
  3. Verify pool address returned
Expected: Pool created successfully
Notes: Use Base mainnet fork for integration. Aerodrome Router: 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
```

```
TC-111: Add initial liquidity to Aerodrome pool
Category: integration
Priority: P1-high
Preconditions: Pool created (TC-110)
Steps:
  1. Approve 10M CLARA + 100K USDC on Router
  2. Call Router.addLiquidity(CLARA, USDC, false, 10M, 100K, ...)
  3. Check LP tokens received by treasury
  4. Check pool reserves match deposit
Expected: Liquidity added, LP tokens minted, price = $0.01/CLARA
Notes: Sets FDV at $1M (CLARA-TOKEN-PLAN.md deployment plan Phase 2)
```

```
TC-112: Swap USDC to CLARA via Aerodrome
Category: integration
Priority: P1-high
Preconditions: Pool has liquidity (TC-111)
Steps:
  1. User approves USDC on Router
  2. Call Router.swapExactTokensForTokens(100 USDC, minOut, [USDC, CLARA], ...)
  3. Check user received CLARA
  4. Check amount is reasonable given pool reserves
Expected: Swap succeeds, user receives CLARA
Notes: This is the "wallet_swap USDC→CLARA" path for non-airdrop users
```

```
TC-113: Swap CLARA to USDC via Aerodrome
Category: integration
Priority: P2-medium
Preconditions: Pool has liquidity (TC-111)
Steps:
  1. User approves CLARA on Router
  2. Call Router.swapExactTokensForTokens(1000 CLARA, minOut, [CLARA, USDC], ...)
  3. Check user received USDC
Expected: Swap succeeds, user receives USDC
Notes: Exit path for CLARA holders
```

### 2.3 UUPS Upgrade

```
TC-120: ClaraStaking UUPS upgrade preserves storage
Category: integration
Priority: P0-critical
Preconditions: ClaraStaking v1 deployed, users have staked and earned
Steps:
  1. UserA stakes 1000 CLARA, FeeSource deposits 100 USDC
  2. Record: totalStaked, rewardPerTokenStored, stakedBalance(A), earned(A)
  3. Deploy ClaraStaking v2 implementation (with additional view function)
  4. Owner (timelock) calls upgradeToAndCall(v2Implementation, "")
  5. Verify totalStaked unchanged
  6. Verify rewardPerTokenStored unchanged
  7. Verify stakedBalance(A) unchanged
  8. Verify earned(A) unchanged
  9. Verify new v2 function is callable
Expected: All storage preserved, no data loss, new functionality accessible
Notes: Most critical upgrade test (security-review.md C1)
```

```
TC-121: ClaraStaking upgrade rejected without timelock
Category: integration
Priority: P0-critical
Preconditions: ClaraStaking deployed, ownership transferred to timelock
Steps:
  1. Attacker directly calls upgradeToAndCall(maliciousImpl, "")
Expected: Reverts (only owner/timelock can authorize)
Notes: Validates _authorizeUpgrade access control
```

```
TC-122: TimelockController enforces 7-day delay
Category: integration
Priority: P0-critical
Preconditions: TimelockController deployed with 7-day minDelay
Steps:
  1. Proposer schedules an upgrade operation
  2. Immediately try to execute — reverts (too early)
  3. Warp 6 days — try execute — reverts (still too early)
  4. Warp 7 days — execute succeeds
Expected: 7-day delay strictly enforced
Notes: This is the critical window for stakers to exit (security-review.md C1 mitigation)
```

```
TC-123: Implementation contract cannot be initialized directly
Category: integration
Priority: P0-critical
Preconditions: ClaraStaking implementation deployed (not proxy)
Steps:
  1. Attacker calls initialize() directly on the implementation address
Expected: Reverts (DisableInitializers or already initialized)
Notes: Prevents C2 attack (security-review.md) — implementation must have _disableInitializers()
```

---

## 3. Smart Contract Security Tests (Foundry)

### 3.1 Flash Loan & Front-Running

```
TC-200: Flash-loan staking attack simulation
Category: security
Priority: P1-high
Preconditions: ClaraStaking deployed with 1M CLARA staked, Aerodrome pool has liquidity
Steps:
  1. UserA has 100_000 CLARA staked (legitimate staker)
  2. Attacker borrows 9M CLARA via flash loan
  3. Attacker stakes 9M CLARA (now 90% of pool)
  4. FeeSource deposits 1000 USDC
  5. Attacker claims ~900 USDC
  6. Attacker unstakes 9M CLARA
  7. Attacker repays flash loan
  8. Calculate: legitimate staker only received ~100 USDC instead of ~1000
Expected: Attack succeeds (this is a KNOWN ACCEPTED RISK per CLARA-TOKEN-PLAN.md).
  Document the exact profit extracted and dilution ratio.
Notes: Base sequencer FIFO ordering is the primary mitigation. This test documents the
  worst case for risk acceptance. If cooldown is added via UUPS upgrade later, re-run
  this test to verify mitigation.
```

```
TC-201: Yield sniping without flash loan
Category: security
Priority: P2-medium
Preconditions: ClaraStaking deployed, Aerodrome pool has liquidity
Steps:
  1. UserA stakes 1000 CLARA long-term
  2. Attacker buys 9000 CLARA on Aerodrome
  3. Attacker stakes 9000 CLARA (block N)
  4. FeeSource deposits 100 USDC (block N+1)
  5. Attacker claims rewards (block N+2)
  6. Attacker unstakes and sells CLARA (block N+3)
Expected: Attack succeeds but is less profitable than flash loan (must buy/sell CLARA
  at market price, incurring slippage). Document profitability threshold.
Notes: Accepted risk (security-review.md M5). Documents when a cooldown becomes necessary.
```

### 3.2 Reentrancy

```
TC-210: Reentrancy attack on claim()
Category: security
Priority: P0-critical
Preconditions: ClaraStaking deployed
Steps:
  1. Deploy a malicious contract that calls claim() from its receive/fallback
  2. Stake CLARA via malicious contract
  3. Deposit USDC
  4. Malicious contract calls claim() — attempts reentrant claim()
Expected: Second claim() reverts due to ReentrancyGuard
Notes: Even though USDC doesn't have callback hooks, ReentrancyGuard protects
  against future token changes (security-review.md M2)
```

```
TC-211: Reentrancy attack on exit()
Category: security
Priority: P1-high
Preconditions: ClaraStaking deployed
Steps:
  1. Deploy malicious contract with reentrant exit() call
  2. Stake and earn rewards
  3. Call exit() from malicious contract
Expected: Reentrant call reverts
Notes: exit() combines unstake + claim — double target
```

```
TC-212: Reentrancy attack on unstake()
Category: security
Priority: P1-high
Preconditions: ClaraStaking deployed
Steps:
  1. Deploy malicious contract that calls unstake() from token receive callback
  2. Stake CLARA via malicious contract
  3. Call unstake() — attempt reentrant unstake()
Expected: Reentrant call reverts
Notes: Tests CEI + ReentrancyGuard on unstake path
```

### 3.3 Zero-Staker Edge Cases

```
TC-220: Deposit when totalStaked == 0 (per consolidated plan: should revert)
Category: security
Priority: P0-critical
Preconditions: ClaraStaking deployed, no one has staked
Steps:
  1. FeeSource calls deposit(100e6)
Expected: Reverts with "No stakers" (per solidity-architecture.md Section 15 Refined Plan: Option A)
  OR — if the consolidated plan uses the current code (no revert), USDC becomes orphaned
  (sits in contract, rewardPerTokenStored doesn't increase). Document which behavior is
  implemented and verify accordingly.
Notes: CRITICAL edge case. The consolidated plan recommends Option A (revert).
  Current code in solidity-architecture.md Section 2 does NOT revert — it silently
  loses the USDC. This discrepancy needs resolution before deployment.
```

```
TC-221: First staker after zero-staker period gets no orphaned USDC
Category: security
Priority: P1-high
Preconditions: If TC-220 allows deposit with 0 stakers (current code path)
Steps:
  1. FeeSource deposits 100 USDC while totalStaked == 0
  2. UserA stakes 1000 CLARA
  3. Check earned(UserA) == 0 (the 100 USDC is orphaned)
Expected: Orphaned USDC is not claimable by anyone
Notes: This documents a known loss scenario. If the code is changed to revert on
  totalStaked==0 (recommended), this test becomes N/A.
```

```
TC-222: Deposit works immediately after first staker
Category: security
Priority: P1-high
Preconditions: ClaraStaking deployed
Steps:
  1. UserA stakes 1000 CLARA
  2. FeeSource deposits 100 USDC (totalStaked > 0 now)
  3. Check earned(UserA) == 100 USDC
Expected: Deposit succeeds and is fully distributable
Notes: Happy path after zero-staker period resolved
```

### 3.4 Precision & Extreme Values

```
TC-230: Precision with 1 wei USDC deposit and large total stake
Category: security
Priority: P1-high
Preconditions: 100M CLARA staked (full supply)
Steps:
  1. FeeSource deposits 1 (1 wei USDC = 0.000001 USDC)
  2. Calculate rewardPerTokenStored increment: 1 * 1e18 / 100_000_000e18 = 0.00000001
  3. Check if rewardPerTokenStored increases (may round to 0)
Expected: Document the rounding behavior. With 100M staked, 1 wei USDC rounds
  rewardPerTokenStored increment to 0. This is acceptable (security-review.md M1).
Notes: Dust amounts as protocol property — documented, not a bug
```

```
TC-231: Precision with large USDC deposit and small stake
Category: security
Priority: P1-high
Preconditions: Only 1 wei CLARA staked
Steps:
  1. FeeSource deposits 1_000_000e6 (1M USDC)
  2. Check rewardPerTokenStored = 1_000_000e6 * 1e18 / 1 = 1e30
  3. Check earned(user) = 1 * 1e30 / 1e18 = 1e12 = 1M USDC
Expected: No overflow, correct calculation
Notes: Tests upper bound of rewardPerTokenStored scaling
```

```
TC-232: MAX_UINT256 staking amount (fuzz boundary)
Category: security
Priority: P2-medium
Preconditions: ClaraToken with unrealistic supply (test-only)
Steps:
  1. Mint type(uint256).max CLARA to user
  2. Attempt to stake type(uint256).max
Expected: Either succeeds or reverts gracefully (no silent overflow)
Notes: Fuzz boundary test
```

```
TC-233: Accumulated dust over many small deposits
Category: security
Priority: P2-medium
Preconditions: 3 stakers with different amounts
Steps:
  1. Perform 1000 small deposits (1 USDC each)
  2. Have all stakers claim
  3. Check: sum of claimed amounts vs total deposited
  4. Check: USDC remaining in contract (dust)
Expected: Total claimed <= total deposited. Dust is small (<= number of deposits).
Notes: Documents precision loss accumulation (security-review.md M1)
```

### 3.5 Access Control

```
TC-240: Unauthorized deposit() rejected
Category: security
Priority: P0-critical
Preconditions: ClaraStaking deployed
Steps:
  1. Random address calls deposit(100e6) with approved USDC
Expected: Reverts with "Only fee source"
Notes: Only the authorized feeSource can inject rewards
```

```
TC-241: Unauthorized upgrade rejected
Category: security
Priority: P0-critical
Preconditions: ClaraStaking proxy deployed, ownership with timelock
Steps:
  1. Random address calls upgradeToAndCall()
Expected: Reverts (not owner)
Notes: None
```

```
TC-242: Unauthorized setFeeSource rejected
Category: security
Priority: P1-high
Preconditions: ClaraStaking deployed
Steps:
  1. Random address calls setFeeSource(attacker)
Expected: Reverts (not owner)
Notes: None
```

```
TC-243: Unauthorized recoverERC20 rejected
Category: security
Priority: P1-high
Preconditions: ClaraStaking deployed
Steps:
  1. Random address calls recoverERC20(USDC, amount)
Expected: Reverts (not owner)
Notes: None
```

### 3.6 Fuzz Tests

```
TC-250: Fuzz — stake/unstake/claim with random amounts
Category: security
Priority: P1-high
Preconditions: ClaraStaking deployed with funded users
Steps:
  1. Foundry fuzz test: randomize (stakeAmount, depositAmount, claimOrder, unstakeAmount)
  2. Run with 10,000+ iterations
  3. Invariants:
     a. totalStaked == sum of all stakedBalance[user]
     b. No user can claim more USDC than total deposited
     c. rewardPerTokenStored is monotonically increasing
     d. Sum of all claimed rewards <= sum of all deposits
Expected: All invariants hold across all fuzz runs
Notes: Foundry built-in fuzzing (solidity-architecture.md Section 15, point 6)
```

```
TC-251: Fuzz — deposit amount boundaries
Category: security
Priority: P2-medium
Preconditions: ClaraStaking deployed with various stake amounts
Steps:
  1. Fuzz deposit amounts from 1 wei to type(uint256).max
  2. Verify no overflow in rewardPerTokenStored calculation
  3. Verify no underflow in earned() calculation
Expected: No arithmetic errors across entire range
Notes: Tests the (amount * 1e18) / totalStaked calculation boundaries
```

```
TC-252: Fuzz — multi-user entry/exit ordering
Category: security
Priority: P2-medium
Preconditions: ClaraStaking deployed
Steps:
  1. Fuzz: random ordering of (stake, unstake, claim, deposit) from N users
  2. Invariants:
     a. No user earns rewards for periods they weren't staked
     b. totalStaked always matches sum of individual balances
     c. Contract USDC balance >= sum of all claimable rewards
Expected: All invariants hold
Notes: Most comprehensive fuzz test — catches ordering-dependent bugs
```

---

## 4. Clara MCP Integration Tests

### 4.1 Regression Tests (CRITICAL — existing UX must not change)

All existing tools must work identically for users who do NOT have CLARA tokens.
These tests should be written in Vitest and mock the Para/provider layer.

```
TC-300: wallet_setup works identically (with email)
Category: mcp
Priority: P0-critical
Preconditions: Clara MCP server running, no active session
Steps:
  1. Call wallet_setup with email="test@example.com"
  2. Verify response includes address, email confirmation
  3. Verify response does NOT mention CLARA tokens or staking
Expected: Setup flow unchanged for non-CLARA users
Notes: UX design says to add "25 free operations" messaging. This test ensures the
  CORE setup flow (address + email) is unchanged. Free tier additions tested separately.
```

```
TC-301: wallet_status works identically
Category: mcp
Priority: P0-critical
Preconditions: Active wallet session
Steps:
  1. Call wallet_status
  2. Verify response shows session info, wallet address
Expected: Output format unchanged
Notes: None
```

```
TC-302: wallet_dashboard shows portfolio without CLARA section (non-staker)
Category: mcp
Priority: P0-critical
Preconditions: Active wallet session, user has USDC and ETH but no CLARA staked
Steps:
  1. Call wallet_dashboard
  2. Verify portfolio shows all tokens with correct balances
  3. Verify NO "CLARA Staking" section appears
Expected: Dashboard identical to current behavior for non-staker
Notes: CLARA section only appears when user has staked (ux-design.md Dashboard Mockup)
```

```
TC-303: wallet_send works identically
Category: mcp
Priority: P0-critical
Preconditions: Active session, user has USDC
Steps:
  1. Call wallet_send with to=<address>, amount="1", token="USDC", chain="base"
  2. Verify transaction sent, hash returned
Expected: Send behavior unchanged
Notes: Uses existing test at src/__tests__/tools/send.test.ts as baseline
```

```
TC-304: wallet_swap works identically
Category: mcp
Priority: P0-critical
Preconditions: Active session, user has USDC
Steps:
  1. Call wallet_swap action="quote" fromToken="USDC" toToken="ETH" amount="10" chain="base"
  2. Verify quote returned with expected format
  3. Call wallet_swap action="execute" with quoteId
Expected: Swap flow unchanged
Notes: Uses existing test at src/__tests__/tools/swap.test.ts as baseline
```

```
TC-305: wallet_call works identically
Category: mcp
Priority: P0-critical
Preconditions: Active session
Steps:
  1. Call wallet_call with target contract, function, args
  2. Verify preparation response (safety analysis + prepared tx)
Expected: Call preparation flow unchanged
Notes: This is the same mechanism users will use to interact with ClaraStaking,
  but the tool itself must work for ANY contract, not just CLARA
```

```
TC-306: wallet_executePrepared works identically
Category: mcp
Priority: P0-critical
Preconditions: A prepared transaction from TC-305
Steps:
  1. Call wallet_executePrepared with txId from preparation
  2. Verify execution response
Expected: Execution flow unchanged
Notes: None
```

```
TC-307: wallet_sign_message works identically
Category: mcp
Priority: P1-high
Preconditions: Active session
Steps:
  1. Call wallet_sign_message with message="test message"
  2. Verify signature returned
Expected: Signing flow unchanged
Notes: None
```

```
TC-308: wallet_sign_typed_data works identically
Category: mcp
Priority: P1-high
Preconditions: Active session
Steps:
  1. Call wallet_sign_typed_data with valid EIP-712 typed data
  2. Verify signature returned
Expected: Signing flow unchanged
Notes: None
```

```
TC-309: wallet_approvals works identically
Category: mcp
Priority: P1-high
Preconditions: Active session
Steps:
  1. Call wallet_approvals
  2. Verify list of token approvals returned
Expected: Output unchanged
Notes: Uses existing test at src/__tests__/tools/approvals.test.ts as baseline
```

```
TC-310: wallet_history works identically
Category: mcp
Priority: P1-high
Preconditions: Active session with transaction history
Steps:
  1. Call wallet_history
  2. Verify transaction history returned
Expected: Output unchanged
Notes: Uses existing test at src/__tests__/tools/history.test.ts as baseline
```

```
TC-311: wallet_pay_x402 works identically
Category: mcp
Priority: P0-critical
Preconditions: Active session, user has USDC
Steps:
  1. Call wallet_pay_x402 with valid x402 payment request
  2. Verify payment processed, response returned
Expected: x402 payment flow unchanged
Notes: Core monetization path — must not break
```

```
TC-312: wallet_spending_limits works identically
Category: mcp
Priority: P1-high
Preconditions: Active session (or no session — this is a public tool)
Steps:
  1. Call wallet_spending_limits action="view"
  2. Verify current limits returned
  3. Call wallet_spending_limits action="set" maxPerTx="2.00"
  4. Verify limits updated
Expected: Spending limit management unchanged
Notes: None
```

```
TC-313: wallet_logout works identically
Category: mcp
Priority: P1-high
Preconditions: Active session
Steps:
  1. Call wallet_logout
  2. Verify session cleared
  3. Call wallet_status — should show no active session
Expected: Logout flow unchanged
Notes: None
```

```
TC-314: wallet_opportunities works identically (no CLARA in wallet)
Category: mcp
Priority: P0-critical
Preconditions: Active session, user has USDC, no CLARA
Steps:
  1. Call wallet_opportunities asset="USDC" chain="base"
  2. Verify lending yields returned (Aave, Compound, etc.)
  3. Verify NO "CLARA Staking" section appended
Expected: Opportunities output unchanged for non-CLARA users
Notes: CLARA staking section only appears when conditions met (ux-design.md Section 6)
```

```
TC-315: wallet_analyze_contract works identically
Category: mcp
Priority: P2-medium
Preconditions: Herd provider available
Steps:
  1. Call wallet_analyze_contract with a known contract address
  2. Verify analysis returned
Expected: Contract analysis unchanged
Notes: Public tool — no auth needed
```

### 4.2 New Tool: wallet_claim_airdrop

```
TC-320: wallet_claim_airdrop — initial call shows verification options
Category: mcp
Priority: P1-high
Preconditions: Active session, MerkleDrop deployed
Steps:
  1. Call wallet_claim_airdrop
  2. Verify response shows verification methods (GitHub, X, Both)
  3. Verify verification link URL generated
Expected: Claim flow starts with identity verification prompt
Notes: ux-design.md Airdrop Claim Flow — Step 1
```

```
TC-321: wallet_claim_airdrop — claim succeeds after verification
Category: mcp
Priority: P1-high
Preconditions: User has verified GitHub identity
Steps:
  1. Call wallet_claim_airdrop (after OAuth verification completed)
  2. Verify CLARA tokens sent to user wallet
  3. Verify response shows amount, tx hash, staking suggestion
Expected: Airdrop claimed, tokens delivered immediately
Notes: ux-design.md Airdrop Claim Flow — Step 4
```

```
TC-322: wallet_claim_airdrop — double claim shows "already claimed"
Category: mcp
Priority: P1-high
Preconditions: User has already claimed airdrop
Steps:
  1. Call wallet_claim_airdrop again
Expected: Response shows "already claimed" status, no error
Notes: Idempotent behavior (ux-design.md Section 8, key decision 2)
```

```
TC-323: wallet_claim_airdrop — ineligible user gets clear message
Category: mcp
Priority: P2-medium
Preconditions: User not in Merkle tree
Steps:
  1. Call wallet_claim_airdrop (user not eligible)
Expected: Response shows eligibility requirements and alternative (wallet_swap)
Notes: Error state E8 from ux-design.md
```

### 4.3 Modified Tools

```
TC-330: wallet_dashboard shows CLARA staking section (staker)
Category: mcp
Priority: P1-high
Preconditions: Active session, user has CLARA staked in ClaraStaking
Steps:
  1. Call wallet_dashboard
  2. Verify "CLARA Staking" section present
  3. Verify shows: Staked amount, Share %, Claimable USDC, Earned Total
  4. Verify inline action hint for claiming
Expected: Dashboard shows staking info matching ux-design.md Active User mockup
Notes: Section only appears for stakers (TC-302 verifies it's absent for non-stakers)
```

```
TC-331: wallet_dashboard shows unstaked CLARA with staking hint
Category: mcp
Priority: P2-medium
Preconditions: User has CLARA in wallet but NOT staked
Steps:
  1. Call wallet_dashboard
  2. Verify CLARA appears in portfolio with "(unstaked)" label
  3. Verify inline hint: "Stake to earn fees: wallet_call..."
Expected: Nudge toward staking for users holding unstaked CLARA
Notes: ux-design.md Refined Plan Section 7 — stake-from-dashboard shortcut
```

```
TC-332: wallet_opportunities appends CLARA staking (user has CLARA)
Category: mcp
Priority: P1-high
Preconditions: User has CLARA in wallet (staked or unstaked)
Steps:
  1. Call wallet_opportunities asset="USDC" chain="base"
  2. Verify standard lending yields present
  3. Verify "CLARA Staking" section appended with: pool stats, APY, how-to
Expected: CLARA staking appears as an additional opportunity
Notes: ux-design.md Opportunities Mockup — auto-detection based on CLARA ownership
```

```
TC-333: wallet_opportunities appends CLARA staking (10+ paid ops)
Category: mcp
Priority: P2-medium
Preconditions: User has used 10+ paid operations, no CLARA in wallet
Steps:
  1. Call wallet_opportunities
  2. Verify "CLARA Staking" section appended
Expected: Organic discovery for active users who don't yet hold CLARA
Notes: ux-design.md Section 6 auto-detection trigger
```

### 4.4 Free Tier

```
TC-340: wallet_setup shows free tier counter
Category: mcp
Priority: P1-high
Preconditions: New wallet being created
Steps:
  1. Call wallet_setup email="newuser@example.com"
  2. Verify response includes "25 free operations" messaging
Expected: Free tier communicated at setup
Notes: ux-design.md First-Run Script Scene 1
```

```
TC-341: Free tier counter decrements on write operations
Category: mcp
Priority: P1-high
Preconditions: New wallet with 25 free ops
Steps:
  1. Perform a write operation (e.g., wallet_sign_message)
  2. Verify response shows "24 remaining"
  3. Perform another write operation
  4. Verify response shows "23 remaining"
Expected: Counter decrements by 1 per write op
Notes: Read operations (dashboard, history, opportunities) should NOT decrement
```

```
TC-342: Free tier — read operations don't decrement counter
Category: mcp
Priority: P1-high
Preconditions: New wallet with 25 free ops
Steps:
  1. Call wallet_dashboard (read)
  2. Call wallet_history (read)
  3. Call wallet_opportunities (read)
  4. Check free ops counter still at 25
Expected: Read operations are always free, counter unchanged
Notes: ux-design.md Free Tier Design — write operations only
```

```
TC-343: Free tier — nudge at 5 remaining
Category: mcp
Priority: P2-medium
Preconditions: Wallet with 5 free ops remaining
Steps:
  1. Perform write operation
  2. Verify response includes low-balance warning
Expected: "Running low on free operations (5 left)" messaging appears
Notes: ux-design.md Free Tier Design — at 5 remaining
```

```
TC-344: Free tier — x402 kicks in after exhaustion
Category: mcp
Priority: P0-critical
Preconditions: Wallet with 0 free ops remaining, has USDC
Steps:
  1. Perform write operation
  2. Verify x402 payment was charged (~$0.01)
  3. Verify response shows x402 fee line
Expected: Seamless transition from free to paid via x402
Notes: Core monetization trigger — ux-design.md Scene 5
```

```
TC-345: Free tier — clear error when 0 free ops and no USDC
Category: mcp
Priority: P1-high
Preconditions: Wallet with 0 free ops and 0 USDC
Steps:
  1. Attempt write operation
Expected: Clear error message with deposit instructions (error E1 from ux-design.md)
Notes: Most critical error state for user retention
```

---

## 5. End-to-End Scenario Tests

These tests simulate complete user journeys from start to finish.

```
TC-400: New user journey — setup to first claim
Category: e2e
Priority: P0-critical
Preconditions: All contracts deployed, Clara MCP running, Aerodrome pool has liquidity
Steps:
  1. wallet_setup email="newuser@example.com" — wallet created
  2. wallet_dashboard — shows empty wallet, 25 free ops
  3. wallet_sign_message — uses free op (24 remaining)
  4. [Simulate 20 more write ops] — 4 remaining
  5. [Fund wallet with 5 USDC on Base]
  6. wallet_send to=<address> amount="0.5" token="USDC" — uses free op (3 remaining)
  7. [Exhaust free ops]
  8. wallet_send — x402 fee charged ($0.01)
  9. wallet_opportunities — discovers CLARA staking
  10. wallet_claim_airdrop — claims 500 CLARA (if eligible)
  11. wallet_call ClaraStaking.stake(500e18) — stakes CLARA
  12. [Wait for fee deposits]
  13. wallet_dashboard — shows "Claimable: $X.XX USDC"
  14. wallet_call ClaraStaking.claim() — claims USDC
  15. Verify USDC balance increased
Expected: Full user journey from zero to earning USDC rewards
Notes: The "aha moment" test — maps to ux-design.md User Journey Map complete flow
```

```
TC-401: Existing user journey — no CLARA involvement
Category: e2e
Priority: P0-critical
Preconditions: Clara MCP running with CLARA system deployed
Steps:
  1. wallet_setup email="existing@example.com"
  2. wallet_dashboard — shows portfolio
  3. wallet_send to=<address> amount="1" token="USDC" chain="base"
  4. wallet_swap action="quote" fromToken="USDC" toToken="ETH" amount="5"
  5. wallet_swap action="execute" quoteId=<id>
  6. wallet_history — shows recent transactions
  7. wallet_approvals — shows token approvals
Expected: ENTIRE journey works without any mention of CLARA, staking, or airdrop.
  No new steps, no changed output formats, no degraded performance.
Notes: THE critical regression test. If this fails, the CLARA integration is broken.
```

```
TC-402: Staker dashboard experience
Category: e2e
Priority: P1-high
Preconditions: User has staked CLARA, fees have been deposited
Steps:
  1. wallet_dashboard — verify CLARA staking section shows
  2. wallet_opportunities — verify CLARA staking section appended
  3. wallet_call ClaraStaking.getClaimable(userAddress) — check rewards
  4. wallet_call ClaraStaking.claim() — claim rewards
  5. wallet_dashboard — verify claimable is now 0, earned total increased
Expected: Full staker experience is cohesive and accurate
Notes: None
```

```
TC-403: Error scenario — no USDC for x402 after free tier
Category: e2e
Priority: P1-high
Preconditions: User has exhausted free tier, no USDC in wallet
Steps:
  1. Attempt wallet_send
  2. Verify clear error message (ux-design.md E1)
  3. Attempt wallet_dashboard — succeeds (read op is free)
  4. Attempt wallet_history — succeeds (read op is free)
Expected: Write ops blocked with helpful message, read ops still work
Notes: Users must never be completely locked out of reading their wallet state
```

```
TC-404: Error scenario — expired session
Category: e2e
Priority: P2-medium
Preconditions: Wallet session has expired (>24h)
Steps:
  1. Call wallet_dashboard
  2. Verify session expired error (ux-design.md E4)
  3. Call wallet_setup to reconnect
  4. Verify same wallet, same address, same funds
Expected: Recovery is smooth, no fund loss
Notes: None
```

```
TC-405: Error scenario — spending limit hit
Category: e2e
Priority: P2-medium
Preconditions: User at daily spending limit
Steps:
  1. Attempt write operation
  2. Verify spending limit error (ux-design.md E3)
  3. Verify shows current spending vs limit
  4. Verify suggests wallet_spending_limits to adjust
Expected: Clear error with actionable remediation
Notes: None
```

```
TC-406: Error scenario — zero rewards to claim
Category: e2e
Priority: P2-medium
Preconditions: User just staked, no fee deposits yet
Steps:
  1. wallet_call ClaraStaking.claim()
  2. Verify graceful response (no revert, just "no rewards" or 0 claim)
Expected: No confusing error — user understands rewards accrue over time
Notes: Maps to ux-design.md E7
```

```
TC-407: Error scenario — insufficient CLARA to stake
Category: e2e
Priority: P3-low
Preconditions: User has 0 CLARA
Steps:
  1. wallet_call ClaraStaking.stake(1000e18)
  2. Verify error indicates need for CLARA
Expected: Clear guidance: swap USDC→CLARA or claim airdrop
Notes: Maps to ux-design.md E6
```

---

## 6. x402 Fee Flow Tests

```
TC-500: x402 facilitator deposits directly to ClaraStaking
Category: x402
Priority: P0-critical
Preconditions: ClaraStaking deployed, feeSource configured as x402 facilitator address
Steps:
  1. Simulate x402 settlement: facilitator sends USDC to ClaraStaking.deposit()
  2. Verify rewardPerTokenStored increased
  3. Verify USDC balance of ClaraStaking increased
Expected: Direct settlement works — no proxy custody (CLARA-TOKEN-PLAN.md architecture)
Notes: Eliminates C4 risk (security-review.md). The x402 facilitator must be set as the
  feeSource in ClaraStaking.
```

```
TC-501: Batch settlement — multiple small fees in one deposit
Category: x402
Priority: P1-high
Preconditions: ClaraStaking deployed
Steps:
  1. Simulate 100 x402 payments of $0.01 each
  2. Clara-proxy batches into one deposit(1e6) (1 USDC total)
  3. Verify rewardPerTokenStored increases by expected amount
Expected: Batch settlement aggregates correctly
Notes: Periodic batch is more gas-efficient than per-tx deposit
```

```
TC-502: Settlement fails during zero-staker period — proxy retries
Category: x402
Priority: P1-high
Preconditions: ClaraStaking deployed, no stakers (totalStaked == 0)
Steps:
  1. Clara-proxy attempts deposit(100e6)
  2. If deposit reverts (per recommended Option A), proxy holds USDC
  3. UserA stakes CLARA
  4. Proxy retries deposit(100e6)
  5. Verify deposit succeeds
Expected: Proxy gracefully handles revert and retries after stakers exist
Notes: This test crosses the boundary between smart contract and proxy service.
  Document the retry mechanism design.
```

```
TC-503: x402 fee visible in tool response after free tier
Category: x402
Priority: P1-high
Preconditions: User has exhausted free tier, has USDC
Steps:
  1. Perform wallet_send
  2. Verify response footer shows: "x402 fee: $0.01 | Today: $X.XX/$10.00"
Expected: Fee transparency after free tier (ux-design.md x402 Fee Communication)
Notes: Fee line should NOT appear during free tier
```

```
TC-504: x402 fee NOT visible during free tier
Category: x402
Priority: P1-high
Preconditions: User has free ops remaining
Steps:
  1. Perform wallet_send (free op)
  2. Verify NO x402 fee line in response
  3. Verify "Free operations: N remaining" shown instead
Expected: Clean UX during free tier — no mention of x402 or costs
Notes: ux-design.md x402 Fee Communication — during free tier
```

```
TC-505: x402 auto-pay respects spending limits
Category: x402
Priority: P1-high
Preconditions: User has $0.50 remaining in daily limit
Steps:
  1. Perform 50 write operations ($0.01 each = $0.50 total)
  2. Attempt 51st operation
  3. Verify spending limit error
Expected: x402 auto-pay stops at daily limit
Notes: Interaction between x402 and spending limits
```

```
TC-506: x402 large fee requires approval
Category: x402
Priority: P2-medium
Preconditions: User has per-tx limit of $1.00
Steps:
  1. Access a resource with $0.75 x402 fee
  2. Verify approval prompt shown
  3. Approve and verify payment processed
Expected: Large fees get explicit user approval
Notes: ux-design.md x402 Fee Communication — approval flow for >$0.50
```

---

## Areas Needing Specialist Input

### For Security Engineer (Task #2)

1. **TC-220 discrepancy**: The consolidated plan says deposit() should revert when totalStaked==0, but the code in solidity-architecture.md does NOT revert. Which behavior ships? This affects TC-220, TC-221, TC-222, and TC-502.

2. **Flash loan profitability analysis (TC-200)**: Need concrete numbers for the risk acceptance documentation. What is the maximum extractable value given realistic pool sizes and fee volumes?

3. **Timelock monitoring tests**: Are there tests needed for the monitoring infrastructure (OpenZeppelin Defender / Tenderly alerting on CallScheduled events)?

4. **Fuzz test parameter ranges (TC-250-252)**: Any specific edge values from the security review that should be targeted in addition to random fuzzing?

### For Solidity Engineer (Task #3)

1. **stakeWithPermit() implementation (TC-025)**: The interface is described in solidity-architecture.md Section 15 but not in the contract code in Section 2. Need to confirm this function will be implemented.

2. **_disableInitializers() (TC-123)**: The ClaraStaking code in Section 2 does NOT show a constructor with _disableInitializers(). Need to confirm this will be added.

3. **Storage gap (TC-120)**: The `uint256[50] private __gap` mentioned in Section 4 is not in the contract code. Need to confirm it will be added for upgrade safety.

4. **MerkleDrop interface**: No Solidity code provided for MerkleDrop. Need the full interface to write precise tests for TC-040 through TC-046.

5. **Immutable ClaraToken (Section 15 recommendation)**: The refined plan recommends deploying ClaraToken WITHOUT a proxy. If accepted, TC-005/006/007 permit tests don't need UUPS context, but we'd also need to verify there's no upgrade path (and document this as intentional).

### For UX Designer (Task #4)

1. **Free tier counter location**: Where does the counter live? On-chain (ClaraCredits contract), in clara-proxy, or client-side? This affects TC-340-345 test infrastructure.

2. **CLARA staking section threshold**: Is the 10+ paid ops threshold for showing CLARA in opportunities (TC-333) tracked in the proxy or on-chain?

3. **Error message exact wording**: TC-345, TC-403, TC-404, TC-405, TC-406, TC-407 all test error messages. Should the test validate exact text or just semantic content?

4. **wallet_status changes**: Does wallet_status get any CLARA-related additions? It's not in the "Modified Tools" section of ux-design.md but is mentioned briefly in the "aha moment" appendix as potentially showing claimable rewards.

---

## Summary

| Category | P0 | P1 | P2 | P3 | Total |
|----------|----|----|----|----|-------|
| Smart Contract Unit | 12 | 9 | 4 | 0 | 25 |
| Smart Contract Integration | 5 | 5 | 2 | 0 | 12 |
| Smart Contract Security | 4 | 8 | 4 | 0 | 16 |
| Clara MCP Integration | 7 | 14 | 4 | 0 | 25 |
| End-to-End Scenarios | 2 | 2 | 3 | 1 | 8 |
| x402 Fee Flow | 1 | 4 | 1 | 0 | 6 |
| **Total** | **31** | **42** | **18** | **1** | **92** |

Note: Final count is 92 test cases (TC-001 through TC-506, non-contiguous numbering for category grouping).
