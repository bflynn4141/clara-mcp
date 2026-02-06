// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title ClaraToken
/// @notice ERC-20 token with fixed 100M supply and ERC-2612 permit.
/// @dev Immutable — no proxy, no mint, no burn, no admin. Deploy and forget.
contract ClaraToken is ERC20, ERC20Permit {
    uint256 public constant MAX_SUPPLY = 100_000_000e18;

    /// @param treasury Address receiving the full 100M supply at deployment
    constructor(address treasury) ERC20("Clara", "CLARA") ERC20Permit("Clara") {
        require(treasury != address(0), "Zero treasury");
        _mint(treasury, MAX_SUPPLY);
    }
}
