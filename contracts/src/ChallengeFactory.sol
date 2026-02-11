// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./Challenge.sol";

/// @title ChallengeFactory
/// @notice Deploys EIP-1167 minimal proxy challenges. Each clone costs ~$0.01 on Base.
/// @dev Uses OpenZeppelin Clones library for deterministic cheap deployments.
contract ChallengeFactory {
    using SafeERC20 for IERC20;

    // ──────────────────────────── Types ────────────────────────────

    /// @notice Parameters for creating a new challenge
    struct CreateParams {
        address token;
        address evaluator;  // address authorized to post scores (0x0 = poster-only)
        uint256 prizePool;
        uint256 deadline;
        uint256 scoringDeadline;
        string  challengeURI;
        bytes32 evalConfigHash;
        bytes32 privateSetHash;
        uint8   winnerCount;
        uint16[] payoutBps;
        uint256 maxParticipants;
        string[] skillTags;
    }

    // ──────────────────────────── State ────────────────────────────

    /// @notice The Challenge implementation that all clones delegate to
    address public immutable implementation;

    /// @notice ERC-8004 IdentityRegistry used by all challenges
    address public immutable identityRegistry;

    /// @notice Factory owner (can update posterBondRate)
    address public owner;

    /// @notice Poster bond rate in basis points (500 = 5%). Applied to prize pool.
    uint256 public posterBondRate = 500;

    /// @notice Maximum bond rate (20%)
    uint256 public constant MAX_BOND_RATE = 2000;

    /// @notice All challenge proxy addresses, in creation order
    address[] public challenges;

    // ──────────────────────────── Events ───────────────────────────

    event ChallengeCreated(
        address indexed challengeAddress,
        address indexed poster,
        address token,
        uint256 prizePool,
        uint256 posterBond,
        uint256 deadline,
        uint256 scoringDeadline,
        string  challengeURI,
        string[] skillTags
    );

    event BondRateUpdated(uint256 oldRate, uint256 newRate);

    // ──────────────────────────── Errors ───────────────────────────

    error ZeroImplementation();
    error ZeroRegistry();
    error NotOwner();
    error BondRateTooHigh();
    error InvalidPayoutBpsLength();
    error InvalidPayoutBpsSum();
    error WinnerCountTooHigh();
    error DeadlineTooSoon();
    error ScoringDeadlineTooSoon();

    // ──────────────────────────── Constructor ──────────────────────

    constructor(address _implementation, address _identityRegistry) {
        if (_implementation == address(0)) revert ZeroImplementation();
        if (_identityRegistry == address(0)) revert ZeroRegistry();
        implementation = _implementation;
        identityRegistry = _identityRegistry;
        owner = msg.sender;
    }

    // ──────────────────────────── Factory ──────────────────────────

    /// @notice Create a new challenge via EIP-1167 minimal proxy.
    /// @dev Caller must have approved this factory to spend `prizePool + posterBond` of `token`.
    /// @param p CreateParams struct with all challenge configuration
    /// @return challenge Address of the newly created challenge proxy
    function createChallenge(CreateParams calldata p) external returns (address challenge) {
        // Validate deadlines
        if (p.deadline <= block.timestamp) revert DeadlineTooSoon();
        if (p.scoringDeadline <= p.deadline) revert ScoringDeadlineTooSoon();

        // Validate winners
        if (p.winnerCount > 25) revert WinnerCountTooHigh();
        if (p.payoutBps.length != p.winnerCount) revert InvalidPayoutBpsLength();

        // Validate payoutBps sum to 10000
        uint256 totalBps = 0;
        for (uint256 i = 0; i < p.payoutBps.length; i++) {
            totalBps += p.payoutBps[i];
        }
        if (totalBps != 10000) revert InvalidPayoutBpsSum();

        // Calculate poster bond
        uint256 posterBond = (p.prizePool * posterBondRate) / 10000;

        // Deploy minimal proxy
        challenge = Clones.clone(implementation);

        // Initialize the proxy
        Challenge(challenge).initialize(Challenge.InitParams({
            poster: msg.sender,
            evaluator: p.evaluator,
            token: p.token,
            prizePool: p.prizePool,
            deadline: p.deadline,
            scoringDeadline: p.scoringDeadline,
            challengeURI: p.challengeURI,
            evalConfigHash: p.evalConfigHash,
            privateSetHash: p.privateSetHash,
            winnerCount: p.winnerCount,
            payoutBps: p.payoutBps,
            identityRegistry: identityRegistry,
            posterBond: posterBond,
            maxParticipants: p.maxParticipants
        }));

        // Transfer tokens from poster to the challenge proxy (prize pool + poster bond)
        uint256 totalDeposit = p.prizePool + posterBond;
        IERC20(p.token).safeTransferFrom(msg.sender, challenge, totalDeposit);

        // Track
        challenges.push(challenge);

        emit ChallengeCreated(
            challenge,
            msg.sender,
            p.token,
            p.prizePool,
            posterBond,
            p.deadline,
            p.scoringDeadline,
            p.challengeURI,
            p.skillTags
        );
    }

    // ──────────────────────────── Admin ──────────────────────────

    /// @notice Update the poster bond rate for future challenges. Owner only.
    /// @param _posterBondRate New bond rate in basis points (max 2000 = 20%)
    function setPosterBondRate(uint256 _posterBondRate) external {
        if (msg.sender != owner) revert NotOwner();
        if (_posterBondRate > MAX_BOND_RATE) revert BondRateTooHigh();

        uint256 oldRate = posterBondRate;
        posterBondRate = _posterBondRate;

        emit BondRateUpdated(oldRate, _posterBondRate);
    }

    // ──────────────────────────── Views ────────────────────────────

    /// @notice Total number of challenges created through this factory
    function getChallengeCount() external view returns (uint256) {
        return challenges.length;
    }
}
