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

    /// @notice Factory owner (can update bondRate)
    address public owner;

    /// @notice Bond rate in basis points (1000 = 10%). Applied to both poster and worker bonds.
    uint256 public bondRate = 1000;

    /// @notice All bounty proxy addresses, in creation order
    address[] public bounties;

    // ──────────────────────────── Events ───────────────────────────

    event BountyCreated(
        address indexed bountyAddress,
        address indexed poster,
        address token,
        uint256 amount,
        uint256 posterBond,
        uint256 bondRate,
        uint256 deadline,
        string  taskURI,
        string[] skillTags
    );

    event BondRateUpdated(uint256 oldRate, uint256 newRate);

    // ──────────────────────────── Errors ───────────────────────────

    error ZeroImplementation();
    error ZeroRegistry();
    error NotOwner();
    error BondRateTooHigh();

    // ──────────────────────────── Constructor ──────────────────────

    constructor(address _implementation, address _identityRegistry, address _reputationRegistry) {
        if (_implementation == address(0)) revert ZeroImplementation();
        if (_identityRegistry == address(0)) revert ZeroRegistry();
        if (_reputationRegistry == address(0)) revert ZeroRegistry();
        implementation = _implementation;
        identityRegistry = _identityRegistry;
        reputationRegistry = _reputationRegistry;
        owner = msg.sender;
    }

    // ──────────────────────────── Factory ──────────────────────────

    /// @notice Create a new bounty via EIP-1167 minimal proxy.
    /// @dev Caller must have approved this factory to spend `amount + posterBond` of `token`.
    ///      The posterBond is calculated as `amount * bondRate / 10000`.
    /// @param token      ERC-20 token for the bounty reward
    /// @param amount     Amount of tokens to lock as payment
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
        // Calculate poster bond
        uint256 posterBond = (amount * bondRate) / 10000;

        // Deploy minimal proxy
        bounty = Clones.clone(implementation);

        // Initialize the proxy with registry addresses and bond parameters
        Bounty(bounty).initialize(
            msg.sender, token, amount, deadline, taskURI,
            identityRegistry, reputationRegistry,
            bondRate, posterBond
        );

        // Transfer tokens from poster to the bounty proxy (escrow + poster bond)
        uint256 totalDeposit = amount + posterBond;
        IERC20(token).safeTransferFrom(msg.sender, bounty, totalDeposit);

        // Track
        bounties.push(bounty);

        emit BountyCreated(bounty, msg.sender, token, amount, posterBond, bondRate, deadline, taskURI, skillTags);
    }

    // ──────────────────────────── Admin ──────────────────────────

    /// @notice Update the bond rate for future bounties. Owner only.
    /// @param _bondRate New bond rate in basis points (max 5000 = 50%)
    function setBondRate(uint256 _bondRate) external {
        if (msg.sender != owner) revert NotOwner();
        if (_bondRate > 5000) revert BondRateTooHigh();

        uint256 oldRate = bondRate;
        bondRate = _bondRate;

        emit BondRateUpdated(oldRate, _bondRate);
    }

    // ──────────────────────────── Views ────────────────────────────

    /// @notice Total number of bounties created through this factory
    function getBountyCount() external view returns (uint256) {
        return bounties.length;
    }
}
