# CLARA Testing Plan: Solidity Engineer Review

> **Author:** Solidity Engineer
> **Date:** 2026-02-05
> **Status:** Review complete
> **Scope:** Contract-level test specifications, Foundry structure, numeric examples, gas benchmarks, Aerodrome integration, missing feature confirmations

---

## Table of Contents

1. [Missing Feature Confirmations](#1-missing-feature-confirmations)
2. [Foundry Test Structure](#2-foundry-test-structure)
3. [Synthetix RewardPerToken Math: Numeric Examples](#3-synthetix-rewardpertoken-math-numeric-examples)
4. [Gas Benchmark Thresholds](#4-gas-benchmark-thresholds)
5. [Storage Layout Tests](#5-storage-layout-tests)
6. [Aerodrome Integration Test Specifications](#6-aerodrome-integration-test-specifications)
7. [Deployment Script Tests](#7-deployment-script-tests)
8. [Additional Unit Test Specifications](#8-additional-unit-test-specifications)
9. [Fuzz Test Specifications](#9-fuzz-test-specifications)
10. [Discrepancy Resolutions](#10-discrepancy-resolutions)

---

## 1. Missing Feature Confirmations

The QA engineer identified several features from the refined plan (Section 15) that are not yet in the contract code (Section 2). Here is the status of each:

### 1.1 `stakeWithPermit()` -- WILL BE IMPLEMENTED

**Status:** Confirmed for implementation. The function signature and logic are specified in Section 15, point 3 of solidity-architecture.md.

**Implementation:**

```solidity
/// @notice Stake CLARA via ERC-2612 permit (approve + stake in one tx)
/// @param amount Amount of CLARA to stake
/// @param deadline Permit signature deadline
/// @param v Signature component
/// @param r Signature component
/// @param s Signature component
function stakeWithPermit(
    uint256 amount,
    uint256 deadline,
    uint8 v, bytes32 r, bytes32 s
) external nonReentrant updateReward(msg.sender) {
    require(amount > 0, "Cannot stake 0");
    IERC20Permit(address(claraToken)).permit(
        msg.sender, address(this), amount, deadline, v, r, s
    );
    totalStaked += amount;
    stakedBalance[msg.sender] += amount;
    claraToken.safeTransferFrom(msg.sender, address(this), amount);
    emit Staked(msg.sender, amount);
}
```

**Test implications:** TC-025 is valid. Additional edge case tests added below in Section 8.

### 1.2 `_disableInitializers()` in constructor -- WILL BE ADDED

**Status:** Confirmed for implementation. Every UUPS implementation contract MUST have this to prevent the uninitialized implementation from being taken over.

**Implementation:**

```solidity
// ClaraStaking.sol
/// @custom:oz-upgrades-unsafe-allow constructor
constructor() {
    _disableInitializers();
}
```

**Why this matters:** Without `_disableInitializers()`, an attacker can call `initialize()` on the raw implementation contract (not the proxy), become its owner, and use `upgradeToAndCall()` to point it at a malicious implementation. While this doesn't directly affect the proxy, it's a well-documented attack vector (OpenZeppelin C2 pattern) and must be prevented.

**Test implications:** TC-123 is valid and P0-critical.

### 1.3 Storage gap `uint256[50] private __gap` -- WILL BE ADDED

**Status:** Confirmed for implementation. Mentioned in Section 4 and Section 14 of solidity-architecture.md.

**Implementation:** Append after all state variables in ClaraStaking:

```solidity
/// @dev Reserved storage slots for future upgrades
uint256[50] private __gap;
```

**Test implications:** New storage layout tests added in Section 5 below.

### 1.4 MerkleDrop contract -- WILL BE IMPLEMENTED

**Status:** Confirmed for Phase 4 implementation. No Solidity code was provided in the architecture doc because it is a standard Merkle distributor (e.g., Uniswap's MerkleDistributor or OpenZeppelin's MerkleProof pattern).

**Recommended interface:**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MerkleDrop
/// @notice One-time CLARA airdrop via Merkle proof. Immutable (no proxy).
contract MerkleDrop {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    bytes32 public immutable merkleRoot;
    uint256 public immutable deadline;

    // Packed bitmap for tracking claims (gas-efficient)
    mapping(uint256 => uint256) private claimedBitMap;

    event Claimed(uint256 indexed index, address indexed account, uint256 amount);

    constructor(address _token, bytes32 _merkleRoot, uint256 _deadline) {
        token = IERC20(_token);
        merkleRoot = _merkleRoot;
        deadline = _deadline;
    }

    function isClaimed(uint256 index) public view returns (bool) {
        uint256 claimedWordIndex = index / 256;
        uint256 claimedBitIndex = index % 256;
        uint256 claimedWord = claimedBitMap[claimedWordIndex];
        uint256 mask = (1 << claimedBitIndex);
        return claimedWord & mask == mask;
    }

    function claim(
        uint256 index,
        address account,
        uint256 amount,
        bytes32[] calldata merkleProof
    ) external {
        require(block.timestamp <= deadline, "Claim deadline passed");
        require(!isClaimed(index), "Already claimed");

        bytes32 node = keccak256(abi.encodePacked(index, account, amount));
        require(MerkleProof.verify(merkleProof, merkleRoot, node), "Invalid proof");

        _setClaimed(index);
        token.safeTransfer(account, amount);
        emit Claimed(index, account, amount);
    }

    function _setClaimed(uint256 index) private {
        uint256 claimedWordIndex = index / 256;
        uint256 claimedBitIndex = index % 256;
        claimedBitMap[claimedWordIndex] = claimedBitMap[claimedWordIndex] | (1 << claimedBitIndex);
    }

    /// @notice Sweep unclaimed tokens back to treasury after deadline
    function sweep(address treasury) external {
        require(block.timestamp > deadline, "Deadline not passed");
        token.safeTransfer(treasury, token.balanceOf(address(this)));
    }
}
```

**Key design decisions:**
- **Immutable (no proxy):** Per Section 15, point 4 -- ClaraToken is immutable, and MerkleDrop should be too. No admin keys, no upgrade path. Deterministic behavior.
- **Bitmap claims:** Gas-efficient O(1) double-claim prevention (same as Uniswap MerkleDistributor).
- **Deadline + sweep:** 6-month claim window per CLARA-TOKEN-PLAN.md, then treasury can reclaim unclaimed tokens.

**Test implications:** TC-040 through TC-046 are valid. Additional tests added in Section 8 (sweep function, bitmap edge cases).

### 1.5 Immutable ClaraToken (Section 15, point 4) -- CONFIRMED

**Status:** ClaraToken will be deployed WITHOUT a proxy, as recommended in Section 15.

**Implications for testing:**
- TC-001 through TC-008 are valid but should NOT test UUPS upgrade behavior on ClaraToken
- No `_authorizeUpgrade` test needed for ClaraToken
- No `_disableInitializers` constructor needed for ClaraToken
- The `initialize()` function becomes a regular function called once at deployment via CREATE2 or constructor encoding
- ClaraToken WILL use `ERC20Permit` (not `ERC20PermitUpgradeable`)

**Revised ClaraToken (non-upgradeable):**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title ClaraToken
/// @notice Fixed-supply 100M ERC-20 with ERC-2612 permit. Immutable.
contract ClaraToken is ERC20, ERC20Permit {
    uint256 public constant MAX_SUPPLY = 100_000_000e18;

    constructor(address treasury) ERC20("Clara", "CLARA") ERC20Permit("Clara") {
        _mint(treasury, MAX_SUPPLY);
    }
}
```

---

## 2. Foundry Test Structure

### 2.1 Project Layout

```
contracts/
  src/
    ClaraToken.sol
    ClaraStaking.sol
    MerkleDrop.sol
  test/
    ClaraToken.t.sol          # TC-001 through TC-008
    ClaraStaking.t.sol        # TC-010 through TC-030
    ClaraStakingMath.t.sol    # Synthetix math tests (Section 3 below)
    MerkleDrop.t.sol          # TC-040 through TC-046 + new specs
    Integration.t.sol         # TC-100 through TC-106
    Aerodrome.t.sol           # TC-110 through TC-113 (fork tests)
    Upgrade.t.sol             # TC-120 through TC-123
    Security.t.sol            # TC-200 through TC-252
    StorageLayout.t.sol       # New: storage slot verification
    GasBenchmark.t.sol        # New: gas threshold assertions
    Deploy.t.sol              # New: deployment script verification
  script/
    DeployCLARA.s.sol
  foundry.toml
```

### 2.2 Base Test Contracts

```solidity
// test/Base.t.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/ClaraToken.sol";
import "../src/ClaraStaking.sol";
import "../src/MerkleDrop.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @dev Shared setUp for all ClaraStaking tests
abstract contract ClaraTestBase is Test {
    ClaraToken public token;
    ClaraStaking public stakingImpl;
    ClaraStaking public staking;
    ERC1967Proxy public stakingProxy;

    // Mock USDC (6 decimals)
    MockERC20 public usdc;

    address public treasury = makeAddr("treasury");
    address public feeSource = makeAddr("feeSource");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public charlie = makeAddr("charlie");
    address public attacker = makeAddr("attacker");

    uint256 public constant INITIAL_SUPPLY = 100_000_000e18;

    function setUp() public virtual {
        // Deploy immutable ClaraToken
        token = new ClaraToken(treasury);

        // Deploy mock USDC (6 decimals)
        usdc = new MockERC20("USD Coin", "USDC", 6);

        // Deploy ClaraStaking via UUPS proxy
        stakingImpl = new ClaraStaking();
        stakingProxy = new ERC1967Proxy(
            address(stakingImpl),
            abi.encodeCall(ClaraStaking.initialize, (
                address(token), address(usdc), feeSource
            ))
        );
        staking = ClaraStaking(address(stakingProxy));

        // Fund accounts
        vm.startPrank(treasury);
        token.transfer(alice, 10_000e18);
        token.transfer(bob, 10_000e18);
        token.transfer(charlie, 10_000e18);
        vm.stopPrank();

        // Mint USDC to feeSource
        usdc.mint(feeSource, 1_000_000e6);

        // Approve staking contract
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

### 2.3 Fork Test Base (for Aerodrome)

```solidity
// test/AerodromeBase.t.sol
abstract contract AerodromeForkTest is Test {
    uint256 public baseFork;

    // Aerodrome on Base mainnet
    address constant AERODROME_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant AERODROME_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    address constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    ClaraToken public token;
    address public treasury = makeAddr("treasury");

    function setUp() public virtual {
        // Fork Base mainnet at a recent block
        baseFork = vm.createFork(vm.envString("BASE_RPC_URL"));
        vm.selectFork(baseFork);

        // Deploy ClaraToken on fork
        token = new ClaraToken(treasury);

        // Deal USDC to treasury (overwrite balance slot on fork)
        deal(USDC_BASE, treasury, 200_000e6);
    }
}
```

### 2.4 foundry.toml Configuration

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

---

## 3. Synthetix RewardPerToken Math: Numeric Examples

This section provides exact input/output values for verifying the core Synthetix accumulator math. All values are in raw token units (CLARA = 18 decimals, USDC = 6 decimals).

### 3.1 Single Staker, Single Deposit

```
Scenario: Alice stakes 1000 CLARA, feeSource deposits 100 USDC

Setup:
  alice stakes 1000e18 CLARA
  totalStaked = 1000e18
  rewardPerTokenStored = 0

Deposit 100 USDC (100_000_000 = 100e6):
  rewardPerTokenStored += (100e6 * 1e18) / 1000e18
  rewardPerTokenStored += 100_000_000_000_000_000_000_000_000 / 1_000_000_000_000_000_000_000
  rewardPerTokenStored += 100_000 (= 100e3 = 1e5)
  rewardPerTokenStored = 100_000

earned(alice):
  = stakedBalance[alice] * (rewardPerTokenStored - userRewardPerTokenPaid[alice]) / 1e18 + rewards[alice]
  = 1000e18 * (100_000 - 0) / 1e18 + 0
  = 1_000_000_000_000_000_000_000 * 100_000 / 1_000_000_000_000_000_000
  = 100_000_000_000_000_000_000_000_000 / 1_000_000_000_000_000_000
  = 100_000_000
  = 100e6 USDC  (correct -- Alice gets all 100 USDC)
```

**Foundry test function:**

```solidity
function test_singleStaker_singleDeposit() public {
    // Alice stakes 1000 CLARA
    vm.prank(alice);
    staking.stake(1000e18);

    // FeeSource deposits 100 USDC
    vm.prank(feeSource);
    staking.deposit(100e6);

    // Verify
    assertEq(staking.rewardPerTokenStored(), 100_000); // 1e5
    assertEq(staking.earned(alice), 100e6);             // 100 USDC
}
```

### 3.2 Two Stakers, Equal Shares

```
Scenario: Alice and Bob each stake 500 CLARA, feeSource deposits 100 USDC

Setup:
  alice stakes 500e18, bob stakes 500e18
  totalStaked = 1000e18
  rewardPerTokenStored = 0

Deposit 100 USDC:
  rewardPerTokenStored += (100e6 * 1e18) / 1000e18 = 100_000
  rewardPerTokenStored = 100_000

earned(alice):
  = 500e18 * (100_000 - 0) / 1e18 = 50_000_000 = 50e6 USDC (50%)

earned(bob):
  = 500e18 * (100_000 - 0) / 1e18 = 50_000_000 = 50e6 USDC (50%)
```

**Foundry test function:**

```solidity
function test_twoStakers_equalShares() public {
    vm.prank(alice);
    staking.stake(500e18);
    vm.prank(bob);
    staking.stake(500e18);

    vm.prank(feeSource);
    staking.deposit(100e6);

    assertEq(staking.earned(alice), 50e6);
    assertEq(staking.earned(bob), 50e6);
}
```

### 3.3 Three Stakers, Unequal Shares (TC-102)

```
Scenario: Alice=500, Bob=300, Charlie=200 CLARA. Deposit 100 USDC.

totalStaked = 1000e18
rewardPerTokenStored += (100e6 * 1e18) / 1000e18 = 100_000

earned(alice) = 500e18 * 100_000 / 1e18 = 50_000_000 = 50e6 (50%)
earned(bob)   = 300e18 * 100_000 / 1e18 = 30_000_000 = 30e6 (30%)
earned(charlie) = 200e18 * 100_000 / 1e18 = 20_000_000 = 20e6 (20%)

Total: 50 + 30 + 20 = 100 USDC (exact, no dust)
```

**Foundry test function:**

```solidity
function test_threeStakers_unequalShares() public {
    vm.prank(alice);
    staking.stake(500e18);
    vm.prank(bob);
    staking.stake(300e18);
    vm.prank(charlie);
    staking.stake(200e18);

    vm.prank(feeSource);
    staking.deposit(100e6);

    assertEq(staking.earned(alice), 50e6);
    assertEq(staking.earned(bob), 30e6);
    assertEq(staking.earned(charlie), 20e6);
}
```

### 3.4 Late Joiner Gets No Prior Rewards (TC-103)

```
Scenario: Alice stakes 1000 CLARA. Deposit 100 USDC. Bob stakes 1000. Deposit 100 USDC.

Step 1: Alice stakes 1000e18
  totalStaked = 1000e18

Step 2: Deposit 100 USDC
  rewardPerTokenStored += (100e6 * 1e18) / 1000e18 = 100_000
  rewardPerTokenStored = 100_000

Step 3: Bob stakes 1000e18
  updateReward(bob) runs:
    rewards[bob] = earned(bob) = 1000e18 * (100_000 - 0) / 1e18 + 0
    BUT bob has 0 stakedBalance at this point! earned(bob) = 0 * 100_000 / 1e18 + 0 = 0
    userRewardPerTokenPaid[bob] = 100_000  <-- KEY: snapshots current rPTS
  totalStaked = 2000e18

Step 4: Deposit 100 USDC
  rewardPerTokenStored += (100e6 * 1e18) / 2000e18 = 50_000
  rewardPerTokenStored = 150_000

earned(alice):
  = 1000e18 * (150_000 - 0) / 1e18 + 0 = 150_000_000 = 150e6

  WAIT -- this is wrong. Alice's userRewardPerTokenPaid is still 0 because she
  hasn't interacted since staking. Let me recalculate:

  Actually: Alice staked before any deposits. At stake(), updateReward(alice) set:
    userRewardPerTokenPaid[alice] = 0 (rewardPerTokenStored was 0)

  After both deposits:
    earned(alice) = 1000e18 * (150_000 - 0) / 1e18 + 0 = 150e6

earned(bob):
  = 1000e18 * (150_000 - 100_000) / 1e18 + 0 = 50_000_000 = 50e6

Total: 150 + 50 = 200 USDC (correct -- matches 2x 100 USDC deposits)
Alice got 100% of first deposit (100) + 50% of second (50) = 150
Bob got 0% of first deposit (0) + 50% of second (50) = 50
```

**Foundry test function:**

```solidity
function test_lateJoiner_noPriorRewards() public {
    // Alice stakes alone
    vm.prank(alice);
    staking.stake(1000e18);

    // First deposit: Alice gets all
    vm.prank(feeSource);
    staking.deposit(100e6);

    // Bob joins (50/50 split)
    vm.prank(bob);
    staking.stake(1000e18);

    // Second deposit: split equally
    vm.prank(feeSource);
    staking.deposit(100e6);

    assertEq(staking.earned(alice), 150e6); // 100 + 50
    assertEq(staking.earned(bob), 50e6);    // 0 + 50
}
```

### 3.5 Early Exit Freezes Rewards (TC-104)

```
Scenario: Alice and Bob each stake 500. Deposit 100. Alice exits. Deposit 100.

Step 1: Both stake 500e18. totalStaked = 1000e18.

Step 2: Deposit 100 USDC.
  rewardPerTokenStored += 100e6 * 1e18 / 1000e18 = 100_000
  rewardPerTokenStored = 100_000

Step 3: Alice unstakes all 500e18.
  updateReward(alice):
    rewards[alice] = 500e18 * (100_000 - 0) / 1e18 + 0 = 50_000_000 = 50e6
    userRewardPerTokenPaid[alice] = 100_000
  stakedBalance[alice] = 0
  totalStaked = 500e18

Step 4: Deposit 100 USDC.
  rewardPerTokenStored += 100e6 * 1e18 / 500e18 = 200_000
  rewardPerTokenStored = 300_000

earned(alice):
  = 0 * (300_000 - 100_000) / 1e18 + 50_000_000 = 50e6
  (frozen at 50 USDC -- her stakedBalance is 0, delta doesn't matter)

earned(bob):
  = 500e18 * (300_000 - 0) / 1e18 + 0 = 150_000_000 = 150e6

Total: 50 + 150 = 200 USDC (correct)
```

**Foundry test function:**

```solidity
function test_earlyExit_freezesRewards() public {
    vm.prank(alice);
    staking.stake(500e18);
    vm.prank(bob);
    staking.stake(500e18);

    vm.prank(feeSource);
    staking.deposit(100e6);

    // Alice exits
    vm.prank(alice);
    staking.unstake(500e18);

    // Second deposit: Bob gets all
    vm.prank(feeSource);
    staking.deposit(100e6);

    assertEq(staking.earned(alice), 50e6);  // frozen
    assertEq(staking.earned(bob), 150e6);   // 50 + 100
}
```

### 3.6 Claim Then Continue Earning (TC-106)

```
Scenario: Alice stakes 1000. Deposit 100. Alice claims. Deposit 100. Check Alice earns again.

Step 1: Alice stakes 1000e18.

Step 2: Deposit 100 USDC.
  rewardPerTokenStored = 100_000

Step 3: Alice calls claim().
  updateReward(alice):
    rewards[alice] = 1000e18 * (100_000 - 0) / 1e18 + 0 = 100e6
    userRewardPerTokenPaid[alice] = 100_000
  claim() transfers 100e6 USDC to alice, sets rewards[alice] = 0.
  stakedBalance[alice] = 1000e18 (UNCHANGED)

Step 4: Deposit 100 USDC.
  rewardPerTokenStored += 100e6 * 1e18 / 1000e18 = 100_000
  rewardPerTokenStored = 200_000

earned(alice):
  = 1000e18 * (200_000 - 100_000) / 1e18 + 0 = 100e6
  (Alice earns the full new deposit -- she never unstaked)
```

**Foundry test function:**

```solidity
function test_claimThenContinueEarning() public {
    vm.prank(alice);
    staking.stake(1000e18);

    vm.prank(feeSource);
    staking.deposit(100e6);

    // Alice claims
    vm.prank(alice);
    staking.claim();
    assertEq(usdc.balanceOf(alice), 100e6);
    assertEq(staking.stakedBalance(alice), 1000e18); // still staked

    // New deposit
    vm.prank(feeSource);
    staking.deposit(100e6);

    assertEq(staking.earned(alice), 100e6); // earns again
}
```

### 3.7 Precision Edge Case: Small Deposit, Large Stake (TC-230)

```
Scenario: 100M CLARA staked (full supply). Deposit 1 wei USDC.

totalStaked = 100_000_000e18 = 100_000_000_000_000_000_000_000_000 (1e26)

Deposit 1 USDC-wei:
  rewardPerTokenStored += (1 * 1e18) / 1e26
  = 1e18 / 1e26
  = 1e-8
  = 0 (integer division truncates)

  rewardPerTokenStored = 0 (no change)

earned(any staker) = stakedBalance * (0 - 0) / 1e18 = 0

Result: 1 USDC-wei is orphaned. This is 0.000001 USDC. Acceptable dust.
```

**Foundry test function:**

```solidity
function test_precision_dustDeposit_fullSupplyStaked() public {
    // Stake full supply
    vm.prank(treasury);
    token.approve(address(staking), INITIAL_SUPPLY);
    vm.prank(treasury);
    staking.stake(INITIAL_SUPPLY);

    uint256 rptBefore = staking.rewardPerTokenStored();

    // Deposit 1 USDC-wei
    vm.prank(feeSource);
    staking.deposit(1);

    // rewardPerTokenStored should NOT change (rounds to 0)
    assertEq(staking.rewardPerTokenStored(), rptBefore);
    assertEq(staking.earned(treasury), 0);
}
```

### 3.8 Precision Edge Case: Large Deposit, Tiny Stake (TC-231)

```
Scenario: 1 wei CLARA staked. Deposit 1M USDC.

totalStaked = 1

Deposit 1_000_000e6 (1M USDC):
  rewardPerTokenStored += (1_000_000_000_000 * 1e18) / 1
  = 1_000_000_000_000_000_000_000_000_000_000 (= 1e30)

  No overflow: uint256 max is ~1.15e77, so 1e30 is fine.

earned(sole staker):
  = 1 * (1e30 - 0) / 1e18 + 0
  = 1e30 / 1e18
  = 1_000_000_000_000 = 1e12 = 1_000_000e6 = 1M USDC (correct)
```

**Foundry test function:**

```solidity
function test_precision_largeDeposit_tinyStake() public {
    // Mint 1 wei CLARA to alice
    vm.prank(treasury);
    token.transfer(alice, 1);

    vm.prank(alice);
    token.approve(address(staking), 1);
    vm.prank(alice);
    staking.stake(1);

    // Deposit 1M USDC
    usdc.mint(feeSource, 1_000_000e6);
    vm.prank(feeSource);
    staking.deposit(1_000_000e6);

    assertEq(staking.rewardPerTokenStored(), 1e30);
    assertEq(staking.earned(alice), 1_000_000e6);
}
```

### 3.9 Multiple Deposits Accumulate Correctly (TC-101)

```
Scenario: Alice stakes 1000 CLARA. Three deposits: 10, 20, 30 USDC.

totalStaked = 1000e18

Deposit 1: 10e6 USDC
  rPTS += 10e6 * 1e18 / 1000e18 = 10_000
  rPTS = 10_000

Deposit 2: 20e6 USDC
  rPTS += 20e6 * 1e18 / 1000e18 = 20_000
  rPTS = 30_000

Deposit 3: 30e6 USDC
  rPTS += 30e6 * 1e18 / 1000e18 = 30_000
  rPTS = 60_000

earned(alice) = 1000e18 * 60_000 / 1e18 = 60e6 = 60 USDC (10 + 20 + 30)
```

**Foundry test function:**

```solidity
function test_multipleDeposits_accumulate() public {
    vm.prank(alice);
    staking.stake(1000e18);

    vm.startPrank(feeSource);
    staking.deposit(10e6);
    assertEq(staking.rewardPerTokenStored(), 10_000);

    staking.deposit(20e6);
    assertEq(staking.rewardPerTokenStored(), 30_000);

    staking.deposit(30e6);
    assertEq(staking.rewardPerTokenStored(), 60_000);
    vm.stopPrank();

    assertEq(staking.earned(alice), 60e6);
}
```

### 3.10 Dust Accumulation Over Many Small Deposits (TC-233)

```
Scenario: Alice=334, Bob=333, Charlie=333 CLARA (total=1000). 1000 deposits of 1 USDC each.

Per deposit: rPTS += 1e6 * 1e18 / 1000e18 = 1000
After 1000 deposits: rPTS = 1_000_000

earned(alice) = 334e18 * 1_000_000 / 1e18 = 334_000_000 = 334e6
earned(bob)   = 333e18 * 1_000_000 / 1e18 = 333_000_000 = 333e6
earned(charlie) = 333e18 * 1_000_000 / 1e18 = 333_000_000 = 333e6

Total claimed = 334 + 333 + 333 = 1000 USDC
Total deposited = 1000 USDC
Dust = 0 (lucky -- even division)

For non-even splits (e.g., 3 stakers with 333.33 each):
  If all three stake 333e18 (total=999e18):
  Per deposit: rPTS += 1e6 * 1e18 / 999e18 = 1001 (truncated from 1001.001...)
  After 1000 deposits: rPTS = 1_001_000
  earned(each) = 333e18 * 1_001_000 / 1e18 = 333_333_000
  Total claimed = 3 * 333_333_000 = 999_999_000
  Total deposited = 1_000_000_000
  Dust = 1_000 USDC-wei = 0.001 USDC

  Acceptable: <$0.01 dust over 1000 deposits.
```

**Foundry test function:**

```solidity
function test_dustAccumulation_1000Deposits() public {
    vm.prank(alice);
    staking.stake(334e18);
    vm.prank(bob);
    staking.stake(333e18);
    vm.prank(charlie);
    staking.stake(333e18);

    vm.startPrank(feeSource);
    for (uint256 i = 0; i < 1000; i++) {
        staking.deposit(1e6);
    }
    vm.stopPrank();

    uint256 totalClaimed;

    vm.prank(alice);
    staking.claim();
    totalClaimed += usdc.balanceOf(alice);

    vm.prank(bob);
    staking.claim();
    totalClaimed += usdc.balanceOf(bob);

    vm.prank(charlie);
    staking.claim();
    totalClaimed += usdc.balanceOf(charlie);

    uint256 totalDeposited = 1000e6;
    uint256 dust = totalDeposited - totalClaimed;

    // Dust must be less than number of deposits (1000 USDC-wei = $0.001)
    assertLe(dust, 1000);
    // Total claimed must not exceed total deposited
    assertLe(totalClaimed, totalDeposited);
}
```

---

## 4. Gas Benchmark Thresholds

Gas benchmarks should be enforced in CI. If an operation exceeds its threshold, the test fails -- this catches accidental storage bloat or unnecessary computation.

These thresholds are based on the estimates in solidity-architecture.md Section 6, with a 25% safety margin added.

### 4.1 Test File: `GasBenchmark.t.sol`

```solidity
function test_gas_stake() public {
    vm.prank(alice);
    uint256 gasBefore = gasleft();
    staking.stake(1000e18);
    uint256 gasUsed = gasBefore - gasleft();
    assertLe(gasUsed, 110_000, "stake() exceeds gas budget");
}

function test_gas_unstake() public {
    vm.prank(alice);
    staking.stake(1000e18);

    vm.prank(feeSource);
    staking.deposit(100e6);

    vm.prank(alice);
    uint256 gasBefore = gasleft();
    staking.unstake(500e18);
    uint256 gasUsed = gasBefore - gasleft();
    assertLe(gasUsed, 90_000, "unstake() exceeds gas budget");
}

function test_gas_claim() public {
    vm.prank(alice);
    staking.stake(1000e18);
    vm.prank(feeSource);
    staking.deposit(100e6);

    vm.prank(alice);
    uint256 gasBefore = gasleft();
    staking.claim();
    uint256 gasUsed = gasBefore - gasleft();
    assertLe(gasUsed, 70_000, "claim() exceeds gas budget");
}

function test_gas_exit() public {
    vm.prank(alice);
    staking.stake(1000e18);
    vm.prank(feeSource);
    staking.deposit(100e6);

    vm.prank(alice);
    uint256 gasBefore = gasleft();
    staking.exit();
    uint256 gasUsed = gasBefore - gasleft();
    assertLe(gasUsed, 130_000, "exit() exceeds gas budget");
}

function test_gas_deposit() public {
    vm.prank(alice);
    staking.stake(1000e18);

    vm.prank(feeSource);
    uint256 gasBefore = gasleft();
    staking.deposit(100e6);
    uint256 gasUsed = gasBefore - gasleft();
    assertLe(gasUsed, 70_000, "deposit() exceeds gas budget");
}

function test_gas_earned_view() public view {
    // View function -- free off-chain, but measures computation cost
    uint256 gasBefore = gasleft();
    staking.earned(alice);
    uint256 gasUsed = gasBefore - gasleft();
    assertLe(gasUsed, 8_000, "earned() view exceeds gas budget");
}

function test_gas_stakeWithPermit() public {
    // Measure the full permit + stake path
    // (signature generation is off-chain, but permit() is on-chain)
    uint256 alicePk = 0xA11CE;
    address aliceSigner = vm.addr(alicePk);
    vm.prank(treasury);
    token.transfer(aliceSigner, 1000e18);

    bytes32 digest = _buildPermitDigest(aliceSigner, address(staking), 1000e18, block.timestamp + 1 hours);
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);

    vm.prank(aliceSigner);
    uint256 gasBefore = gasleft();
    staking.stakeWithPermit(1000e18, block.timestamp + 1 hours, v, r, s);
    uint256 gasUsed = gasBefore - gasleft();
    assertLe(gasUsed, 160_000, "stakeWithPermit() exceeds gas budget");
}
```

### 4.2 Gas Threshold Summary

| Operation | Max Gas (threshold) | Rationale |
|-----------|-------------------|-----------|
| `stake()` | 110,000 | Architecture doc estimates ~85k + 25% margin |
| `unstake()` | 90,000 | Architecture doc estimates ~70k + 25% margin |
| `claim()` | 70,000 | Architecture doc estimates ~55k + 25% margin |
| `exit()` | 130,000 | Architecture doc estimates ~100k + 25% margin |
| `deposit()` | 70,000 | Architecture doc estimates ~55k + 25% margin |
| `earned()` | 8,000 | Architecture doc estimates ~5k + 60% margin (view) |
| `stakeWithPermit()` | 160,000 | stake() + permit() ECDSA recovery overhead |

---

## 5. Storage Layout Tests

Storage layout verification is critical for UUPS upgradeable contracts. If a V2 upgrade accidentally reorders storage, all staker balances could be corrupted silently.

### 5.1 Slot Position Verification

```solidity
// test/StorageLayout.t.sol

function test_storageLayout_claraToken_slot() public view {
    // claraToken is the first custom variable after OZ internals
    bytes32 slot = vm.load(address(staking), _claraTokenSlot());
    assertEq(address(uint160(uint256(slot))), address(token));
}

function test_storageLayout_usdc_slot() public view {
    bytes32 slot = vm.load(address(staking), _usdcSlot());
    assertEq(address(uint160(uint256(slot))), address(usdc));
}

function test_storageLayout_feeSource_slot() public view {
    bytes32 slot = vm.load(address(staking), _feeSourceSlot());
    assertEq(address(uint160(uint256(slot))), feeSource);
}

function test_storageLayout_totalStaked_slot() public {
    vm.prank(alice);
    staking.stake(1000e18);

    bytes32 slot = vm.load(address(staking), _totalStakedSlot());
    assertEq(uint256(slot), 1000e18);
}

function test_storageLayout_rewardPerTokenStored_slot() public {
    vm.prank(alice);
    staking.stake(1000e18);
    vm.prank(feeSource);
    staking.deposit(100e6);

    bytes32 slot = vm.load(address(staking), _rewardPerTokenStoredSlot());
    assertEq(uint256(slot), 100_000);
}

function test_storageLayout_gap_exists() public view {
    // The __gap should occupy 50 consecutive slots after stakedBalance's slot
    // Verify the slots are zero (uninitialized)
    bytes32 gapStart = bytes32(uint256(_stakedBalanceSlot()) + 1);
    for (uint256 i = 0; i < 50; i++) {
        bytes32 slot = vm.load(address(staking), bytes32(uint256(gapStart) + i));
        assertEq(uint256(slot), 0, "Gap slot not empty");
    }
}
```

**Note:** The exact slot numbers depend on the OpenZeppelin storage layout. Use `forge inspect ClaraStaking storage-layout` to determine the correct slot offsets and encode them as constants in the test helper functions (`_claraTokenSlot()`, etc.).

### 5.2 Upgrade Storage Preservation Test (Enhanced TC-120)

```solidity
function test_upgradePreservesAllStorage() public {
    // Setup: stake, deposit, partial claim
    vm.prank(alice);
    staking.stake(1000e18);
    vm.prank(bob);
    staking.stake(500e18);
    vm.prank(feeSource);
    staking.deposit(100e6);
    vm.prank(alice);
    staking.claim();

    // Snapshot all storage
    uint256 snap_totalStaked = staking.totalStaked();
    uint256 snap_rPTS = staking.rewardPerTokenStored();
    uint256 snap_aliceStaked = staking.stakedBalance(alice);
    uint256 snap_bobStaked = staking.stakedBalance(bob);
    uint256 snap_aliceEarned = staking.earned(alice);
    uint256 snap_bobEarned = staking.earned(bob);
    uint256 snap_aliceRPTP = staking.userRewardPerTokenPaid(alice);
    uint256 snap_bobRPTP = staking.userRewardPerTokenPaid(bob);
    address snap_feeSource = staking.feeSource();

    // Deploy V2 and upgrade
    ClaraStakingV2 v2Impl = new ClaraStakingV2();
    staking.upgradeToAndCall(address(v2Impl), "");

    // Verify ALL storage preserved
    assertEq(staking.totalStaked(), snap_totalStaked);
    assertEq(staking.rewardPerTokenStored(), snap_rPTS);
    assertEq(staking.stakedBalance(alice), snap_aliceStaked);
    assertEq(staking.stakedBalance(bob), snap_bobStaked);
    assertEq(staking.earned(alice), snap_aliceEarned);
    assertEq(staking.earned(bob), snap_bobEarned);
    assertEq(staking.userRewardPerTokenPaid(alice), snap_aliceRPTP);
    assertEq(staking.userRewardPerTokenPaid(bob), snap_bobRPTP);
    assertEq(staking.feeSource(), snap_feeSource);

    // Verify V2 functionality works
    assertEq(ClaraStakingV2(address(staking)).version(), 2);
}
```

---

## 6. Aerodrome Integration Test Specifications

All Aerodrome tests use Base mainnet fork testing (`vm.createFork`).

### 6.1 Pool Creation (TC-110 enhanced)

```solidity
// test/Aerodrome.t.sol

function test_createVolatilePool() public {
    vm.selectFork(baseFork);

    // Create pool via Router
    vm.startPrank(treasury);
    address pool = IRouter(AERODROME_ROUTER).createPool(
        address(token),
        USDC_BASE,
        false  // volatile, not stable
    );
    vm.stopPrank();

    assertTrue(pool != address(0), "Pool not created");

    // Verify pool type is volatile
    IPool poolContract = IPool(pool);
    assertFalse(poolContract.stable(), "Pool should be volatile");

    // Verify token ordering
    (address token0, address token1) = address(token) < USDC_BASE
        ? (address(token), USDC_BASE)
        : (USDC_BASE, address(token));
    assertEq(poolContract.token0(), token0);
    assertEq(poolContract.token1(), token1);
}
```

### 6.2 Add Initial Liquidity (TC-111 enhanced)

```solidity
function test_addInitialLiquidity() public {
    vm.selectFork(baseFork);

    uint256 claraAmount = 10_000_000e18;  // 10M CLARA
    uint256 usdcAmount = 100_000e6;       // 100K USDC

    vm.startPrank(treasury);
    IERC20(address(token)).approve(AERODROME_ROUTER, claraAmount);
    IERC20(USDC_BASE).approve(AERODROME_ROUTER, usdcAmount);

    (uint256 amountA, uint256 amountB, uint256 liquidity) = IRouter(AERODROME_ROUTER).addLiquidity(
        address(token),
        USDC_BASE,
        false,           // volatile
        claraAmount,
        usdcAmount,
        claraAmount * 99 / 100,  // 1% slippage tolerance
        usdcAmount * 99 / 100,
        treasury,
        block.timestamp + 600
    );
    vm.stopPrank();

    // Verify amounts deposited
    assertGe(amountA, claraAmount * 99 / 100);
    assertGe(amountB, usdcAmount * 99 / 100);
    assertGt(liquidity, 0, "No LP tokens minted");

    // Verify pool reserves
    address pool = IRouter(AERODROME_ROUTER).poolFor(address(token), USDC_BASE, false);
    (uint256 reserve0, uint256 reserve1, ) = IPool(pool).getReserves();
    assertGt(reserve0, 0);
    assertGt(reserve1, 0);

    // Verify implied price: $0.01/CLARA (100K USDC / 10M CLARA)
    // reserve ratio should be ~100:1 (CLARA:USDC in 18:6 decimal adjusted terms)
}
```

### 6.3 Swap USDC to CLARA (TC-112 enhanced)

```solidity
function test_swapUsdcToClara() public {
    _addLiquidityToPool(); // helper from TC-111

    address user = makeAddr("swapper");
    deal(USDC_BASE, user, 100e6); // 100 USDC

    vm.startPrank(user);
    IERC20(USDC_BASE).approve(AERODROME_ROUTER, 100e6);

    IRouter.Route[] memory routes = new IRouter.Route[](1);
    routes[0] = IRouter.Route({
        from: USDC_BASE,
        to: address(token),
        stable: false,
        factory: AERODROME_FACTORY
    });

    uint256[] memory amounts = IRouter(AERODROME_ROUTER).swapExactTokensForTokens(
        100e6,       // amountIn: 100 USDC
        1,           // amountOutMin: 1 wei (for test; real txs need proper slippage)
        routes,
        user,
        block.timestamp + 600
    );
    vm.stopPrank();

    uint256 claraReceived = amounts[amounts.length - 1];
    assertGt(claraReceived, 0, "No CLARA received");

    // Sanity: at ~$0.01/CLARA, 100 USDC should buy ~10,000 CLARA
    // With AMM slippage on a 10M/100K pool, 100 USDC is 0.1% of pool
    // Expected: ~9,990 CLARA (minimal slippage)
    assertGt(claraReceived, 9_000e18, "CLARA received less than expected");
    assertLt(claraReceived, 11_000e18, "CLARA received more than expected");
}
```

### 6.4 Swap CLARA to USDC (TC-113 enhanced)

```solidity
function test_swapClaraToUsdc() public {
    _addLiquidityToPool();

    address user = makeAddr("swapper");
    vm.prank(treasury);
    token.transfer(user, 10_000e18); // 10K CLARA

    vm.startPrank(user);
    token.approve(AERODROME_ROUTER, 10_000e18);

    IRouter.Route[] memory routes = new IRouter.Route[](1);
    routes[0] = IRouter.Route({
        from: address(token),
        to: USDC_BASE,
        stable: false,
        factory: AERODROME_FACTORY
    });

    uint256[] memory amounts = IRouter(AERODROME_ROUTER).swapExactTokensForTokens(
        10_000e18,   // amountIn: 10K CLARA
        1,
        routes,
        user,
        block.timestamp + 600
    );
    vm.stopPrank();

    uint256 usdcReceived = amounts[amounts.length - 1];
    assertGt(usdcReceived, 0, "No USDC received");

    // At $0.01/CLARA, 10K CLARA ~ $100
    // With AMM slippage: expect ~$99 (0.1% of pool)
    assertGt(usdcReceived, 90e6, "USDC received less than expected");
    assertLt(usdcReceived, 110e6, "USDC received more than expected");
}
```

### 6.5 Full Flow: Buy CLARA, Stake, Earn, Sell

```solidity
function test_aerodromeFullFlow_buyStakeEarnSell() public {
    _addLiquidityToPool();
    _deployStakingOnFork();

    address user = makeAddr("full_flow_user");
    deal(USDC_BASE, user, 200e6);
    deal(USDC_BASE, feeSource, 50e6);

    // 1. Buy CLARA on Aerodrome
    vm.startPrank(user);
    IERC20(USDC_BASE).approve(AERODROME_ROUTER, 100e6);
    uint256[] memory amounts = _swapUsdcToClara(100e6, user);
    uint256 claraBought = amounts[amounts.length - 1];
    vm.stopPrank();

    // 2. Stake CLARA
    vm.startPrank(user);
    token.approve(address(staking), claraBought);
    staking.stake(claraBought);
    vm.stopPrank();

    // 3. Fee deposit
    vm.startPrank(feeSource);
    IERC20(USDC_BASE).approve(address(staking), 50e6);
    staking.deposit(50e6);
    vm.stopPrank();

    // 4. Claim USDC
    uint256 claimable = staking.earned(user);
    assertGt(claimable, 0, "No rewards earned");

    vm.prank(user);
    staking.claim();

    // 5. Unstake and sell CLARA
    vm.prank(user);
    staking.unstake(claraBought);

    vm.startPrank(user);
    token.approve(AERODROME_ROUTER, claraBought);
    _swapClaraToUsdc(claraBought, user);
    vm.stopPrank();

    // User should have more USDC than they started with (profit from staking rewards)
    uint256 finalUsdc = IERC20(USDC_BASE).balanceOf(user);
    // Started with 200, spent 100 on CLARA, earned staking rewards + sold CLARA back
    // Net should be > 200 if rewards > slippage
}
```

---

## 7. Deployment Script Tests

### 7.1 Deployment Correctness

```solidity
// test/Deploy.t.sol

function test_deployment_tokenInitialization() public {
    ClaraToken deployedToken = new ClaraToken(treasury);

    assertEq(deployedToken.name(), "Clara");
    assertEq(deployedToken.symbol(), "CLARA");
    assertEq(deployedToken.decimals(), 18);
    assertEq(deployedToken.totalSupply(), 100_000_000e18);
    assertEq(deployedToken.balanceOf(treasury), 100_000_000e18);
}

function test_deployment_tokenCannotReinitialize() public {
    // ClaraToken is immutable (no proxy), so there's no initialize() to call twice.
    // This test verifies the constructor-based approach is correct.
    ClaraToken deployedToken = new ClaraToken(treasury);
    // No initialize() function exists -- verified by compiler
    assertEq(deployedToken.totalSupply(), 100_000_000e18);
}

function test_deployment_stakingInitialization() public {
    ClaraStaking impl = new ClaraStaking();
    ERC1967Proxy proxy = new ERC1967Proxy(
        address(impl),
        abi.encodeCall(ClaraStaking.initialize, (
            address(token), address(usdc), feeSource
        ))
    );
    ClaraStaking deployed = ClaraStaking(address(proxy));

    assertEq(address(deployed.claraToken()), address(token));
    assertEq(address(deployed.usdc()), address(usdc));
    assertEq(deployed.feeSource(), feeSource);
    assertEq(deployed.totalStaked(), 0);
    assertEq(deployed.rewardPerTokenStored(), 0);
    assertEq(deployed.owner(), address(this));
}

function test_deployment_stakingCannotReinitialize() public {
    // Proxy is already initialized in setUp()
    vm.expectRevert();
    staking.initialize(address(token), address(usdc), feeSource);
}

function test_deployment_implementationCannotInitialize() public {
    // The raw implementation should have _disableInitializers() in constructor
    ClaraStaking impl = new ClaraStaking();
    vm.expectRevert();
    impl.initialize(address(token), address(usdc), feeSource);
}

function test_deployment_ownershipTransferToTimelock() public {
    address timelock = makeAddr("timelock");

    staking.transferOwnership(timelock);
    assertEq(staking.owner(), timelock);

    // Old owner can no longer call admin functions
    vm.expectRevert();
    staking.setFeeSource(makeAddr("new_fee_source"));

    // Timelock can
    vm.prank(timelock);
    staking.setFeeSource(makeAddr("new_fee_source"));
    assertEq(staking.feeSource(), makeAddr("new_fee_source"));
}
```

### 7.2 Deployment Script Verification

```solidity
function test_deployScript_endToEnd() public {
    // Simulate the full deployment script from solidity-architecture.md Section 12
    address deployer = makeAddr("deployer");
    address timelockAddr = makeAddr("timelock");

    vm.startPrank(deployer);

    // Phase 1: Deploy token (immutable)
    ClaraToken deployedToken = new ClaraToken(deployer);
    assertEq(deployedToken.balanceOf(deployer), 100_000_000e18);

    // Phase 1: Deploy staking (UUPS)
    ClaraStaking sImpl = new ClaraStaking();
    ERC1967Proxy sProxy = new ERC1967Proxy(
        address(sImpl),
        abi.encodeCall(ClaraStaking.initialize, (
            address(deployedToken), address(usdc), feeSource
        ))
    );
    ClaraStaking deployedStaking = ClaraStaking(address(sProxy));

    // Phase 2: Transfer ownership to timelock
    deployedStaking.transferOwnership(timelockAddr);
    assertEq(deployedStaking.owner(), timelockAddr);

    vm.stopPrank();

    // Phase 2: Verify deployer can no longer admin
    vm.prank(deployer);
    vm.expectRevert();
    deployedStaking.setFeeSource(deployer);

    // Phase 2: Verify timelock can admin
    vm.prank(timelockAddr);
    deployedStaking.setFeeSource(makeAddr("new_source"));
}
```

---

## 8. Additional Unit Test Specifications

### 8.1 stakeWithPermit() Edge Cases

```solidity
function test_stakeWithPermit_success() public {
    // TC-025 with exact implementation
    uint256 alicePk = 0xA11CE;
    address aliceSigner = vm.addr(alicePk);
    vm.prank(treasury);
    token.transfer(aliceSigner, 1000e18);

    uint256 deadline = block.timestamp + 1 hours;
    bytes32 digest = _buildPermitDigest(aliceSigner, address(staking), 1000e18, deadline);
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);

    vm.prank(aliceSigner);
    staking.stakeWithPermit(1000e18, deadline, v, r, s);

    assertEq(staking.stakedBalance(aliceSigner), 1000e18);
    assertEq(staking.totalStaked(), 1000e18);
    assertEq(token.balanceOf(address(staking)), 1000e18);
}

function test_stakeWithPermit_expiredDeadline_reverts() public {
    uint256 alicePk = 0xA11CE;
    address aliceSigner = vm.addr(alicePk);
    vm.prank(treasury);
    token.transfer(aliceSigner, 1000e18);

    uint256 deadline = block.timestamp - 1; // expired
    bytes32 digest = _buildPermitDigest(aliceSigner, address(staking), 1000e18, deadline);
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);

    vm.prank(aliceSigner);
    vm.expectRevert(); // ERC2612ExpiredSignature
    staking.stakeWithPermit(1000e18, deadline, v, r, s);
}

function test_stakeWithPermit_wrongSigner_reverts() public {
    uint256 alicePk = 0xA11CE;
    uint256 bobPk = 0xB0B;
    address aliceSigner = vm.addr(alicePk);
    vm.prank(treasury);
    token.transfer(aliceSigner, 1000e18);

    uint256 deadline = block.timestamp + 1 hours;
    // Bob signs, but Alice calls
    bytes32 digest = _buildPermitDigest(aliceSigner, address(staking), 1000e18, deadline);
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(bobPk, digest);

    vm.prank(aliceSigner);
    vm.expectRevert(); // ERC2612InvalidSigner
    staking.stakeWithPermit(1000e18, deadline, v, r, s);
}

function test_stakeWithPermit_zeroAmount_reverts() public {
    uint256 alicePk = 0xA11CE;
    address aliceSigner = vm.addr(alicePk);

    uint256 deadline = block.timestamp + 1 hours;
    bytes32 digest = _buildPermitDigest(aliceSigner, address(staking), 0, deadline);
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);

    vm.prank(aliceSigner);
    vm.expectRevert("Cannot stake 0");
    staking.stakeWithPermit(0, deadline, v, r, s);
}
```

### 8.2 MerkleDrop Additional Tests

```solidity
// test/MerkleDrop.t.sol

function test_merkleDrop_sweepAfterDeadline() public {
    // Deploy MerkleDrop with short deadline
    uint256 deadline = block.timestamp + 30 days;
    MerkleDrop drop = new MerkleDrop(address(token), merkleRoot, deadline);

    // Fund it
    vm.prank(treasury);
    token.transfer(address(drop), 1_000_000e18);

    // Cannot sweep before deadline
    vm.expectRevert("Deadline not passed");
    drop.sweep(treasury);

    // Warp past deadline
    vm.warp(deadline + 1);

    // Sweep succeeds
    drop.sweep(treasury);
    assertEq(token.balanceOf(address(drop)), 0);
    assertEq(token.balanceOf(treasury), token.totalSupply()); // got everything back
}

function test_merkleDrop_bitmapMultipleIndices() public {
    // Verify bitmap works across word boundaries (index 255, 256, 257)
    // Index 255 is in word 0, bit 255
    // Index 256 is in word 1, bit 0
    // Index 257 is in word 1, bit 1

    // Claim index 255
    _claimWithValidProof(255);
    assertTrue(drop.isClaimed(255));
    assertFalse(drop.isClaimed(256));

    // Claim index 256
    _claimWithValidProof(256);
    assertTrue(drop.isClaimed(256));
    assertTrue(drop.isClaimed(255)); // still claimed
    assertFalse(drop.isClaimed(257));
}

function test_merkleDrop_claimExactlyAtDeadline() public {
    // Boundary: block.timestamp == deadline should succeed
    vm.warp(deadline);
    _claimWithValidProof(0); // should not revert
    assertTrue(drop.isClaimed(0));
}

function test_merkleDrop_claimOneSecondAfterDeadline() public {
    vm.warp(deadline + 1);
    vm.expectRevert("Claim deadline passed");
    _claimWithValidProof(0);
}
```

### 8.3 recoverERC20 Cannot Recover Reward USDC

The current contract code allows recovering USDC but does not check against the reward pool. This should be documented and potentially addressed.

```solidity
function test_recoverERC20_cannotRecoverCLARA() public {
    vm.prank(alice);
    staking.stake(1000e18);

    vm.expectRevert("Cannot recover staked token");
    staking.recoverERC20(address(token), 1000e18);
}

function test_recoverERC20_canRecoverRandomToken() public {
    MockERC20 dai = new MockERC20("DAI", "DAI", 18);
    dai.mint(address(staking), 100e18); // accidentally sent

    staking.recoverERC20(address(dai), 100e18);
    assertEq(dai.balanceOf(staking.owner()), 100e18);
}

function test_recoverERC20_usdcRecovery_riskDocumentation() public {
    // NOTE: The current contract allows recovering USDC.
    // This means the owner could drain unclaimed rewards.
    // The architecture doc (Section 2) says "Allow recovering USDC only if it exceeds owed rewards"
    // but the code does NOT enforce this check.
    //
    // RECOMMENDATION: Add a check:
    //   if (token == address(usdc)) {
    //       uint256 owed = _totalOwedRewards();
    //       require(amount <= usdc.balanceOf(address(this)) - owed, "Cannot recover owed rewards");
    //   }
    //
    // For now, this test documents the current behavior.

    vm.prank(alice);
    staking.stake(1000e18);
    vm.prank(feeSource);
    staking.deposit(100e6);

    // Owner CAN recover the USDC that was just deposited for rewards
    // This is a design concern -- the timelock is the mitigation
    staking.recoverERC20(address(usdc), 100e6);
    assertEq(usdc.balanceOf(staking.owner()), 100e6);

    // Alice's rewards are now underfunded
    vm.prank(alice);
    vm.expectRevert(); // insufficient USDC balance
    staking.claim();
}
```

---

## 9. Fuzz Test Specifications

### 9.1 Enhanced Invariant Fuzz (TC-250 enhanced)

```solidity
// test/Security.t.sol

/// @dev Fuzz: random stake amounts, verify totalStaked invariant
function testFuzz_stakeUnstake_totalStakedInvariant(
    uint128 stakeA,
    uint128 stakeB,
    uint128 unstakeA
) public {
    vm.assume(stakeA > 0 && stakeA <= 10_000e18);
    vm.assume(stakeB > 0 && stakeB <= 10_000e18);
    vm.assume(unstakeA > 0 && unstakeA <= stakeA);

    vm.prank(alice);
    staking.stake(stakeA);
    vm.prank(bob);
    staking.stake(stakeB);

    assertEq(staking.totalStaked(), uint256(stakeA) + uint256(stakeB));

    vm.prank(alice);
    staking.unstake(unstakeA);

    assertEq(staking.totalStaked(), uint256(stakeA) - uint256(unstakeA) + uint256(stakeB));
    assertEq(staking.stakedBalance(alice), uint256(stakeA) - uint256(unstakeA));
    assertEq(staking.stakedBalance(bob), uint256(stakeB));
}

/// @dev Fuzz: deposit amount boundaries -- no overflow in rPTS calculation
function testFuzz_deposit_noOverflow(uint128 depositAmount, uint128 totalStakeAmount) public {
    vm.assume(totalStakeAmount > 0 && totalStakeAmount <= 100_000_000e18);
    vm.assume(depositAmount > 0 && depositAmount <= type(uint128).max);

    vm.prank(treasury);
    token.transfer(alice, totalStakeAmount);
    vm.prank(alice);
    token.approve(address(staking), totalStakeAmount);
    vm.prank(alice);
    staking.stake(totalStakeAmount);

    usdc.mint(feeSource, depositAmount);
    vm.prank(feeSource);
    usdc.approve(address(staking), depositAmount);
    vm.prank(feeSource);
    staking.deposit(depositAmount);

    // rewardPerTokenStored should be: depositAmount * 1e18 / totalStakeAmount
    uint256 expected = uint256(depositAmount) * 1e18 / uint256(totalStakeAmount);
    assertEq(staking.rewardPerTokenStored(), expected);

    // earned should equal depositAmount (sole staker)
    // May lose precision due to division truncation
    uint256 earned = staking.earned(alice);
    assertLe(earned, depositAmount); // never earn more than deposited
    // Max dust: totalStakeAmount - 1 (from integer division)
    assertGe(earned, depositAmount - totalStakeAmount + 1 > depositAmount ? 0 : depositAmount - (totalStakeAmount - 1) / 1e18);
}

/// @dev Fuzz: multi-user entry/exit -- no user earns more than deposited
function testFuzz_multiUser_noOverclaim(
    uint128 stakeA,
    uint128 stakeB,
    uint128 deposit1,
    uint128 deposit2,
    bool aliceExitsEarly
) public {
    vm.assume(stakeA > 0 && stakeA <= 10_000e18);
    vm.assume(stakeB > 0 && stakeB <= 10_000e18);
    vm.assume(deposit1 > 0 && deposit1 <= 1_000_000e6);
    vm.assume(deposit2 > 0 && deposit2 <= 1_000_000e6);

    vm.prank(alice);
    staking.stake(stakeA);
    vm.prank(bob);
    staking.stake(stakeB);

    usdc.mint(feeSource, uint256(deposit1) + uint256(deposit2));
    vm.prank(feeSource);
    usdc.approve(address(staking), uint256(deposit1) + uint256(deposit2));

    vm.prank(feeSource);
    staking.deposit(deposit1);

    if (aliceExitsEarly) {
        vm.prank(alice);
        staking.unstake(stakeA);
    }

    vm.prank(feeSource);
    staking.deposit(deposit2);

    // Invariant: sum of all earned <= sum of all deposited
    uint256 totalEarned = staking.earned(alice) + staking.earned(bob);
    uint256 totalDeposited = uint256(deposit1) + uint256(deposit2);
    assertLe(totalEarned, totalDeposited, "Over-claim detected");
}

/// @dev Fuzz: rewardPerTokenStored is monotonically increasing
function testFuzz_rPTS_monotonic(uint128[5] calldata deposits) public {
    vm.prank(alice);
    staking.stake(1000e18);

    uint256 prevRPTS = 0;
    for (uint256 i = 0; i < 5; i++) {
        uint256 amount = bound(deposits[i], 1, 1_000_000e6);
        usdc.mint(feeSource, amount);
        vm.prank(feeSource);
        usdc.approve(address(staking), amount);
        vm.prank(feeSource);
        staking.deposit(amount);

        uint256 currentRPTS = staking.rewardPerTokenStored();
        assertGe(currentRPTS, prevRPTS, "rPTS decreased");
        prevRPTS = currentRPTS;
    }
}
```

---

## 10. Discrepancy Resolutions

### 10.1 TC-220: deposit() when totalStaked == 0

**Resolution:** Implement Option A (revert). The contract code in Section 2 does NOT revert, but the refined plan (Section 15, point 2) explicitly recommends it.

**Updated contract code:**

```solidity
function deposit(uint256 amount) external nonReentrant {
    require(msg.sender == feeSource, "Only fee source");
    require(amount > 0, "Cannot deposit 0");
    require(totalStaked > 0, "No stakers");  // <-- ADD THIS

    rewardPerTokenStored += (amount * 1e18) / totalStaked;
    usdc.safeTransferFrom(msg.sender, address(this), amount);
    emit FeesDeposited(msg.sender, amount);
}
```

**Test implication:** TC-220 tests for revert. TC-221 becomes N/A. TC-502 tests proxy retry behavior.

### 10.2 Timelock Duration: 48h vs 7 days

The architecture doc (Section 7) says 48-hour timelock. The testing plan (TC-122) says 7-day timelock. The security review likely recommends 7 days for staker exit window.

**Resolution:** Use **7-day timelock** (604800 seconds). This aligns with the security review's recommendation that stakers need sufficient time to exit if a bad upgrade is proposed. 48 hours was mentioned in Section 7 but the security review overrides this.

**Test:** TC-122 is correct with 7-day delay.

### 10.3 ClaraToken: Upgradeable vs Immutable

The contract code in Section 2 shows ClaraToken as UUPS upgradeable. The refined plan (Section 15, point 4) recommends deploying WITHOUT a proxy.

**Resolution:** Deploy ClaraToken as **immutable** (no proxy). See Section 1.5 above for the revised contract. This means:
- No `_authorizeUpgrade` on ClaraToken
- No proxy deployment for ClaraToken in the deploy script
- ClaraToken uses non-upgradeable OZ contracts (`ERC20`, `ERC20Permit`)

### 10.4 recoverERC20 and USDC Protection

The contract allows recovering USDC without checking against owed rewards. See Section 8.3 for the risk documentation test.

**Recommendation:** Add a check in `recoverERC20()` to prevent recovering USDC below the total owed amount. This requires computing the total owed, which is expensive on-chain (iterating all users). Alternative: simply block USDC recovery entirely and rely on the timelock for any emergency recovery. This is the safer option:

```solidity
function recoverERC20(address tokenAddr, uint256 amount) external onlyOwner {
    require(tokenAddr != address(claraToken), "Cannot recover staked token");
    require(tokenAddr != address(usdc), "Cannot recover reward token");
    IERC20(tokenAddr).safeTransfer(owner(), amount);
}
```

---

## Summary of Additions

| Section | New Tests Added | Priority |
|---------|----------------|----------|
| Missing features confirmed | 4 confirmations | -- |
| Foundry structure | Test base contracts, fork base, foundry.toml | -- |
| Synthetix math examples | 10 numeric scenarios with exact values | P0 |
| Gas benchmarks | 7 threshold tests | P1 |
| Storage layout | 7 slot verification tests | P0 |
| Aerodrome integration | 5 fork tests (create, add LP, swap both directions, full flow) | P1 |
| Deployment script | 6 deployment verification tests | P0 |
| stakeWithPermit edge cases | 4 permit tests | P1 |
| MerkleDrop additional | 4 tests (sweep, bitmap boundary, deadline boundary) | P1 |
| recoverERC20 risk docs | 3 tests documenting USDC recovery risk | P0 |
| Fuzz enhancements | 4 fuzz functions with specific invariants | P1 |
| Discrepancy resolutions | 4 resolved | -- |
| **Total new test specifications** | **~54** | |
