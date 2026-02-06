// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ClaraToken.sol";
import "../src/MerkleDrop.sol";

/// @title MerkleCompat — Cross-validate TypeScript Merkle output against Solidity
/// @dev Proves the TS generate-merkle.ts output is compatible with MerkleDrop.sol
contract MerkleCompatTest is Test {
    ClaraToken public token;
    MerkleDrop public drop;
    address public treasury = address(this);

    // Values from merkle-output-testnet.json
    bytes32 constant ROOT = 0xfdbc4f010fbfd47ac317b41246e4f669ccecc31f8fa95968063abc8aa3ddeecf;

    function setUp() public {
        token = new ClaraToken(treasury);
        drop = new MerkleDrop(address(token), ROOT, 180 days, treasury);
        // Fund with 10M CLARA
        token.transfer(address(drop), 10_000_000e18);
    }

    function test_claim_index0_deployer() public {
        address account = 0x7C5FA16118Df518AD0fF27eB108FE5C08f46E994;
        uint256 amount = 5_000_000e18;
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = 0x3e1f8f2ab1a2ccc7717ce704fcf16bf2546ae0d24da63dadc2ea995f73d5d890;
        proof[1] = 0x6eaf434328c41a706649ce3ff6d47eb045af8ede58bc27ef4535776f41010a31;

        drop.claim(0, account, amount, proof);

        assertEq(token.balanceOf(account), amount, "Index 0 claimed correctly");
        assertTrue(drop.isClaimed(0));
    }

    function test_claim_index1_brian() public {
        address account = 0x8744BAF00f5Ad7ffccC56c25FA5aA9270e2caffD;
        uint256 amount = 3_000_000e18;
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = 0x3891e97b7db55e12a93822314a5924ba7738663ca0b6126a5f558d05a5bea36f;
        proof[1] = 0x6eaf434328c41a706649ce3ff6d47eb045af8ede58bc27ef4535776f41010a31;

        drop.claim(1, account, amount, proof);

        assertEq(token.balanceOf(account), amount, "Index 1 claimed correctly");
        assertTrue(drop.isClaimed(1));
    }

    function test_claim_index2() public {
        address account = address(1);
        uint256 amount = 1_000_000e18;
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = 0xf3d660925ff327d376f283e05f914314ecfc21eac5f65ae80d5d3b52f132ec67;
        proof[1] = 0x8ccc9dff6af3d621ffa30b7a9bf77ba7ff4ab8906fdcd20c9fbd90bd03c69957;

        drop.claim(2, account, amount, proof);

        assertEq(token.balanceOf(account), amount, "Index 2 claimed correctly");
        assertTrue(drop.isClaimed(2));
    }

    function test_claim_index3() public {
        address account = address(2);
        uint256 amount = 1_000_000e18;
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = 0x4db86042c21af3558cf78a9b35d5dd45f1c3b059dc48c2ac2db1696519d85577;
        proof[1] = 0x8ccc9dff6af3d621ffa30b7a9bf77ba7ff4ab8906fdcd20c9fbd90bd03c69957;

        drop.claim(3, account, amount, proof);

        assertEq(token.balanceOf(account), amount, "Index 3 claimed correctly");
        assertTrue(drop.isClaimed(3));
    }

    function test_all_claims_exhaust_supply() public {
        // Claim all 4
        bytes32[] memory p0 = new bytes32[](2);
        p0[0] = 0x3e1f8f2ab1a2ccc7717ce704fcf16bf2546ae0d24da63dadc2ea995f73d5d890;
        p0[1] = 0x6eaf434328c41a706649ce3ff6d47eb045af8ede58bc27ef4535776f41010a31;
        drop.claim(0, 0x7C5FA16118Df518AD0fF27eB108FE5C08f46E994, 5_000_000e18, p0);

        bytes32[] memory p1 = new bytes32[](2);
        p1[0] = 0x3891e97b7db55e12a93822314a5924ba7738663ca0b6126a5f558d05a5bea36f;
        p1[1] = 0x6eaf434328c41a706649ce3ff6d47eb045af8ede58bc27ef4535776f41010a31;
        drop.claim(1, 0x8744BAF00f5Ad7ffccC56c25FA5aA9270e2caffD, 3_000_000e18, p1);

        bytes32[] memory p2 = new bytes32[](2);
        p2[0] = 0xf3d660925ff327d376f283e05f914314ecfc21eac5f65ae80d5d3b52f132ec67;
        p2[1] = 0x8ccc9dff6af3d621ffa30b7a9bf77ba7ff4ab8906fdcd20c9fbd90bd03c69957;
        drop.claim(2, address(1), 1_000_000e18, p2);

        bytes32[] memory p3 = new bytes32[](2);
        p3[0] = 0x4db86042c21af3558cf78a9b35d5dd45f1c3b059dc48c2ac2db1696519d85577;
        p3[1] = 0x8ccc9dff6af3d621ffa30b7a9bf77ba7ff4ab8906fdcd20c9fbd90bd03c69957;
        drop.claim(3, address(2), 1_000_000e18, p3);

        // Drop contract should have 0 CLARA remaining
        assertEq(token.balanceOf(address(drop)), 0, "All tokens claimed");
    }
}
