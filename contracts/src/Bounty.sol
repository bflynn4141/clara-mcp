// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Minimal interface for ERC-8004 IdentityRegistry (ERC-721)
interface IIdentityRegistry {
    /// @dev ERC-721 ownerOf — returns the address that owns agentId
    function ownerOf(uint256 agentId) external view returns (address);
    /// @dev ERC-721 balanceOf — returns number of agent tokens owned
    function balanceOf(address owner) external view returns (uint256);
}

/// @notice Minimal interface for ERC-8004 ReputationRegistry on Base
interface IReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}

/// @title Bounty
/// @notice Implementation template for EIP-1167 minimal proxy bounties.
///         State machine: Open -> Claimed -> Submitted -> Approved / Rejected / Expired / Cancelled / Resolved.
/// @dev Must be initialized via `initialize()` — constructors are not called on clones.
contract Bounty is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────── Types ────────────────────────────

    enum Status { Open, Claimed, Submitted, Approved, Expired, Cancelled, Rejected, Resolved }

    // ──────────────────────────── State ────────────────────────────

    address public poster;
    address public claimer;
    uint256 public claimerAgentId;
    IERC20  public token;
    uint256 public amount;
    uint256 public deadline;
    string  public taskURI;
    string  public proofURI;
    Status  public status;
    bool    private _initialized;

    /// @dev ERC-8004 registries — set during initialize(), immutable after
    IIdentityRegistry   public identityRegistry;
    IReputationRegistry public reputationRegistry;

    /// @dev Bond mechanism state
    uint256 public posterBond;
    uint256 public workerBond;
    uint256 public bondRate;        // basis points (1000 = 10%)
    uint256 public submittedAt;     // timestamp for auto-approve
    uint8   public rejectionCount;  // 0, 1, or 2
    uint256 public claimedAt;       // timestamp for unclaim grace period

    uint256 public constant REVIEW_PERIOD = 72 hours;

    // ──────────────────────────── Events ───────────────────────────

    event BountyClaimed(address indexed claimer, uint256 agentId);
    event WorkSubmitted(address indexed claimer, string proofURI);
    event BountyApproved(address indexed claimer, uint256 amount);
    event BountyExpired(address indexed poster, uint256 amount);
    event BountyCancelled(address indexed poster, uint256 amount);
    event BountyRejected(address indexed poster, address indexed claimer, uint8 rejectionCount);
    event BondSlashed(address indexed from, uint256 amount, address indexed to);
    event BondBurned(address indexed from, uint256 amount);
    event AutoApproved(address indexed claimer, uint256 amount);

    // ──────────────────────────── Errors ───────────────────────────

    error AlreadyInitialized();
    error NotPoster();
    error NotClaimer();
    error InvalidStatus(Status current, Status expected);
    error NotRegisteredAgent();
    error DeadlineNotReached();
    error DeadlinePassed();
    error ZeroAddress();
    error ZeroAmount();
    error DeadlineTooSoon();
    error ReviewPeriodNotElapsed();
    error MaxRejectionsReached();
    error UnclaimWindowClosed();

    // ──────────────────────────── Modifiers ────────────────────────

    modifier onlyPoster() {
        if (msg.sender != poster) revert NotPoster();
        _;
    }

    modifier onlyClaimer() {
        if (msg.sender != claimer) revert NotClaimer();
        _;
    }

    modifier inStatus(Status expected) {
        if (status != expected) revert InvalidStatus(status, expected);
        _;
    }

    // ──────────────────────────── Init ─────────────────────────────

    /// @notice Initialize the bounty proxy. Called once by BountyFactory.
    /// @param _poster              Address that posted (and funds) the bounty
    /// @param _token               ERC-20 token used for payment
    /// @param _amount              Token amount locked in this bounty
    /// @param _deadline            Unix timestamp after which the bounty can expire
    /// @param _taskURI             Data URI or IPFS hash describing the task
    /// @param _identityRegistry    ERC-8004 IdentityRegistry address
    /// @param _reputationRegistry  ERC-8004 ReputationRegistry address
    /// @param _bondRate            Bond rate in basis points (1000 = 10%)
    /// @param _posterBond          Poster bond amount (pre-calculated by factory)
    function initialize(
        address _poster,
        address _token,
        uint256 _amount,
        uint256 _deadline,
        string calldata _taskURI,
        address _identityRegistry,
        address _reputationRegistry,
        uint256 _bondRate,
        uint256 _posterBond
    ) external {
        if (_initialized) revert AlreadyInitialized();
        if (_poster == address(0)) revert ZeroAddress();
        if (_token == address(0)) revert ZeroAddress();
        if (_amount == 0) revert ZeroAmount();
        if (_deadline <= block.timestamp) revert DeadlineTooSoon();
        if (_identityRegistry == address(0)) revert ZeroAddress();
        if (_reputationRegistry == address(0)) revert ZeroAddress();

        _initialized = true;
        poster   = _poster;
        token    = IERC20(_token);
        amount   = _amount;
        deadline = _deadline;
        taskURI  = _taskURI;
        identityRegistry   = IIdentityRegistry(_identityRegistry);
        reputationRegistry = IReputationRegistry(_reputationRegistry);
        bondRate   = _bondRate;
        posterBond = _posterBond;
        status     = Status.Open;
    }

    // ──────────────────────────── Actions ──────────────────────────

    /// @notice Claim this bounty. Caller must own the specified ERC-8004 agent token.
    ///         Worker must approve this contract for the worker bond amount first.
    /// @param agentId The caller's ERC-8004 agent token ID (verified via ownerOf)
    function claim(uint256 agentId) external nonReentrant inStatus(Status.Open) {
        if (block.timestamp >= deadline) revert DeadlinePassed();

        // Verify caller owns this agent token (reverts if token doesn't exist)
        if (identityRegistry.ownerOf(agentId) != msg.sender) revert NotRegisteredAgent();

        claimer = msg.sender;
        claimerAgentId = agentId;
        claimedAt = block.timestamp;
        status  = Status.Claimed;

        // Calculate and collect worker bond
        uint256 _workerBond = (amount * bondRate) / 10000;
        if (_workerBond > 0) {
            workerBond = _workerBond;
            token.safeTransferFrom(msg.sender, address(this), _workerBond);
        }

        emit BountyClaimed(msg.sender, agentId);
    }

    /// @notice Submit proof of work. Only the claimer can call this.
    ///         Allowed from Claimed status (first submission) or Rejected status (resubmission).
    /// @param _proofURI  URI pointing to the work proof (data URI / IPFS)
    function submitWork(string calldata _proofURI) external nonReentrant onlyClaimer {
        if (status != Status.Claimed && status != Status.Rejected) {
            revert InvalidStatus(status, Status.Claimed);
        }
        if (status == Status.Rejected && rejectionCount >= 2) {
            revert MaxRejectionsReached();
        }

        proofURI = _proofURI;
        submittedAt = block.timestamp;
        status   = Status.Submitted;

        emit WorkSubmitted(msg.sender, _proofURI);
    }

    /// @notice Approve the submission and pay the claimer.
    ///         Returns worker bond to claimer and poster bond to poster.
    function approve() external nonReentrant onlyPoster inStatus(Status.Submitted) {
        status = Status.Approved;

        // Pay the worker
        token.safeTransfer(claimer, amount);

        // Return bonds
        if (workerBond > 0) {
            token.safeTransfer(claimer, workerBond);
            workerBond = 0;
        }
        if (posterBond > 0) {
            token.safeTransfer(poster, posterBond);
            posterBond = 0;
        }

        emit BountyApproved(claimer, amount);
    }

    /// @notice Approve with on-chain reputation feedback via ReputationRegistry.
    /// @param value         Feedback value (e.g. 5 for 5.0 rating)
    /// @param valueDecimals Decimals for the value (e.g. 0 for integer, 1 for one decimal)
    /// @param tag1          Primary skill tag (e.g. "audit")
    /// @param tag2          Secondary skill tag (e.g. "solidity")
    /// @param endpoint      Agent endpoint URI
    /// @param feedbackURI   URI pointing to detailed feedback
    /// @param feedbackHash  Keccak hash of the feedback content
    function approveWithFeedback(
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external nonReentrant onlyPoster inStatus(Status.Submitted) {
        status = Status.Approved;

        // Pay the worker
        token.safeTransfer(claimer, amount);

        // Return bonds
        if (workerBond > 0) {
            token.safeTransfer(claimer, workerBond);
            workerBond = 0;
        }
        if (posterBond > 0) {
            token.safeTransfer(poster, posterBond);
            posterBond = 0;
        }

        if (claimerAgentId != 0) {
            reputationRegistry.giveFeedback(
                claimerAgentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash
            );
        }

        emit BountyApproved(claimer, amount);
    }

    /// @notice Reject the submission. First rejection slashes worker bond (50/50).
    ///         Second rejection burns both bonds and returns escrow to poster.
    function reject() external nonReentrant onlyPoster inStatus(Status.Submitted) {
        rejectionCount++;

        if (rejectionCount == 1) {
            // First rejection: slash worker bond (50% to poster, 50% burned)
            uint256 halfBond = workerBond / 2;
            if (halfBond > 0) {
                token.safeTransfer(poster, halfBond);
                emit BondSlashed(claimer, halfBond, poster);
                uint256 burnAmount = workerBond - halfBond;
                token.safeTransfer(address(0xdead), burnAmount);
                emit BondBurned(claimer, burnAmount);
            }
            workerBond = 0;
            status = Status.Rejected;

            emit BountyRejected(poster, claimer, rejectionCount);
        } else {
            // Second rejection: burn BOTH bonds, return escrow to poster
            if (workerBond > 0) {
                token.safeTransfer(address(0xdead), workerBond);
                emit BondBurned(claimer, workerBond);
                workerBond = 0;
            }
            if (posterBond > 0) {
                token.safeTransfer(address(0xdead), posterBond);
                emit BondBurned(poster, posterBond);
                posterBond = 0;
            }

            // Return escrow to poster
            token.safeTransfer(poster, amount);

            status = Status.Resolved;

            emit BountyRejected(poster, claimer, rejectionCount);
        }
    }

    /// @notice Auto-approve after the review period expires. Anyone can call.
    ///         Protects workers from poster ghosting.
    function autoApprove() external nonReentrant inStatus(Status.Submitted) {
        if (block.timestamp < submittedAt + REVIEW_PERIOD) revert ReviewPeriodNotElapsed();

        status = Status.Approved;

        // Pay the worker
        token.safeTransfer(claimer, amount);

        // Return bonds
        if (workerBond > 0) {
            token.safeTransfer(claimer, workerBond);
            workerBond = 0;
        }
        if (posterBond > 0) {
            token.safeTransfer(poster, posterBond);
            posterBond = 0;
        }

        emit AutoApproved(claimer, amount);
    }

    /// @notice Expire the bounty and refund the poster.
    ///         Anyone can call after the deadline if status is Open or Claimed.
    function expire() external nonReentrant {
        if (block.timestamp < deadline) revert DeadlineNotReached();
        if (status != Status.Open && status != Status.Claimed) {
            revert InvalidStatus(status, Status.Open);
        }

        Status previousStatus = status;
        status = Status.Expired;

        // Return escrow to poster
        token.safeTransfer(poster, amount);

        // Return poster bond
        if (posterBond > 0) {
            token.safeTransfer(poster, posterBond);
            posterBond = 0;
        }

        // Worker bond: 100% to poster if claimed (worker failed to deliver)
        if (previousStatus == Status.Claimed && workerBond > 0) {
            token.safeTransfer(poster, workerBond);
            emit BondSlashed(claimer, workerBond, poster);
            workerBond = 0;
        }

        emit BountyExpired(poster, amount);
    }

    /// @notice Cancel the bounty before anyone claims it. Poster only.
    ///         Returns escrow and poster bond.
    function cancel() external nonReentrant onlyPoster inStatus(Status.Open) {
        status = Status.Cancelled;

        // Return escrow
        token.safeTransfer(poster, amount);

        // Return poster bond
        if (posterBond > 0) {
            token.safeTransfer(poster, posterBond);
            posterBond = 0;
        }

        emit BountyCancelled(poster, amount);
    }

    /// @notice Worker voluntarily releases the bounty within a grace period.
    ///         Grace period = first 20% of time between claim and deadline.
    ///         Worker bond is returned in full.
    function unclaim() external nonReentrant onlyClaimer inStatus(Status.Claimed) {
        uint256 graceEnd = claimedAt + ((deadline - claimedAt) * 20) / 100;
        if (block.timestamp > graceEnd) revert UnclaimWindowClosed();

        // Return worker bond
        if (workerBond > 0) {
            token.safeTransfer(claimer, workerBond);
            workerBond = 0;
        }

        // Reset claim state
        claimer = address(0);
        claimerAgentId = 0;
        claimedAt = 0;
        status = Status.Open;
    }
}
