// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/// @title GasBenchmark
/// @notice Gas cost verification for all ClaraStaking user-facing operations.
/// @dev Each test measures gas usage and asserts it stays under the budget.
///      Gas budgets are conservative upper bounds — actual costs should be well below.
contract GasBenchmarkTest is ClaraTestBase {

    // ========================================================================
    // GB-001: stake() gas benchmark
    // ========================================================================

    /// @notice GB-001: stake() should cost <= 130,000 gas [P0]
    /// @dev First stake hits cold SSTORE for stakedBalance + totalStaked, so budget is higher.
    ///      Warm-path (subsequent stakes) tested separately in GB-001b.
    function test_GB001_stakeGas() public {
        vm.prank(alice);
        uint256 gasBefore = gasleft();
        staking.stake(1000e18);
        uint256 gasUsed = gasBefore - gasleft();

        assertLe(gasUsed, 130_000, "stake() exceeds gas budget of 130k");
    }

    /// @notice GB-001b: stake() gas for second staker (non-cold storage)
    function test_GB001b_stakeGasSecondStaker() public {
        // First staker warms up storage
        vm.prank(alice);
        staking.stake(1000e18);

        vm.prank(bob);
        uint256 gasBefore = gasleft();
        staking.stake(1000e18);
        uint256 gasUsed = gasBefore - gasleft();

        assertLe(gasUsed, 110_000, "stake() second staker exceeds gas budget of 110k");
    }

    // ========================================================================
    // GB-002: unstake() gas benchmark
    // ========================================================================

    /// @notice GB-002: unstake() should cost <= 90,000 gas [P0]
    function test_GB002_unstakeGas() public {
        // Prerequisite: alice has staked
        vm.prank(alice);
        staking.stake(5000e18);

        vm.prank(alice);
        uint256 gasBefore = gasleft();
        staking.unstake(2000e18);
        uint256 gasUsed = gasBefore - gasleft();

        assertLe(gasUsed, 90_000, "unstake() exceeds gas budget of 90k");
    }

    // ========================================================================
    // GB-003: claim() gas benchmark
    // ========================================================================

    /// @notice GB-003: claim() should cost <= 75,000 gas [P0]
    /// @dev claim() includes SSTORE for rewards reset + USDC safeTransfer + updateReward modifier.
    function test_GB003_claimGas() public {
        // Prerequisite: alice has staked and there are rewards to claim
        vm.prank(alice);
        staking.stake(1000e18);

        vm.prank(feeSource);
        staking.deposit(100e6);

        // Verify alice has rewards
        assertTrue(staking.earned(alice) > 0, "Precondition: alice has rewards");

        vm.prank(alice);
        uint256 gasBefore = gasleft();
        staking.claim();
        uint256 gasUsed = gasBefore - gasleft();

        assertLe(gasUsed, 75_000, "claim() exceeds gas budget of 75k");
    }

    // ========================================================================
    // GB-004: exit() gas benchmark
    // ========================================================================

    /// @notice GB-004: exit() should cost <= 130,000 gas [P0]
    function test_GB004_exitGas() public {
        // Prerequisite: alice has staked and has rewards
        vm.prank(alice);
        staking.stake(1000e18);

        vm.prank(feeSource);
        staking.deposit(100e6);

        vm.prank(alice);
        uint256 gasBefore = gasleft();
        staking.exit();
        uint256 gasUsed = gasBefore - gasleft();

        assertLe(gasUsed, 130_000, "exit() exceeds gas budget of 130k");
    }

    // ========================================================================
    // GB-005: deposit() gas benchmark
    // ========================================================================

    /// @notice GB-005: deposit() should cost <= 70,000 gas [P0]
    function test_GB005_depositGas() public {
        // Prerequisite: there is at least one staker
        vm.prank(alice);
        staking.stake(1000e18);

        vm.prank(feeSource);
        uint256 gasBefore = gasleft();
        staking.deposit(100e6);
        uint256 gasUsed = gasBefore - gasleft();

        assertLe(gasUsed, 70_000, "deposit() exceeds gas budget of 70k");
    }

    // ========================================================================
    // GB-006: earned() view gas benchmark
    // ========================================================================

    /// @notice GB-006: earned() should cost <= 8,000 gas [P0]
    function test_GB006_earnedViewGas() public {
        // Set up state so earned() has values to compute
        vm.prank(alice);
        staking.stake(1000e18);
        vm.prank(feeSource);
        staking.deposit(100e6);

        uint256 gasBefore = gasleft();
        staking.earned(alice);
        uint256 gasUsed = gasBefore - gasleft();

        assertLe(gasUsed, 8_000, "earned() exceeds gas budget of 8k");
    }

    // ========================================================================
    // GB-007: stakeWithPermit() gas benchmark
    // ========================================================================

    /// @notice GB-007: stakeWithPermit() should cost <= 170,000 gas [P0]
    /// @dev Includes ECRECOVER for permit verification + cold-path stake SSTOREs.
    function test_GB007_stakeWithPermitGas() public {
        // Use a fresh account with a known private key for permit signing
        uint256 ownerPk = 0xA11CE;
        address permitUser = vm.addr(ownerPk);

        // Give permitUser some CLARA tokens
        vm.prank(treasury);
        token.transfer(permitUser, 5000e18);

        // Build the permit signature
        uint256 stakeAmount = 1000e18;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = token.nonces(permitUser);

        bytes32 permitTypehash = keccak256(
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        );

        bytes32 structHash = keccak256(
            abi.encode(
                permitTypehash,
                permitUser,
                address(staking),
                stakeAmount,
                nonce,
                deadline
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);

        vm.prank(permitUser);
        uint256 gasBefore = gasleft();
        staking.stakeWithPermit(stakeAmount, deadline, v, r, s);
        uint256 gasUsed = gasBefore - gasleft();

        assertLe(gasUsed, 170_000, "stakeWithPermit() exceeds gas budget of 170k");

        // Verify the stake actually succeeded
        assertEq(staking.stakedBalance(permitUser), stakeAmount, "Permit user should have staked");
    }
}
