// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/ClaraCredits.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock USDC for testing (6 decimals like real USDC)
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract ClaraCreditsTest is Test {
    ClaraCredits public credits;
    MockUSDC public usdc;

    address public owner = address(this);
    address public user1 = address(0x1);
    address public user2 = address(0x2);
    address public proxy = address(0x3);

    // Constants from contract
    uint256 constant MIN_DEPOSIT = 100000; // $0.10
    uint256 constant COST_PER_OPERATION = 1000; // $0.001

    function setUp() public {
        usdc = new MockUSDC();
        credits = new ClaraCredits(address(usdc));

        // Authorize proxy
        credits.setProxyAuthorization(proxy, true);

        // Give users some USDC
        usdc.mint(user1, 10_000_000); // $10
        usdc.mint(user2, 5_000_000);  // $5
    }

    // ============================================
    // DEPOSIT TESTS
    // ============================================

    function test_Deposit() public {
        vm.startPrank(user1);
        usdc.approve(address(credits), MIN_DEPOSIT);
        credits.deposit(MIN_DEPOSIT);
        vm.stopPrank();

        assertEq(credits.credits(user1), MIN_DEPOSIT);
        assertEq(credits.totalCredits(), MIN_DEPOSIT);
    }

    function test_DepositFor() public {
        vm.startPrank(user1);
        usdc.approve(address(credits), MIN_DEPOSIT);
        credits.depositFor(user2, MIN_DEPOSIT);
        vm.stopPrank();

        // user2 gets the credits, not user1
        assertEq(credits.credits(user1), 0);
        assertEq(credits.credits(user2), MIN_DEPOSIT);
    }

    function test_Deposit_RevertBelowMinimum() public {
        vm.startPrank(user1);
        usdc.approve(address(credits), MIN_DEPOSIT - 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                ClaraCredits.BelowMinimumDeposit.selector,
                MIN_DEPOSIT - 1,
                MIN_DEPOSIT
            )
        );
        credits.deposit(MIN_DEPOSIT - 1);
        vm.stopPrank();
    }

    function test_DepositFor_RevertZeroAddress() public {
        vm.startPrank(user1);
        usdc.approve(address(credits), MIN_DEPOSIT);

        vm.expectRevert(ClaraCredits.ZeroAddress.selector);
        credits.depositFor(address(0), MIN_DEPOSIT);
        vm.stopPrank();
    }

    // ============================================
    // WITHDRAWAL TESTS
    // ============================================

    function test_Withdraw() public {
        // Deposit first
        vm.startPrank(user1);
        usdc.approve(address(credits), 1_000_000); // $1
        credits.deposit(1_000_000);

        // Withdraw half
        credits.withdraw(500_000);
        vm.stopPrank();

        assertEq(credits.credits(user1), 500_000);
        assertEq(usdc.balanceOf(user1), 9_500_000); // Started with $10, deposited $1, withdrew $0.50
    }

    function test_WithdrawAll() public {
        vm.startPrank(user1);
        usdc.approve(address(credits), 1_000_000);
        credits.deposit(1_000_000);

        credits.withdrawAll();
        vm.stopPrank();

        assertEq(credits.credits(user1), 0);
        assertEq(usdc.balanceOf(user1), 10_000_000); // Back to original
    }

    function test_Withdraw_RevertInsufficientCredits() public {
        vm.startPrank(user1);
        usdc.approve(address(credits), MIN_DEPOSIT);
        credits.deposit(MIN_DEPOSIT);

        vm.expectRevert(
            abi.encodeWithSelector(
                ClaraCredits.InsufficientCredits.selector,
                user1,
                MIN_DEPOSIT + 1,
                MIN_DEPOSIT
            )
        );
        credits.withdraw(MIN_DEPOSIT + 1);
        vm.stopPrank();
    }

    function test_Withdraw_RevertZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert(ClaraCredits.ZeroAmount.selector);
        credits.withdraw(0);
    }

    // ============================================
    // VIEW FUNCTION TESTS
    // ============================================

    function test_AvailableOperations() public {
        vm.startPrank(user1);
        usdc.approve(address(credits), 1_000_000); // $1
        credits.deposit(1_000_000);
        vm.stopPrank();

        // $1 / $0.001 = 1000 operations
        assertEq(credits.availableOperations(user1), 1000);
    }

    function test_HasCredits() public {
        vm.startPrank(user1);
        usdc.approve(address(credits), 1_000_000);
        credits.deposit(1_000_000);
        vm.stopPrank();

        assertTrue(credits.hasCredits(user1, 1000));
        assertTrue(credits.hasCredits(user1, 1));
        assertFalse(credits.hasCredits(user1, 1001));
    }

    function test_BalanceUSD() public {
        vm.startPrank(user1);
        usdc.approve(address(credits), 1_000_000);
        credits.deposit(1_000_000);
        vm.stopPrank();

        assertEq(credits.balanceUSD(user1), 1_000_000);
    }

    // ============================================
    // PROXY SPENDING TESTS
    // ============================================

    function test_Spend() public {
        // User deposits
        vm.startPrank(user1);
        usdc.approve(address(credits), 1_000_000);
        credits.deposit(1_000_000);
        vm.stopPrank();

        // Proxy spends 100 operations = $0.10 = 100,000 units
        vm.prank(proxy);
        credits.spend(user1, 100);

        assertEq(credits.credits(user1), 900_000);
        assertEq(credits.totalCredits(), 900_000);
    }

    function test_Spend_RevertNotAuthorizedProxy() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(ClaraCredits.NotAuthorizedProxy.selector, user1)
        );
        credits.spend(user1, 1);
    }

    function test_Spend_RevertInsufficientCredits() public {
        vm.startPrank(user1);
        usdc.approve(address(credits), MIN_DEPOSIT);
        credits.deposit(MIN_DEPOSIT);
        vm.stopPrank();

        // Try to spend more than available
        uint256 availableOps = credits.availableOperations(user1);

        vm.prank(proxy);
        vm.expectRevert(
            abi.encodeWithSelector(
                ClaraCredits.InsufficientCredits.selector,
                user1,
                (availableOps + 1) * COST_PER_OPERATION,
                MIN_DEPOSIT
            )
        );
        credits.spend(user1, availableOps + 1);
    }

    function test_BatchSpend() public {
        // Both users deposit
        vm.startPrank(user1);
        usdc.approve(address(credits), 1_000_000);
        credits.deposit(1_000_000);
        vm.stopPrank();

        vm.startPrank(user2);
        usdc.approve(address(credits), 500_000);
        credits.deposit(500_000);
        vm.stopPrank();

        // Batch spend
        address[] memory users = new address[](2);
        users[0] = user1;
        users[1] = user2;

        uint256[] memory ops = new uint256[](2);
        ops[0] = 100; // $0.10 from user1
        ops[1] = 50;  // $0.05 from user2

        vm.prank(proxy);
        (uint256 settled, uint256 skipped) = credits.batchSpend(users, ops);

        assertEq(settled, 2);
        assertEq(skipped, 0);
        assertEq(credits.credits(user1), 900_000);
        assertEq(credits.credits(user2), 450_000);
    }

    function test_BatchSpend_SkipsInsufficientBalance() public {
        // Only user1 deposits
        vm.startPrank(user1);
        usdc.approve(address(credits), 1_000_000);
        credits.deposit(1_000_000);
        vm.stopPrank();

        // Batch spend for both users (user2 has no credits)
        address[] memory users = new address[](2);
        users[0] = user1;
        users[1] = user2;

        uint256[] memory ops = new uint256[](2);
        ops[0] = 100;
        ops[1] = 50;

        vm.prank(proxy);
        (uint256 settled, uint256 skipped) = credits.batchSpend(users, ops);

        assertEq(settled, 1);
        assertEq(skipped, 1);
        assertEq(credits.credits(user1), 900_000);
        assertEq(credits.credits(user2), 0);
    }

    function test_BatchSpend_RevertLengthMismatch() public {
        address[] memory users = new address[](2);
        uint256[] memory ops = new uint256[](1);

        vm.prank(proxy);
        vm.expectRevert(
            abi.encodeWithSelector(ClaraCredits.LengthMismatch.selector, 2, 1)
        );
        credits.batchSpend(users, ops);
    }

    // ============================================
    // ADMIN TESTS
    // ============================================

    function test_SetProxyAuthorization() public {
        address newProxy = address(0x4);

        assertFalse(credits.authorizedProxies(newProxy));

        credits.setProxyAuthorization(newProxy, true);
        assertTrue(credits.authorizedProxies(newProxy));

        credits.setProxyAuthorization(newProxy, false);
        assertFalse(credits.authorizedProxies(newProxy));
    }

    function test_SetProxyAuthorization_RevertZeroAddress() public {
        vm.expectRevert(ClaraCredits.ZeroAddress.selector);
        credits.setProxyAuthorization(address(0), true);
    }

    function test_SetProxyAuthorization_RevertNotOwner() public {
        vm.prank(user1);
        vm.expectRevert();
        credits.setProxyAuthorization(address(0x4), true);
    }

    function test_CollectFees() public {
        // User deposits
        vm.startPrank(user1);
        usdc.approve(address(credits), 1_000_000);
        credits.deposit(1_000_000);
        vm.stopPrank();

        // Proxy spends (this generates fees)
        vm.prank(proxy);
        credits.spend(user1, 100); // $0.10 fee

        // Now contract has $1 USDC but only $0.90 in credits
        // Difference is fees
        uint256 ownerBalanceBefore = usdc.balanceOf(owner);
        credits.collectFees();

        assertEq(usdc.balanceOf(owner) - ownerBalanceBefore, 100_000); // $0.10 fee
    }

    function test_EmergencyWithdraw() public {
        // User deposits
        vm.startPrank(user1);
        usdc.approve(address(credits), 1_000_000);
        credits.deposit(1_000_000);
        vm.stopPrank();

        uint256 ownerBalanceBefore = usdc.balanceOf(owner);

        // Emergency withdraw everything
        credits.emergencyWithdraw(address(usdc), 1_000_000);

        assertEq(usdc.balanceOf(owner), ownerBalanceBefore + 1_000_000);
    }

    // ============================================
    // INTEGRATION TESTS
    // ============================================

    function test_FullFlow() public {
        // 1. User deposits $1 from external source (e.g., Coinbase)
        vm.startPrank(user1);
        usdc.approve(address(credits), 1_000_000);
        credits.deposit(1_000_000);
        vm.stopPrank();

        // 2. User now has 1000 operations available
        assertEq(credits.availableOperations(user1), 1000);

        // 3. Proxy settles batch of 500 operations
        address[] memory users = new address[](1);
        users[0] = user1;
        uint256[] memory ops = new uint256[](1);
        ops[0] = 500;

        vm.prank(proxy);
        credits.batchSpend(users, ops);

        // 4. User has 500 operations left
        assertEq(credits.availableOperations(user1), 500);
        assertEq(credits.credits(user1), 500_000);

        // 5. User withdraws remaining $0.50
        vm.prank(user1);
        credits.withdrawAll();

        assertEq(credits.credits(user1), 0);
        assertEq(credits.totalCredits(), 0);

        // 6. Owner collects $0.50 in fees
        uint256 contractBalance = usdc.balanceOf(address(credits));
        assertEq(contractBalance, 500_000); // Fees from spending
    }

    function test_DepositFrom_ExternalWallet() public {
        // Simulate user depositing from MetaMask to their Clara wallet
        address metamaskWallet = address(0x5);
        address claraWallet = user1;

        usdc.mint(metamaskWallet, 5_000_000); // $5 in MetaMask

        // MetaMask deposits to Clara wallet
        vm.startPrank(metamaskWallet);
        usdc.approve(address(credits), 5_000_000);
        credits.depositFor(claraWallet, 5_000_000);
        vm.stopPrank();

        // Clara wallet has the credits
        assertEq(credits.credits(claraWallet), 5_000_000);
        assertEq(credits.availableOperations(claraWallet), 5000);

        // MetaMask has no credits (just sent USDC)
        assertEq(credits.credits(metamaskWallet), 0);
    }
}
