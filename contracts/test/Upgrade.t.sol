// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";

/// @notice V2 implementation for upgrade testing
/// @dev Inherits all ClaraStaking logic, adds version() and newVariable.
///      The _disableInitializers() in ClaraStaking's constructor also fires here
///      so V2 impl cannot be initialized directly — which is correct for UUPS.
contract ClaraStakingV2 is ClaraStaking {
    uint256 public newVariable;

    function version() external pure returns (uint256) {
        return 2;
    }

    function setNewVariable(uint256 val) external {
        newVariable = val;
    }
}

/// @title Upgrade Tests for ClaraStaking (UUPS proxy)
/// @notice Covers TC-120 through TC-123: state preservation, access control,
///         timelock-gated upgrades, and implementation initializer lockdown.
contract UpgradeTest is ClaraTestBase {
    ClaraStakingV2 public v2Impl;
    TimelockController public timelock;

    address public proposer = makeAddr("proposer");
    address public executor = makeAddr("executor");

    uint256 public constant TIMELOCK_DELAY = 7 days;

    function setUp() public override {
        super.setUp();

        // Deploy V2 implementation
        v2Impl = new ClaraStakingV2();

        // Set up some staking state for snapshot tests
        vm.prank(alice);
        staking.stake(5_000e18);

        vm.prank(bob);
        staking.stake(3_000e18);

        // Deposit some USDC rewards
        vm.prank(feeSource);
        staking.deposit(100e6);
    }

    /// @dev Deploy a TimelockController with 7-day delay, proposer/executor roles
    function _deployTimelock() internal returns (TimelockController) {
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = executor;

        return new TimelockController(
            TIMELOCK_DELAY,
            proposers,
            executors,
            address(0) // no admin
        );
    }

    // ═════════════════════════════════════════════════════
    // TC-120: State preservation across upgrade
    // ═════════════════════════════════════════════════════

    /// @notice TC-120: Upgrade preserves all storage
    /// Snapshot: totalStaked, rewardPerTokenStored, stakedBalance(alice/bob),
    /// earned(alice/bob), feeSource, guardian, claraToken, usdc, owner.
    /// Upgrade to V2. Verify all state unchanged. V2's version() returns 2.
    function test_TC120_statePreservation() public {
        // ── Snapshot state before upgrade ──
        uint256 snapTotalStaked = staking.totalStaked();
        uint256 snapRewardPerToken = staking.rewardPerTokenStored();
        uint256 snapAliceStaked = staking.stakedBalance(alice);
        uint256 snapBobStaked = staking.stakedBalance(bob);
        uint256 snapAliceEarned = staking.earned(alice);
        uint256 snapBobEarned = staking.earned(bob);
        address snapFeeSource = staking.feeSource();
        address snapGuardian = staking.guardian();
        address snapClaraToken = address(staking.claraToken());
        address snapUsdc = address(staking.usdc());
        address snapOwner = staking.owner();

        // Sanity checks on pre-upgrade state
        assertGt(snapTotalStaked, 0, "Pre-upgrade: totalStaked > 0");
        assertGt(snapRewardPerToken, 0, "Pre-upgrade: rPTS > 0");
        assertGt(snapAliceEarned, 0, "Pre-upgrade: alice earned > 0");

        // ── Perform upgrade ──
        staking.upgradeToAndCall(address(v2Impl), "");

        // ── Verify state is unchanged ──
        ClaraStakingV2 stakingV2 = ClaraStakingV2(address(stakingProxy));

        assertEq(stakingV2.totalStaked(), snapTotalStaked, "totalStaked preserved");
        assertEq(stakingV2.rewardPerTokenStored(), snapRewardPerToken, "rPTS preserved");
        assertEq(stakingV2.stakedBalance(alice), snapAliceStaked, "alice staked preserved");
        assertEq(stakingV2.stakedBalance(bob), snapBobStaked, "bob staked preserved");
        assertEq(stakingV2.earned(alice), snapAliceEarned, "alice earned preserved");
        assertEq(stakingV2.earned(bob), snapBobEarned, "bob earned preserved");
        assertEq(stakingV2.feeSource(), snapFeeSource, "feeSource preserved");
        assertEq(stakingV2.guardian(), snapGuardian, "guardian preserved");
        assertEq(address(stakingV2.claraToken()), snapClaraToken, "claraToken preserved");
        assertEq(address(stakingV2.usdc()), snapUsdc, "usdc preserved");
        assertEq(stakingV2.owner(), snapOwner, "owner preserved");

        // ── Verify V2 functionality ──
        assertEq(stakingV2.version(), 2, "V2 version() should return 2");

        // New variable should default to 0
        assertEq(stakingV2.newVariable(), 0, "newVariable defaults to 0");

        // Can set new variable
        stakingV2.setNewVariable(42);
        assertEq(stakingV2.newVariable(), 42, "newVariable can be set");
    }

    // ═════════════════════════════════════════════════════
    // TC-121: Attacker cannot upgrade directly
    // ═════════════════════════════════════════════════════

    /// @notice TC-121: Non-owner cannot call upgradeToAndCall
    /// Transfer ownership to timelock. Attacker tries upgradeToAndCall -> reverts.
    function test_TC121_attackerCannotUpgrade() public {
        timelock = _deployTimelock();

        // Transfer ownership to timelock
        staking.transferOwnership(address(timelock));

        // Attacker tries to upgrade directly
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                attacker
            )
        );
        staking.upgradeToAndCall(address(v2Impl), "");
    }

    // ═════════════════════════════════════════════════════
    // TC-122: Timelock-gated upgrade with delay enforcement
    // ═════════════════════════════════════════════════════

    /// @notice TC-122: Proposer schedules upgrade. Execute immediately -> reverts.
    /// Warp 6 days -> reverts. Warp 7 days -> succeeds.
    function test_TC122_timelockEnforcesDelay() public {
        timelock = _deployTimelock();

        // Transfer ownership to timelock
        staking.transferOwnership(address(timelock));

        // Build the upgrade call
        bytes memory upgradeCall = abi.encodeCall(
            staking.upgradeToAndCall,
            (address(v2Impl), "")
        );

        bytes32 predecessor = bytes32(0);
        bytes32 salt = keccak256("upgrade-v2");

        // Proposer schedules
        vm.prank(proposer);
        timelock.schedule(
            address(staking),
            0,
            upgradeCall,
            predecessor,
            salt,
            TIMELOCK_DELAY
        );

        // ── Attempt immediate execution -> reverts ──
        vm.prank(executor);
        vm.expectRevert(); // TimelockUnexpectedOperationState
        timelock.execute(address(staking), 0, upgradeCall, predecessor, salt);

        // ── Warp 6 days -> still reverts ──
        vm.warp(block.timestamp + 6 days);
        vm.prank(executor);
        vm.expectRevert(); // Still not ready
        timelock.execute(address(staking), 0, upgradeCall, predecessor, salt);

        // ── Warp to exactly 7 days -> succeeds ──
        vm.warp(block.timestamp + 1 days); // now at +7 days total
        vm.prank(executor);
        timelock.execute(address(staking), 0, upgradeCall, predecessor, salt);

        // Verify upgrade succeeded
        ClaraStakingV2 stakingV2 = ClaraStakingV2(address(stakingProxy));
        assertEq(stakingV2.version(), 2, "Upgrade succeeded via timelock");
    }

    // ═════════════════════════════════════════════════════
    // TC-123: Implementation cannot be initialized directly
    // ═════════════════════════════════════════════════════

    /// @notice TC-123: Calling initialize() on the implementation contract reverts.
    /// ClaraStaking impl has _disableInitializers() in constructor.
    function test_TC123_implCannotBeInitialized() public {
        ClaraStaking freshImpl = new ClaraStaking();

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        freshImpl.initialize(
            address(token),
            address(usdc),
            feeSource,
            guardian
        );
    }
}
