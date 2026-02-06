# CLARA Token System: Final Testing Plan

> **Status:** Approved -- Single Source of Truth
> **Date:** 2026-02-05
> **Consolidated from:** QA draft (92 tests), Security review (+23), Solidity review (+54), UX review (+11)
> **Final test count:** 168 test cases

---

## Executive Summary

### Test Count by Category and Priority

| Category | P0 | P1 | P2 | P3 | Total |
|----------|----|----|----|----|-------|
| Smart Contract Unit | 14 | 14 | 4 | 0 | 32 |
| Smart Contract Integration | 5 | 5 | 2 | 0 | 12 |
| Smart Contract Security | 9 | 11 | 5 | 1 | 26 |
| Smart Contract Fuzz | 0 | 7 | 2 | 0 | 9 |
| Storage Layout & Gas | 7 | 7 | 0 | 0 | 14 |
| Deployment Script | 6 | 0 | 0 | 0 | 6 |
| Aerodrome Integration | 0 | 5 | 0 | 0 | 5 |
| Clara MCP Regression | 12 | 6 | 1 | 0 | 19 |
| Clara MCP New Features | 0 | 10 | 3 | 0 | 13 |
| End-to-End Scenarios | 2 | 2 | 3 | 1 | 8 |
| x402 Fee Flow | 1 | 5 | 1 | 0 | 7 |
| Free Tier | 1 | 5 | 1 | 0 | 7 |
| Error States | 0 | 2 | 0 | 0 | 2 |
| **Total** | **57** | **79** | **22** | **2** | **160** |

Note: 8 test cases from the QA draft were de-duplicated or subsumed by more comprehensive versions from specialist reviews, reducing the raw total from 180 to 168. Exact de-duplication notes appear inline.

### Blocking Issues (Must Resolve Before Testing Can Begin)

These are CODE CHANGES required before the test suite can be implemented. Tests cannot pass (or even compile) without these fixes.

| # | Issue | Affected Tests | Resolution |
|---|-------|---------------|------------|
| B1 | `deposit()` does NOT revert when `totalStaked == 0` -- code silently orphans USDC. Consolidated plan mandates revert. | TC-220, TC-502 | Add `require(totalStaked > 0, "No stakers")` to `deposit()`. Confirmed by both security and solidity engineers. |
| B2 | ClaraStaking has no `constructor() { _disableInitializers(); }` -- implementation contract can be taken over. | TC-262, TC-263, DS-005 | Add constructor with `_disableInitializers()`. Confirmed by solidity engineer. |
| B3 | ClaraStaking has no `uint256[50] private __gap` -- upgrades risk storage collision. | TC-264, SL-007 | Add `__gap` after all state variables. Confirmed by solidity engineer. |
| B4 | `recoverERC20()` allows draining reward USDC beyond what's owed to stakers. | TC-265 | Add `require(tokenAddr != address(usdc), "Cannot recover reward token")` (simplest fix). Or add surplus check. |
| B5 | Pausable functionality not implemented -- security review mandates Pausable with guardian + 7-day auto-unpause. | TC-270 through TC-273 | Implement `PausableUpgradeable` with guardian role. |

### Discrepancies Found and Resolutions

| # | Discrepancy | Resolution |
|---|-------------|------------|
| D1 | deposit() revert behavior: Code (Section 2) silently orphans USDC vs. Consolidated plan says revert | **Revert wins.** Both security and solidity engineers confirm Option A. Code must be updated (B1). |
| D2 | Timelock duration: Architecture doc says 48h (Section 7) vs. Testing plan says 7 days | **7 days wins.** Security review overrides -- stakers need 7 days to exit after bad upgrade proposal. |
| D3 | ClaraToken: Code shows UUPS upgradeable vs. Refined plan (Section 15) says immutable | **Immutable wins.** Solidity engineer confirms. Deploy without proxy. Use non-upgradeable OZ imports. |
| D4 | recoverERC20 USDC protection: Current code allows full USDC recovery vs. Security review says guard it | **Block USDC recovery entirely** (simplest, safest). See B4. |
| D5 | TC-221 (orphaned USDC): Tests orphan path vs. Revert path | **TC-221 becomes N/A.** With the revert fix (D1), orphaned USDC is impossible. Removed from final plan. |
| D6 | Free tier counter: wallet_setup messaging conflicts with ClaraCredits model | **Free tier replaces ClaraCredits onboarding copy.** Per UX designer recommendation (Option A). |
| D7 | wallet_status CLARA additions: UX appendix hints at claimable rewards | **Phase 2 -- not in initial release.** wallet_status remains unchanged per BL-003 baseline. |

---

## Architecture References

| Document | Path |
|----------|------|
| Consolidated plan | `docs/CLARA-TOKEN-PLAN.md` |
| Security review | `docs/security-review.md` |
| Solidity architecture | `docs/solidity-architecture.md` |
| UX design | `docs/ux-design.md` |

## Test Infrastructure

### Smart Contracts (Foundry)

```
contracts/
  src/
    ClaraToken.sol          # Immutable ERC-20 + ERC-2612 permit
    ClaraStaking.sol        # UUPS + Pausable + ReentrancyGuard
    MerkleDrop.sol          # Immutable Merkle distributor
  test/
    Base.t.sol              # Shared setUp (ClaraTestBase)
    AerodromeBase.t.sol     # Fork test base
    ClaraToken.t.sol        # TC-001 through TC-008
    ClaraStaking.t.sol      # TC-010 through TC-030 + math tests
    ClaraStakingMath.t.sol  # Synthetix math numeric examples
    MerkleDrop.t.sol        # TC-040 through TC-048
    Integration.t.sol       # TC-100 through TC-106
    Aerodrome.t.sol         # AE-001 through AE-005 (fork tests)
    Upgrade.t.sol           # TC-120 through TC-123
    Security.t.sol          # TC-200 through TC-284
    StorageLayout.t.sol     # SL-001 through SL-007
    GasBenchmark.t.sol      # GB-001 through GB-007
    Deploy.t.sol            # DS-001 through DS-006
  script/
    DeployCLARA.s.sol
  foundry.toml
```

**foundry.toml:**

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.20"
optimizer = true
optimizer_runs = 200
via_ir = false

[profile.default.fuzz]
runs = 10000
max_test_rejects = 100000
seed = "0xBEEF"

[profile.ci.fuzz]
runs = 50000

[rpc_endpoints]
base = "${BASE_RPC_URL}"

[etherscan]
base = { key = "${BASESCAN_API_KEY}" }
```

### Clara MCP (Vitest)

Existing test files in `src/__tests__/` plus new test files for CLARA integration. All MCP tests mock the Para/provider layer.

### Base Test Contract (Foundry)

```solidity
// test/Base.t.sol
abstract contract ClaraTestBase is Test {
    ClaraToken public token;
    ClaraStaking public stakingImpl;
    ClaraStaking public staking;
    ERC1967Proxy public stakingProxy;
    MockERC20 public usdc; // 6 decimals

    address public treasury = makeAddr("treasury");
    address public feeSource = makeAddr("feeSource");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public charlie = makeAddr("charlie");
    address public attacker = makeAddr("attacker");

    uint256 public constant INITIAL_SUPPLY = 100_000_000e18;

    function setUp() public virtual {
        token = new ClaraToken(treasury);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        stakingImpl = new ClaraStaking();
        stakingProxy = new ERC1967Proxy(
            address(stakingImpl),
            abi.encodeCall(ClaraStaking.initialize, (
                address(token), address(usdc), feeSource
            ))
        );
        staking = ClaraStaking(address(stakingProxy));

        vm.startPrank(treasury);
        token.transfer(alice, 10_000e18);
        token.transfer(bob, 10_000e18);
        token.transfer(charlie, 10_000e18);
        vm.stopPrank();

        usdc.mint(feeSource, 1_000_000e6);

        vm.prank(alice);
        token.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        token.approve(address(staking), type(uint256).max);
        vm.prank(charlie);
        token.approve(address(staking), type(uint256).max);
        vm.prank(feeSource);
        usdc.approve(address(staking), type(uint256).max);
    }
}
```

### Fork Test Base (Aerodrome)

```solidity
abstract contract AerodromeForkTest is Test {
    uint256 public baseFork;
    address constant AERODROME_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant AERODROME_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    address constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    ClaraToken public token;
    address public treasury = makeAddr("treasury");

    function setUp() public virtual {
        baseFork = vm.createFork(vm.envString("BASE_RPC_URL"));
        vm.selectFork(baseFork);
        token = new ClaraToken(treasury);
        deal(USDC_BASE, treasury, 200_000e6);
    }
}
```

---

## Threat-to-Test Coverage Matrix

Every threat from `security-review.md` is mapped to at least one test case.

### CRITICAL Threats

| Threat | ID | Test Coverage | Status |
|--------|----|--------------|--------|
| UUPS upgrade to drain staked funds | C1 | TC-120, TC-121, TC-122, TC-123, TC-261, TC-264 | COVERED |
| Uninitialized UUPS implementation | C2 | TC-123, TC-262, TC-263, DS-005 | COVERED |
| Flash-loan staking attack | C3 | TC-200, TC-201 | COVERED (accepted risk) |
| Proxy wallet USDC custody risk | C4 | TC-500, TC-501, TC-502 | COVERED (architectural mitigation) |

### HIGH Threats

| Threat | ID | Test Coverage | Status |
|--------|----|--------------|--------|
| Infinite approval + malicious upgrade | H1 | TC-260, TC-261 | COVERED |
| Unmonitored timelock | H2 | TC-122, TC-274, TC-275 | COVERED |
| Division by zero when totalStaked == 0 | H3 | TC-220, TC-222 | COVERED (code fix B1 required) |

### MEDIUM Threats

| Threat | ID | Test Coverage | Status |
|--------|----|--------------|--------|
| Rounding / precision loss | M1 | TC-230, TC-231, TC-233, FZ-004 | COVERED |
| Reentrancy in claim() | M2 | TC-210, TC-211, TC-212 | COVERED |
| Sybil attacks on airdrop | M3 | TC-041, TC-042, TC-043 (Merkle proof structure prevents multi-claim) | COVERED |
| Pause function abuse | M4 | TC-270, TC-271, TC-272, TC-273 | COVERED (code fix B5 required) |
| Yield sniping (no flash loan) | M5 | TC-201 | COVERED (accepted risk) |

### LOW Threats

| Threat | ID | Test Coverage | Status |
|--------|----|--------------|--------|
| Token decimals mismatch | L1 | TC-008, TC-230, TC-231 | COVERED |
| First depositor inflation attack | L2 | N/A -- Synthetix pattern immune | N/A |
| Griefing via dust deposits | L3 | TC-284 | COVERED |
| Merkle root update mechanism | L4 | TC-276 | COVERED |

### Accepted Risks (Documented by Tests)

| Risk | Test | Outcome |
|------|------|---------|
| Flash-loan staking dilution | TC-200 | Attack succeeds; Base FIFO is sole mitigation |
| Yield sniping without flash loan | TC-201 | Attack succeeds; less profitable than flash loan |
| Malicious upgrade can drain contract | TC-261 | 7-day timelock is sole mitigation |
| Rounding dust accumulation | TC-233, FZ-004 | Dust is bounded and immaterial |

---

## Regression Baselines (UX Designer)

These are the EXACT output formats of current tool implementations. Any test asserting "output unchanged" validates against these baselines. Full baseline definitions are in the Appendix.

| ID | Tool | Key Assertion |
|----|------|--------------|
| BL-001 | wallet_setup (email, new) | First line "Wallet created!", mentions $0.001/op, recommends wallet_briefing. NO CLARA mention. |
| BL-002 | wallet_setup (no email) | Machine-specific warning. Otherwise identical to BL-001. |
| BL-003 | wallet_status (authenticated) | Shows address/email/chain/credits. NO CLARA staking info. |
| BL-004 | wallet_status (not authenticated) | "No wallet configured" with setup instructions. |
| BL-005 | wallet_dashboard (with balances) | Sections: Account, Portfolio, Spending Limits, Recent Payments, Actions. NO CLARA Staking section. |
| BL-006 | wallet_dashboard (empty) | "No balances found on any chain." |
| BL-007 | wallet_send (success) | "Transaction sent!" with amount/to/chain/tx link. NO fee line, NO counter. |
| BL-008 | wallet_send (invalid address) | "Invalid recipient address." |
| BL-009 | wallet_send (spending limit) | "Send blocked by spending limits" with remediation. |
| BL-010 | wallet_swap (quote) | Quote details with rate/impact/gas/quoteId. NO CLARA mention. |
| BL-011 | wallet_swap (execute) | "Swap Submitted!" with tx link. |
| BL-012 | wallet_opportunities (results) | Lending table + Protocol Actions. NO CLARA Staking section. |
| BL-013 | wallet_opportunities (no results) | "No opportunities found." |
| BL-014 | wallet_logout | "Logged out" with setup instructions. |

---

## 1. Smart Contract Unit Tests (Foundry)

### 1.1 ClaraToken

```
TC-001: ClaraToken deploys with correct name and symbol
Category: unit | Priority: P0 | File: ClaraToken.t.sol
Preconditions: Foundry environment configured
Steps:
  1. Deploy ClaraToken(treasury)
  2. Call name() -> "Clara"
  3. Call symbol() -> "CLARA"
  4. Call decimals() -> 18
Expected: name()="Clara", symbol()="CLARA", decimals()=18
Notes: ClaraToken is immutable (no proxy). Uses constructor, not initialize().
```

```
TC-002: ClaraToken mints exactly 100M to treasury at construction
Category: unit | Priority: P0 | File: ClaraToken.t.sol
Preconditions: None
Steps:
  1. Deploy ClaraToken(treasury)
  2. totalSupply() == 100_000_000e18
  3. balanceOf(treasury) == 100_000_000e18
Expected: Full supply minted to treasury in constructor
```

```
TC-003: ClaraToken has no mint function
Category: unit | Priority: P0 | File: ClaraToken.t.sol
Preconditions: ClaraToken deployed
Steps:
  1. Verify no public/external mint function exists (compile-time interface check)
  2. Verify totalSupply is immutable after construction
Expected: No minting capability. Fixed supply is a core security property.
```

```
TC-004: ClaraToken standard ERC-20 transfer works
Category: unit | Priority: P0 | File: ClaraToken.t.sol
Steps:
  1. Treasury approves spender for 1000e18
  2. Spender calls transferFrom(treasury, recipient, 1000e18)
  3. balanceOf(recipient) == 1000e18
  4. balanceOf(treasury) == 100M - 1000e18
Expected: Standard ERC-20 transfer succeeds
```

```
TC-005: ClaraToken ERC-2612 permit sets allowance
Category: unit | Priority: P1 | File: ClaraToken.t.sol
Steps:
  1. Generate permit signature for (owner, spender, value, deadline, nonce)
  2. Call permit(owner, spender, value, deadline, v, r, s)
  3. allowance(owner, spender) == value
Expected: Allowance set without on-chain approve transaction
Notes: Enables gasless staking via stakeWithPermit()
```

```
TC-006: ClaraToken permit rejects expired deadline
Category: unit | Priority: P1 | File: ClaraToken.t.sol
Steps:
  1. Generate permit with deadline in the past
  2. Call permit()
Expected: Reverts with ERC2612ExpiredSignature
```

```
TC-007: ClaraToken permit rejects invalid signature
Category: unit | Priority: P1 | File: ClaraToken.t.sol
Steps:
  1. Generate permit signature from wrong signer
  2. Call permit()
Expected: Reverts with ERC2612InvalidSigner
```

```
TC-008: ClaraToken has 18 decimals
Category: unit | Priority: P1 | File: ClaraToken.t.sol
Steps:
  1. Call decimals()
Expected: Returns 18
Notes: Critical for reward math -- CLARA(18) vs USDC(6) precision
```

### 1.2 ClaraStaking

```
TC-010: ClaraStaking initializes with correct parameters
Category: unit | Priority: P0 | File: ClaraStaking.t.sol
Steps:
  1. Deploy ClaraStaking proxy with initialize(claraToken, usdc, feeSource)
  2. claraToken() == deployed token address
  3. usdc() == deployed USDC address
  4. feeSource() == configured fee source
  5. totalStaked() == 0
  6. rewardPerTokenStored() == 0
  7. owner() == deployer
Expected: All initialization values correct
```

```
TC-011: ClaraStaking stake() works with approved CLARA
Category: unit | Priority: P0 | File: ClaraStaking.t.sol
Steps:
  1. Alice calls stake(1000e18) [already approved in setUp]
  2. stakedBalance(alice) == 1000e18
  3. totalStaked == 1000e18
  4. token.balanceOf(staking) == 1000e18
Expected: Stake succeeds, all balances correct, Staked event emitted
```

```
TC-012: ClaraStaking stake() reverts on zero amount
Category: unit | Priority: P1 | File: ClaraStaking.t.sol
Steps:
  1. Alice calls stake(0)
Expected: Reverts with "Cannot stake 0"
```

```
TC-013: ClaraStaking stake() reverts without approval
Category: unit | Priority: P1 | File: ClaraStaking.t.sol
Steps:
  1. Attacker (no approval) calls stake(1000e18)
Expected: Reverts (SafeERC20 transferFrom failure)
```

```
TC-014: ClaraStaking unstake() returns CLARA to user
Category: unit | Priority: P0 | File: ClaraStaking.t.sol
Steps:
  1. Alice stakes 1000e18, then unstakes 500e18
  2. stakedBalance(alice) == 500e18
  3. totalStaked decreased by 500e18
  4. Alice's CLARA balance increased by 500e18
Expected: Unstake succeeds, Unstaked event emitted
```

```
TC-015: ClaraStaking unstake() reverts on insufficient staked balance
Category: unit | Priority: P1 | File: ClaraStaking.t.sol
Steps:
  1. Alice stakes 1000e18, then unstakes 2000e18
Expected: Reverts with "Insufficient staked balance"
```

```
TC-016: ClaraStaking unstake() reverts on zero amount
Category: unit | Priority: P1 | File: ClaraStaking.t.sol
Steps:
  1. Alice calls unstake(0)
Expected: Reverts with "Cannot unstake 0"
```

```
TC-017: ClaraStaking claim() sends USDC to staker
Category: unit | Priority: P0 | File: ClaraStaking.t.sol
Steps:
  1. Alice stakes 1000e18
  2. FeeSource deposits 100e6 (100 USDC)
  3. Alice calls claim()
  4. Alice USDC balance increased by 100e6
  5. earned(alice) == 0
Expected: USDC transferred, RewardsClaimed event emitted
Notes: Core "aha moment" -- users see USDC arriving
```

```
TC-018: ClaraStaking claim() with no rewards is a no-op
Category: unit | Priority: P2 | File: ClaraStaking.t.sol
Steps:
  1. Alice stakes, no deposits have occurred
  2. Alice calls claim()
Expected: No USDC transferred, no revert. Graceful no-op.
```

```
TC-019: ClaraStaking exit() unstakes all and claims all
Category: unit | Priority: P0 | File: ClaraStaking.t.sol
Steps:
  1. Alice stakes 1000e18, 10 USDC deposited
  2. Alice calls exit()
  3. stakedBalance(alice) == 0
  4. Alice received 1000 CLARA + 10 USDC
Expected: Both unstake and claim succeed in single tx
```

```
TC-020: ClaraStaking deposit() updates rewardPerTokenStored correctly
Category: unit | Priority: P0 | File: ClaraStaking.t.sol
Numeric Example (from solidity engineer):
  Setup: 1000 CLARA staked
  Deposit 100 USDC (100e6):
    rPTS += (100e6 * 1e18) / 1000e18 = 100_000
  Deposit 200 USDC (200e6):
    rPTS += (200e6 * 1e18) / 1000e18 = 200_000
    rPTS total = 300_000
Steps:
  1. Alice stakes 1000e18
  2. FeeSource deposits 100e6 -> assertEq(rPTS, 100_000)
  3. FeeSource deposits 200e6 -> assertEq(rPTS, 300_000)
Expected: rewardPerTokenStored increases monotonically with correct math
```

```
TC-021: ClaraStaking deposit() restricted to feeSource only
Category: unit | Priority: P0 | File: ClaraStaking.t.sol
Steps:
  1. Attacker (not feeSource) calls deposit(100e6)
Expected: Reverts with "Only fee source"
```

```
TC-022: ClaraStaking deposit() reverts on zero amount
Category: unit | Priority: P2 | File: ClaraStaking.t.sol
Steps:
  1. FeeSource calls deposit(0)
Expected: Reverts with "Cannot deposit 0"
```

```
TC-023: ClaraStaking earned() returns correct proportional reward
Category: unit | Priority: P0 | File: ClaraStaking.t.sol
Numeric Example:
  Alice stakes 500e18 out of 1000e18 total, 100 USDC deposited
  earned(alice) = 500e18 * (rPTS - 0) / 1e18 = 50e6 (50 USDC = 50%)
Steps:
  1. Alice stakes 500e18, Bob stakes 500e18
  2. FeeSource deposits 100e6
  3. assertEq(earned(alice), 50e6)
  4. assertEq(earned(bob), 50e6)
Expected: Proportional share returned
```

```
TC-024: ClaraStaking getClaimable() aliases earned()
Category: unit | Priority: P2 | File: ClaraStaking.t.sol
Steps:
  1. Same preconditions as TC-023
  2. getClaimable(alice) == earned(alice)
Expected: Both return identical values
Notes: Herd-legible alias
```

```
TC-025: ClaraStaking stakeWithPermit() combines approve and stake
Category: unit | Priority: P1 | File: ClaraStaking.t.sol
Steps:
  1. Alice signs ERC-2612 permit for staking contract
  2. Alice calls stakeWithPermit(1000e18, deadline, v, r, s)
  3. stakedBalance(alice) == 1000e18
  4. token.balanceOf(staking) == 1000e18
Expected: Stake succeeds without separate approve() tx
```

```
TC-025a: stakeWithPermit() expired deadline reverts
Category: unit | Priority: P1 | File: ClaraStaking.t.sol
Steps:
  1. Sign permit with deadline in the past
  2. Call stakeWithPermit()
Expected: Reverts (ERC2612ExpiredSignature)
```

```
TC-025b: stakeWithPermit() wrong signer reverts
Category: unit | Priority: P1 | File: ClaraStaking.t.sol
Steps:
  1. Bob signs permit, Alice calls stakeWithPermit()
Expected: Reverts (ERC2612InvalidSigner)
```

```
TC-025c: stakeWithPermit() zero amount reverts
Category: unit | Priority: P1 | File: ClaraStaking.t.sol
Steps:
  1. Sign permit for 0, call stakeWithPermit(0, ...)
Expected: Reverts with "Cannot stake 0"
```

```
TC-026: ClaraStaking setFeeSource() updates authorized depositor
Category: unit | Priority: P1 | File: ClaraStaking.t.sol
Steps:
  1. Owner calls setFeeSource(newAddress)
  2. feeSource() == newAddress
  3. Old feeSource deposit() reverts
  4. New feeSource deposit() succeeds
Expected: FeeSource updated, FeeSourceUpdated event emitted
```

```
TC-027: ClaraStaking setFeeSource() rejected from non-owner
Category: unit | Priority: P1 | File: ClaraStaking.t.sol
Steps:
  1. Attacker calls setFeeSource(attacker)
Expected: Reverts with OwnableUnauthorizedAccount
```

```
TC-028: ClaraStaking recoverERC20() recovers accidental tokens
Category: unit | Priority: P2 | File: ClaraStaking.t.sol
Steps:
  1. Send 100 DAI to staking address
  2. Owner calls recoverERC20(DAI, 100e18)
  3. Owner received 100 DAI
Expected: Recovery succeeds for non-CLARA, non-USDC tokens
```

```
TC-029: ClaraStaking recoverERC20() cannot recover staked CLARA
Category: unit | Priority: P0 | File: ClaraStaking.t.sol
Steps:
  1. Users have staked CLARA
  2. Owner calls recoverERC20(CLARA, 100e18)
Expected: Reverts with "Cannot recover staked token"
```

```
TC-030: ClaraStaking events emitted correctly
Category: unit | Priority: P2 | File: ClaraStaking.t.sol
Steps:
  1. stake() -> Staked event
  2. unstake() -> Unstaked event
  3. claim() -> RewardsClaimed event
  4. deposit() -> FeesDeposited event
  5. setFeeSource() -> FeeSourceUpdated event
Expected: All events emitted with correct parameters
Notes: Required for Herd classification and monitoring
```

### 1.3 MerkleDrop

MerkleDrop interface confirmed by solidity engineer (immutable, bitmap claims, deadline + sweep):

```solidity
contract MerkleDrop {
    IERC20 public immutable token;
    bytes32 public immutable merkleRoot;
    uint256 public immutable deadline;
    mapping(uint256 => uint256) private claimedBitMap;

    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata proof) external;
    function isClaimed(uint256 index) public view returns (bool);
    function sweep(address treasury) external; // only after deadline
}
```

```
TC-040: MerkleDrop deploys with correct root and deadline
Category: unit | Priority: P0 | File: MerkleDrop.t.sol
Steps:
  1. Deploy MerkleDrop(token, root, deadline)
  2. token() == token address
  3. merkleRoot() == root
  4. deadline() == deadline
Expected: All immutable values set in constructor
```

```
TC-041: MerkleDrop claim succeeds with valid proof
Category: unit | Priority: P0 | File: MerkleDrop.t.sol
Steps:
  1. Generate Merkle tree with known leaves
  2. Generate proof for (index=0, alice, 500e18)
  3. Alice calls claim(0, alice, 500e18, proof)
  4. Alice received 500 CLARA
Expected: Claim succeeds, Claimed event emitted
```

```
TC-042: MerkleDrop prevents double-claim
Category: unit | Priority: P0 | File: MerkleDrop.t.sol
Steps:
  1. Alice claims successfully
  2. Alice calls claim() again with same params
Expected: Reverts with "Already claimed"
Notes: Bitmap-based tracking
```

```
TC-043: MerkleDrop rejects invalid proof
Category: unit | Priority: P0 | File: MerkleDrop.t.sol
Steps:
  1. Generate proof for Alice
  2. Bob calls claim() with Alice's proof but Bob's address
Expected: Reverts (proof verification fails)
```

```
TC-044: MerkleDrop rejects claim after deadline
Category: unit | Priority: P1 | File: MerkleDrop.t.sol
Steps:
  1. vm.warp(deadline + 1)
  2. Eligible user calls claim()
Expected: Reverts with "Claim deadline passed"
```

```
TC-045: MerkleDrop claim works at exactly deadline
Category: unit | Priority: P2 | File: MerkleDrop.t.sol
Steps:
  1. vm.warp(deadline)
  2. Eligible user calls claim()
Expected: Succeeds (require uses <=)
Notes: Boundary condition -- at deadline is allowed, after is not
```

```
TC-046: MerkleDrop rejects claim with wrong amount
Category: unit | Priority: P1 | File: MerkleDrop.t.sol
Steps:
  1. User eligible for 500 CLARA calls claim with amount=1000
Expected: Reverts (proof mismatch -- amount is part of leaf)
```

```
TC-047: MerkleDrop sweep recovers unclaimed tokens after deadline
Category: unit | Priority: P1 | File: MerkleDrop.t.sol
Steps:
  1. Deploy MerkleDrop with 1M CLARA, deadline = now + 30 days
  2. Some users claim 600K CLARA
  3. vm.warp(deadline + 1)
  4. Anyone calls sweep(treasury)
  5. Treasury receives remaining 400K CLARA
Expected: Unclaimed tokens returned to treasury post-deadline
```

```
TC-048: MerkleDrop sweep fails before deadline
Category: unit | Priority: P1 | File: MerkleDrop.t.sol
Steps:
  1. Call sweep(treasury) before deadline
Expected: Reverts with "Deadline not passed"
Notes: Prevents admin from pulling tokens early
```

```
TC-049: MerkleDrop bitmap works across word boundaries
Category: unit | Priority: P1 | File: MerkleDrop.t.sol
Steps:
  1. Claim index 255 (word 0, bit 255)
  2. Assert isClaimed(255) == true, isClaimed(256) == false
  3. Claim index 256 (word 1, bit 0)
  4. Assert both 255 and 256 claimed, 257 not claimed
Expected: Bitmap correctly handles word boundary crossings
```

---

## 2. Smart Contract Integration Tests (Foundry)

### 2.1 Full Lifecycle

```
TC-100: Full lifecycle -- deploy, stake, deposit, claim, unstake
Category: integration | Priority: P0 | File: Integration.t.sol
Numeric Example:
  Alice stakes 10_000e18 (sole staker)
  FeeSource deposits 100e6
  earned(alice) = 10_000e18 * (100e6 * 1e18 / 10_000e18) / 1e18 = 100e6
Steps:
  1. Deploy ClaraToken, ClaraStaking
  2. Treasury transfers 10_000 CLARA to Alice
  3. Alice approves and stakes 10_000e18
  4. FeeSource deposits 100e6
  5. assertEq(earned(alice), 100e6)
  6. Alice claims -> receives 100 USDC
  7. Alice unstakes -> receives 10_000 CLARA
  8. Verify all balances correct
Expected: Complete lifecycle end-to-end
```

```
TC-101: Multiple deposits accumulate correctly
Category: integration | Priority: P0 | File: Integration.t.sol
Numeric Example:
  Alice stakes 1000e18. Deposits: 10, 20, 30 USDC.
  rPTS = 10_000 + 20_000 + 30_000 = 60_000
  earned(alice) = 1000e18 * 60_000 / 1e18 = 60e6 (60 USDC)
Steps:
  1. Alice stakes 1000e18
  2. FeeSource deposits 10e6 -> rPTS = 10_000
  3. FeeSource deposits 20e6 -> rPTS = 30_000
  4. FeeSource deposits 30e6 -> rPTS = 60_000
  5. assertEq(earned(alice), 60e6)
Expected: Multiple deposits accumulate without loss
```

```
TC-102: Multi-user proportional distribution (3 stakers)
Category: integration | Priority: P0 | File: Integration.t.sol
Numeric Example:
  Alice=500, Bob=300, Charlie=200 (total=1000). Deposit 100 USDC.
  rPTS = 100e6 * 1e18 / 1000e18 = 100_000
  earned(alice) = 500e18 * 100_000 / 1e18 = 50e6 (50%)
  earned(bob) = 300e18 * 100_000 / 1e18 = 30e6 (30%)
  earned(charlie) = 200e18 * 100_000 / 1e18 = 20e6 (20%)
  Total = 100 USDC (exact, no dust)
Steps:
  1. Stake: Alice=500e18, Bob=300e18, Charlie=200e18
  2. FeeSource deposits 100e6
  3. assertEq(earned(alice), 50e6)
  4. assertEq(earned(bob), 30e6)
  5. assertEq(earned(charlie), 20e6)
Expected: Rewards split proportionally to stake
```

```
TC-103: Late joiner gets no prior rewards
Category: integration | Priority: P1 | File: Integration.t.sol
Numeric Example:
  Alice stakes 1000. Deposit 100 USDC. Bob stakes 1000. Deposit 100 USDC.
  rPTS after D1: 100_000. Bob's userRewardPerTokenPaid set to 100_000.
  rPTS after D2: 150_000. earned(alice) = 1000e18*(150_000-0)/1e18 = 150e6
  earned(bob) = 1000e18*(150_000-100_000)/1e18 = 50e6. Total = 200 USDC.
Steps:
  1. Alice stakes 1000e18
  2. FeeSource deposits 100e6
  3. Bob stakes 1000e18
  4. FeeSource deposits 100e6
  5. assertEq(earned(alice), 150e6)
  6. assertEq(earned(bob), 50e6)
Expected: Bob earns nothing from deposits before he joined
```

```
TC-104: Staker exits mid-stream -- claimable frozen
Category: integration | Priority: P1 | File: Integration.t.sol
Numeric Example:
  Alice and Bob each stake 500. Deposit 100. Alice unstakes. Deposit 100.
  After D1: rPTS=100_000. Alice and Bob each earned 50.
  Alice unstakes: rewards[alice]=50e6, stakedBalance[alice]=0.
  After D2: rPTS=300_000. earned(alice)=0*(300_000-100_000)/1e18+50e6=50e6
  earned(bob)=500e18*(300_000-0)/1e18=150e6. Total=200.
Steps:
  1. Both stake 500e18
  2. FeeSource deposits 100e6
  3. Alice unstakes all 500e18
  4. FeeSource deposits 100e6
  5. assertEq(earned(alice), 50e6) // frozen
  6. assertEq(earned(bob), 150e6) // 50 + 100
Expected: Exited staker's rewards freeze
```

```
TC-105: Partial unstake preserves proportional rewards
Category: integration | Priority: P1 | File: Integration.t.sol
Steps:
  1. Alice stakes 1000e18 (sole staker)
  2. FeeSource deposits 50e6
  3. Alice unstakes 500e18 (now 500 staked)
  4. Bob stakes 500e18 (now 50/50)
  5. FeeSource deposits 100e6
  6. assertEq(earned(alice), 100e6) // 50 + 50
  7. assertEq(earned(bob), 50e6)
Expected: Partial unstake adjusts share correctly
```

```
TC-106: Claim does not affect staked balance
Category: integration | Priority: P1 | File: Integration.t.sol
Numeric Example:
  Alice stakes 1000. Deposit 100. Alice claims. Deposit 100.
  After claim: stakedBalance[alice]=1000e18, rewards[alice]=0,
    userRewardPerTokenPaid[alice]=100_000.
  After D2: rPTS=200_000. earned(alice)=1000e18*(200_000-100_000)/1e18=100e6
Steps:
  1. Alice stakes 1000e18
  2. FeeSource deposits 100e6
  3. Alice claims -> receives 100 USDC
  4. assertEq(stakedBalance(alice), 1000e18) // unchanged
  5. FeeSource deposits 100e6
  6. assertEq(earned(alice), 100e6) // earns again
Expected: Claiming is non-destructive -- user continues earning
```

### 2.2 UUPS Upgrade

```
TC-120: ClaraStaking UUPS upgrade preserves ALL storage
Category: integration | Priority: P0 | File: Upgrade.t.sol
Steps:
  1. Alice stakes 1000e18, Bob stakes 500e18, FeeSource deposits 100e6, Alice claims
  2. Snapshot: totalStaked, rPTS, stakedBalance(A/B), earned(A/B),
     userRewardPerTokenPaid(A/B), feeSource, claraToken, usdc
  3. Deploy V2 implementation, owner calls upgradeToAndCall(v2, "")
  4. Verify ALL snapshotted values unchanged
  5. Verify V2 new function is callable (e.g., version() returns 2)
Expected: Zero storage corruption on upgrade
Notes: Enhanced per security engineer -- now checks all mapping values too
```

```
TC-121: ClaraStaking upgrade rejected without timelock
Category: integration | Priority: P0 | File: Upgrade.t.sol
Steps:
  1. Ownership transferred to timelock
  2. Attacker directly calls upgradeToAndCall(maliciousImpl, "")
Expected: Reverts (only owner/timelock can authorize)
```

```
TC-122: TimelockController enforces 7-day delay
Category: integration | Priority: P0 | File: Upgrade.t.sol
Steps:
  1. Proposer schedules upgrade
  2. Immediately try execute -> reverts (too early)
  3. vm.warp(6 days) -> try execute -> reverts
  4. vm.warp(7 days) -> execute succeeds
Expected: 7-day delay (604800 seconds) strictly enforced
Notes: Resolution D2 -- 7 days wins over 48h
```

```
TC-123: Implementation contract cannot be initialized
Category: integration | Priority: P0 | File: Upgrade.t.sol
Steps:
  1. Deploy ClaraStaking implementation directly
  2. Call initialize() on implementation
Expected: Reverts (InvalidInitialization or already initialized)
Notes: Depends on B2 fix (_disableInitializers in constructor)
```

---

## 3. Smart Contract Security Tests (Foundry)

### 3.1 Flash Loan & Yield Sniping

```
TC-200: Flash-loan staking attack simulation
Category: security | Priority: P1 | File: Security.t.sol
Concrete Parameters:
  Existing stake: 1,000,000 CLARA
  Deposit: 1,000 USDC
  Flash loan: 9,000,000 CLARA
  Expected attacker profit: ~900 USDC (minus gas + flash loan fee)
  Expected legitimate staker loss: ~900 USDC (receives ~100 instead of ~1000)
Steps:
  1. Legitimate staker has 1M CLARA staked
  2. Attacker borrows 9M CLARA via flash loan
  3. Attacker stakes 9M (now 90% of pool)
  4. FeeSource deposits 1000 USDC
  5. Attacker claims ~900 USDC
  6. Attacker unstakes and repays
  7. Document exact profit and dilution ratio
Expected: Attack succeeds -- ACCEPTED RISK (Base FIFO is primary mitigation)
```

```
TC-201: Yield sniping without flash loan
Category: security | Priority: P2 | File: Security.t.sol
Steps:
  1. Legitimate staker has 1000 CLARA staked long-term
  2. Attacker buys 9000 CLARA on market
  3. Attacker stakes, deposit occurs, attacker claims, unstakes, sells
  4. Document profitability threshold (must account for market slippage)
Expected: Attack succeeds but less profitable -- ACCEPTED RISK
```

### 3.2 Reentrancy

```
TC-210: Reentrancy attack on claim()
Category: security | Priority: P0 | File: Security.t.sol
Steps:
  1. Deploy malicious contract that calls claim() from receive/fallback
  2. Stake CLARA via malicious contract, deposit USDC
  3. Malicious contract calls claim()
Expected: Reentrant call reverts (ReentrancyGuard)
```

```
TC-211: Reentrancy attack on exit()
Category: security | Priority: P1 | File: Security.t.sol
Steps:
  1. Deploy malicious contract with reentrant exit() in receive
  2. Stake, earn, call exit()
Expected: Reentrant call reverts
```

```
TC-212: Reentrancy attack on unstake()
Category: security | Priority: P1 | File: Security.t.sol
Steps:
  1. Deploy malicious contract with reentrant unstake() in token callback
  2. Stake, call unstake()
Expected: Reentrant call reverts
```

### 3.3 Zero-Staker Edge Cases

```
TC-220: deposit() reverts when totalStaked == 0
Category: security | Priority: P0 | File: Security.t.sol
Preconditions: ClaraStaking deployed, no stakers
Steps:
  1. FeeSource calls deposit(100e6)
Expected: Reverts with "No stakers"
Notes: Requires code fix B1. Both security and solidity engineers confirm.
```

[TC-221 REMOVED -- Subsumed by TC-220 revert fix. Orphaned USDC path is impossible after B1.]

```
TC-222: Deposit works immediately after first staker
Category: security | Priority: P1 | File: Security.t.sol
Steps:
  1. Alice stakes 1000e18
  2. FeeSource deposits 100e6
  3. assertEq(earned(alice), 100e6)
Expected: Deposit succeeds and is fully distributable
```

### 3.4 Precision & Extreme Values

```
TC-230: Precision -- 1 wei USDC deposit with full supply staked
Category: security | Priority: P1 | File: Security.t.sol
Numeric Example:
  totalStaked = 100_000_000e18 = 1e26
  deposit(1):
    rPTS += 1 * 1e18 / 1e26 = 1e18 / 1e26 = 0 (integer truncation)
  Result: 1 USDC-wei orphaned. This is $0.000001. Acceptable dust.
Steps:
  1. Stake full supply (100M CLARA)
  2. FeeSource deposits 1 (1 wei USDC)
  3. assertEq(rPTS, previous rPTS) // no change
  4. assertEq(earned(treasury), 0)
Expected: Dust rounds to zero. Documented, not a bug.
```

```
TC-231: Precision -- large deposit with tiny stake
Category: security | Priority: P1 | File: Security.t.sol
Numeric Example:
  totalStaked = 1 (1 wei CLARA)
  deposit(1_000_000e6):
    rPTS += 1e12 * 1e18 / 1 = 1e30
  earned(sole staker) = 1 * 1e30 / 1e18 = 1e12 = 1_000_000e6 (correct)
Steps:
  1. Alice stakes 1 wei CLARA
  2. FeeSource deposits 1M USDC
  3. assertEq(rPTS, 1e30)
  4. assertEq(earned(alice), 1_000_000e6)
Expected: No overflow, correct calculation
```

```
TC-232: MAX_UINT256 staking amount (fuzz boundary)
Category: security | Priority: P2 | File: Security.t.sol
Steps:
  1. Mint type(uint256).max CLARA to user
  2. Attempt to stake type(uint256).max
Expected: Either succeeds or reverts gracefully (no silent overflow)
```

```
TC-233: Dust accumulation over 1000 small deposits
Category: security | Priority: P2 | File: Security.t.sol
Numeric Example:
  Alice=334, Bob=333, Charlie=333 CLARA (total=1000).
  Per deposit of 1 USDC: rPTS += 1e6*1e18/1000e18 = 1000
  After 1000 deposits: rPTS = 1_000_000
  earned(alice)=334e18*1_000_000/1e18=334e6, bob=333e6, charlie=333e6
  Total claimed=1000e6. Dust=0 (even division).
  For non-even (3 x 333e18, total=999e18):
    Per deposit: rPTS += 1e6*1e18/999e18 = 1001 (truncated)
    Dust after 1000 deposits: ~1000 wei USDC = $0.001
Steps:
  1. Three stakers with non-even splits
  2. 1000 deposits of 1 USDC each
  3. All claim. Check dust = totalDeposited - totalClaimed
  4. assertLe(dust, 1000) // < $0.001
  5. assertLe(totalClaimed, totalDeposited)
Expected: Conservation of value holds. Dust is bounded and immaterial.
```

### 3.5 Access Control

```
TC-240: Unauthorized deposit() rejected
Category: security | Priority: P0 | File: Security.t.sol
Steps:
  1. Random address calls deposit(100e6)
Expected: Reverts with "Only fee source"
```

```
TC-241: Unauthorized upgrade rejected
Category: security | Priority: P0 | File: Security.t.sol
Steps:
  1. Random address calls upgradeToAndCall()
Expected: Reverts (not owner)
```

```
TC-242: Unauthorized setFeeSource rejected
Category: security | Priority: P1 | File: Security.t.sol
Steps:
  1. Random address calls setFeeSource(attacker)
Expected: Reverts (not owner)
```

```
TC-243: Unauthorized recoverERC20 rejected
Category: security | Priority: P1 | File: Security.t.sol
Steps:
  1. Random address calls recoverERC20(USDC, amount)
Expected: Reverts (not owner)
```

### 3.6 Post-Upgrade Drain Simulation (Security Engineer)

```
TC-260: Malicious upgrade cannot drain user CLARA via existing approvals
Category: security | Priority: P0 | File: Security.t.sol
Steps:
  1. Alice stakes 1000 CLARA (approval consumed by transferFrom)
  2. Deploy MaliciousClaraStakingV2 with drain() that calls transferFrom(alice)
  3. Upgrade to V2 via timelock
  4. Call drain() targeting Alice
Expected: Reverts -- Alice's allowance is 0 (consumed by stake).
  If users used exact-amount approvals, drain fails.
  Test BOTH paths (exact-amount and infinite approval).
Notes: Documents H1 risk. Infinite approval path SUCCEEDS -- validates mandate for exact-amount approvals.
```

```
TC-261: Malicious upgrade can steal staked CLARA held by contract
Category: security | Priority: P0 | File: Security.t.sol
Steps:
  1. Alice stakes 1000, Bob stakes 2000
  2. Deploy MaliciousClaraStakingV2 with drain() that calls token.transfer(attacker, balance)
  3. Upgrade via timelock
  4. Call drain() -> SUCCEEDS
Expected: Drain succeeds -- ACCEPTED RISK. 7-day timelock is the ONLY mitigation.
Notes: This test DOCUMENTS the risk, not prevents it. Clear "accepted risk" label in output.
```

### 3.7 Constructor & Storage Verification (Security Engineer)

```
TC-262: ClaraStaking implementation has _disableInitializers()
Category: security | Priority: P0 | File: Security.t.sol
Steps:
  1. Deploy ClaraStaking implementation directly (not via proxy)
  2. Verify initialized flag is set to type(uint8).max
  3. Call initialize() -> reverts
Expected: All initialize calls revert
Notes: Requires code fix B2
```

```
TC-263: ClaraToken cannot be re-initialized
Category: security | Priority: P0 | File: Security.t.sol
Steps:
  1. ClaraToken deployed via constructor (immutable)
  2. No initialize() function exists (constructor-only)
  3. totalSupply() == 100M (set in constructor, cannot change)
Expected: No re-initialization possible
Notes: ClaraToken is immutable per D3
```

```
TC-264: ClaraStaking has __gap storage reservation
Category: security | Priority: P0 | File: Security.t.sol
Steps:
  1. Inspect source for uint256[50] private __gap
  2. Deploy V1, deploy V2 with new state variable after __gap
  3. Upgrade succeeds, existing storage not corrupted
  4. New variable accessible
Expected: Storage gap exists, upgrade-safe
Notes: Requires code fix B3. Run OZ Upgrades plugin storage layout check.
```

### 3.8 recoverERC20 USDC Safety (Security Engineer)

```
TC-265: recoverERC20() cannot recover reward USDC
Category: security | Priority: P0 | File: Security.t.sol
Steps:
  1. Alice stakes 1000e18
  2. FeeSource deposits 100 USDC
  3. Owner calls recoverERC20(USDC, 100e6)
Expected: Reverts with "Cannot recover reward token"
Notes: Requires code fix B4. Current code allows this -- fund safety issue.
```

### 3.9 Pausable Functionality (Security Engineer)

```
TC-270: Pause guardian can pause staking contract
Category: security | Priority: P1 | File: Security.t.sol
Steps:
  1. Guardian calls pause()
  2. paused() == true
  3. stake() -> reverts "EnforcedPause"
  4. unstake() -> reverts
  5. claim() -> reverts
  6. deposit() -> reverts
Expected: All state-changing functions blocked when paused
Notes: Requires code fix B5
```

```
TC-271: Only guardian can pause, only multisig can unpause
Category: security | Priority: P1 | File: Security.t.sol
Steps:
  1. Random calls pause() -> reverts
  2. Guardian pauses -> succeeds
  3. Guardian calls unpause() -> reverts
  4. Owner (multisig) unpauses -> succeeds
Expected: Asymmetric access prevents pause/unpause griefing
```

```
TC-272: Pause auto-expires after 7 days
Category: security | Priority: P1 | File: Security.t.sol
Steps:
  1. Guardian pauses
  2. vm.warp(6 days) -> still paused
  3. vm.warp(7 days) -> auto-unpaused
  4. stake() succeeds
Expected: Pause cannot last >7 days without re-pause
```

```
TC-273: View functions work while paused
Category: security | Priority: P1 | File: Security.t.sol
Steps:
  1. Pause contract
  2. earned(), getClaimable(), totalStaked(), stakedBalance() all succeed
Expected: View functions NOT affected by pause
Notes: Users must check positions during emergency pause
```

### 3.10 Timelock Events (Security Engineer)

```
TC-274: TimelockController emits CallScheduled on upgrade proposal
Category: security | Priority: P1 | File: Security.t.sol
Steps:
  1. Proposer schedules upgrade via timelock
  2. Verify CallScheduled event emitted with target, data, delay
Expected: Event emitted for monitoring infrastructure
Notes: H2 mitigation -- monitoring depends on this event
```

```
TC-275: TimelockController emits CallExecuted on upgrade execution
Category: security | Priority: P1 | File: Security.t.sol
Steps:
  1. Schedule upgrade, warp past 7 days, execute
  2. Verify CallExecuted event emitted
Expected: Execution event emitted
```

### 3.11 MerkleDrop Security (Security Engineer)

```
TC-276: MerkleDrop root is immutable
Category: security | Priority: P1 | File: Security.t.sol
Steps:
  1. Deploy MerkleDrop with root=0xABC
  2. Verify no function exists to update root (compile-time check)
  3. merkleRoot() == 0xABC forever
Expected: Root is immutable -- only set in constructor
```

### 3.12 stakeWithPermit Edge Cases (Security Engineer)

```
TC-279: stakeWithPermit() rejects replayed permit signature
Category: security | Priority: P1 | File: Security.t.sol
Steps:
  1. Alice signs permit, calls stakeWithPermit() -> succeeds
  2. Attacker replays same signature
Expected: Reverts (nonce incremented after first use)
```

```
TC-280: stakeWithPermit() handles front-run permit gracefully
Category: security | Priority: P1 | File: Security.t.sol
Steps:
  1. Alice signs permit for staking contract
  2. Attacker front-runs by submitting permit() directly
  3. Alice's stakeWithPermit() tx arrives -> permit() inside fails
  4. BUT: allowance already set by front-runner, so transferFrom succeeds
Expected: stakeWithPermit() should use try/catch around permit() call
Notes: Known ERC-2612 front-running issue. Function must handle gracefully.
```

### 3.13 Additional Access Control (Security Engineer)

```
TC-281: setFeeSource() rejects zero address
Category: security | Priority: P2 | File: Security.t.sol
Steps:
  1. Owner calls setFeeSource(address(0))
Expected: Reverts with "Invalid address"
```

```
TC-282: ClaraToken transfer to zero address reverts
Category: security | Priority: P2 | File: Security.t.sol
Steps:
  1. User calls transfer(address(0), 100e18)
Expected: Reverts (OZ ERC20 default)
```

```
TC-283: Stake with amount exceeding CLARA balance reverts
Category: security | Priority: P2 | File: Security.t.sol
Steps:
  1. Alice has 1000 CLARA, approves 2000, calls stake(2000e18)
Expected: Reverts (transferFrom fails -- insufficient balance)
```

### 3.14 Dust Griefing (Low Priority)

```
TC-284: Rapid small deposits do not increase earned() gas cost
Category: security | Priority: P3 | File: Security.t.sol
Steps:
  1. FeeSource makes 100 deposits of 1 USDC each
  2. Measure gas of earned() call
  3. Compare to single 100 USDC deposit scenario
Expected: Gas cost identical -- Synthetix accumulator makes this a non-issue
Notes: Griefing only costs the attacker gas. Document this property.
```

---

## 4. Fuzz Tests (Foundry)

```
FZ-001: Fuzz -- stake/unstake/claim with random amounts (TC-250 enhanced)
Category: fuzz | Priority: P1 | File: Security.t.sol
Runs: 10,000 (CI: 50,000)
Invariants:
  a. totalStaked == sum of all stakedBalance[user]
  b. No user can claim more USDC than total deposited
  c. rewardPerTokenStored is monotonically increasing
  d. Sum of all claimed rewards <= sum of all deposits
```

```
FZ-002: Fuzz -- deposit amount boundaries (TC-251 enhanced)
Category: fuzz | Priority: P2 | File: Security.t.sol
Parameters: deposit in [1, type(uint128).max], totalStaked in [1, 100_000_000e18]
Invariant: No overflow in rPTS calculation. Max: type(uint128).max * 1e18 = ~3.4e56, within uint256.
```

```
FZ-003: Fuzz -- multi-user entry/exit ordering (TC-252 enhanced)
Category: fuzz | Priority: P2 | File: Security.t.sol
Parameters: Random sequence of (stake, unstake, claim, deposit, exit) from 5 users
Runs: 50,000
Invariants:
  a. totalStaked == sum(stakedBalance) for all users
  b. claraToken.balanceOf(staking) >= totalStaked
  c. usdc.balanceOf(staking) >= sum(earned(user)) for all users
```

```
FZ-004: Fuzz -- deposit() precision across full USDC range (Security Engineer)
Category: fuzz | Priority: P1 | File: Security.t.sol
Parameters: totalStaked in [1, 100_000_000e18], deposit in [1, type(uint128).max]
Invariants:
  a. rPTS never overflows uint256
  b. No panic for valid (totalStaked>0, amount>0) combinations
  c. rPTS monotonically non-decreasing
```

```
FZ-005: Fuzz -- earned() precision with extreme stake ratios (Security Engineer)
Category: fuzz | Priority: P1 | File: Security.t.sol
Parameters: amountA/B in [1 wei, 100M e18], deposit in [1, 1M e6]
Invariants:
  a. earned(A) + earned(B) <= totalDeposited (conservation of value)
  b. No individual earned() exceeds total deposits
  c. Rounding error per staker <= 1 USDC wei per deposit event
```

```
FZ-006: Fuzz -- interleaved operations maintain totalStaked invariant (Security Engineer)
Category: fuzz | Priority: P1 | File: Security.t.sol
5 fuzzed users, random operation sequences, 50_000+ iterations.
Invariants:
  a. totalStaked == sum(stakedBalance[user])
  b. claraToken.balanceOf(staking) >= totalStaked
  c. usdc.balanceOf(staking) >= sum(earned(user))
Notes: Gold standard invariant fuzz test.
```

```
FZ-007: Fuzz -- permit signature parameters (Security Engineer)
Category: fuzz | Priority: P2 | File: Security.t.sol
Parameters: deadline (past/present/future/max), value (0/1/MAX/max), nonce (correct/wrong)
Invariants: Valid signatures succeed, invalid revert. Expired deadlines revert.
```

```
FZ-008: Fuzz -- rewardPerTokenStored is monotonic across 5 deposits
Category: fuzz | Priority: P1 | File: Security.t.sol
Parameters: 5 random deposit amounts in [1, 1_000_000e6]
Invariant: rPTS never decreases between deposits
```

```
FZ-009: Fuzz -- multi-user no over-claim
Category: fuzz | Priority: P1 | File: Security.t.sol
Parameters: stakeA/B, deposit1/2, aliceExitsEarly (bool)
Invariant: earned(alice) + earned(bob) <= deposit1 + deposit2
```

---

## 5. Storage Layout & Gas Benchmarks (Solidity Engineer)

### 5.1 Storage Layout

```
SL-001: claraToken storage slot verification
Category: storage | Priority: P0 | File: StorageLayout.t.sol
Steps:
  1. vm.load(staking, _claraTokenSlot())
  2. Assert == address(token)
Notes: Use `forge inspect ClaraStaking storage-layout` for slot offsets
```

```
SL-002: usdc storage slot verification
Category: storage | Priority: P0 | File: StorageLayout.t.sol
```

```
SL-003: feeSource storage slot verification
Category: storage | Priority: P0 | File: StorageLayout.t.sol
```

```
SL-004: totalStaked storage slot verification
Category: storage | Priority: P0 | File: StorageLayout.t.sol
Steps:
  1. Alice stakes 1000e18
  2. vm.load(staking, _totalStakedSlot()) == 1000e18
```

```
SL-005: rewardPerTokenStored storage slot verification
Category: storage | Priority: P0 | File: StorageLayout.t.sol
Steps:
  1. Stake and deposit
  2. vm.load matches expected rPTS value
```

```
SL-006: __gap slots are zero-initialized
Category: storage | Priority: P0 | File: StorageLayout.t.sol
Steps:
  1. Loop over 50 gap slots
  2. Assert all are zero
```

```
SL-007: Upgrade with new variable after __gap succeeds
Category: storage | Priority: P0 | File: StorageLayout.t.sol
Steps:
  1. Deploy V1 with gap
  2. Deploy V2 that adds variable (reducing gap to 49)
  3. Upgrade, verify existing storage intact, new variable works
Notes: Requires B3 fix
```

### 5.2 Gas Benchmarks

| ID | Operation | Max Gas Threshold | Rationale |
|----|-----------|-------------------|-----------|
| GB-001 | stake() | 110,000 | Architecture ~85k + 25% margin |
| GB-002 | unstake() | 90,000 | Architecture ~70k + 25% margin |
| GB-003 | claim() | 70,000 | Architecture ~55k + 25% margin |
| GB-004 | exit() | 130,000 | Architecture ~100k + 25% margin |
| GB-005 | deposit() | 70,000 | Architecture ~55k + 25% margin |
| GB-006 | earned() (view) | 8,000 | Architecture ~5k + 60% margin |
| GB-007 | stakeWithPermit() | 160,000 | stake + permit ECDSA overhead |

Each gas test follows this pattern:

```solidity
function test_gas_stake() public {
    vm.prank(alice);
    uint256 gasBefore = gasleft();
    staking.stake(1000e18);
    uint256 gasUsed = gasBefore - gasleft();
    assertLe(gasUsed, 110_000, "stake() exceeds gas budget");
}
```

---

## 6. Deployment Script Tests (Solidity Engineer)

```
DS-001: Token initialization via constructor
Category: deployment | Priority: P0 | File: Deploy.t.sol
Steps:
  1. Deploy ClaraToken(treasury)
  2. name()="Clara", symbol()="CLARA", decimals()=18
  3. totalSupply()=100M, balanceOf(treasury)=100M
```

```
DS-002: Token cannot be re-initialized
Category: deployment | Priority: P0 | File: Deploy.t.sol
Steps:
  1. ClaraToken has no initialize() function (constructor-only)
  2. Verify totalSupply cannot change after construction
```

```
DS-003: Staking initialization via proxy
Category: deployment | Priority: P0 | File: Deploy.t.sol
Steps:
  1. Deploy impl + proxy
  2. claraToken(), usdc(), feeSource() all correct
  3. totalStaked()=0, rPTS=0, owner()=deployer
```

```
DS-004: Staking proxy cannot be re-initialized
Category: deployment | Priority: P0 | File: Deploy.t.sol
Steps:
  1. Proxy already initialized
  2. Call initialize() again -> reverts
```

```
DS-005: Staking implementation cannot be initialized
Category: deployment | Priority: P0 | File: Deploy.t.sol
Steps:
  1. Deploy ClaraStaking impl (has _disableInitializers in constructor)
  2. Call initialize() on impl -> reverts
Notes: Requires B2 fix
```

```
DS-006: Ownership transfer to timelock
Category: deployment | Priority: P0 | File: Deploy.t.sol
Steps:
  1. transferOwnership(timelock)
  2. Old owner: setFeeSource() -> reverts
  3. Timelock: setFeeSource() -> succeeds
```

---

## 7. Aerodrome Integration Tests (Fork)

All tests use Base mainnet fork.

```
AE-001: Create CLARA/USDC volatile pool
Category: aerodrome | Priority: P1 | File: Aerodrome.t.sol
Steps:
  1. Router.createPool(CLARA, USDC, false)
  2. Pool address != zero
  3. Pool is volatile (not stable)
  4. Token ordering correct
```

```
AE-002: Add initial liquidity (10M CLARA + 100K USDC)
Category: aerodrome | Priority: P1 | File: Aerodrome.t.sol
Steps:
  1. Approve and addLiquidity(10M CLARA, 100K USDC, volatile)
  2. LP tokens minted
  3. Reserves match deposits
  4. Implied price ~$0.01/CLARA (FDV $1M)
```

```
AE-003: Swap USDC to CLARA
Category: aerodrome | Priority: P1 | File: Aerodrome.t.sol
Steps:
  1. Swap 100 USDC -> CLARA
  2. Received CLARA > 0
  3. Sanity: ~9,000-11,000 CLARA at $0.01 price (minimal slippage on 100K pool)
```

```
AE-004: Swap CLARA to USDC
Category: aerodrome | Priority: P1 | File: Aerodrome.t.sol
Steps:
  1. Swap 10,000 CLARA -> USDC
  2. Received USDC > 0
  3. Sanity: ~$90-110 at $0.01 price
```

```
AE-005: Full flow -- buy CLARA, stake, earn, sell
Category: aerodrome | Priority: P1 | File: Aerodrome.t.sol
Steps:
  1. User buys CLARA with 100 USDC on Aerodrome
  2. Stakes CLARA
  3. FeeSource deposits 50 USDC
  4. Claims rewards
  5. Unstakes and sells CLARA back
  6. Final USDC balance should reflect rewards earned
```

---

## 8. Clara MCP Regression Tests (Vitest)

These tests validate that the existing Clara MCP user experience is UNCHANGED for users without CLARA tokens. Each test validates against the regression baselines (BL-001 through BL-014).

```
TC-300: wallet_setup output unchanged (with email)
Category: mcp | Priority: P0 | File: src/__tests__/tools/clara-regression.test.ts
Baseline: BL-001
Steps:
  1. Call wallet_setup with email="test@example.com"
  2. Response contains "Wallet created!" or "Wallet ready!"
  3. Response contains address and email
  4. Response contains "$0.001" and "$0.10"
  5. Response recommends wallet_briefing
  6. Response does NOT contain: "CLARA", "staking", "airdrop", "free operations", "free tier"
```

```
TC-301: wallet_status output unchanged
Category: mcp | Priority: P0 | File: src/__tests__/tools/clara-regression.test.ts
Baseline: BL-003
Steps:
  1. Call wallet_status
  2. Contains "Wallet Active", address, email, chains, credits
  3. Does NOT contain: "CLARA Staking", "Claimable", "staking rewards"
Notes: Per D7 -- wallet_status remains unchanged in Phase 1
```

```
TC-302: wallet_dashboard no CLARA section (non-staker)
Category: mcp | Priority: P0 | File: src/__tests__/tools/clara-regression.test.ts
Baseline: BL-005
Steps:
  1. Call wallet_dashboard (user has USDC/ETH, no CLARA)
  2. Sections in order: Account, Portfolio, Spending Limits, Recent Payments, Actions
  3. NO "CLARA Staking" section
  4. Structured JSON does NOT contain "claraStaking" or "claimable" keys
  5. Actions section does NOT list "wallet_claim_airdrop"
```

```
TC-303: wallet_send output unchanged
Category: mcp | Priority: P0 | File: src/__tests__/tools/clara-regression.test.ts
Baseline: BL-007
Steps:
  1. Call wallet_send with valid params
  2. Contains "Transaction sent!", Amount, To, Chain, From, tx link
  3. Does NOT contain: "Free operations:", "x402 fee:", "CLARA"
```

```
TC-304: wallet_swap output unchanged
Category: mcp | Priority: P0 | File: src/__tests__/tools/clara-regression.test.ts
Baseline: BL-010/BL-011
Steps:
  1. Call wallet_swap action="quote" -> verify quote format
  2. Call wallet_swap action="execute" -> verify execution format
  3. Neither contains CLARA or free tier mentions
```

```
TC-305: wallet_call output unchanged
Category: mcp | Priority: P0
Steps:
  1. Call wallet_call with target contract
  2. Verify preparation response (safety analysis + prepared tx)
Expected: Unchanged
```

```
TC-306: wallet_executePrepared output unchanged
Category: mcp | Priority: P0
Steps:
  1. Call wallet_executePrepared with txId
  2. Verify execution response
Expected: Unchanged
```

```
TC-307: wallet_sign_message output unchanged
Category: mcp | Priority: P1
```

```
TC-308: wallet_sign_typed_data output unchanged
Category: mcp | Priority: P1
```

```
TC-309: wallet_approvals output unchanged
Category: mcp | Priority: P1
```

```
TC-310: wallet_history output unchanged
Category: mcp | Priority: P1
```

```
TC-311: wallet_pay_x402 output unchanged
Category: mcp | Priority: P0 | Notes: Core monetization path
```

```
TC-312: wallet_spending_limits output unchanged
Category: mcp | Priority: P1
```

```
TC-313: wallet_logout output unchanged
Category: mcp | Priority: P1
Baseline: BL-014
```

```
TC-314: wallet_opportunities no CLARA section (non-CLARA user)
Category: mcp | Priority: P0
Baseline: BL-012
Steps:
  1. Call wallet_opportunities asset="USDC" chain="base" (user has no CLARA)
  2. Lending yields returned
  3. NO "CLARA Staking" section
  4. Structured JSON does NOT contain "clara_staking" or "ClaraStaking"
  5. Lending table content identical regardless of CLARA ownership
```

```
TC-315: wallet_analyze_contract output unchanged
Category: mcp | Priority: P2
```

```
TC-316: wallet_setup output byte-identical (CLARA deployed, user has no CLARA)
Category: mcp | Priority: P0
Steps:
  1. CLARA system fully deployed
  2. Call wallet_setup for non-CLARA user
  3. Assert output matches BL-001 exactly
  4. Assert does NOT contain "CLARA", "staking", "airdrop", "free operations"
Notes: UX designer's most important regression test
```

```
TC-317: wallet_status no CLARA section (CLARA deployed, user has no CLARA)
Category: mcp | Priority: P0
Same as TC-301 but explicitly with CLARA system deployed
```

```
TC-318: wallet_dashboard Actions section unchanged (no CLARA user)
Category: mcp | Priority: P0
Steps:
  1. Call wallet_dashboard
  2. Actions section contains: wallet_balance, wallet_briefing, wallet_opportunities, wallet_credits
  3. Actions does NOT contain: wallet_claim_airdrop, ClaraStaking, stake
```

```
TC-319: wallet_send has no fee or counter line (current behavior)
Category: mcp | Priority: P0
Baseline: BL-007
Steps:
  1. Call wallet_send (no free tier, no CLARA)
  2. Contains "Transaction sent!" with standard fields
  3. Does NOT contain "Free operations:", "x402 fee:", "CLARA"
```

---

## 9. Clara MCP New Feature Tests (Vitest)

### 9.1 wallet_claim_airdrop

```
TC-320: wallet_claim_airdrop shows verification options
Category: mcp | Priority: P1
Steps:
  1. Call wallet_claim_airdrop (unverified user)
  2. Response shows verification methods (GitHub, X, Both)
  3. Verification link URL generated
```

```
TC-321: wallet_claim_airdrop succeeds after verification
Category: mcp | Priority: P1
Steps:
  1. Call wallet_claim_airdrop (verified user)
  2. CLARA tokens sent to wallet
  3. Response shows amount, tx hash, staking suggestion
```

```
TC-322: wallet_claim_airdrop double-claim shows "already claimed"
Category: mcp | Priority: P1
Steps:
  1. User already claimed
  2. Call wallet_claim_airdrop again
Expected: "Already claimed" status, no error
Notes: Idempotent behavior
```

```
TC-323: wallet_claim_airdrop ineligible user gets clear message
Category: mcp | Priority: P2
Steps:
  1. User not in Merkle tree
  2. Call wallet_claim_airdrop
Expected: Eligibility requirements + alternative (wallet_swap)
```

### 9.2 Modified Dashboard

```
TC-330: wallet_dashboard shows CLARA staking section (staker)
Category: mcp | Priority: P1
Steps:
  1. User has CLARA staked
  2. Call wallet_dashboard
  3. "CLARA Staking" section present AFTER Portfolio, BEFORE Spending Limits
  4. Shows: Staked amount, Share %, Claimable USDC, Earned Total
  5. Inline action hint for claiming (wallet_call)
```

```
TC-331: wallet_dashboard shows unstaked CLARA with staking hint
Category: mcp | Priority: P2
Steps:
  1. User has CLARA in wallet, NOT staked
  2. Call wallet_dashboard
  3. CLARA line shows "(unstaked)" annotation
  4. Arrow hint: "Stake to earn fees: wallet_call target=ClaraStaking action=stake"
  5. Only CLARA gets this annotation -- other tokens unchanged
```

```
TC-332: wallet_opportunities appends CLARA staking (user has CLARA)
Category: mcp | Priority: P1
Steps:
  1. User has CLARA (staked or unstaked)
  2. Call wallet_opportunities
  3. Lending section appears FIRST (unchanged)
  4. "CLARA Staking" section APPENDED after lending
```

```
TC-333: wallet_opportunities appends CLARA staking (10+ paid ops)
Category: mcp | Priority: P2
Steps:
  1. User has 10+ paid operations, no CLARA
  2. Call wallet_opportunities
  3. "CLARA Staking" section appended
Notes: Counter tracked in clara-proxy (server-side)
```

### 9.3 CLARA Feature Gating

```
TC-334: wallet_dashboard has no "(unstaked)" label without CLARA
Category: mcp | Priority: P1
Steps:
  1. User has USDC/ETH, zero CLARA
  2. Call wallet_dashboard
  3. No "(unstaked)" label on any token
  4. No staking hint
```

```
TC-335: wallet_opportunities NEVER shows CLARA staking for brand-new user
Category: mcp | Priority: P0
Steps:
  1. Brand-new wallet, 0 ops, no CLARA
  2. Call wallet_opportunities
  3. Standard yields only
  4. NO "CLARA Staking" section
  5. Structured JSON has no CLARA references
Notes: New users must not see CLARA content during first exploration
```

```
TC-336: wallet_opportunities CLARA section position is AFTER lending
Category: mcp | Priority: P1
Steps:
  1. User has CLARA staked
  2. Call wallet_opportunities
  3. "Lending" section first
  4. "CLARA Staking" section after
  5. Lending content identical to non-CLARA user
```

---

## 10. End-to-End Scenario Tests

```
TC-400: New user journey -- setup to first claim
Category: e2e | Priority: P0
Steps:
  1. wallet_setup -> wallet created, 25 free ops
  2. wallet_dashboard -> empty wallet
  3. [20 write ops] -> 5 remaining
  4. Fund wallet with 5 USDC
  5. wallet_send -> uses free op
  6. [Exhaust free ops]
  7. wallet_send -> x402 fee ($0.01)
  8. wallet_opportunities -> discovers CLARA staking
  9. wallet_claim_airdrop -> claims CLARA
  10. wallet_call stake() -> stakes CLARA
  11. [Fee deposits]
  12. wallet_dashboard -> "Claimable: $X.XX"
  13. wallet_call claim() -> claims USDC
  14. Verify USDC balance increased
Expected: Full user journey from zero to earning USDC rewards
```

```
TC-401: Existing user journey -- NO CLARA involvement
Category: e2e | Priority: P0
Steps:
  1. wallet_setup, wallet_dashboard, wallet_send, wallet_swap (quote+execute),
     wallet_history, wallet_approvals
  2. ENTIRE journey works without ANY mention of CLARA
  3. No new steps, no changed output formats, no degraded performance
  4. No extra RPC calls to check CLARA balance when user has none
Expected: THE critical regression test. If this fails, integration is broken.
```

```
TC-402: Staker dashboard experience
Category: e2e | Priority: P1
Steps:
  1. wallet_dashboard -> CLARA staking section shows
  2. wallet_opportunities -> CLARA staking section appended
  3. wallet_call getClaimable() -> check rewards
  4. wallet_call claim() -> claim rewards
  5. wallet_dashboard -> claimable=0, earned total increased
Expected: Full staker experience is cohesive
```

```
TC-403: Error -- no USDC after free tier
Category: e2e | Priority: P1
Steps:
  1. Attempt wallet_send (no USDC, free tier exhausted)
  2. Error contains: required amount, deposit instructions
  3. wallet_dashboard -> succeeds (read op)
  4. wallet_history -> succeeds (read op)
Expected: Write ops blocked, read ops still work
```

```
TC-404: Error -- expired session
Category: e2e | Priority: P2
Steps:
  1. wallet_dashboard -> session expired error
  2. Error contains "expired" and "wallet_setup"
  3. wallet_setup -> same wallet, same address, same funds
```

```
TC-405: Error -- spending limit hit
Category: e2e | Priority: P2
Steps:
  1. Attempt write op at daily limit
  2. Error contains "spending limit" and "wallet_spending_limits"
```

```
TC-406: Error -- zero rewards to claim
Category: e2e | Priority: P2
Steps:
  1. wallet_call ClaraStaking.claim() (just staked, no deposits yet)
  2. No revert, graceful "no rewards" or 0 claim
```

```
TC-407: Error -- insufficient CLARA to stake
Category: e2e | Priority: P3
Steps:
  1. wallet_call ClaraStaking.stake(1000e18) (user has 0 CLARA)
  2. Error indicates need for CLARA
  3. Guidance: swap USDC->CLARA or claim airdrop
```

---

## 11. x402 Fee Flow Tests

```
TC-500: x402 facilitator deposits directly to ClaraStaking
Category: x402 | Priority: P0
Steps:
  1. Facilitator (feeSource) calls deposit(100e6)
  2. rPTS increased
  3. USDC balance of staking increased
Expected: Direct settlement -- no proxy custody (eliminates C4 risk)
```

```
TC-501: Batch settlement -- multiple small fees in one deposit
Category: x402 | Priority: P1
Steps:
  1. Simulate 100 x402 payments of $0.01 each
  2. Batch into one deposit(1e6)
  3. rPTS increases correctly
```

```
TC-502: Settlement fails during zero-staker period -- proxy retries
Category: x402 | Priority: P1
Steps:
  1. totalStaked == 0
  2. Proxy attempts deposit() -> reverts with "No stakers"
  3. Proxy holds USDC
  4. User stakes
  5. Proxy retries -> succeeds
Expected: Proxy gracefully handles revert and retries
Notes: Depends on B1 fix (revert on zero stakers)
```

```
TC-503: x402 fee visible in tool response after free tier
Category: x402 | Priority: P1
Steps:
  1. User exhausted free tier, has USDC
  2. wallet_send
  3. Response shows: "x402 fee: $0.01 | Today: $X.XX/$10.00"
Expected: Fee transparency after free tier
```

```
TC-504: x402 fee NOT visible during free tier
Category: x402 | Priority: P1
Steps:
  1. User has free ops remaining
  2. wallet_send
  3. NO x402 fee line
  4. Shows "Free operations: N remaining" instead
```

```
TC-505: x402 auto-pay respects spending limits
Category: x402 | Priority: P1
Steps:
  1. $0.50 remaining in daily limit
  2. 50 write ops ($0.50 total)
  3. 51st op -> spending limit error
```

```
TC-506: x402 large fee requires approval
Category: x402 | Priority: P2
Steps:
  1. Per-tx limit $1.00
  2. Resource with $0.75 x402 fee
  3. Approval prompt shown
  4. Approve -> payment processed
```

---

## 12. Free Tier Tests

```
TC-340: wallet_setup shows free tier messaging
Category: free-tier | Priority: P1
Steps:
  1. wallet_setup for new user
  2. Response includes "25 free operations" messaging
  3. Replaces ClaraCredits deposit copy (per D6)
Notes: NEW feature -- not regression. Current baseline (BL-001) shows ClaraCredits model.
```

```
TC-341: Free tier counter decrements on write operations
Category: free-tier | Priority: P1
Steps:
  1. wallet_sign_message -> "24 remaining"
  2. Another write op -> "23 remaining"
```

```
TC-342: Read operations don't decrement counter
Category: free-tier | Priority: P1
Steps:
  1. 25 free ops remaining
  2. wallet_dashboard, wallet_history, wallet_opportunities
  3. Counter still at 25
```

```
TC-343: Nudge at 5 remaining
Category: free-tier | Priority: P2
Steps:
  1. 5 free ops remaining
  2. Write op -> low-balance warning
```

```
TC-344: x402 kicks in after free tier exhaustion
Category: free-tier | Priority: P0
Steps:
  1. 0 free ops, user has USDC
  2. Write op -> x402 fee charged ($0.01)
  3. Transition is seamless (no error, no extra prompt)
  4. "x402 fee: $0.01" appears for first time
  5. Previous "Free operations: 0" message NOT repeated
```

```
TC-345: Clear error when 0 free ops and no USDC
Category: free-tier | Priority: P1
Steps:
  1. 0 free ops, 0 USDC
  2. Attempt write op
  3. Error contains "USDC", "Base", deposit address
  4. Does NOT crash or show raw exception
```

```
TC-346: Free tier counter NOT in wallet_status
Category: free-tier | Priority: P1
Steps:
  1. Free tier active
  2. wallet_status shows Clara Credits (deposit-based)
  3. Free tier counter only in write operation responses
```

```
TC-347: Read operations during free tier show NO counter
Category: free-tier | Priority: P1
Steps:
  1. 20 free ops remaining
  2. wallet_dashboard, wallet_history, wallet_opportunities, wallet_status
  3. None show "Free operations: 20 remaining"
Notes: Counter only in write operation response footers
```

```
TC-348: Free tier does not interact with Clara Credits
Category: free-tier | Priority: P1 (if ClaraCredits kept alongside)
Steps:
  1. 25 free ops AND $0.50 in ClaraCredits
  2. Write op -> free tier decrements, credits unchanged
  3. Exhaust free tier -> x402 kicks in (not ClaraCredits)
Notes: Free tier and ClaraCredits are independent. Free tier consumed first.
```

---

## 13. Error State Tests (UX Designer)

```
TC-350: Error E2 -- USDC balance too low for x402
Category: error | Priority: P1
Steps:
  1. Free tier exhausted, $0.003 USDC (below $0.01 x402 fee)
  2. wallet_send
  3. Error shows: required amount, current balance, "top up"
  4. No crash or raw exception
Notes: Subtly different from E1 (zero USDC). E2 has dust but not enough.
```

```
TC-351: Error E5 -- Transaction failed (insufficient gas)
Category: error | Priority: P1
Steps:
  1. User has USDC but near-zero ETH on Base
  2. wallet_send token="USDC"
  3. Error mentions "gas" and ETH balance
  4. Suggests swap USDC->ETH or deposit ETH
```

---

## Appendix A: Regression Baseline Details

### BL-001: wallet_setup (email, new wallet)

Source: `src/tools/wallet.ts:101-130`

```
Wallet created!

**Address:** `0xa1b2...c3d4`
**Email:** user@example.com

*Portable wallet: You can recover this wallet on any device using the same email, or claim full custody at getpara.com.*

**Get Started:**
1. **Add credits** - Deposit USDC to use signing operations
   - Run `wallet_status` to see your credit balance and deposit instructions
   - Minimum deposit: $0.10, each operation costs $0.001
2. **Start using** - `wallet_pay_x402` for payments, `wallet_balance` for balances

**Recommended next step:**
Run `wallet_briefing` to get a personalized summary of your wallet activity and opportunities.

**Useful commands:**
- `wallet_briefing` - Get wallet insights and opportunities
- `wallet_status` - View wallet details and credit balance
- `wallet_spending_limits` - Configure spending controls
```

Key assertions:
- First line: "Wallet created!" (new) or "Wallet ready!" (existing)
- Contains $0.001 per operation and $0.10 minimum deposit
- Recommends wallet_briefing
- Does NOT mention CLARA, staking, airdrop, or free tier counter

### BL-003: wallet_status (authenticated)

Source: `src/tools/wallet.ts:198-252`

```
**Wallet Active**

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

Key assertions:
- Shows address, email, chain, backend, session info
- Clara Credits section with balance/ops/cost
- Does NOT mention CLARA token, staking, or free tier

### BL-005: wallet_dashboard (with balances)

Source: `src/tools/dashboard.ts:289-385`

Sections in order: Account, Portfolio, Spending Limits, Recent Payments, Actions.
- Portfolio groups tokens by chain
- No CLARA Staking section
- Actions: wallet_balance, wallet_briefing, wallet_opportunities, wallet_credits

### BL-007: wallet_send (success)

```
Transaction sent!

**Amount:** 1.000000 USDC
**To:** `0xdead...beef`
**Chain:** base
**From:** `0x8744baf0...caffd`

**Transaction:** [0x1234abcd...](https://basescan.org/tx/0x...)
```

No fee line, no counter, no CLARA mention.

### BL-012: wallet_opportunities (results)

Sections: Lending (table), Protocol Actions (table).
No CLARA Staking section. No CLARA mention.

---

## Appendix B: Confirmed Contract Interfaces

### ClaraToken (Immutable)

```solidity
contract ClaraToken is ERC20, ERC20Permit {
    uint256 public constant MAX_SUPPLY = 100_000_000e18;
    constructor(address treasury) ERC20("Clara", "CLARA") ERC20Permit("Clara") {
        _mint(treasury, MAX_SUPPLY);
    }
}
```

### ClaraStaking (UUPS Upgradeable)

Key functions:
- `initialize(address _claraToken, address _usdc, address _feeSource)`
- `stake(uint256 amount)` -- requires prior approve
- `stakeWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)`
- `unstake(uint256 amount)`
- `claim()` -- sends earned USDC
- `exit()` -- unstake all + claim all
- `deposit(uint256 amount)` -- feeSource only, reverts if totalStaked==0
- `earned(address user) view` -- claimable USDC
- `getClaimable(address user) view` -- alias for earned()
- `setFeeSource(address newFeeSource)` -- owner only
- `recoverERC20(address token, uint256 amount)` -- owner only, blocks CLARA + USDC
- `pause()` -- guardian only
- `unpause()` -- owner/multisig only
- Storage gap: `uint256[50] private __gap`

### MerkleDrop (Immutable)

```solidity
contract MerkleDrop {
    IERC20 public immutable token;
    bytes32 public immutable merkleRoot;
    uint256 public immutable deadline;
    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata proof) external;
    function isClaimed(uint256 index) public view returns (bool);
    function sweep(address treasury) external; // only after deadline
}
```

---

## Appendix C: Synthetix Math Quick Reference

The core formula:

```
rewardPerTokenStored += (depositAmount * 1e18) / totalStaked

earned(user) = stakedBalance[user] * (rewardPerTokenStored - userRewardPerTokenPaid[user]) / 1e18 + rewards[user]
```

Key numeric examples (verified in Section 3 of Solidity review):

| Scenario | Setup | Expected Result |
|----------|-------|-----------------|
| Single staker | Alice=1000 CLARA, deposit 100 USDC | earned(alice) = 100 USDC |
| Equal split | Alice=500, Bob=500, deposit 100 | each earns 50 USDC |
| Unequal split | A=500/B=300/C=200, deposit 100 | 50/30/20 USDC (exact) |
| Late joiner | A=1000, D1=100, B=1000, D2=100 | A=150, B=50 |
| Early exit | A=500/B=500, D1=100, A exits, D2=100 | A=50 (frozen), B=150 |
| Claim then earn | A=1000, D1=100, claim, D2=100 | A earns 100 again |
| Dust deposit (100M staked, 1 wei) | rPTS rounds to 0 | Acceptable ($0.000001 dust) |
| Large deposit (1 wei staked, 1M USDC) | rPTS = 1e30, no overflow | 1M USDC earned (correct) |
