// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/// @title FuzzTest
/// @notice Fuzz tests FZ-001 through FZ-009 for ClaraStaking.
/// @dev Extends ClaraTestBase for shared setup. Uses bound() for input constraints.
contract FuzzTest is ClaraTestBase {
    uint256 private constant PRECISION = 1e18;

    // ───────────────────────────────────────────────────────────────
    // FZ-001: Fuzz -- stake/unstake/claim with random amounts
    // Invariant: For any valid inputs, claimed amount == earned amount.
    // ───────────────────────────────────────────────────────────────
    function testFuzz_FZ001_stakeUnstakeClaim(uint256 stakeAmt, uint256 depositAmt) public {
        stakeAmt = bound(stakeAmt, 1, 10_000e18);
        depositAmt = bound(depositAmt, 1, 1_000_000e6);

        // Alice stakes
        vm.prank(alice);
        staking.stake(stakeAmt);

        // feeSource deposits USDC
        vm.prank(feeSource);
        staking.deposit(depositAmt);

        // Snapshot earned before claiming
        uint256 earnedBefore = staking.earned(alice);

        // Snapshot balances
        uint256 aliceUsdcBefore = usdc.balanceOf(alice);
        uint256 stakingUsdcBefore = usdc.balanceOf(address(staking));

        // Alice claims
        vm.prank(alice);
        staking.claim();

        uint256 aliceUsdcAfter = usdc.balanceOf(alice);
        uint256 stakingUsdcAfter = usdc.balanceOf(address(staking));

        // Verify: alice balance delta == earned before claim
        assertEq(aliceUsdcAfter - aliceUsdcBefore, earnedBefore, "FZ-001: alice balance delta != earned");
        // Verify: staking contract USDC balance decreased by same amount
        assertEq(stakingUsdcBefore - stakingUsdcAfter, earnedBefore, "FZ-001: staking balance delta != earned");
    }

    // ───────────────────────────────────────────────────────────────
    // FZ-002: Fuzz -- deposit amount boundaries
    // Invariant: rewardPerTokenStored updated correctly.
    // ───────────────────────────────────────────────────────────────
    function testFuzz_FZ002_depositBoundaries(uint256 depositAmt) public {
        // Use uint128 upper bound to avoid overflow in PRECISION multiplication
        depositAmt = bound(depositAmt, 1, type(uint128).max);

        uint256 stakeAmt = 1000e18;

        // Alice stakes
        vm.prank(alice);
        staking.stake(stakeAmt);

        // Mint enough USDC for the deposit (feeSource may need more than initial 1M)
        usdc.mint(feeSource, depositAmt);

        uint256 rewardPerTokenBefore = staking.rewardPerTokenStored();

        // feeSource deposits
        vm.prank(feeSource);
        staking.deposit(depositAmt);

        uint256 rewardPerTokenAfter = staking.rewardPerTokenStored();
        uint256 expectedDelta = (depositAmt * PRECISION) / stakeAmt;

        assertEq(
            rewardPerTokenAfter - rewardPerTokenBefore,
            expectedDelta,
            "FZ-002: rewardPerTokenStored delta incorrect"
        );
    }

    // ───────────────────────────────────────────────────────────────
    // FZ-003: Fuzz -- multi-user entry/exit ordering
    // Invariant: totalStaked always equals sum of individual stakedBalance.
    // ───────────────────────────────────────────────────────────────
    function testFuzz_FZ003_multiUserEntryExit(
        uint256[6] calldata actions,
        uint256[6] calldata amounts
    ) public {
        address[3] memory users = [alice, bob, charlie];

        for (uint256 i = 0; i < 6; i++) {
            uint256 userIdx = actions[i] % 3;
            bool isStake = (actions[i] / 3) % 2 == 0;
            address user = users[userIdx];

            if (isStake) {
                uint256 balance = token.balanceOf(user);
                if (balance == 0) continue;
                uint256 amt = bound(amounts[i], 1, balance);
                vm.prank(user);
                staking.stake(amt);
            } else {
                uint256 staked = staking.stakedBalance(user);
                if (staked == 0) continue;
                uint256 amt = bound(amounts[i], 1, staked);
                vm.prank(user);
                staking.unstake(amt);
            }

            // Invariant check after every operation
            uint256 sumStaked = staking.stakedBalance(alice)
                + staking.stakedBalance(bob)
                + staking.stakedBalance(charlie);
            assertEq(staking.totalStaked(), sumStaked, "FZ-003: totalStaked != sum of stakedBalance");
        }
    }

    // ───────────────────────────────────────────────────────────────
    // FZ-004: Fuzz -- deposit() precision across full USDC range
    // Invariant: Rounding error is bounded.
    // ───────────────────────────────────────────────────────────────
    function testFuzz_FZ004_depositPrecision(uint256 stakeAmt, uint256 depositAmt) public {
        stakeAmt = bound(stakeAmt, 1, INITIAL_SUPPLY);
        depositAmt = bound(depositAmt, 1, 10_000_000e6);

        // Give alice enough CLARA for a large stake (transfer from treasury)
        uint256 aliceBalance = token.balanceOf(alice);
        if (stakeAmt > aliceBalance) {
            uint256 needed = stakeAmt - aliceBalance;
            uint256 treasuryBal = token.balanceOf(treasury);
            if (needed > treasuryBal) {
                stakeAmt = aliceBalance + treasuryBal;
            }
            if (stakeAmt == 0) return; // edge case: nothing to stake
            vm.prank(treasury);
            token.transfer(alice, stakeAmt - aliceBalance);
        }

        vm.prank(alice);
        token.approve(address(staking), type(uint256).max);

        vm.prank(alice);
        staking.stake(stakeAmt);

        // Mint USDC for repeated deposits
        usdc.mint(feeSource, depositAmt * 100);

        for (uint256 i = 0; i < 100; i++) {
            vm.prank(feeSource);
            staking.deposit(depositAmt);
        }

        uint256 earnedVal = staking.earned(alice);
        // Alice is the sole staker, so she should earn everything.
        // Expected = depositAmt * 100, but floor-division in
        // rewardPerTokenStored += (amount * PRECISION) / totalStaked
        // introduces rounding loss. Per deposit, max loss from floor division
        // is: depositAmt - floor(depositAmt * PRECISION / totalStaked) * totalStaked / PRECISION
        // This is bounded by ceil(totalStaked / PRECISION) per deposit.
        uint256 expectedTotal = depositAmt * 100;
        uint256 totalDust = 0;
        if (expectedTotal >= earnedVal) {
            totalDust = expectedTotal - earnedVal;
        }

        // Max dust per deposit: ceil(totalStaked / PRECISION).
        // Across 100 deposits, bound = 100 * ceil(totalStaked / PRECISION).
        // When totalStaked <= PRECISION (1e18), this is 100 (matching spec).
        // When totalStaked > PRECISION, dust scales proportionally.
        uint256 maxDustPerDeposit = (stakeAmt + PRECISION - 1) / PRECISION;
        uint256 maxTotalDust = 100 * maxDustPerDeposit;

        assertLe(totalDust, maxTotalDust, "FZ-004: accumulated dust exceeds bound");
    }

    // ───────────────────────────────────────────────────────────────
    // FZ-005: Fuzz -- earned() precision with extreme stake ratios
    // Invariant: No over-distribution (alice earned + bob earned <= deposit).
    // ───────────────────────────────────────────────────────────────
    function testFuzz_FZ005_extremeStakeRatios(uint256 smallAmt, uint256 bigAmt) public {
        smallAmt = bound(smallAmt, 1, 1e18);
        // Cap bigAmt to what treasury can provide AFTER sending smallAmt
        uint256 treasuryBal = token.balanceOf(treasury);
        // Need at least 1e18 for bigAmt, plus smallAmt for alice
        // If treasury can't cover both, skip (shouldn't happen with 100M supply - 30k distributed)
        uint256 maxBig = treasuryBal - smallAmt;
        bigAmt = bound(bigAmt, 1e18, maxBig);

        // Transfer from treasury to alice and bob
        vm.startPrank(treasury);
        token.transfer(alice, smallAmt);
        token.transfer(bob, bigAmt);
        vm.stopPrank();

        // Re-approve since alice/bob have new tokens
        vm.prank(alice);
        token.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        token.approve(address(staking), type(uint256).max);

        // Stake: alice stakes smallAmt, bob stakes bigAmt
        vm.prank(alice);
        staking.stake(smallAmt);
        vm.prank(bob);
        staking.stake(bigAmt);

        uint256 depositAmt = 1_000_000e6;
        // Ensure feeSource has enough
        usdc.mint(feeSource, depositAmt);

        vm.prank(feeSource);
        staking.deposit(depositAmt);

        uint256 aliceEarned = staking.earned(alice);
        uint256 bobEarned = staking.earned(bob);

        // No over-distribution
        assertLe(aliceEarned + bobEarned, depositAmt, "FZ-005: over-distribution detected");

        // Dust comes from two floor-division steps:
        //   1) rewardPerTokenStored += (amount * PRECISION) / totalStaked  -- loses up to ceil(totalStaked/PRECISION)
        //   2) earned() = (stakedBalance * delta) / PRECISION              -- each user loses up to 1
        // With 2 users, max dust = ceil(totalStaked/PRECISION) + 2
        uint256 totalStk = smallAmt + bigAmt;
        uint256 maxDust = (totalStk + PRECISION - 1) / PRECISION + 2;
        uint256 dust = depositAmt - (aliceEarned + bobEarned);
        assertLe(dust, maxDust, "FZ-005: dust exceeds rounding bound");
    }

    // ───────────────────────────────────────────────────────────────
    // FZ-006: Fuzz -- interleaved operations maintain totalStaked invariant
    // Invariant: Accounting always consistent across 5 users.
    // ───────────────────────────────────────────────────────────────
    function testFuzz_FZ006_interleavedOps(
        uint256[10] calldata actions,
        uint256[10] calldata amounts
    ) public {
        // Set up 5 users (alice, bob, charlie + 2 more)
        address dave = makeAddr("dave");
        address eve = makeAddr("eve");

        vm.startPrank(treasury);
        token.transfer(dave, 10_000e18);
        token.transfer(eve, 10_000e18);
        vm.stopPrank();

        vm.prank(dave);
        token.approve(address(staking), type(uint256).max);
        vm.prank(eve);
        token.approve(address(staking), type(uint256).max);

        address[5] memory users = [alice, bob, charlie, dave, eve];

        for (uint256 i = 0; i < 10; i++) {
            uint256 userIdx = actions[i] % 5;
            bool isStake = (actions[i] / 5) % 2 == 0;
            address user = users[userIdx];

            if (isStake) {
                uint256 balance = token.balanceOf(user);
                if (balance == 0) continue;
                uint256 amt = bound(amounts[i], 1, balance);
                vm.prank(user);
                staking.stake(amt);
            } else {
                uint256 staked = staking.stakedBalance(user);
                if (staked == 0) continue;
                uint256 amt = bound(amounts[i], 1, staked);
                vm.prank(user);
                staking.unstake(amt);
            }

            // Invariant: totalStaked == sum of stakedBalance for all 5
            uint256 sumStaked = 0;
            for (uint256 j = 0; j < 5; j++) {
                sumStaked += staking.stakedBalance(users[j]);
            }
            assertEq(staking.totalStaked(), sumStaked, "FZ-006: totalStaked != sum of stakedBalance");
        }
    }

    // ───────────────────────────────────────────────────────────────
    // FZ-007: Fuzz -- permit signature parameters
    // Invariant: Valid permit always accepted, stakedBalance updated.
    // ───────────────────────────────────────────────────────────────
    function testFuzz_FZ007_permitSignature(uint256 amount, uint256 deadlineOffset) public {
        amount = bound(amount, 1, 10_000e18);
        deadlineOffset = bound(deadlineOffset, 1, 365 days);
        uint256 deadline = block.timestamp + deadlineOffset;

        // Use a dedicated private key for the permit signer
        uint256 privateKey = 0xA11CE;
        address permitUser = vm.addr(privateKey);

        // Fund the permit user with CLARA
        vm.prank(treasury);
        token.transfer(permitUser, amount);

        // Build the ERC-2612 permit digest
        bytes32 PERMIT_TYPEHASH = keccak256(
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        );
        uint256 nonce = token.nonces(permitUser);
        bytes32 domainSeparator = token.DOMAIN_SEPARATOR();

        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, permitUser, address(staking), amount, nonce, deadline)
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator, structHash)
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);

        // Stake with permit (no prior approval needed)
        vm.prank(permitUser);
        staking.stakeWithPermit(amount, deadline, v, r, s);

        // Verify stakedBalance updated correctly
        assertEq(staking.stakedBalance(permitUser), amount, "FZ-007: stakedBalance not updated");
        assertEq(staking.totalStaked(), amount, "FZ-007: totalStaked not updated");
    }

    // ───────────────────────────────────────────────────────────────
    // FZ-008: Fuzz -- rewardPerTokenStored is monotonic across 5 deposits
    // Invariant: rewardPerTokenStored never decreases.
    // ───────────────────────────────────────────────────────────────
    function testFuzz_FZ008_rewardPerTokenMonotonic(uint256[5] calldata depositAmounts) public {
        // Alice stakes so totalStaked > 0
        vm.prank(alice);
        staking.stake(1000e18);

        uint256 prevRewardPerToken = staking.rewardPerTokenStored();

        for (uint256 i = 0; i < 5; i++) {
            uint256 amt = bound(depositAmounts[i], 1, 1_000_000e6);
            // Mint fresh USDC for each deposit
            usdc.mint(feeSource, amt);

            vm.prank(feeSource);
            staking.deposit(amt);

            uint256 currentRewardPerToken = staking.rewardPerTokenStored();
            assertGe(
                currentRewardPerToken,
                prevRewardPerToken,
                "FZ-008: rewardPerTokenStored decreased"
            );
            prevRewardPerToken = currentRewardPerToken;
        }
    }

    // ───────────────────────────────────────────────────────────────
    // FZ-009: Fuzz -- multi-user no over-claim
    // Invariant: Conservation of USDC (total claimed <= total deposited).
    // ───────────────────────────────────────────────────────────────
    function testFuzz_FZ009_noOverClaim(
        uint256[3] calldata stakeAmounts,
        uint256[3] calldata depositAmounts
    ) public {
        address[3] memory users = [alice, bob, charlie];

        // 3 users stake random amounts
        uint256 totalDeposited = 0;
        for (uint256 i = 0; i < 3; i++) {
            uint256 amt = bound(stakeAmounts[i], 1, 10_000e18);
            vm.prank(users[i]);
            staking.stake(amt);
        }

        // 3 random deposits
        for (uint256 i = 0; i < 3; i++) {
            uint256 amt = bound(depositAmounts[i], 1, 1_000_000e6);
            usdc.mint(feeSource, amt);
            vm.prank(feeSource);
            staking.deposit(amt);
            totalDeposited += amt;
        }

        // All users claim
        uint256 totalClaimed = 0;
        for (uint256 i = 0; i < 3; i++) {
            uint256 balBefore = usdc.balanceOf(users[i]);
            vm.prank(users[i]);
            staking.claim();
            uint256 balAfter = usdc.balanceOf(users[i]);
            totalClaimed += (balAfter - balBefore);
        }

        // Total claimed <= total deposited
        assertLe(totalClaimed, totalDeposited, "FZ-009: total claimed exceeds total deposited");
    }
}
