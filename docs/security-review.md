# CLARA Token + x402 Fee Distribution: Security Review

**Reviewer:** Security Engineer (Automated)
**Date:** 2025-02-05
**System:** Model B — ClaraToken + ClaraStaking + FeeDistributor on Base
**Status:** Pre-implementation review (architecture-level)

---

## Table of Contents

1. [Threat Model](#1-threat-model)
2. [Recommendations](#2-recommendations)
3. [Contract-Level Security Requirements](#3-contract-level-security-requirements)
4. [Admin Model Recommendation](#4-admin-model-recommendation)
5. [Things to Throw Out](#5-things-to-throw-out)
6. [Refined Plan (v2 Architecture)](#6-refined-plan-v2-architecture)

---

## 1. Threat Model

### CRITICAL

#### C1: UUPS Upgrade to Drain FeeDistributor

**Attack:** A compromised admin (or key theft) queues a malicious UUPS upgrade to FeeDistributor that adds a `drain()` function, waits out the timelock, then executes. All accumulated USDC is stolen.

**Precedent:** The OpenZeppelin UUPS vulnerability (Sep 2021) showed that uninitialized implementation contracts could be seized by attackers who then self-destructed them, bricking all proxies. While that specific bug is patched, the general attack surface of "upgrade = arbitrary code execution" remains the most dangerous vector in any upgradeable system.

**Likelihood:** Medium (requires admin key compromise)
**Impact:** Total loss of all staker funds in FeeDistributor

#### C2: Uninitialized UUPS Implementation

**Attack:** If the implementation contract behind a UUPS proxy is deployed but not initialized, an attacker can call `initialize()` on the implementation directly, appoint themselves as upgrade admin, and potentially `selfdestruct` the implementation — bricking the proxy permanently.

**Precedent:** OpenZeppelin UUPS vulnerability (Sep 2021). Patched in OZ Contracts v4.3.2+ with `_disableInitializers()` in the constructor.

**Likelihood:** Low if using modern OZ, but catastrophic if missed
**Impact:** Permanent contract brick, total loss of funds

#### C3: Front-Running / Flash-Loan Attack on Staking Rewards

**Attack:** Attacker monitors the mempool for large USDC deposits to FeeDistributor (e.g., a batch settlement from clara-proxy). Attacker flash-loans CLARA, stakes immediately before the deposit, captures a disproportionate share of rewards, unstakes, and repays the flash loan — all in one transaction.

**Precedent:** This is a well-known attack pattern in DeFi. The Synthetix StakingRewards contract and its many forks are all vulnerable to this if staking and reward notification happen in separate transactions without time-weighting.

**Likelihood:** High (trivially exploitable with flash loans once CLARA has DEX liquidity)
**Impact:** Dilution of legitimate staker rewards; attacker captures yield at zero cost

#### C4: Proxy Wallet USDC Custody Risk

**Attack:** The clara-proxy collects USDC from x402 payments and must forward it to FeeDistributor. Between collection and settlement, the proxy wallet holds USDC. If the proxy is compromised (key leaked, worker hijacked), all unsettled USDC is stolen.

**Likelihood:** Medium (the proxy is a Cloudflare Worker with a hot key)
**Impact:** Loss of all USDC between settlement intervals

---

### HIGH

#### H1: Infinite Approval + Malicious Upgrade

**Attack:** Users approve ClaraStaking to spend their CLARA (required for staking). If ClaraStaking is upgraded maliciously (via compromised timelock admin), the new implementation can call `transferFrom` to steal all approved CLARA from every user who ever staked.

**Precedent:** UniCats rug pull — project deployed a staking contract, users approved infinite CLARA, project upgraded and drained. ConcentricFi lost $1.72M via this vector. SocketDotTech (Bungee) lost $3.3M from users with infinite approvals.

**Likelihood:** Low (requires admin compromise + timelock bypass)
**Impact:** Total loss of all CLARA tokens ever approved to staking contract

#### H2: Unmonitored Timelock

**Attack:** A malicious upgrade is queued via timelock but nobody monitors the timelock events. The upgrade executes after the delay period with no intervention.

**Precedent:** Beanstalk ($182M loss, April 2022). A malicious governance proposal was submitted with a 24-hour emergency delay but went completely unmonitored. The attacker executed it the moment the delay expired.

**Likelihood:** High in early-stage projects without monitoring infrastructure
**Impact:** Enables all admin-level attacks (C1, H1)

#### H3: FeeDistributor Share Calculation — Division by Zero

**Attack:** If `totalStaked == 0` (no stakers), USDC sent to FeeDistributor becomes permanently trapped. The `rewardPerToken` calculation divides by `totalStaked`, causing either a revert (blocking deposits) or the USDC is allocated to no one and becomes unrecoverable.

**Likelihood:** High in early days before staking adoption
**Impact:** Permanent loss of accumulated USDC fees

---

### MEDIUM

#### M1: Rounding / Precision Loss in Reward Accounting

**Attack:** Solidity's integer division truncates. Over millions of claim() calls with small balances, accumulated rounding errors can cause: (a) some USDC permanently locked in FeeDistributor ("dust"), or (b) last claimant unable to withdraw because the contract is short by a few wei.

**Precedent:** This is a well-documented issue in Synthetix-style reward contracts. The standard mitigation is scaling by 1e18 before division, but even this accumulates error over time.

**Likelihood:** Certain (this is a mathematical inevitability)
**Impact:** Low per-user (dust amounts), but reputationally damaging if the contract "runs out"

#### M2: Reentrancy in claim()

**Attack:** The `claim()` function transfers USDC (ERC-20) to the caller. If USDC had callback hooks (like ERC-777), the caller could reenter `claim()` before state is updated. Standard USDC does not have callbacks, but: (a) Circle could upgrade USDC, (b) if the contract is ever pointed at a non-standard token, reentrancy is possible.

**Likelihood:** Very low for USDC specifically (no hooks currently)
**Impact:** Double-claiming of rewards

#### M3: Sybil Attacks on Airdrop

**Attack:** The airdrop claims eligibility via GitHub + X identity. An attacker creates dozens of fake GitHub accounts and X profiles, meets the minimum criteria, and claims multiple airdrop allocations. They then stake all CLARA to capture disproportionate staking rewards.

**Likelihood:** Medium-High (GitHub accounts are free, X accounts are cheap)
**Impact:** Inequitable token distribution, concentration of staking power

#### M4: Pause Function Abuse

**Attack:** If an emergency `pause()` function exists, and a single EOA controls it, that key holder can freeze the entire protocol — blocking staking, unstaking, and claiming. This is a censorship/griefing vector.

**Likelihood:** Low if properly designed
**Impact:** DoS on all protocol functions

#### M5: Staking Contract — No Unbonding Period Enables Yield Sniping

**Attack:** Without a minimum staking duration or unbonding period, users can stake right before rewards are distributed and unstake immediately after claiming. This is a less capital-efficient version of C3 (flash loan attack) but doesn't even require flash loans.

**Likelihood:** Certain
**Impact:** Legitimate long-term stakers receive diluted rewards

---

### LOW

#### L1: Token Decimals Mismatch

**Issue:** CLARA (likely 18 decimals) and USDC (6 decimals) have different decimal scales. If the reward math doesn't account for this, reward calculations will be off by 12 orders of magnitude.

**Likelihood:** Low (should be caught in testing)
**Impact:** Completely broken reward distribution

#### L2: First Depositor Inflation Attack

**Issue:** If the FeeDistributor uses a share-based accounting model (like ERC-4626), the first depositor can manipulate the share price by depositing a tiny amount of CLARA and then "donating" a large amount of USDC. This inflates the share value, causing the next staker's deposit to round down to zero shares.

**Likelihood:** Low (depends on implementation)
**Impact:** New stakers lose their entire deposit

#### L3: Griefing via Dust Deposits

**Issue:** An attacker can repeatedly send 1 wei of USDC to FeeDistributor, triggering state updates and increasing gas costs for legitimate operations without meaningful economic impact.

**Likelihood:** Low (costly to the attacker)
**Impact:** Increased gas costs for legitimate users

#### L4: Merkle Root Update Mechanism

**Issue:** If the airdrop Merkle root can be updated after deployment (e.g., for a multi-phase airdrop), a compromised admin could set a new root that includes attacker-controlled addresses.

**Likelihood:** Low (depends on whether root is immutable)
**Impact:** Theft of unclaimed airdrop tokens

---

## 2. Recommendations

### For C1 (UUPS Upgrade Drain)

1. **Use a 7-day timelock on FeeDistributor upgrades.** This gives stakers time to unstake and claim before any malicious upgrade executes.
2. **Implement a "withdrawal window" pattern:** When an upgrade is queued, a 48-hour "exit window" opens where stakers can claim + unstake with no penalty.
3. **Consider making FeeDistributor non-upgradeable.** It's the contract holding user funds. If the logic is simple enough (Synthetix-style reward accounting), there's no need for upgradeability. Immutability is the strongest security guarantee.

### For C2 (Uninitialized Implementation)

1. **Use OpenZeppelin v5.x+ and call `_disableInitializers()` in every implementation constructor.**
2. **Verify in deployment scripts** that the implementation's `initialize()` reverts when called directly.
3. **Add a post-deployment check** that reads the implementation's initialized slot.

### For C3 (Flash Loan / Front-Running)

1. **Implement time-weighted staking.** Rewards should accrue based on "stake-seconds" — how long you've been staked, not just how much. A user who stakes 1 block before reward distribution earns virtually nothing.
2. **Minimum staking duration.** Require a minimum lockup period (e.g., 1 epoch = 1 week) before staked CLARA becomes eligible for rewards.
3. **Continuous reward streaming.** Instead of discrete reward events (which create front-running opportunities), use a continuous accrual model (like Synthetix's `rewardPerToken` accumulator updated per second). This eliminates the "big deposit event" that attackers target.
4. **Consider a cooldown on unstaking.** A 7-day unstaking cooldown (like Aave's Safety Module) makes flash-loan attacks impossible because the attacker can't repay within the same block.

### For C4 (Proxy Wallet Custody)

1. **Minimize float.** Settle USDC to FeeDistributor as frequently as economically feasible (every N transactions or every M minutes, whichever is sooner).
2. **Use a dedicated settlement address** that can only call `FeeDistributor.deposit()`, not arbitrary functions.
3. **Set a maximum balance threshold** on the proxy wallet. If it exceeds X USDC, auto-settle.
4. **Consider having x402 payments go directly to FeeDistributor** via the facilitator contract, eliminating proxy custody entirely.

### For H1 (Infinite Approval)

1. **Do NOT use infinite approvals.** Require users to approve only the exact stake amount.
2. **Use `increaseAllowance` / `decreaseAllowance`** instead of `approve` (mitigates the front-running approval race condition).
3. **Support ERC-2612 permit** — users sign a gasless approval that's submitted with the stake transaction. This eliminates the separate approval step and limits approval to exactly one transaction.

### For H2 (Unmonitored Timelock)

1. **Implement on-chain monitoring** from day one. Use a service like OpenZeppelin Defender, Tenderly, or a custom bot that alerts on `TimelockController.CallScheduled` events.
2. **Publish all timelock events** to a public monitoring dashboard.
3. **Require a 2-step execution:** After the timelock delay, require a second confirmation from a different key (proposer != executor).

### For H3 (Division by Zero)

1. **Gate deposits:** If `totalStaked == 0`, USDC deposited to FeeDistributor should go to a "pending" buffer that is distributed once the first staker arrives. Alternatively, revert deposits when no stakers exist.
2. **Seed the staking pool:** At deployment, stake a small amount of CLARA from a protocol-controlled address to ensure `totalStaked > 0` always.

### For M1 (Rounding)

1. **Scale by 1e18** in the reward-per-token accumulator.
2. **Accept dust as protocol property.** Document that tiny residual amounts may remain in the contract due to integer math. This is normal and expected.
3. **Add a sweep function** (admin-only, timelocked) for recovering dust after a long period.

### For M2 (Reentrancy)

1. **Follow Checks-Effects-Interactions:** Update all state (claimed amounts, reward debt) BEFORE transferring USDC.
2. **Use `ReentrancyGuard`** from OpenZeppelin on all external-facing functions.
3. **Use `SafeERC20.safeTransfer`** for USDC transfers.

### For M3 (Sybil Airdrop)

1. **Require meaningful GitHub activity.** Don't just check account existence — require repositories with stars, commit history > 6 months, or contributions to known projects.
2. **Use Gitcoin Passport or similar humanity scoring.** A composite score from multiple identity providers is much harder to sybil than a single platform check.
3. **Consider a claim-and-vest model:** Airdrop recipients get tokens vested over 6 months with a cliff. Sybil attackers have reduced economic incentive if they can't sell immediately.
4. **Use Base Verify** if available for Base-native identity attestation (one verified account = one claim).

### For M5 (Yield Sniping without Flash Loans)

1. **Minimum staking epoch.** Stakes aren't eligible for rewards until the next epoch boundary (e.g., weekly).
2. **Warmup period.** First 7 days of staking earn at 50% rate, scaling to 100% over 30 days.
3. This is the same mitigation as C3 — time-weighting solves both flash loans and manual sniping.

---

## 3. Contract-Level Security Requirements

### ClaraToken (ERC-20)

| Requirement | Rationale |
|---|---|
| Fixed 100M supply, minted in constructor to a single address | No mint function = no inflation attack |
| `_disableInitializers()` in implementation constructor | Prevents UUPS uninitialized impl attack (C2) |
| UUPS with 48h timelock for upgrades | Lower risk contract (no funds held), shorter lock OK |
| Support ERC-2612 (permit) | Enables gasless staking flow, avoids infinite approvals |
| NO burn function | Deflationary mechanics add complexity with no security benefit here |
| NO blocklist/allowlist | Avoid admin censorship vector |

### ClaraStaking

| Requirement | Rationale |
|---|---|
| Synthetix-style `rewardPerToken` accumulator | O(1) gas for any number of stakers |
| Scale accumulator by 1e18 | Prevent precision loss (M1) |
| Minimum staking epoch of 7 days | Prevents flash-loan (C3) and yield sniping (M5) |
| Unstaking cooldown of 7 days | Same as above, also prevents panic bank-runs |
| CEI pattern + ReentrancyGuard on `stake()`, `unstake()`, `claim()` | Reentrancy protection (M2) |
| `_disableInitializers()` in constructor | UUPS protection (C2) |
| UUPS with 7-day timelock for upgrades | Holds user CLARA deposits — needs maximum protection |
| Exact-amount approvals only (document in SDK/UI) | Prevents infinite approval drain (H1) |
| Handle `totalStaked == 0` gracefully | Prevent division by zero (H3) |
| Emit events on all state changes | Enables monitoring (H2) |
| `Pausable` with guardian role (separate from admin) | Emergency response (M4) |
| Pause duration limited to 7 days (auto-unpause) | Prevents indefinite pause abuse |

### FeeDistributor

| Requirement | Rationale |
|---|---|
| **Strongly recommend: Non-upgradeable (no proxy)** | This contract holds all USDC. Immutability eliminates C1 entirely. |
| If upgradeable: 7-day timelock + exit window | Gives stakers time to withdraw before malicious upgrade |
| Accept USDC deposits only from whitelisted addresses | Prevents griefing (L3) and ensures only valid fee sources |
| Integrate with ClaraStaking for share calculation | Single source of truth for stake weights |
| CEI + ReentrancyGuard on `claim()` | Reentrancy protection (M2) |
| `SafeERC20.safeTransfer` for all USDC movement | Handle non-standard ERC-20 edge cases |
| `rewardPerToken` accumulator scaled by 1e18 | Precision (M1) |
| Handle `totalStaked == 0`: buffer deposits, don't revert | Prevent lost USDC (H3) |
| Emit `RewardDeposited` event with amount + timestamp | Monitoring |
| NO admin withdrawal function | Admin cannot steal accumulated USDC |
| Dust sweep function with 90-day timelock | Recovery of precision-loss residuals only |

### Airdrop (MerkleDrop)

| Requirement | Rationale |
|---|---|
| Immutable Merkle root (set once in constructor) | Prevent admin root swap (L4) |
| Double-claim protection via bitmap | Gas-efficient claim tracking |
| Claim deadline (e.g., 6 months) | Unclaimed tokens return to treasury |
| Vesting: 6-month linear vest with 1-month cliff | Sybil deterrent (M3) |
| Sybil scoring: Gitcoin Passport / GitHub activity threshold | Identity verification (M3) |

---

## 4. Admin Model Recommendation

### Recommended: Progressive Decentralization

**Phase 1 (Launch, months 0-6): 3-of-5 Multisig + Timelock**

| Role | Controller | Rationale |
|---|---|---|
| Timelock Proposer | 3-of-5 multisig (Gnosis Safe) | No single point of failure |
| Timelock Executor | Same multisig OR separate 2-of-5 | Two-step execution for extra safety |
| Pause Guardian | Single EOA (team lead) | Speed of emergency response |
| Unpause | 3-of-5 multisig only | Prevent single-actor griefing |
| Proxy admin (UUPS) | Timelock contract (not EOA) | All upgrades go through timelock |
| FeeDistributor deposit whitelist | Timelock | Adding new fee sources requires delay |

**Multisig Composition (3-of-5):**
- 2 core team members (e.g., founder + lead engineer)
- 1 advisor/investor with aligned incentives
- 2 community members or reputable third parties
- Hardware wallets required for all signers

**Timelock Durations:**

| Contract | Upgrade Timelock | Rationale |
|---|---|---|
| ClaraToken | 48 hours | Low-risk (no funds held, simple ERC-20) |
| ClaraStaking | 7 days | Holds user deposits, needs exit time |
| FeeDistributor | **Immutable** (no upgrades) | Holds accumulated USDC, maximum protection |

**Phase 2 (months 6-12): Governance Token Voting**

Once sufficient CLARA distribution exists, migrate the timelock proposer role from multisig to on-chain governance (e.g., OpenZeppelin Governor with CLARA token voting). Keep the multisig as a "guardian" that can cancel malicious proposals.

**Phase 3 (12+ months): Full Decentralization**

Renounce all admin keys. The contracts operate autonomously with only governance-controlled upgrades (via CLARA token voting).

### What to AVOID

- **Single EOA as admin for anything except emergency pause.** Key compromise = total loss.
- **Team-only multisig.** If all signers are on the same team, a coordinated attack or legal compulsion compromises all keys simultaneously.
- **Governance from day one.** With low token distribution, governance is trivially captured (see Beanstalk).

---

## 5. Things to Throw Out

### 1. UUPS Upgradeability on FeeDistributor — REMOVE IT

**Rationale:** The FeeDistributor is the contract holding accumulated USDC. It is the #1 target for attackers. Its logic is simple (receive USDC, track reward-per-token, let stakers claim). There is almost no reason you'd need to upgrade it. By making it immutable, you eliminate the single most dangerous attack vector (C1) entirely.

If you discover a bug post-deployment, deploy a new FeeDistributor and redirect new deposits to it. Stakers can claim from the old one and migrate. This is simpler and safer than trying to upgrade in-place.

### 2. Complex Airdrop Vesting — SIMPLIFY

**Rationale:** On-chain vesting contracts are a significant attack surface (storage manipulation, cliff calculation bugs, early withdrawal exploits). Consider a simpler approach:

- **Option A:** Airdrop 100% immediately but require a 30-day staking lockup to claim. This incentivizes staking without complex vesting logic.
- **Option B:** Use a simple 2-phase airdrop — 50% at launch, 50% after 90 days — rather than linear vesting. Two Merkle roots, two claim windows. Much simpler.

### 3. Per-Contract Timelocks — CONSOLIDATE

Don't deploy 3 separate TimelockControllers. Use one shared TimelockController with role-based access. This reduces deployment cost, audit surface, and operational complexity.

**But**: Use different minimum delays per function. The single timelock can still enforce that `FeeDistributor` actions (if any) have longer delays than `ClaraToken` actions.

### 4. Custom Settlement Logic — ELIMINATE

If the x402 facilitator can be configured to send USDC directly to the FeeDistributor contract address, do that. This eliminates:
- Proxy wallet custody risk (C4)
- Settlement batching complexity
- An entire class of bugs related to accounting between collection and settlement

Check if x402's facilitator supports configuring the `recipient` to be a contract address. If yes, this is the single biggest simplification you can make.

---

## 6. Refined Plan (v2 Architecture)

### Architecture After Security Hardening

```
User does wallet_send/swap/call/sign
     |
     v
clara-proxy returns HTTP 402 (~$0.01 USDC)
     |
     v
wallet_pay_x402 auto-pays
     |
     v
x402 facilitator settles USDC --> FeeDistributor (DIRECT, no proxy custody)
     |
     v
FeeDistributor (IMMUTABLE, non-upgradeable)
  - Receives USDC from whitelisted sources only
  - Tracks rewardPerToken accumulator (scaled 1e18)
  - Buffers deposits when totalStaked == 0
     |
     v
ClaraStaking (UUPS + 7-day timelock)
  - stake(amount) with ERC-2612 permit support
  - 7-day minimum epoch before rewards accrue
  - 7-day unstaking cooldown
  - claim() uses CEI + ReentrancyGuard
  - Pausable (guardian = single EOA, unpause = multisig)
  - Pause auto-expires after 7 days
     |
ClaraToken (UUPS + 48h timelock)
  - Fixed 100M supply, no mint
  - ERC-2612 permit support
  - No burn, no blocklist

MerkleDrop (IMMUTABLE)
  - Single Merkle root set in constructor
  - 6-month claim deadline
  - Sybil scoring via Gitcoin Passport
  - Simple 2-phase: 50% at launch, 50% at day 90
```

### Contracts: 4 Total

| Contract | Proxy | Timelock | Holds Funds |
|---|---|---|---|
| ClaraToken | UUPS | 48h | No (ERC-20 only) |
| ClaraStaking | UUPS | 7 days | Yes (CLARA deposits) |
| FeeDistributor | **None (immutable)** | N/A | Yes (USDC fees) |
| MerkleDrop | **None (immutable)** | N/A | Yes (airdrop CLARA) |

### Deployment Checklist (Security-Critical)

1. [ ] Deploy ClaraToken implementation with `_disableInitializers()`
2. [ ] Deploy ClaraToken proxy, initialize, verify implementation is locked
3. [ ] Deploy ClaraStaking implementation with `_disableInitializers()`
4. [ ] Deploy ClaraStaking proxy, initialize, verify implementation is locked
5. [ ] Deploy FeeDistributor (no proxy) — set ClaraStaking address, whitelist deposit sources
6. [ ] Deploy MerkleDrop (no proxy) — set Merkle root, claim deadline, CLARA token address
7. [ ] Deploy TimelockController — set 7-day delay, assign proposer = multisig, executor = multisig
8. [ ] Transfer ClaraToken proxy admin to timelock
9. [ ] Transfer ClaraStaking proxy admin to timelock
10. [ ] Set pause guardian on ClaraStaking
11. [ ] Seed ClaraStaking with small CLARA amount from treasury (prevents totalStaked=0)
12. [ ] Verify ALL implementation contracts revert on direct `initialize()` calls
13. [ ] Set up timelock monitoring (OpenZeppelin Defender / Tenderly)
14. [ ] Publish timelock event monitoring dashboard
15. [ ] Run full test suite including: zero-staker scenarios, precision tests with large numbers, reentrancy tests, flash-loan attack simulation

### Open Questions for the Team

1. **Can x402 facilitator pay FeeDistributor directly?** If yes, this eliminates C4 entirely. This is the single most impactful architectural decision.

2. **Is UUPS truly needed on ClaraToken?** If the ERC-20 is a standard fixed-supply token, what would you ever upgrade? Consider making it immutable too.

3. **What's the expected USDC volume per day?** This affects whether the precision loss (M1) is material or purely theoretical.

4. **What Gitcoin Passport score threshold for airdrop eligibility?** The higher the threshold, the stronger sybil resistance but the smaller the eligible population.

5. **Who are the 5 multisig signers?** This must be decided before deployment and should include at least 2 entities external to the core team.

---

## Appendix: Research Sources

- [OpenZeppelin UUPS Vulnerability Post-Mortem](https://forum.openzeppelin.com/t/uupsupgradeable-vulnerability-post-mortem/15680)
- [UUPS Vulnerability Disclosure (iosiro)](https://iosiro.com/blog/openzeppelin-uups-proxy-vulnerability-disclosure)
- [Synthetix StakingRewards Inefficient Distribution (0xMacro)](https://0xmacro.com/blog/synthetix-staking-rewards-issue-inefficient-reward-distribution/)
- [Beanstalk Governance Attack Analysis (Immunefi)](https://medium.com/immunefi/hack-analysis-beanstalk-governance-attack-april-2022-f42788fc821e)
- [Staking Algorithm of Synthetix and SushiSwap (RareSkills)](https://rareskills.io/post/staking-algorithm)
- [Precision Loss Vulnerability in Solidity (ImmuneBytes)](https://immunebytes.com/blog/precision-loss-vulnerability-in-solidity-a-deep-technical-dive/)
- [Unlimited ERC20 Allowances Considered Harmful](https://kalis.me/unlimited-erc20-allowances/)
- [Approval Vulnerabilities (Smart Contract Security Field Guide)](https://scsfg.io/hackers/approvals/)
- [Sybil Attacks in Crypto (Formo)](https://formo.so/blog/what-are-sybil-attacks-in-crypto-and-how-to-prevent-them)
- [Smart Contract Timelocks (OpenZeppelin)](https://www.openzeppelin.com/news/protect-your-users-with-smart-contract-timelocks)
- [Maturing Smart Contracts Beyond Private Key Risk (Trail of Bits)](https://blog.trailofbits.com/2025/06/25/maturing-your-smart-contracts-beyond-private-key-risk/)
- [Base Verify Demo (Sybil-resistant claims)](https://github.com/base/base-verify-demo)
- [yAcademy Proxy Security Guide](https://proxies.yacademy.dev/pages/Security-Guide)
- [Ultimate Guide to Reentrancy (Immunefi)](https://immunefi.com/blog/expert-insights/ultimate-guide-to-reentrancy/)
