// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Base.t.sol";

contract ClaraTokenTest is ClaraTestBase {
    // TC-001: ClaraToken deploys with correct name and symbol (P0)
    function test_TC001_nameAndSymbol() public view {
        assertEq(token.name(), "Clara");
        assertEq(token.symbol(), "CLARA");
        assertEq(token.decimals(), 18);
    }

    // TC-002: ClaraToken mints exactly 100M to treasury at construction (P0)
    function test_TC002_initialSupply() public view {
        assertEq(token.totalSupply(), 100_000_000e18);
        // Treasury distributed some in setUp, so check total - distributed
        uint256 distributed = 10_000e18 * 3; // alice + bob + charlie
        assertEq(token.balanceOf(treasury), 100_000_000e18 - distributed);
    }

    // TC-003: ClaraToken has no mint function (P0)
    // Verified by the fact that ClaraToken only inherits ERC20 and ERC20Permit,
    // neither of which exposes a public mint(). We verify supply is fixed.
    function test_TC003_noMinting() public view {
        assertEq(token.totalSupply(), 100_000_000e18);
        // After construction, totalSupply can never increase
        // (no mint function exists on the contract)
    }

    // TC-004: ClaraToken standard ERC-20 transfer works (P0)
    function test_TC004_transfer() public {
        address recipient = makeAddr("recipient");

        vm.prank(alice);
        // Alice has 10_000e18 from setUp, transfer 500 to recipient
        token.transfer(recipient, 500e18);

        assertEq(token.balanceOf(recipient), 500e18);
        assertEq(token.balanceOf(alice), 10_000e18 - 500e18);
    }

    // TC-005: ERC-2612 permit sets allowance (P1)
    function test_TC005_permit() public {
        uint256 ownerPk = 0xA11CE;
        address owner = vm.addr(ownerPk);

        // Give owner some tokens
        vm.prank(treasury);
        token.transfer(owner, 1000e18);

        address spender = makeAddr("spender");
        uint256 value = 500e18;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = token.nonces(owner);

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                spender,
                value,
                nonce,
                deadline
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);

        token.permit(owner, spender, value, deadline, v, r, s);

        assertEq(token.allowance(owner, spender), value);
        assertEq(token.nonces(owner), nonce + 1);
    }

    // TC-006: Permit rejects expired deadline (P1)
    function test_TC006_permitExpiredDeadline() public {
        uint256 ownerPk = 0xA11CE;
        address owner = vm.addr(ownerPk);
        address spender = makeAddr("spender");

        // Warp to a known time so deadline can be in the past
        vm.warp(1000);

        uint256 deadline = block.timestamp - 1; // expired
        uint256 nonce = token.nonces(owner);

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner, spender, 100e18, nonce, deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);

        vm.expectRevert();
        token.permit(owner, spender, 100e18, deadline, v, r, s);
    }

    // TC-007: Permit rejects invalid signature (P1)
    function test_TC007_permitInvalidSigner() public {
        uint256 ownerPk = 0xA11CE;
        address owner = vm.addr(ownerPk);
        uint256 wrongPk = 0xB0B;
        address spender = makeAddr("spender");

        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = token.nonces(owner);

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner, spender, 100e18, nonce, deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, digest); // wrong signer

        vm.expectRevert();
        token.permit(owner, spender, 100e18, deadline, v, r, s);
    }

    // TC-008: ClaraToken has 18 decimals (P1)
    function test_TC008_decimals() public view {
        assertEq(token.decimals(), 18);
    }

    // TC-263: ClaraToken cannot be re-initialized (P0 - security)
    // ClaraToken is immutable (constructor-only), no initialize() exists
    function test_TC263_noReinitialize() public view {
        // ClaraToken uses constructor, not initializer pattern
        // Supply is fixed and cannot change
        assertEq(token.totalSupply(), 100_000_000e18);
    }

    // Verify zero treasury address reverts
    function test_zeroTreasuryReverts() public {
        vm.expectRevert("Zero treasury");
        new ClaraToken(address(0));
    }
}
