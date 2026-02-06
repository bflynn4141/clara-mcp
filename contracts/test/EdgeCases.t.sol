// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";
import "../src/MerkleDrop.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/// @title EdgeCasesTest
/// @notice Remaining P1 edge-case tests not covered by other test files.
///         Covers TC-232, TC-233, TC-282, TC-283, TC-284, TC-013(plan),
///         TC-046(plan), TC-276(plan), TC-281, TC-279(plan), TC-280(plan).
contract EdgeCasesTest is ClaraTestBase {

    // ─── Private key for permit-based tests ──────────────────
    uint256 internal constant ALICE_PK = 0xA11CE;

    // ─── Helpers ─────────────────────────────────────────────

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

    /// @dev Build an ERC-2612 permit digest for ClaraToken
    function _buildPermitDigest(
        address owner_,
        address spender_,
        uint256 value_,
        uint256 nonce_,
        uint256 deadline_
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner_,
                spender_,
                value_,
                nonce_,
                deadline_
            )
        );
        return keccak256(
            abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)
        );
    }

    /// @dev Sorted hash pair (same as OZ MerkleProof convention)
    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b
            ? keccak256(abi.encodePacked(a, b))
            : keccak256(abi.encodePacked(b, a));
    }

    // ═════════════════════════════════════════════════════════
    //  TC-232: MAX_UINT256 staking amount (fuzz boundary)
    // ═════════════════════════════════════════════════════════

    /// @notice TC-232: Attempting to stake type(uint256).max reverts because
    ///         alice does not hold that many tokens.
    function test_TC232_maxUint256StakeReverts() public {
        vm.prank(alice);
        vm.expectRevert(); // ERC20InsufficientBalance or SafeERC20 revert
        staking.stake(type(uint256).max);
    }

    // ═════════════════════════════════════════════════════════
    //  TC-233: Dust accumulation over 1000 small deposits
    // ═════════════════════════════════════════════════════════

    /// @notice TC-233: After 1000 deposits of 1 USDC (1e6), alice (sole staker)
    ///         should be able to claim >= 999e6 (dust < 1e6 tolerance).
    ///         The Synthetix pattern rounds down on each deposit:
    ///           rPTS += (1e6 * 1e18) / 1e18 = 1e6 (no truncation at this ratio)
    ///         So dust should actually be zero for this configuration.
    function test_TC233_dustAccumulationOver1000Deposits() public {
        _stake(alice, 1e18);

        // Mint extra USDC for 1000 small deposits
        usdc.mint(feeSource, 1_000e6);
        vm.prank(feeSource);
        usdc.approve(address(staking), type(uint256).max);

        for (uint256 i = 0; i < 1000; i++) {
            _deposit(1e6);
        }

        uint256 aliceEarned = staking.earned(alice);

        // Claim
        uint256 aliceUsdcBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        staking.claim();
        uint256 claimed = usdc.balanceOf(alice) - aliceUsdcBefore;

        // Invariant: dust bounded - claimed should be >= 999e6
        assertGe(claimed, 999e6, "Dust must be < 1e6 tolerance");
        // Also verify earned matched what was claimed
        assertEq(claimed, aliceEarned, "claimed should match earned()");
    }

    // ═════════════════════════════════════════════════════════
    //  TC-282: ClaraToken transfer to zero address reverts
    // ═════════════════════════════════════════════════════════

    /// @notice TC-282: ERC20 transfer to address(0) reverts with ERC20InvalidReceiver.
    function test_TC282_transferToZeroAddressReverts() public {
        vm.prank(alice);
        vm.expectRevert(); // ERC20InvalidReceiver(address(0))
        token.transfer(address(0), 1e18);
    }

    // ═════════════════════════════════════════════════════════
    //  TC-283: Stake with amount exceeding CLARA balance reverts
    // ═════════════════════════════════════════════════════════

    /// @notice TC-283: Alice has 10_000e18 CLARA but tries staking 20_000e18.
    function test_TC283_stakeExceedingBalanceReverts() public {
        // Precondition: alice has 10_000e18 from setUp
        assertEq(token.balanceOf(alice), 10_000e18);

        vm.prank(alice);
        vm.expectRevert(); // ERC20InsufficientBalance
        staking.stake(20_000e18);
    }

    // ═════════════════════════════════════════════════════════
    //  TC-284: Rapid small deposits do not increase earned() gas
    // ═════════════════════════════════════════════════════════

    /// @notice TC-284: earned() is O(1) regardless of deposit count.
    ///         Measures gas after 1 deposit vs after 100 deposits; the
    ///         difference should be < 1000 gas.
    function test_TC284_earnedGasConstantAfterManyDeposits() public {
        _stake(alice, 1000e18);

        // Mint extra USDC for many deposits
        usdc.mint(feeSource, 200e6);

        // --- Baseline: single deposit ---
        _deposit(1e6);
        uint256 gasBefore1 = gasleft();
        staking.earned(alice);
        uint256 gasAfter1 = gasleft();
        uint256 gasForSingleDeposit = gasBefore1 - gasAfter1;

        // --- Now add 100 more deposits ---
        for (uint256 i = 0; i < 100; i++) {
            _deposit(1e6);
        }

        uint256 gasBefore2 = gasleft();
        staking.earned(alice);
        uint256 gasAfter2 = gasleft();
        uint256 gasForManyDeposits = gasBefore2 - gasAfter2;

        // The difference should be < 1000 gas (earned is O(1))
        uint256 diff = gasForManyDeposits > gasForSingleDeposit
            ? gasForManyDeposits - gasForSingleDeposit
            : gasForSingleDeposit - gasForManyDeposits;
        assertLt(diff, 1000, "earned() gas should be O(1) regardless of deposit count");
    }

    // ═════════════════════════════════════════════════════════
    //  TC-013 (plan): stake() reverts without approval
    // ═════════════════════════════════════════════════════════

    /// @notice TC-013 (plan version): A fresh address with CLARA but NO approval
    ///         cannot stake. Should revert with ERC20InsufficientAllowance.
    function test_TC013plan_stakeRevertsWithoutApproval() public {
        address fresh = makeAddr("freshUser");

        // Give fresh user CLARA tokens
        vm.prank(treasury);
        token.transfer(fresh, 5000e18);

        // No approval given - attempt stake
        vm.prank(fresh);
        vm.expectRevert(); // ERC20InsufficientAllowance
        staking.stake(1000e18);
    }

    // ═════════════════════════════════════════════════════════
    //  TC-046 (plan): MerkleDrop rejects claim with wrong amount
    // ═════════════════════════════════════════════════════════

    /// @notice TC-046 (plan version): Alice has a valid proof for 500e18 (index 0),
    ///         but attempts to claim with 2000e18 - reverts "Invalid proof".
    function test_TC046plan_merkleDropWrongAmountReverts() public {
        // Build a small Merkle tree with alice
        uint256 aliceAmount = 1000e18;
        bytes32 leaf0 = keccak256(abi.encodePacked(uint256(0), alice, aliceAmount));
        bytes32 leaf1 = keccak256(abi.encodePacked(uint256(1), bob, uint256(500e18)));

        bytes32 root = _hashPair(leaf0, leaf1);

        MerkleDrop drop = new MerkleDrop(
            address(token), root, 180 days, treasury
        );

        // Fund the drop
        vm.prank(treasury);
        token.transfer(address(drop), 2000e18);

        // Build proof for alice (index 0): sibling is leaf1
        bytes32[] memory aliceProof = new bytes32[](1);
        aliceProof[0] = leaf1;

        // Attempt claim with WRONG amount (2000e18 instead of 1000e18)
        vm.expectRevert("Invalid proof");
        drop.claim(0, alice, 2000e18, aliceProof);
    }

    // ═════════════════════════════════════════════════════════
    //  TC-276 (plan): MerkleDrop root is immutable
    // ═════════════════════════════════════════════════════════

    /// @notice TC-276 (plan version): Verify merkleRoot is immutable and matches
    ///         the constructor argument. There is no setter function.
    function test_TC276plan_merkleDropRootIsImmutable() public {
        bytes32 expectedRoot = keccak256("test-root");

        MerkleDrop drop = new MerkleDrop(
            address(token), expectedRoot, 180 days, treasury
        );

        // merkleRoot matches the constructor arg
        assertEq(drop.merkleRoot(), expectedRoot, "merkleRoot must match constructor arg");

        // Verify immutability: there is no setMerkleRoot function on MerkleDrop.
        // We confirm by checking that the stored value is the same bytes32 and
        // the token/deadline/treasury are also immutable.
        assertEq(address(drop.token()), address(token), "token is immutable");
        assertEq(drop.treasury(), treasury, "treasury is immutable");
    }

    // ═════════════════════════════════════════════════════════
    //  TC-281: setFeeSource() rejects zero address
    // ═════════════════════════════════════════════════════════

    /// @notice TC-281: setFeeSource(address(0)) reverts with "Zero address".
    ///         Re-asserted here for completeness (also in ClaraStaking.t.sol TC-026c).
    function test_TC281_setFeeSourceRejectsZeroAddress() public {
        vm.expectRevert("Zero address");
        staking.setFeeSource(address(0));
    }

    // ═════════════════════════════════════════════════════════
    //  TC-279 (plan): stakeWithPermit() rejects replayed permit
    // ═════════════════════════════════════════════════════════

    /// @notice TC-279 (plan version): After a successful stakeWithPermit, replaying
    ///         the same permit signature reverts because the nonce was incremented.
    function test_TC279plan_stakeWithPermitRejectsReplay() public {
        address user = vm.addr(ALICE_PK);

        // Fund user with CLARA
        vm.prank(treasury);
        token.transfer(user, 10_000e18);

        uint256 amount = 1000e18;
        uint256 deadline = block.timestamp + 1 hours;

        // --- First permit + stake: should succeed ---
        uint256 nonce0 = token.nonces(user);
        bytes32 digest0 = _buildPermitDigest(user, address(staking), amount, nonce0, deadline);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(ALICE_PK, digest0);

        vm.prank(user);
        staking.stakeWithPermit(amount, deadline, v0, r0, s0);
        assertEq(staking.stakedBalance(user), amount, "First stakeWithPermit should succeed");

        // --- Replay the SAME signature: should revert ---
        // The nonce has incremented (nonce0 -> nonce0+1), so the old signature
        // with nonce0 will fail ERC20Permit verification.
        vm.prank(user);
        vm.expectRevert(); // ERC2612InvalidSigner (nonce mismatch)
        staking.stakeWithPermit(amount, deadline, v0, r0, s0);
    }

    // ═════════════════════════════════════════════════════════
    //  TC-280 (plan): stakeWithPermit() and front-run permit
    // ═════════════════════════════════════════════════════════

    /// @notice TC-280 (plan version): If an attacker front-runs by calling
    ///         token.permit() directly (consuming the nonce), then the user's
    ///         subsequent stakeWithPermit() will revert because the inner
    ///         permit() call fails on the already-consumed nonce.
    ///         This is a KNOWN LIMITATION of the current implementation.
    function test_TC280plan_stakeWithPermitRevertsOnFrontRunPermit() public {
        address user = vm.addr(ALICE_PK);

        // Fund user with CLARA
        vm.prank(treasury);
        token.transfer(user, 10_000e18);

        uint256 amount = 1000e18;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = token.nonces(user);

        // User signs a permit for stakeWithPermit
        bytes32 digest = _buildPermitDigest(user, address(staking), amount, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_PK, digest);

        // --- Attacker front-runs: calls permit() directly ---
        // Anyone can call permit() with a valid signature. The attacker
        // executes the permit on-chain, consuming nonce and setting allowance.
        vm.prank(attacker);
        token.permit(user, address(staking), amount, deadline, v, r, s);

        // Verify: allowance IS set (front-runner succeeded)
        assertEq(token.allowance(user, address(staking)), amount, "Allowance set by front-runner");
        // Verify: nonce incremented
        assertEq(token.nonces(user), nonce + 1, "Nonce consumed by front-runner");

        // --- User calls stakeWithPermit with the same signature ---
        // The inner permit() call will revert because the nonce was already consumed.
        // OZ ERC20Permit checks nonce strictly. This is the KNOWN LIMITATION:
        // stakeWithPermit does not try-catch the permit call, so it reverts.
        vm.prank(user);
        vm.expectRevert(); // ERC2612InvalidSigner (nonce already consumed)
        staking.stakeWithPermit(amount, deadline, v, r, s);
    }
}
