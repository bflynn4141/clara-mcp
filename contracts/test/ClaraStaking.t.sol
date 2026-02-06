// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";

contract ClaraStakingTest is ClaraTestBase {

    // ─── Helper ───────────────────────────────────────────────────
    /// @dev Stake `amount` of CLARA as `user`
    function _stake(address user, uint256 amount) internal {
        vm.prank(user);
        staking.stake(amount);
    }

    /// @dev Deposit `amount` of USDC as feeSource
    function _deposit(uint256 amount) internal {
        vm.prank(feeSource);
        staking.deposit(amount);
    }

    // ═══════════════════════════════════════════════════════════════
    //                         P0 TESTS
    // ═══════════════════════════════════════════════════════════════

    // TC-010: stake() transfers CLARA and updates stakedBalance (P0)
    function test_TC010_stakeTransfers() public {
        uint256 amount = 1000e18;
        uint256 aliceBefore = token.balanceOf(alice);

        _stake(alice, amount);

        assertEq(staking.stakedBalance(alice), amount);
        assertEq(staking.totalStaked(), amount);
        assertEq(token.balanceOf(alice), aliceBefore - amount);
        assertEq(token.balanceOf(address(staking)), amount);
    }

    // TC-011: unstake() returns CLARA and decrements stakedBalance (P0)
    function test_TC011_unstakeReturns() public {
        _stake(alice, 1000e18);

        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        staking.unstake(500e18);

        assertEq(staking.stakedBalance(alice), 500e18);
        assertEq(staking.totalStaked(), 500e18);
        assertEq(token.balanceOf(alice), aliceBefore + 500e18);
    }

    // TC-014: deposit() updates rewardPerTokenStored correctly (P0)
    function test_TC014_depositUpdatesRPTS() public {
        _stake(alice, 1000e18);

        _deposit(100e6); // 100 USDC

        // rPTS = (100e6 * 1e18) / 1000e18 = 100_000
        assertEq(staking.rewardPerTokenStored(), 100_000);
    }

    // TC-017: deposit() with zero totalStaked reverts "No stakers" (P0 - B1 fix)
    function test_TC017_depositNoStakersReverts() public {
        vm.prank(feeSource);
        vm.expectRevert("No stakers");
        staking.deposit(100e6);
    }

    // TC-019: claim() transfers accrued USDC to staker (P0)
    function test_TC019_claimTransfersUSDC() public {
        _stake(alice, 1000e18);
        _deposit(100e6);

        uint256 aliceUsdcBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        staking.claim();

        // Alice is sole staker -> gets all 100 USDC
        assertEq(usdc.balanceOf(alice), aliceUsdcBefore + 100e6);
        assertEq(staking.rewards(alice), 0);
    }

    // TC-020: Two sequential deposits accumulate rPTS correctly (P0)
    function test_TC020_twoDepositsAccumulate() public {
        _stake(alice, 1000e18);

        // Deposit #1: 100 USDC -> rPTS += (100e6 * 1e18) / 1000e18 = 100_000
        _deposit(100e6);
        assertEq(staking.rewardPerTokenStored(), 100_000);

        // Deposit #2: 200 USDC -> rPTS += (200e6 * 1e18) / 1000e18 = 200_000
        _deposit(200e6);
        assertEq(staking.rewardPerTokenStored(), 300_000);
    }

    // TC-021: exit() unstakes full balance and claims all rewards (P0)
    function test_TC021_exitUnstakesAndClaims() public {
        _stake(alice, 1000e18);
        _deposit(100e6);

        uint256 aliceClaraBefore = token.balanceOf(alice);
        uint256 aliceUsdcBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        staking.exit();

        // All CLARA returned
        assertEq(token.balanceOf(alice), aliceClaraBefore + 1000e18);
        assertEq(staking.stakedBalance(alice), 0);
        assertEq(staking.totalStaked(), 0);

        // All USDC rewards claimed
        assertEq(usdc.balanceOf(alice), aliceUsdcBefore + 100e6);
        assertEq(staking.rewards(alice), 0);
    }

    // TC-023: Two stakers split rewards proportionally (P0)
    function test_TC023_twoStakersSplitRewards() public {
        // Alice=500, Bob=500, total=1000
        _stake(alice, 500e18);
        _stake(bob, 500e18);

        // Deposit 100 USDC
        _deposit(100e6);

        // rPTS = 100e6 * 1e18 / 1000e18 = 100_000
        assertEq(staking.rewardPerTokenStored(), 100_000);

        // earned(alice) = 500e18 * 100_000 / 1e18 = 50e6
        assertEq(staking.earned(alice), 50e6);
        assertEq(staking.earned(bob), 50e6);
    }

    // TC-029: deposit() reverts when called by non-feeSource (P0)
    function test_TC029_depositOnlyFeeSource() public {
        _stake(alice, 1000e18);

        vm.prank(attacker);
        vm.expectRevert("Only fee source");
        staking.deposit(100e6);
    }

    // ═══════════════════════════════════════════════════════════════
    //                       P1 / P2 TESTS
    // ═══════════════════════════════════════════════════════════════

    // TC-012: stake(0) reverts (P1)
    function test_TC012_stakeZeroReverts() public {
        vm.prank(alice);
        vm.expectRevert("Cannot stake 0");
        staking.stake(0);
    }

    // TC-013: unstake(0) reverts (P1)
    function test_TC013_unstakeZeroReverts() public {
        _stake(alice, 1000e18);

        vm.prank(alice);
        vm.expectRevert("Cannot unstake 0");
        staking.unstake(0);
    }

    // TC-015: deposit(0) reverts (P1)
    function test_TC015_depositZeroReverts() public {
        _stake(alice, 1000e18);

        vm.prank(feeSource);
        vm.expectRevert("Cannot deposit 0");
        staking.deposit(0);
    }

    // TC-016: unstake more than staked reverts (P1)
    function test_TC016_unstakeExceedsBalance() public {
        _stake(alice, 1000e18);

        vm.prank(alice);
        vm.expectRevert("Insufficient staked balance");
        staking.unstake(1001e18);
    }

    // TC-018: claim() with no rewards is a no-op (P1)
    function test_TC018_claimNoRewardsNoOp() public {
        _stake(alice, 1000e18);
        // No deposit -> no rewards

        uint256 aliceUsdcBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        staking.claim();

        assertEq(usdc.balanceOf(alice), aliceUsdcBefore);
    }

    // TC-022: earned() returns correct pending value without state change (P1)
    function test_TC022_earnedViewOnly() public {
        _stake(alice, 1000e18);
        _deposit(200e6);

        // earned is a view -- calling it must not change state
        uint256 e1 = staking.earned(alice);
        uint256 e2 = staking.earned(alice);
        assertEq(e1, e2);
        assertEq(e1, 200e6); // sole staker gets all
    }

    // TC-024: getClaimable() mirrors earned() (P1)
    function test_TC024_getClaimableMirrorsEarned() public {
        _stake(alice, 1000e18);
        _deposit(50e6);

        assertEq(staking.getClaimable(alice), staking.earned(alice));
        assertEq(staking.getClaimable(alice), 50e6);
    }

    // TC-025: stakeWithPermit works with valid ERC-2612 signature (P1)
    function test_TC025_stakeWithPermit() public {
        uint256 userPk = 0xA11CE;
        address user = vm.addr(userPk);

        // Fund user with CLARA
        vm.prank(treasury);
        token.transfer(user, 5000e18);

        uint256 amount = 1000e18;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = token.nonces(user);

        // Build permit digest
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                user,
                address(staking),
                amount,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);

        // Call stakeWithPermit -- no prior approval needed
        vm.prank(user);
        staking.stakeWithPermit(amount, deadline, v, r, s);

        assertEq(staking.stakedBalance(user), amount);
        assertEq(staking.totalStaked(), amount);
        assertEq(token.balanceOf(user), 5000e18 - amount);
    }

    // TC-025b: stakeWithPermit reverts on invalid permit signature (P1)
    function test_TC025b_stakeWithPermitInvalidSig() public {
        uint256 userPk = 0xA11CE;
        address user = vm.addr(userPk);
        uint256 wrongPk = 0xB0B;

        vm.prank(treasury);
        token.transfer(user, 5000e18);

        uint256 amount = 1000e18;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = token.nonces(user);

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                user,
                address(staking),
                amount,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, digest); // wrong key

        vm.prank(user);
        vm.expectRevert();
        staking.stakeWithPermit(amount, deadline, v, r, s);
    }

    // TC-026: setFeeSource() updates feeSource (P1 - admin)
    function test_TC026_setFeeSource() public {
        address newFeeSource = makeAddr("newFeeSource");

        // Caller is the deployer of the proxy (this test contract), who is owner
        staking.setFeeSource(newFeeSource);

        assertEq(staking.feeSource(), newFeeSource);
    }

    // TC-026b: setFeeSource() reverts for non-owner (P1)
    function test_TC026b_setFeeSourceNonOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        staking.setFeeSource(makeAddr("newFeeSource"));
    }

    // TC-026c: setFeeSource(address(0)) reverts (P1)
    function test_TC026c_setFeeSourceZeroAddress() public {
        vm.expectRevert("Zero address");
        staking.setFeeSource(address(0));
    }

    // TC-027: setGuardian() updates guardian (P1 - admin)
    function test_TC027_setGuardian() public {
        address newGuardian = makeAddr("newGuardian");

        staking.setGuardian(newGuardian);

        assertEq(staking.guardian(), newGuardian);
    }

    // TC-027b: setGuardian() reverts for non-owner (P1)
    function test_TC027b_setGuardianNonOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        staking.setGuardian(makeAddr("newGuardian"));
    }

    // TC-027c: setGuardian(address(0)) reverts (P1)
    function test_TC027c_setGuardianZeroAddress() public {
        vm.expectRevert("Zero address");
        staking.setGuardian(address(0));
    }

    // TC-028: pause() by guardian blocks stake/unstake/claim (P1 - B5 fix)
    function test_TC028_pauseBlocksUserActions() public {
        _stake(alice, 1000e18);
        _deposit(50e6);

        // Guardian pauses
        vm.prank(guardian);
        staking.pause();

        // stake blocked
        vm.prank(alice);
        vm.expectRevert();
        staking.stake(100e18);

        // unstake blocked
        vm.prank(alice);
        vm.expectRevert();
        staking.unstake(100e18);

        // claim blocked
        vm.prank(alice);
        vm.expectRevert();
        staking.claim();

        // exit blocked
        vm.prank(alice);
        vm.expectRevert();
        staking.exit();

        // stakeWithPermit blocked (no valid sig needed, reverts on pause first)
        vm.prank(alice);
        vm.expectRevert();
        staking.stakeWithPermit(100e18, block.timestamp + 1, 27, bytes32(0), bytes32(0));
    }

    // TC-028b: pause() by owner also works (P1)
    function test_TC028b_pauseByOwner() public {
        // Owner (this contract) pauses
        staking.pause();

        vm.prank(alice);
        vm.expectRevert();
        staking.stake(100e18);
    }

    // TC-028c: pause() by random address reverts (P1)
    function test_TC028c_pauseByAttacker() public {
        vm.prank(attacker);
        vm.expectRevert("Not guardian or owner");
        staking.pause();
    }

    // TC-028d: unpause() only by owner (P1)
    function test_TC028d_unpauseOnlyOwner() public {
        staking.pause();

        // Guardian cannot unpause
        vm.prank(guardian);
        vm.expectRevert();
        staking.unpause();

        // Owner can unpause
        staking.unpause();

        // Confirm stake works again
        _stake(alice, 100e18);
        assertEq(staking.stakedBalance(alice), 100e18);
    }

    // TC-028e: deposit() works even when paused (deposit has no whenNotPaused) (P2)
    function test_TC028e_depositWorksWhenPaused() public {
        _stake(alice, 1000e18);

        staking.pause();

        // deposit should still succeed - no whenNotPaused modifier
        _deposit(100e6);
        assertEq(staking.rewardPerTokenStored(), 100_000);
    }

    // TC-030: recoverERC20() blocked for CLARA and USDC tokens (P1 - B4 fix)
    function test_TC030_recoverBlockedForStakedAndRewardToken() public {
        // Cannot recover CLARA (staked token)
        vm.expectRevert("Cannot recover staked token");
        staking.recoverERC20(address(token), 1);

        // Cannot recover USDC (reward token)
        vm.expectRevert("Cannot recover reward token");
        staking.recoverERC20(address(usdc), 1);
    }

    // TC-030b: recoverERC20() works for arbitrary token (P1)
    function test_TC030b_recoverArbitraryToken() public {
        MockERC20 randomToken = new MockERC20("Random", "RND", 18);
        randomToken.mint(address(staking), 500e18);

        uint256 ownerBefore = randomToken.balanceOf(address(this));
        staking.recoverERC20(address(randomToken), 500e18);

        assertEq(randomToken.balanceOf(address(this)), ownerBefore + 500e18);
        assertEq(randomToken.balanceOf(address(staking)), 0);
    }

    // TC-030c: recoverERC20() reverts for non-owner (P1)
    function test_TC030c_recoverNonOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        staking.recoverERC20(makeAddr("someToken"), 1);
    }

    // ═══════════════════════════════════════════════════════════════
    //                   ADDITIONAL COVERAGE
    // ═══════════════════════════════════════════════════════════════

    // Three stakers with unequal stakes and multiple deposits
    function test_threeStakersUnequalSplit() public {
        // Alice=600, Bob=300, Charlie=100  (total=1000)
        _stake(alice, 600e18);
        _stake(bob, 300e18);
        _stake(charlie, 100e18);

        // Deposit 1000 USDC
        _deposit(1000e6);

        // rPTS = 1000e6 * 1e18 / 1000e18 = 1_000_000
        assertEq(staking.rewardPerTokenStored(), 1_000_000);

        // earned proportionally
        assertEq(staking.earned(alice), 600e6);   // 600/1000 * 1000
        assertEq(staking.earned(bob), 300e6);     // 300/1000 * 1000
        assertEq(staking.earned(charlie), 100e6); // 100/1000 * 1000
    }

    // Stake after deposit -- new staker should NOT earn retroactive rewards
    function test_stakeAfterDepositNoRetroReward() public {
        _stake(alice, 1000e18);
        _deposit(100e6);

        // Bob stakes after deposit
        _stake(bob, 1000e18);

        // Bob should have 0 earned (joined after deposit)
        assertEq(staking.earned(bob), 0);
        // Alice still has her 100 USDC
        assertEq(staking.earned(alice), 100e6);
    }

    // Partial unstake preserves remaining rewards
    function test_partialUnstakePreservesRewards() public {
        _stake(alice, 1000e18);
        _deposit(100e6); // Alice earns 100 USDC

        // Partial unstake of 500
        vm.prank(alice);
        staking.unstake(500e18);

        // Rewards should be preserved (moved to rewards mapping via updateReward)
        assertEq(staking.earned(alice), 100e6);
        assertEq(staking.stakedBalance(alice), 500e18);
    }

    // Staking events emitted correctly
    function test_stakeEmitsEvent() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit ClaraStaking.Staked(alice, 500e18);
        staking.stake(500e18);
    }

    function test_unstakeEmitsEvent() public {
        _stake(alice, 500e18);

        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit ClaraStaking.Unstaked(alice, 500e18);
        staking.unstake(500e18);
    }

    function test_claimEmitsEvent() public {
        _stake(alice, 1000e18);
        _deposit(100e6);

        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit ClaraStaking.RewardsClaimed(alice, 100e6);
        staking.claim();
    }

    function test_depositEmitsEvent() public {
        _stake(alice, 1000e18);

        vm.prank(feeSource);
        vm.expectEmit(true, false, false, true);
        emit ClaraStaking.FeesDeposited(feeSource, 100e6);
        staking.deposit(100e6);
    }

    // Initialize with zero addresses reverts
    function test_initializeZeroAddresses() public {
        ClaraStaking impl = new ClaraStaking();

        // Zero claraToken
        vm.expectRevert("Zero claraToken");
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(ClaraStaking.initialize, (address(0), address(usdc), feeSource, guardian))
        );

        // Zero usdc
        vm.expectRevert("Zero usdc");
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(ClaraStaking.initialize, (address(token), address(0), feeSource, guardian))
        );

        // Zero feeSource
        vm.expectRevert("Zero feeSource");
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(ClaraStaking.initialize, (address(token), address(usdc), address(0), guardian))
        );

        // Zero guardian
        vm.expectRevert("Zero guardian");
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(ClaraStaking.initialize, (address(token), address(usdc), feeSource, address(0)))
        );
    }

    // Implementation contract cannot be re-initialized (B2 fix)
    function test_implCannotBeReinitialized() public {
        vm.expectRevert();
        stakingImpl.initialize(address(token), address(usdc), feeSource, guardian);
    }

    // Proxy cannot be re-initialized
    function test_proxyCannotBeReinitialized() public {
        vm.expectRevert();
        staking.initialize(address(token), address(usdc), feeSource, guardian);
    }

    // FeeSourceUpdated event emitted on setFeeSource
    function test_setFeeSourceEmitsEvent() public {
        address newFeeSource = makeAddr("newFeeSource");

        vm.expectEmit(true, true, false, false);
        emit ClaraStaking.FeeSourceUpdated(feeSource, newFeeSource);
        staking.setFeeSource(newFeeSource);
    }

    // GuardianUpdated event emitted on setGuardian
    function test_setGuardianEmitsEvent() public {
        address newGuardian = makeAddr("newGuardian");

        vm.expectEmit(true, true, false, false);
        emit ClaraStaking.GuardianUpdated(guardian, newGuardian);
        staking.setGuardian(newGuardian);
    }

    // exit() with no stake and no rewards is a no-op
    function test_exitNoStakeNoRewards() public {
        uint256 claraBefore = token.balanceOf(alice);
        uint256 usdcBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        staking.exit();

        assertEq(token.balanceOf(alice), claraBefore);
        assertEq(usdc.balanceOf(alice), usdcBefore);
    }
}
