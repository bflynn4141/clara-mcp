// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ClaraCredits
 * @notice Prepaid credits for Clara MCP signing operations
 * @dev Users deposit USDC, proxy deducts on usage via batch settlement
 *
 * Deposit flow:
 * 1. User approves USDC to this contract
 * 2. User calls deposit(amount) or depositFor(recipient, amount)
 * 3. Credits tracked in mapping
 *
 * Spending flow:
 * 1. Proxy tracks spending off-chain (fast, no gas per operation)
 * 2. Proxy calls batchSpend() periodically to settle on-chain
 *
 * Pricing:
 * - $0.001 per signing operation (1000 units in 6-decimal USDC)
 * - Minimum deposit: $0.10 (100000 units)
 */
contract ClaraCredits is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============================================
    // CONSTANTS
    // ============================================

    /// @notice Minimum deposit amount ($0.10 = 100000 in 6 decimals)
    uint256 public constant MIN_DEPOSIT = 100000;

    /// @notice Cost per signing operation ($0.001 = 1000 in 6 decimals)
    uint256 public constant COST_PER_OPERATION = 1000;

    // ============================================
    // STATE
    // ============================================

    /// @notice USDC token contract
    IERC20 public immutable usdc;

    /// @notice Credit balance per user (in USDC units, 6 decimals)
    mapping(address => uint256) public credits;

    /// @notice Total credits across all users (for accounting)
    uint256 public totalCredits;

    /// @notice Authorized proxy addresses that can spend credits
    mapping(address => bool) public authorizedProxies;

    // ============================================
    // EVENTS
    // ============================================

    event Deposited(
        address indexed user,
        address indexed from,
        uint256 amount,
        uint256 newBalance
    );

    event Spent(
        address indexed user,
        uint256 amount,
        uint256 operations,
        uint256 newBalance
    );

    event Withdrawn(
        address indexed user,
        uint256 amount,
        uint256 newBalance
    );

    event ProxyAuthorized(address indexed proxy, bool authorized);

    event FeesCollected(address indexed to, uint256 amount);

    // ============================================
    // ERRORS
    // ============================================

    error BelowMinimumDeposit(uint256 amount, uint256 minimum);
    error InsufficientCredits(address user, uint256 required, uint256 available);
    error NotAuthorizedProxy(address caller);
    error LengthMismatch(uint256 usersLength, uint256 countsLength);
    error ZeroAddress();
    error ZeroAmount();

    // ============================================
    // CONSTRUCTOR
    // ============================================

    /**
     * @param _usdc USDC token address (Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
     */
    constructor(address _usdc) Ownable(msg.sender) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
    }

    // ============================================
    // USER FUNCTIONS
    // ============================================

    /**
     * @notice Deposit USDC credits for yourself
     * @param amount Amount of USDC (6 decimals) to deposit
     */
    function deposit(uint256 amount) external nonReentrant {
        _deposit(msg.sender, msg.sender, amount);
    }

    /**
     * @notice Deposit USDC credits for another user (e.g., fund a Clara wallet)
     * @dev Useful for funding a Clara wallet from a different wallet (MetaMask, exchange, etc.)
     * @param recipient The Clara wallet address to credit
     * @param amount Amount of USDC (6 decimals) to deposit
     */
    function depositFor(address recipient, uint256 amount) external nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        _deposit(recipient, msg.sender, amount);
    }

    /**
     * @notice Withdraw unused credits back to your wallet
     * @param amount Amount of USDC to withdraw
     */
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (credits[msg.sender] < amount) {
            revert InsufficientCredits(msg.sender, amount, credits[msg.sender]);
        }

        credits[msg.sender] -= amount;
        totalCredits -= amount;

        usdc.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount, credits[msg.sender]);
    }

    /**
     * @notice Withdraw all credits
     */
    function withdrawAll() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert ZeroAmount();

        credits[msg.sender] = 0;
        totalCredits -= amount;

        usdc.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount, 0);
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    /**
     * @notice Check how many signing operations a user can perform
     * @param user The user address to check
     * @return Number of signing operations available
     */
    function availableOperations(address user) external view returns (uint256) {
        return credits[user] / COST_PER_OPERATION;
    }

    /**
     * @notice Check if user has enough credits for N operations
     * @param user The user address
     * @param operations Number of operations to check
     * @return True if user has sufficient credits
     */
    function hasCredits(address user, uint256 operations) external view returns (bool) {
        return credits[user] >= (operations * COST_PER_OPERATION);
    }

    /**
     * @notice Get credit balance in USD (human readable)
     * @param user The user address
     * @return Balance as a string with 6 decimal places
     */
    function balanceUSD(address user) external view returns (uint256) {
        return credits[user];
    }

    // ============================================
    // PROXY FUNCTIONS
    // ============================================

    /**
     * @notice Deduct credits for a single user (called by authorized proxy)
     * @param user The user who performed operations
     * @param operations Number of operations to charge
     */
    function spend(address user, uint256 operations) external onlyProxy {
        uint256 cost = operations * COST_PER_OPERATION;

        if (credits[user] < cost) {
            revert InsufficientCredits(user, cost, credits[user]);
        }

        credits[user] -= cost;
        totalCredits -= cost;

        emit Spent(user, cost, operations, credits[user]);
    }

    /**
     * @notice Batch deduct credits for multiple users (gas efficient settlement)
     * @dev Skips users with insufficient balance instead of reverting
     * @param users Array of user addresses
     * @param operationCounts Array of operation counts per user
     * @return settled Number of users successfully settled
     * @return skipped Number of users skipped due to insufficient balance
     */
    function batchSpend(
        address[] calldata users,
        uint256[] calldata operationCounts
    ) external onlyProxy returns (uint256 settled, uint256 skipped) {
        if (users.length != operationCounts.length) {
            revert LengthMismatch(users.length, operationCounts.length);
        }

        for (uint256 i = 0; i < users.length; i++) {
            uint256 cost = operationCounts[i] * COST_PER_OPERATION;

            if (credits[users[i]] >= cost) {
                credits[users[i]] -= cost;
                totalCredits -= cost;
                settled++;

                emit Spent(users[i], cost, operationCounts[i], credits[users[i]]);
            } else {
                skipped++;
            }
        }
    }

    // ============================================
    // ADMIN FUNCTIONS
    // ============================================

    /**
     * @notice Authorize or revoke a proxy address
     * @param proxy The proxy address
     * @param authorized Whether to authorize (true) or revoke (false)
     */
    function setProxyAuthorization(address proxy, bool authorized) external onlyOwner {
        if (proxy == address(0)) revert ZeroAddress();
        authorizedProxies[proxy] = authorized;
        emit ProxyAuthorized(proxy, authorized);
    }

    /**
     * @notice Collect accumulated fees (contract balance minus user credits)
     * @dev Fees = total USDC in contract - totalCredits
     */
    function collectFees() external onlyOwner {
        uint256 contractBalance = usdc.balanceOf(address(this));
        uint256 fees = contractBalance - totalCredits;

        if (fees > 0) {
            usdc.safeTransfer(owner(), fees);
            emit FeesCollected(owner(), fees);
        }
    }

    /**
     * @notice Emergency withdraw (only if contract is deprecated)
     * @dev Should only be used if migrating to a new contract
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }

    // ============================================
    // INTERNAL FUNCTIONS
    // ============================================

    function _deposit(address recipient, address from, uint256 amount) internal {
        if (amount < MIN_DEPOSIT) {
            revert BelowMinimumDeposit(amount, MIN_DEPOSIT);
        }

        usdc.safeTransferFrom(from, address(this), amount);

        credits[recipient] += amount;
        totalCredits += amount;

        emit Deposited(recipient, from, amount, credits[recipient]);
    }

    // ============================================
    // MODIFIERS
    // ============================================

    modifier onlyProxy() {
        if (!authorizedProxies[msg.sender]) {
            revert NotAuthorizedProxy(msg.sender);
        }
        _;
    }
}
