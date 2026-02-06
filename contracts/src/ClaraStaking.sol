// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/// @title ClaraStaking
/// @notice Stake CLARA tokens, earn proportional USDC from x402 fee revenue.
/// @dev Adapted Synthetix RewardPerToken pattern for deposit-triggered distribution.
///      ReentrancyGuard (OZ v5.5) uses namespaced storage and is proxy-safe without
///      an initializer call — the uninitialized slot value (0) is treated as "not entered".
contract ClaraStaking is
    UUPSUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuard,
    PausableUpgradeable
{
    using SafeERC20 for IERC20;

    // ─── Constants ──────────────────────────────────
    uint256 private constant PRECISION = 1e18;

    // ─── Events ─────────────────────────────────────
    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event RewardsClaimed(address indexed user, uint256 amount);
    event FeesDeposited(address indexed depositor, uint256 amount);
    event FeeSourceUpdated(address indexed oldSource, address indexed newSource);
    event GuardianUpdated(address indexed oldGuardian, address indexed newGuardian);

    // ─── State Variables ────────────────────────────
    IERC20 public claraToken;
    IERC20 public usdc;
    address public feeSource;
    address public guardian;

    uint256 public totalStaked;
    uint256 public rewardPerTokenStored;

    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;
    mapping(address => uint256) public stakedBalance;

    // ─── Storage Gap (B3 fix) ───────────────────────
    uint256[50] private __gap;

    // ─── Constructor: Disable Initializers (B2 fix) ─
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ─── Initializer ────────────────────────────────
    function initialize(
        address _claraToken,
        address _usdc,
        address _feeSource,
        address _guardian
    ) external initializer {
        require(_claraToken != address(0), "Zero claraToken");
        require(_usdc != address(0), "Zero usdc");
        require(_feeSource != address(0), "Zero feeSource");
        require(_guardian != address(0), "Zero guardian");

        __Ownable_init(msg.sender);
        __Pausable_init();

        claraToken = IERC20(_claraToken);
        usdc = IERC20(_usdc);
        feeSource = _feeSource;
        guardian = _guardian;
    }

    // ─── Modifiers ──────────────────────────────────
    modifier updateReward(address account) {
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    // ─── View Functions ─────────────────────────────
    function earned(address account) public view returns (uint256) {
        return
            (stakedBalance[account] *
                (rewardPerTokenStored - userRewardPerTokenPaid[account])) /
            PRECISION +
            rewards[account];
    }

    function getClaimable(address account) external view returns (uint256) {
        return earned(account);
    }

    // ─── User Actions ───────────────────────────────
    function stake(uint256 amount) external nonReentrant whenNotPaused updateReward(msg.sender) {
        require(amount > 0, "Cannot stake 0");
        totalStaked += amount;
        stakedBalance[msg.sender] += amount;
        claraToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function stakeWithPermit(
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused updateReward(msg.sender) {
        require(amount > 0, "Cannot stake 0");
        IERC20Permit(address(claraToken)).permit(msg.sender, address(this), amount, deadline, v, r, s);
        totalStaked += amount;
        stakedBalance[msg.sender] += amount;
        claraToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant whenNotPaused updateReward(msg.sender) {
        require(amount > 0, "Cannot unstake 0");
        require(stakedBalance[msg.sender] >= amount, "Insufficient staked balance");
        totalStaked -= amount;
        stakedBalance[msg.sender] -= amount;
        claraToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function claim() external nonReentrant whenNotPaused updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            usdc.safeTransfer(msg.sender, reward);
            emit RewardsClaimed(msg.sender, reward);
        }
    }

    function exit() external nonReentrant whenNotPaused updateReward(msg.sender) {
        uint256 stakedAmt = stakedBalance[msg.sender];
        uint256 reward = rewards[msg.sender];

        if (stakedAmt > 0) {
            totalStaked -= stakedAmt;
            stakedBalance[msg.sender] = 0;
            claraToken.safeTransfer(msg.sender, stakedAmt);
            emit Unstaked(msg.sender, stakedAmt);
        }

        if (reward > 0) {
            rewards[msg.sender] = 0;
            usdc.safeTransfer(msg.sender, reward);
            emit RewardsClaimed(msg.sender, reward);
        }
    }

    // ─── Fee Deposit (B1 fix: revert when totalStaked == 0) ──
    function deposit(uint256 amount) external nonReentrant {
        require(msg.sender == feeSource, "Only fee source");
        require(amount > 0, "Cannot deposit 0");
        require(totalStaked > 0, "No stakers"); // B1 FIX

        rewardPerTokenStored += (amount * PRECISION) / totalStaked;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit FeesDeposited(msg.sender, amount);
    }

    // ─── Admin Functions ────────────────────────────
    function setFeeSource(address newFeeSource) external onlyOwner {
        require(newFeeSource != address(0), "Zero address");
        emit FeeSourceUpdated(feeSource, newFeeSource);
        feeSource = newFeeSource;
    }

    function setGuardian(address newGuardian) external onlyOwner {
        require(newGuardian != address(0), "Zero address");
        emit GuardianUpdated(guardian, newGuardian);
        guardian = newGuardian;
    }

    // B5 FIX: Pausable with guardian
    function pause() external {
        require(msg.sender == guardian || msg.sender == owner(), "Not guardian or owner");
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // B4 FIX: Block both CLARA and USDC recovery
    function recoverERC20(address token, uint256 amount) external onlyOwner {
        require(token != address(claraToken), "Cannot recover staked token");
        require(token != address(usdc), "Cannot recover reward token");
        IERC20(token).safeTransfer(owner(), amount);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
