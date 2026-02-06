// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";

/// @title Integration Tests for ClaraStaking reward distribution
/// @notice Covers TC-100 through TC-106: single/multi-staker flows,
///         partial unstake, claim-then-re-earn, and deposit-triggered accrual.
contract IntegrationTest is ClaraTestBase {
    // ─────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────

    /// @dev feeSource deposits `amount` USDC into staking
    function _deposit(uint256 amount) internal {
        vm.prank(feeSource);
        staking.deposit(amount);
    }

    /// @dev `user` stakes `amount` CLARA
    function _stake(address user, uint256 amount) internal {
        vm.prank(user);
        staking.stake(amount);
    }

    /// @dev `user` unstakes `amount` CLARA
    function _unstake(address user, uint256 amount) internal {
        vm.prank(user);
        staking.unstake(amount);
    }

    /// @dev `user` claims accrued USDC rewards
    function _claim(address user) internal {
        vm.prank(user);
        staking.claim();
    }

    // ═════════════════════════════════════════════════════
    // P0 Tests
    // ═════════════════════════════════════════════════════

    /// @notice TC-100: Single staker earns 100% of deposited fees
    /// Alice stakes 10_000e18 (sole staker). FeeSource deposits 100e6 USDC.
    /// earned(alice) = 10_000e18 * (100e6 * 1e18 / 10_000e18) / 1e18 = 100e6
    function test_TC100_singleStakerFullReward() public {
        _stake(alice, 10_000e18);
        _deposit(100e6);

        uint256 aliceEarned = staking.earned(alice);
        assertEq(aliceEarned, 100e6, "Alice should earn all 100 USDC");
    }

    /// @notice TC-101: Multiple sequential deposits accumulate for sole staker
    /// Alice stakes 1000e18. Deposits: 10e6, 20e6, 30e6 USDC.
    /// rPTS = (10e6*1e18/1000e18) + (20e6*1e18/1000e18) + (30e6*1e18/1000e18)
    ///      = 10_000 + 20_000 + 30_000 = 60_000
    /// earned(alice) = 1000e18 * 60_000 / 1e18 = 60e6
    function test_TC101_sequentialDeposits() public {
        _stake(alice, 1000e18);

        _deposit(10e6);
        _deposit(20e6);
        _deposit(30e6);

        uint256 aliceEarned = staking.earned(alice);
        assertEq(aliceEarned, 60e6, "Alice should earn 60 USDC across 3 deposits");
    }

    /// @notice TC-102: Pro-rata distribution among 3 stakers
    /// Alice=500e18, Bob=300e18, Charlie=200e18 (total=1000e18). Deposit 100e6 USDC.
    /// earned(alice)=50e6, bob=30e6, charlie=20e6
    function test_TC102_proRataThreeStakers() public {
        _stake(alice, 500e18);
        _stake(bob, 300e18);
        _stake(charlie, 200e18);

        _deposit(100e6);

        assertEq(staking.earned(alice), 50e6, "Alice should earn 50 USDC");
        assertEq(staking.earned(bob), 30e6, "Bob should earn 30 USDC");
        assertEq(staking.earned(charlie), 20e6, "Charlie should earn 20 USDC");
    }

    // ═════════════════════════════════════════════════════
    // P1 Tests
    // ═════════════════════════════════════════════════════

    /// @notice TC-103: Late joiner dilutes future rewards but not past
    /// Alice stakes 1000e18. Deposit 100e6 USDC. Bob stakes 1000e18. Deposit 100e6 USDC.
    /// After first deposit: rPTS = 100e6*1e18/1000e18 = 100_000
    /// After Bob stakes: totalStaked = 2000e18
    /// After second deposit: rPTS += 100e6*1e18/2000e18 = 50_000 => total rPTS = 150_000
    /// earned(alice) = 1000e18 * 150_000 / 1e18 = 150e6
    /// earned(bob) = 1000e18 * (150_000 - 100_000) / 1e18 = 50e6
    function test_TC103_lateJoinerDilution() public {
        _stake(alice, 1000e18);
        _deposit(100e6);

        _stake(bob, 1000e18);
        _deposit(100e6);

        assertEq(staking.earned(alice), 150e6, "Alice should earn 150 USDC");
        assertEq(staking.earned(bob), 50e6, "Bob should earn 50 USDC");
    }

    /// @notice TC-104: Unstaker freezes rewards, remaining staker earns more
    /// Alice and Bob each stake 500e18. Deposit 100e6. Alice unstakes. Deposit 100e6.
    /// After first deposit: rPTS = 100e6*1e18/1000e18 = 100_000
    ///   earned(alice) = 500e18 * 100_000 / 1e18 = 50e6
    ///   earned(bob) = 500e18 * 100_000 / 1e18 = 50e6
    /// Alice unstakes: her rewards[alice] = 50e6 (frozen), stakedBalance = 0
    /// After second deposit: totalStaked = 500e18
    ///   rPTS += 100e6*1e18/500e18 = 200_000 => total rPTS = 300_000
    /// earned(alice) = 0 * (300_000 - 100_000)/1e18 + 50e6 = 50e6 (frozen)
    /// earned(bob) = 500e18 * (300_000 - 100_000)/1e18 + 50e6 = 100e6 + 50e6 = 150e6
    function test_TC104_unstakeFreezesRewards() public {
        _stake(alice, 500e18);
        _stake(bob, 500e18);
        _deposit(100e6);

        _unstake(alice, 500e18);
        _deposit(100e6);

        assertEq(staking.earned(alice), 50e6, "Alice rewards frozen at 50 USDC");
        assertEq(staking.earned(bob), 150e6, "Bob should earn 150 USDC");
    }

    /// @notice TC-105: Partial unstake + new staker
    /// Alice stakes 1000e18 (sole). Deposit 50e6.
    ///   earned(alice) = 50e6
    /// Alice unstakes 500. Bob stakes 500. totalStaked = 1000.
    ///   Alice stakedBalance = 500, rewards[alice] = 50e6
    /// Deposit 100e6 => rPTS += 100e6*1e18/1000e18 = 100_000
    ///   earned(alice) = 500e18 * 100_000/1e18 + 50e6 = 50e6 + 50e6 = 100e6
    ///   earned(bob) = 500e18 * 100_000/1e18 = 50e6
    function test_TC105_partialUnstakeNewStaker() public {
        _stake(alice, 1000e18);
        _deposit(50e6);

        _unstake(alice, 500e18);
        _stake(bob, 500e18);
        _deposit(100e6);

        assertEq(staking.earned(alice), 100e6, "Alice should earn 100 USDC");
        assertEq(staking.earned(bob), 50e6, "Bob should earn 50 USDC");
    }

    /// @notice TC-106: Claim resets earned without affecting stake
    /// Alice stakes 1000e18 (sole). Deposit 100e6. Alice claims -> 100 USDC.
    /// stakedBalance unchanged. Deposit 100e6 more. earned(alice) = 100e6 again.
    function test_TC106_claimDoesNotAffectStake() public {
        _stake(alice, 1000e18);
        _deposit(100e6);

        // Verify earned before claim
        assertEq(staking.earned(alice), 100e6, "Pre-claim earned");

        uint256 usdcBefore = usdc.balanceOf(alice);
        _claim(alice);
        uint256 usdcAfter = usdc.balanceOf(alice);

        // Alice received 100 USDC
        assertEq(usdcAfter - usdcBefore, 100e6, "Alice should receive 100 USDC");

        // Earned is now 0
        assertEq(staking.earned(alice), 0, "Earned should be 0 after claim");

        // Staked balance unchanged
        assertEq(staking.stakedBalance(alice), 1000e18, "Staked balance unchanged");

        // Deposit another 100 USDC — Alice earns again
        _deposit(100e6);
        assertEq(staking.earned(alice), 100e6, "Alice earns 100 USDC again");
    }
}
