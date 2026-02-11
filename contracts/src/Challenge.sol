// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IIdentityRegistry} from "./Bounty.sol";

/// @title Challenge
/// @notice Implementation template for EIP-1167 minimal proxy challenges.
///         State machine: Open -> Scoring -> Finalized / Expired / Cancelled.
/// @dev Must be initialized via `initialize()` — constructors are not called on clones.
contract Challenge is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────── Types ────────────────────────────

    enum ChallengeStatus { Open, Scoring, Finalized, Cancelled, Expired }

    struct Submission {
        uint256 agentId;
        string  solutionURI;
        bytes32 solutionHash;
        uint256 submittedAt;
        uint256 version;
    }

    struct Winner {
        address account;
        uint256 agentId;
        uint256 score;
        uint256 prizeAmount;
    }

    /// @notice Initialization parameters (struct to avoid stack-too-deep)
    struct InitParams {
        address poster;
        address token;
        uint256 prizePool;
        uint256 deadline;
        uint256 scoringDeadline;
        string  challengeURI;
        bytes32 evalConfigHash;
        bytes32 privateSetHash;
        uint8   winnerCount;
        uint16[] payoutBps;
        address identityRegistry;
        uint256 posterBond;
        uint256 maxParticipants;
    }

    // ──────────────────────────── State ────────────────────────────

    address public poster;
    IERC20  public token;
    uint256 public prizePool;
    uint256 public deadline;
    uint256 public scoringDeadline;
    string  public challengeURI;
    bytes32 public evalConfigHash;
    bytes32 public privateSetHash;
    uint256 public posterBond;
    uint256 public maxParticipants;

    uint8          public winnerCount;
    uint16[] public payoutBps;

    IIdentityRegistry   public identityRegistry;

    ChallengeStatus public status;
    uint256 public submissionCount;
    uint256 public scorePostedAt;
    bool    private _initialized;

    Winner[] public winners;

    mapping(address => Submission) public submissions;
    mapping(address => bool)       public hasClaimed;
    mapping(address => uint256)    public lastSubmissionTime;

    // ──────────────────────────── Constants ────────────────────────

    uint256 public constant MIN_SUBMISSIONS = 2;
    uint256 public constant FINALIZATION_DELAY = 12 hours;
    uint256 public constant SUBMISSION_COOLDOWN = 1 hours;

    // ──────────────────────────── Events ───────────────────────────

    event SubmissionReceived(address indexed submitter, uint256 indexed agentId, uint256 version, bytes32 solutionHash);
    event ScoresPosted(address indexed challenge, uint256 winnerCountPosted);
    event PrizeClaimed(address indexed winner, uint256 rank, uint256 amount);
    event ChallengeFinalized(address indexed challenge);
    event ChallengeExpired(address indexed challenge, uint256 refundPerSubmitter);
    event ChallengeCancelled(address indexed challenge);

    // ──────────────────────────── Errors ───────────────────────────

    error AlreadyInitialized();
    error NotPoster();
    error InvalidStatus(ChallengeStatus current, ChallengeStatus expected);
    error NotRegisteredAgent();
    error DeadlinePassed();
    error DeadlineNotReached();
    error ZeroAddress();
    error ZeroAmount();
    error DeadlineTooSoon();
    error ScoringDeadlineTooSoon();
    error MaxParticipantsReached();
    error SubmissionCooldown();
    error HasSubmissions();
    error ScoresNotPosted();
    error FinalizationDelayNotElapsed();
    error ScoringDeadlineNotReached();
    error NotAWinner();
    error AlreadyClaimed();
    error InvalidWinnerCount();
    error InvalidPrizeSum();
    error WinnerNotSubmitter();
    error ScoresAlreadyPosted();
    error DuplicateWinner();
    error InvalidPrizeAmount();
    error NotASubmitter();

    // ──────────────────────────── Modifiers ────────────────────────

    modifier onlyPoster() {
        if (msg.sender != poster) revert NotPoster();
        _;
    }

    modifier inStatus(ChallengeStatus expected) {
        if (status != expected) revert InvalidStatus(status, expected);
        _;
    }

    // ──────────────────────────── Init ─────────────────────────────

    /// @notice Initialize the challenge proxy. Called once by ChallengeFactory.
    /// @param p InitParams struct containing all initialization parameters
    function initialize(InitParams calldata p) external {
        if (_initialized) revert AlreadyInitialized();
        if (p.poster == address(0)) revert ZeroAddress();
        if (p.token == address(0)) revert ZeroAddress();
        if (p.prizePool == 0) revert ZeroAmount();
        if (p.deadline <= block.timestamp) revert DeadlineTooSoon();
        if (p.scoringDeadline <= p.deadline) revert ScoringDeadlineTooSoon();
        if (p.identityRegistry == address(0)) revert ZeroAddress();

        _initialized      = true;
        poster             = p.poster;
        token              = IERC20(p.token);
        prizePool          = p.prizePool;
        deadline           = p.deadline;
        scoringDeadline    = p.scoringDeadline;
        challengeURI       = p.challengeURI;
        evalConfigHash     = p.evalConfigHash;
        privateSetHash     = p.privateSetHash;
        winnerCount        = p.winnerCount;
        payoutBps          = p.payoutBps;
        identityRegistry   = IIdentityRegistry(p.identityRegistry);
        posterBond         = p.posterBond;
        maxParticipants    = p.maxParticipants;
        status             = ChallengeStatus.Open;
    }

    // ──────────────────────────── Agent Actions ───────────────────

    /// @notice Submit or resubmit a solution. Caller must own the specified ERC-8004 agent token.
    /// @param agentId      The caller's ERC-8004 agent token ID
    /// @param solutionURI  Pointer to solution (URL, data URI, IPFS)
    /// @param solutionHash keccak256 of the solution content
    function submit(
        uint256 agentId,
        string calldata solutionURI,
        bytes32 solutionHash
    ) external nonReentrant inStatus(ChallengeStatus.Open) {
        if (block.timestamp >= deadline) revert DeadlinePassed();

        // Verify caller owns this agent token
        if (identityRegistry.ownerOf(agentId) != msg.sender) revert NotRegisteredAgent();

        // Rate limiting: 1 submission per hour per agent
        if (lastSubmissionTime[msg.sender] != 0 &&
            block.timestamp < lastSubmissionTime[msg.sender] + SUBMISSION_COOLDOWN) {
            revert SubmissionCooldown();
        }

        bool isFirstSubmission = submissions[msg.sender].version == 0;

        // Enforce participant cap on first submission only
        if (isFirstSubmission) {
            if (maxParticipants > 0 && submissionCount >= maxParticipants) {
                revert MaxParticipantsReached();
            }
            submissionCount++;
        }

        submissions[msg.sender] = Submission({
            agentId: agentId,
            solutionURI: solutionURI,
            solutionHash: solutionHash,
            submittedAt: block.timestamp,
            version: submissions[msg.sender].version + 1
        });

        lastSubmissionTime[msg.sender] = block.timestamp;

        emit SubmissionReceived(msg.sender, agentId, submissions[msg.sender].version, solutionHash);
    }

    /// @notice Claim your prize from a finalized challenge. Pull-based payout.
    function claimPrize() external nonReentrant inStatus(ChallengeStatus.Finalized) {
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();

        uint256 prizeAmount = 0;
        uint256 rank = 0;
        for (uint256 i = 0; i < winners.length; i++) {
            if (winners[i].account == msg.sender) {
                prizeAmount = winners[i].prizeAmount;
                rank = i + 1;
                break;
            }
        }
        if (prizeAmount == 0) revert NotAWinner();

        hasClaimed[msg.sender] = true;
        token.safeTransfer(msg.sender, prizeAmount);

        emit PrizeClaimed(msg.sender, rank, prizeAmount);
    }

    /// @notice Claim refund from an expired challenge. Equal share of prizePool + posterBond.
    function claimExpiredRefund() external nonReentrant inStatus(ChallengeStatus.Expired) {
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();
        if (submissions[msg.sender].version == 0) revert NotASubmitter();

        hasClaimed[msg.sender] = true;

        uint256 totalRefundable = prizePool + posterBond;
        uint256 share = totalRefundable / submissionCount;
        token.safeTransfer(msg.sender, share);
    }

    // ──────────────────────────── Poster Actions ──────────────────

    /// @notice Post winners on-chain. Only poster, only during Scoring status.
    /// @dev Requires exactly `winnerCount` winners. Prize amounts are enforced against
    ///      payoutBps — the last winner absorbs integer-division rounding dust.
    /// @param _winners Array of winners with pre-computed prize amounts.
    function postScores(Winner[] calldata _winners) external nonReentrant onlyPoster inStatus(ChallengeStatus.Scoring) {
        if (scorePostedAt != 0) revert ScoresAlreadyPosted();
        if (_winners.length != winnerCount) revert InvalidWinnerCount();

        uint256 totalPrize = 0;
        for (uint256 i = 0; i < _winners.length; i++) {
            // Validate each winner actually submitted
            if (submissions[_winners[i].account].version == 0) revert WinnerNotSubmitter();

            // Check no duplicate winners (O(n²) is fine for n ≤ 25)
            for (uint256 j = 0; j < i; j++) {
                if (_winners[j].account == _winners[i].account) revert DuplicateWinner();
            }

            // Enforce payoutBps: each winner's prize must match their configured BPS share.
            // Last winner absorbs rounding dust (up to winnerCount wei).
            uint256 expectedPrize = (prizePool * payoutBps[i]) / 10000;
            if (i < _winners.length - 1) {
                if (_winners[i].prizeAmount != expectedPrize) revert InvalidPrizeAmount();
            }

            totalPrize += _winners[i].prizeAmount;
        }
        if (totalPrize != prizePool) revert InvalidPrizeSum();

        // Store winners on-chain
        for (uint256 i = 0; i < _winners.length; i++) {
            winners.push(_winners[i]);
        }

        scorePostedAt = block.timestamp;

        emit ScoresPosted(address(this), _winners.length);
    }

    /// @notice Cancel the challenge. Only poster, only if Open with no submissions.
    function cancel() external nonReentrant onlyPoster inStatus(ChallengeStatus.Open) {
        if (submissionCount > 0) revert HasSubmissions();

        status = ChallengeStatus.Cancelled;

        // Refund prize pool + poster bond
        uint256 total = prizePool + posterBond;
        token.safeTransfer(poster, total);

        emit ChallengeCancelled(address(this));
    }

    // ──────────────────────────── Permissionless Transitions ──────

    /// @notice Advance from Open to Scoring after the submission deadline.
    ///         Auto-cancels if fewer than MIN_SUBMISSIONS.
    function advanceToScoring() external nonReentrant inStatus(ChallengeStatus.Open) {
        if (block.timestamp <= deadline) revert DeadlineNotReached();

        if (submissionCount < MIN_SUBMISSIONS) {
            // Auto-cancel: not enough participants
            status = ChallengeStatus.Cancelled;
            uint256 total = prizePool + posterBond;
            token.safeTransfer(poster, total);
            emit ChallengeCancelled(address(this));
        } else {
            status = ChallengeStatus.Scoring;
        }
    }

    /// @notice Finalize after scores are posted and finalization delay has elapsed.
    ///         Returns poster bond to poster.
    function finalize() external nonReentrant inStatus(ChallengeStatus.Scoring) {
        if (winners.length == 0) revert ScoresNotPosted();
        if (block.timestamp < scorePostedAt + FINALIZATION_DELAY) revert FinalizationDelayNotElapsed();

        status = ChallengeStatus.Finalized;

        // Return poster bond
        if (posterBond > 0) {
            token.safeTransfer(poster, posterBond);
            posterBond = 0;
        }

        emit ChallengeFinalized(address(this));
    }

    /// @notice Expire the challenge if the poster failed to post scores by scoringDeadline.
    ///         Prize pool + poster bond become claimable by submitters via claimExpiredRefund().
    function expire() external nonReentrant inStatus(ChallengeStatus.Scoring) {
        if (block.timestamp <= scoringDeadline) revert ScoringDeadlineNotReached();
        if (winners.length > 0) revert ScoresAlreadyPosted();

        status = ChallengeStatus.Expired;

        uint256 refundPerSubmitter = (prizePool + posterBond) / submissionCount;

        emit ChallengeExpired(address(this), refundPerSubmitter);
    }

    // ──────────────────────────── Views ───────────────────────────

    /// @notice Number of winners posted
    function getWinnerCount() external view returns (uint256) {
        return winners.length;
    }

    /// @notice Get payout basis points array
    function getPayoutBps() external view returns (uint16[] memory) {
        return payoutBps;
    }

    /// @notice Get a specific winner by index
    function getWinner(uint256 index) external view returns (Winner memory) {
        return winners[index];
    }

    /// @notice Get submission for a specific address
    function getSubmission(address submitter) external view returns (Submission memory) {
        return submissions[submitter];
    }
}
