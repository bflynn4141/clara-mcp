// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/MerkleDrop.sol";
import "../src/ClaraToken.sol";

/// @title MerkleDrop Tests
/// @notice Covers TC-040 through TC-049: deployment, claiming, double-claim,
///         wrong-proof, expired claim, sweep, and bitmap word-boundary.
contract MerkleDropTest is Test {
    ClaraToken public token;
    MerkleDrop public drop;

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public charlie = makeAddr("charlie");
    address public attacker = makeAddr("attacker");

    // Airdrop amounts
    uint256 public constant ALICE_AMOUNT = 500e18;
    uint256 public constant BOB_AMOUNT = 300e18;
    uint256 public constant CHARLIE_AMOUNT = 200e18;

    // Claim duration: 180 days (approx 6 months)
    uint256 public constant CLAIM_DURATION = 180 days;

    // Merkle tree nodes (computed in setUp)
    bytes32 public leaf0; // alice
    bytes32 public leaf1; // bob
    bytes32 public leaf2; // charlie
    bytes32 public leaf3; // padding (attacker, amount=0)
    bytes32 public node01;
    bytes32 public node23;
    bytes32 public merkleRoot;

    // Proofs
    bytes32[] public aliceProof;
    bytes32[] public bobProof;
    bytes32[] public charlieProof;

    function setUp() public {
        // Deploy token
        token = new ClaraToken(treasury);

        // ── Build 4-leaf Merkle tree ──
        // Leaves: keccak256(abi.encodePacked(index, account, amount))
        leaf0 = keccak256(abi.encodePacked(uint256(0), alice, ALICE_AMOUNT));
        leaf1 = keccak256(abi.encodePacked(uint256(1), bob, BOB_AMOUNT));
        leaf2 = keccak256(abi.encodePacked(uint256(2), charlie, CHARLIE_AMOUNT));
        leaf3 = keccak256(abi.encodePacked(uint256(3), attacker, uint256(0)));

        // Internal nodes: hash pair with sorting (OZ MerkleProof convention)
        node01 = _hashPair(leaf0, leaf1);
        node23 = _hashPair(leaf2, leaf3);
        merkleRoot = _hashPair(node01, node23);

        // ── Build proofs ──
        // Proof for leaf0 (alice): [leaf1, node23]
        aliceProof = new bytes32[](2);
        aliceProof[0] = leaf1;
        aliceProof[1] = node23;

        // Proof for leaf1 (bob): [leaf0, node23]
        bobProof = new bytes32[](2);
        bobProof[0] = leaf0;
        bobProof[1] = node23;

        // Proof for leaf2 (charlie): [leaf3, node01]
        charlieProof = new bytes32[](2);
        charlieProof[0] = leaf3;
        charlieProof[1] = node01;

        // Deploy MerkleDrop
        drop = new MerkleDrop(
            address(token),
            merkleRoot,
            CLAIM_DURATION,
            treasury
        );

        // Fund the drop contract with enough tokens
        uint256 totalDrop = ALICE_AMOUNT + BOB_AMOUNT + CHARLIE_AMOUNT;
        vm.prank(treasury);
        token.transfer(address(drop), totalDrop);
    }

    /// @dev Sorted hash pair (same as OZ MerkleProof internal logic)
    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b
            ? keccak256(abi.encodePacked(a, b))
            : keccak256(abi.encodePacked(b, a));
    }

    // ═════════════════════════════════════════════════════
    // P0 Tests
    // ═════════════════════════════════════════════════════

    /// @notice TC-040: Deployment — verify token(), merkleRoot(), deadline(), treasury()
    function test_TC040_deployment() public view {
        assertEq(address(drop.token()), address(token), "token");
        assertEq(drop.merkleRoot(), merkleRoot, "merkleRoot");
        assertEq(drop.deadline(), block.timestamp + CLAIM_DURATION, "deadline");
        assertEq(drop.treasury(), treasury, "treasury");
    }

    /// @notice TC-041: Valid claim — Alice claims 500e18 CLARA
    function test_TC041_validClaim() public {
        uint256 balBefore = token.balanceOf(alice);

        drop.claim(0, alice, ALICE_AMOUNT, aliceProof);

        uint256 balAfter = token.balanceOf(alice);
        assertEq(balAfter - balBefore, ALICE_AMOUNT, "Alice receives 500e18 CLARA");
        assertTrue(drop.isClaimed(0), "Index 0 marked claimed");
    }

    /// @notice TC-042: Double-claim reverts with "Already claimed"
    function test_TC042_doubleClaim() public {
        drop.claim(0, alice, ALICE_AMOUNT, aliceProof);

        vm.expectRevert("Already claimed");
        drop.claim(0, alice, ALICE_AMOUNT, aliceProof);
    }

    /// @notice TC-043: Wrong account with valid proof -> reverts (invalid proof)
    /// Bob tries to claim with Alice's index/amount/proof -> leaf mismatch
    function test_TC043_wrongAccountReverts() public {
        // Bob tries Alice's claim parameters (index=0, amount=500e18) with alice's proof
        // This builds a different leaf (bob's address instead of alice's)
        vm.expectRevert("Invalid proof");
        drop.claim(0, bob, ALICE_AMOUNT, aliceProof);
    }

    // ═════════════════════════════════════════════════════
    // P1 Tests
    // ═════════════════════════════════════════════════════

    /// @notice TC-044: Claim after deadline -> reverts
    function test_TC044_claimAfterDeadline() public {
        vm.warp(drop.deadline() + 1);

        vm.expectRevert("Claim period ended");
        drop.claim(0, alice, ALICE_AMOUNT, aliceProof);
    }

    /// @notice TC-045: Claim at exactly the deadline -> succeeds
    /// The contract checks `block.timestamp <= deadline`, so claiming AT
    /// the deadline should succeed.
    function test_TC045_claimAtExactDeadline() public {
        vm.warp(drop.deadline());

        drop.claim(0, alice, ALICE_AMOUNT, aliceProof);

        assertTrue(drop.isClaimed(0), "Claim at exact deadline succeeds");
        assertEq(token.balanceOf(alice), ALICE_AMOUNT, "Alice got tokens");
    }

    /// @notice TC-046: Sweep after deadline returns unclaimed to treasury
    function test_TC046_sweepAfterDeadline() public {
        // Alice claims, Bob and Charlie do not
        drop.claim(0, alice, ALICE_AMOUNT, aliceProof);

        uint256 unclaimed = BOB_AMOUNT + CHARLIE_AMOUNT;
        uint256 treasuryBefore = token.balanceOf(treasury);

        vm.warp(drop.deadline() + 1);
        drop.sweep();

        uint256 treasuryAfter = token.balanceOf(treasury);
        assertEq(
            treasuryAfter - treasuryBefore,
            unclaimed,
            "Treasury receives unclaimed tokens"
        );
    }

    /// @notice TC-047: Sweep before deadline reverts
    function test_TC047_sweepBeforeDeadline() public {
        vm.expectRevert("Claim period not ended");
        drop.sweep();
    }

    /// @notice TC-048: Multiple valid claims in sequence
    function test_TC048_multipleValidClaims() public {
        drop.claim(0, alice, ALICE_AMOUNT, aliceProof);
        drop.claim(1, bob, BOB_AMOUNT, bobProof);
        drop.claim(2, charlie, CHARLIE_AMOUNT, charlieProof);

        assertEq(token.balanceOf(alice), ALICE_AMOUNT, "Alice balance");
        assertEq(token.balanceOf(bob), BOB_AMOUNT, "Bob balance");
        assertEq(token.balanceOf(charlie), CHARLIE_AMOUNT, "Charlie balance");

        assertTrue(drop.isClaimed(0), "Index 0 claimed");
        assertTrue(drop.isClaimed(1), "Index 1 claimed");
        assertTrue(drop.isClaimed(2), "Index 2 claimed");
    }

    /// @notice TC-049: Bitmap word boundary — indices 255 and 256 in different words
    /// Index 255 is bit 255 of word 0. Index 256 is bit 0 of word 1.
    /// Both marked claimed, index 257 not.
    function test_TC049_bitmapWordBoundary() public {
        // Use a separate helper to avoid stack-too-deep
        (MerkleDrop boundaryDrop, bytes32[] memory proof255, bytes32[] memory proof256)
            = _buildBoundaryDrop();

        address claimer1 = makeAddr("claimer255");
        address claimer2 = makeAddr("claimer256");
        uint256 amt = 100e18;

        // Claim index 255
        boundaryDrop.claim(255, claimer1, amt, proof255);
        assertTrue(boundaryDrop.isClaimed(255), "Index 255 claimed");
        assertFalse(boundaryDrop.isClaimed(256), "Index 256 not yet claimed");

        // Claim index 256
        boundaryDrop.claim(256, claimer2, amt, proof256);
        assertTrue(boundaryDrop.isClaimed(256), "Index 256 claimed");

        // Index 257 should NOT be claimed
        assertFalse(boundaryDrop.isClaimed(257), "Index 257 not claimed");

        // Verify balances
        assertEq(token.balanceOf(claimer1), amt, "claimer255 got tokens");
        assertEq(token.balanceOf(claimer2), amt, "claimer256 got tokens");
    }

    /// @dev Build a MerkleDrop with indices 255/256 for word-boundary testing.
    ///      Separated to reduce stack depth in the test function.
    function _buildBoundaryDrop()
        internal
        returns (MerkleDrop boundaryDrop, bytes32[] memory proof255, bytes32[] memory proof256)
    {
        address claimer1 = makeAddr("claimer255");
        address claimer2 = makeAddr("claimer256");
        uint256 amt = 100e18;

        bytes32 leafA = keccak256(abi.encodePacked(uint256(255), claimer1, amt));
        bytes32 leafB = keccak256(abi.encodePacked(uint256(256), claimer2, amt));
        bytes32 leafC = keccak256(abi.encodePacked(uint256(257), address(0xdead), uint256(0)));
        bytes32 leafD = keccak256(abi.encodePacked(uint256(258), address(0xbeef), uint256(0)));

        bytes32 nodeAB = _hashPair(leafA, leafB);
        bytes32 nodeCD = _hashPair(leafC, leafD);
        bytes32 root = _hashPair(nodeAB, nodeCD);

        boundaryDrop = new MerkleDrop(address(token), root, CLAIM_DURATION, treasury);

        vm.prank(treasury);
        token.transfer(address(boundaryDrop), amt * 2);

        proof255 = new bytes32[](2);
        proof255[0] = leafB;
        proof255[1] = nodeCD;

        proof256 = new bytes32[](2);
        proof256[0] = leafA;
        proof256[1] = nodeCD;
    }
}
