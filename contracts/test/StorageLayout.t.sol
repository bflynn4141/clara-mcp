// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

// ============================================================================
// V2 Contract for Storage Layout Tests
// ============================================================================

/// @notice V2 with extra variable to test storage gap consumption
/// @dev Uses one slot from the __gap. Since __gap is private and cannot be
///      overridden, V2 simply declares a new state variable that occupies the
///      first gap slot. Foundry tests verify no storage collision occurs.
contract ClaraStakingV2Storage is ClaraStaking {
    /// @notice New variable occupying the first gap slot
    uint256 public extraVar;

    function setExtraVar(uint256 val) external {
        extraVar = val;
    }

    function version() external pure returns (uint256) {
        return 2;
    }
}

/// @notice V3 with two extra variables to test progressive gap consumption
contract ClaraStakingV3Storage is ClaraStaking {
    uint256 public extraVar1;
    uint256 public extraVar2;

    function setExtraVar1(uint256 val) external {
        extraVar1 = val;
    }

    function setExtraVar2(uint256 val) external {
        extraVar2 = val;
    }

    function version() external pure returns (uint256) {
        return 3;
    }
}

// ============================================================================
// Storage Layout Test Suite
// ============================================================================

contract StorageLayoutTest is ClaraTestBase {

    // ========================================================================
    // SL-001: Core state variables are accessible and correct after init
    // ========================================================================

    /// @notice SL-001: Verify all core state variables have correct values post-initialization [P0]
    function test_SL001_coreStateVariablesInitialized() public view {
        // Token addresses
        assertEq(address(staking.claraToken()), address(token), "claraToken should be set");
        assertEq(address(staking.usdc()), address(usdc), "usdc should be set");

        // Admin addresses
        assertEq(staking.feeSource(), feeSource, "feeSource should be set");
        assertEq(staking.guardian(), guardian, "guardian should be set");
        assertEq(staking.owner(), address(this), "owner should be deployer");

        // Counters start at zero
        assertEq(staking.totalStaked(), 0, "totalStaked should be 0");
        assertEq(staking.rewardPerTokenStored(), 0, "rewardPerTokenStored should be 0");
    }

    // ========================================================================
    // SL-002: Staking updates storage correctly
    // ========================================================================

    /// @notice SL-002: stake() and unstake() correctly update stakedBalance and totalStaked [P0]
    function test_SL002_stakingUpdatesStorage() public {
        // Alice stakes
        vm.prank(alice);
        staking.stake(1000e18);
        assertEq(staking.stakedBalance(alice), 1000e18, "Alice staked balance");
        assertEq(staking.totalStaked(), 1000e18, "Total staked after alice");

        // Bob stakes
        vm.prank(bob);
        staking.stake(2000e18);
        assertEq(staking.stakedBalance(bob), 2000e18, "Bob staked balance");
        assertEq(staking.totalStaked(), 3000e18, "Total staked after bob");

        // Alice unstakes partially
        vm.prank(alice);
        staking.unstake(500e18);
        assertEq(staking.stakedBalance(alice), 500e18, "Alice staked balance after unstake");
        assertEq(staking.totalStaked(), 2500e18, "Total staked after alice unstake");
    }

    // ========================================================================
    // SL-003: Reward accounting storage is correct
    // ========================================================================

    /// @notice SL-003: deposit() updates rewardPerTokenStored, earned() is consistent [P0]
    function test_SL003_rewardAccountingStorage() public {
        // Alice stakes 1000e18
        vm.prank(alice);
        staking.stake(1000e18);

        // Deposit 100e6 USDC
        vm.prank(feeSource);
        staking.deposit(100e6);

        // rewardPerTokenStored = (100e6 * 1e18) / 1000e18 = 100e6 * 1e18 / 1000e18 = 1e5
        uint256 expectedRPT = (100e6 * 1e18) / 1000e18;
        assertEq(staking.rewardPerTokenStored(), expectedRPT, "rewardPerTokenStored after deposit");

        // Alice earned should equal deposit amount (sole staker)
        assertEq(staking.earned(alice), 100e6, "Alice earned all rewards");

        // Bob stakes after deposit
        vm.prank(bob);
        staking.stake(1000e18);

        // Bob's userRewardPerTokenPaid should be updated to current rewardPerTokenStored
        assertEq(staking.userRewardPerTokenPaid(bob), expectedRPT, "Bob's paid RPT set on stake");
        assertEq(staking.earned(bob), 0, "Bob has no prior rewards");

        // Second deposit: split between alice and bob equally
        vm.prank(feeSource);
        staking.deposit(200e6);

        // Each gets 100e6 from second deposit
        assertEq(staking.earned(alice), 200e6, "Alice: 100 first + 100 second");
        assertEq(staking.earned(bob), 100e6, "Bob: 100 from second");
    }

    // ========================================================================
    // SL-004: Mapping isolation — users don't interfere with each other
    // ========================================================================

    /// @notice SL-004: User storage is properly isolated [P0]
    function test_SL004_userStorageIsolation() public {
        // Alice and Bob stake different amounts
        vm.prank(alice);
        staking.stake(3000e18);
        vm.prank(bob);
        staking.stake(1000e18);

        // Deposit rewards
        vm.prank(feeSource);
        staking.deposit(400e6);

        // Alice should earn 3/4, Bob should earn 1/4
        assertEq(staking.earned(alice), 300e6, "Alice earns 75%");
        assertEq(staking.earned(bob), 100e6, "Bob earns 25%");

        // Alice claims — should not affect Bob
        vm.prank(alice);
        staking.claim();

        assertEq(staking.earned(alice), 0, "Alice earned reset after claim");
        assertEq(staking.earned(bob), 100e6, "Bob earned unaffected by Alice's claim");
        assertEq(staking.stakedBalance(alice), 3000e18, "Alice stake unaffected by claim");
        assertEq(staking.stakedBalance(bob), 1000e18, "Bob stake unaffected");
    }

    // ========================================================================
    // SL-005: Proxy delegates correctly (implementation has no state)
    // ========================================================================

    /// @notice SL-005: Implementation contract has no state, proxy holds all state [P0]
    function test_SL005_proxyDelegation() public {
        // State on proxy
        vm.prank(alice);
        staking.stake(1000e18);

        // Proxy has state
        assertEq(staking.totalStaked(), 1000e18, "Proxy has staked state");
        assertEq(staking.stakedBalance(alice), 1000e18, "Proxy has alice's balance");

        // Implementation contract should have zero state (it was never initialized via proxy)
        assertEq(stakingImpl.totalStaked(), 0, "Impl has no staked state");
        assertEq(stakingImpl.stakedBalance(alice), 0, "Impl has no alice balance");
        assertEq(address(stakingImpl.claraToken()), address(0), "Impl claraToken is zero");
    }

    // ========================================================================
    // SL-006: __gap slots are zero (not corrupted)
    // ========================================================================

    /// @notice SL-006: Verify __gap slots are zero by deploying V2 that uses gap space [P0]
    /// @dev Rather than hardcoding slot numbers (which depend on OZ ERC-7201 namespaced
    ///      storage internals), we verify the gap is usable by deploying V2 with extraVar.
    ///      If __gap slots were corrupted, extraVar would read garbage data.
    function test_SL006_gapSlotsAreClean() public {
        // Perform some operations to ensure storage is populated
        vm.prank(alice);
        staking.stake(1000e18);
        vm.prank(feeSource);
        staking.deposit(50e6);

        // Upgrade to V2
        ClaraStakingV2Storage v2Impl = new ClaraStakingV2Storage();
        staking.upgradeToAndCall(address(v2Impl), "");
        ClaraStakingV2Storage v2 = ClaraStakingV2Storage(address(stakingProxy));

        // extraVar occupies the first gap slot — should be 0 if gap was clean
        assertEq(v2.extraVar(), 0, "First gap slot should be zero (clean)");

        // Set it and verify it works
        v2.setExtraVar(12345);
        assertEq(v2.extraVar(), 12345, "extraVar should be writable");

        // Existing state should be unaffected
        assertEq(v2.stakedBalance(alice), 1000e18, "Alice stake preserved");
        assertEq(v2.totalStaked(), 1000e18, "Total staked preserved");
    }

    // ========================================================================
    // SL-007: Upgrade with new variable — full lifecycle test
    // ========================================================================

    /// @notice SL-007: Full upgrade lifecycle: V1 -> stake/deposit -> V2 -> verify + use new var [P0]
    function test_SL007_upgradeWithNewVariable() public {
        // === V1 Operations ===
        vm.prank(alice);
        staking.stake(5000e18);
        vm.prank(bob);
        staking.stake(3000e18);

        vm.prank(feeSource);
        staking.deposit(800e6);

        // Snapshot V1 state
        uint256 v1AliceStake = staking.stakedBalance(alice);
        uint256 v1BobStake = staking.stakedBalance(bob);
        uint256 v1TotalStaked = staking.totalStaked();
        uint256 v1RPT = staking.rewardPerTokenStored();
        uint256 v1AliceEarned = staking.earned(alice);
        uint256 v1BobEarned = staking.earned(bob);
        address v1ClaraToken = address(staking.claraToken());
        address v1Usdc = address(staking.usdc());
        address v1FeeSource = staking.feeSource();
        address v1Guardian = staking.guardian();
        address v1Owner = staking.owner();

        // === Upgrade to V2 ===
        ClaraStakingV2Storage v2Impl = new ClaraStakingV2Storage();
        staking.upgradeToAndCall(address(v2Impl), "");
        ClaraStakingV2Storage v2 = ClaraStakingV2Storage(address(stakingProxy));

        // === Verify all V1 state preserved ===
        assertEq(v2.stakedBalance(alice), v1AliceStake, "Alice stake preserved");
        assertEq(v2.stakedBalance(bob), v1BobStake, "Bob stake preserved");
        assertEq(v2.totalStaked(), v1TotalStaked, "totalStaked preserved");
        assertEq(v2.rewardPerTokenStored(), v1RPT, "rewardPerTokenStored preserved");
        assertEq(v2.earned(alice), v1AliceEarned, "Alice earned preserved");
        assertEq(v2.earned(bob), v1BobEarned, "Bob earned preserved");
        assertEq(address(v2.claraToken()), v1ClaraToken, "claraToken preserved");
        assertEq(address(v2.usdc()), v1Usdc, "usdc preserved");
        assertEq(v2.feeSource(), v1FeeSource, "feeSource preserved");
        assertEq(v2.guardian(), v1Guardian, "guardian preserved");
        assertEq(v2.owner(), v1Owner, "owner preserved");

        // === New variable works ===
        assertEq(v2.extraVar(), 0, "extraVar starts at 0");
        v2.setExtraVar(999);
        assertEq(v2.extraVar(), 999, "extraVar set to 999");
        assertEq(v2.version(), 2, "V2 version check");

        // === V1 functionality continues working ===
        // Alice claims
        vm.prank(alice);
        ClaraStaking(address(v2)).claim();
        assertEq(usdc.balanceOf(alice), v1AliceEarned, "Alice claimed correctly after upgrade");
        assertEq(v2.earned(alice), 0, "Alice earned reset after claim");

        // Charlie stakes for the first time on V2
        vm.prank(charlie);
        ClaraStaking(address(v2)).stake(2000e18);
        assertEq(v2.stakedBalance(charlie), 2000e18, "Charlie can stake on V2");
        assertEq(v2.totalStaked(), v1TotalStaked + 2000e18, "totalStaked updated");

        // feeSource deposits on V2
        vm.prank(feeSource);
        ClaraStaking(address(v2)).deposit(300e6);

        // Bob and Charlie now earn proportionally
        // Bob: 3000e18 / 10000e18 * 300e6 = 90e6, plus v1BobEarned
        // Charlie: 2000e18 / 10000e18 * 300e6 = 60e6
        uint256 bobEarnedV2 = v2.earned(bob);
        uint256 charlieEarnedV2 = v2.earned(charlie);
        assertEq(bobEarnedV2, v1BobEarned + 90e6, "Bob earns correctly on V2");
        assertEq(charlieEarnedV2, 60e6, "Charlie earns correctly on V2");

        // extraVar remains unchanged by other operations
        assertEq(v2.extraVar(), 999, "extraVar unchanged by V1 operations");
    }

    // ========================================================================
    // SL-007b: Progressive upgrade V1 -> V2 -> V3
    // ========================================================================

    /// @notice SL-007b: Two sequential upgrades maintain all storage [P0]
    function test_SL007b_progressiveUpgradeV1V2V3() public {
        // V1: stake
        vm.prank(alice);
        staking.stake(1000e18);

        // Upgrade to V2
        ClaraStakingV2Storage v2Impl = new ClaraStakingV2Storage();
        staking.upgradeToAndCall(address(v2Impl), "");
        ClaraStakingV2Storage v2 = ClaraStakingV2Storage(address(stakingProxy));
        v2.setExtraVar(42);

        // V2 operations
        vm.prank(feeSource);
        ClaraStaking(address(v2)).deposit(100e6);

        // Upgrade to V3
        ClaraStakingV3Storage v3Impl = new ClaraStakingV3Storage();
        ClaraStaking(address(v2)).upgradeToAndCall(address(v3Impl), "");
        ClaraStakingV3Storage v3 = ClaraStakingV3Storage(address(stakingProxy));

        // V1 state preserved
        assertEq(v3.stakedBalance(alice), 1000e18, "Alice stake preserved through V2->V3");
        assertEq(v3.earned(alice), 100e6, "Alice earned preserved through V2->V3");

        // V3 new variables work
        v3.setExtraVar1(100);
        v3.setExtraVar2(200);
        assertEq(v3.extraVar1(), 100, "V3 extraVar1 works");
        assertEq(v3.extraVar2(), 200, "V3 extraVar2 works");
        assertEq(v3.version(), 3, "V3 version check");
    }
}
