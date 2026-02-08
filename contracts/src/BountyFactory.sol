// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./Bounty.sol";

/// @title BountyFactory
/// @notice Deploys EIP-1167 minimal proxy bounties. Each clone costs ~$0.05-0.10 on Base.
/// @dev Uses OpenZeppelin Clones library for deterministic cheap deployments.
contract BountyFactory {
    using SafeERC20 for IERC20;

    // ──────────────────────────── State ────────────────────────────

    /// @notice The Bounty implementation that all clones delegate to
    address public immutable implementation;

    /// @notice ERC-8004 IdentityRegistry used by all bounties
    address public immutable identityRegistry;

    /// @notice ERC-8004 ReputationRegistry used by all bounties
    address public immutable reputationRegistry;

    /// @notice All bounty proxy addresses, in creation order
    address[] public bounties;

    // ──────────────────────────── Events ───────────────────────────

    event BountyCreated(
        address indexed bountyAddress,
        address indexed poster,
        address token,
        uint256 amount,
        uint256 deadline,
        string  taskURI,
        string[] skillTags
    );

    // ──────────────────────────── Errors ───────────────────────────

    error ZeroImplementation();
    error ZeroRegistry();

    // ──────────────────────────── Constructor ──────────────────────

    constructor(address _implementation, address _identityRegistry, address _reputationRegistry) {
        if (_implementation == address(0)) revert ZeroImplementation();
        if (_identityRegistry == address(0)) revert ZeroRegistry();
        if (_reputationRegistry == address(0)) revert ZeroRegistry();
        implementation = _implementation;
        identityRegistry = _identityRegistry;
        reputationRegistry = _reputationRegistry;
    }

    // ──────────────────────────── Factory ──────────────────────────

    /// @notice Create a new bounty via EIP-1167 minimal proxy.
    /// @dev Caller must have approved this factory to spend `amount` of `token`.
    /// @param token      ERC-20 token for the bounty reward
    /// @param amount     Amount of tokens to lock
    /// @param deadline   Unix timestamp after which the bounty can expire
    /// @param taskURI    Data URI or IPFS hash describing the task
    /// @param skillTags  Array of skill tags for discoverability
    /// @return bounty    Address of the newly created bounty proxy
    function createBounty(
        address token,
        uint256 amount,
        uint256 deadline,
        string calldata taskURI,
        string[] calldata skillTags
    ) external returns (address bounty) {
        // Deploy minimal proxy
        bounty = Clones.clone(implementation);

        // Initialize the proxy with registry addresses
        Bounty(bounty).initialize(
            msg.sender, token, amount, deadline, taskURI,
            identityRegistry, reputationRegistry
        );

        // Transfer tokens from poster to the bounty proxy
        IERC20(token).safeTransferFrom(msg.sender, bounty, amount);

        // Track
        bounties.push(bounty);

        emit BountyCreated(bounty, msg.sender, token, amount, deadline, taskURI, skillTags);
    }

    // ──────────────────────────── Views ────────────────────────────

    /// @notice Total number of bounties created through this factory
    function getBountyCount() external view returns (uint256) {
        return bounties.length;
    }
}
