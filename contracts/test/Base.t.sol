// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/ClaraToken.sol";
import "../src/ClaraStaking.sol";

/// @notice Mock ERC20 with configurable decimals (for USDC = 6)
contract MockERC20 is ERC20 {
    uint8 private _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Shared test base for all CLARA test files
abstract contract ClaraTestBase is Test {
    ClaraToken public token;
    ClaraStaking public stakingImpl;
    ClaraStaking public staking;
    ERC1967Proxy public stakingProxy;
    MockERC20 public usdc;

    address public treasury = makeAddr("treasury");
    address public feeSource = makeAddr("feeSource");
    address public guardian = makeAddr("guardian");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public charlie = makeAddr("charlie");
    address public attacker = makeAddr("attacker");

    uint256 public constant INITIAL_SUPPLY = 100_000_000e18;

    function setUp() public virtual {
        // Deploy ClaraToken (immutable, no proxy)
        token = new ClaraToken(treasury);

        // Deploy MockUSDC (6 decimals)
        usdc = new MockERC20("USD Coin", "USDC", 6);

        // Deploy ClaraStaking impl + proxy
        stakingImpl = new ClaraStaking();
        stakingProxy = new ERC1967Proxy(
            address(stakingImpl),
            abi.encodeCall(ClaraStaking.initialize, (
                address(token), address(usdc), feeSource, guardian
            ))
        );
        staking = ClaraStaking(address(stakingProxy));

        // Distribute CLARA from treasury
        vm.startPrank(treasury);
        token.transfer(alice, 10_000e18);
        token.transfer(bob, 10_000e18);
        token.transfer(charlie, 10_000e18);
        vm.stopPrank();

        // Mint USDC for feeSource
        usdc.mint(feeSource, 1_000_000e6);

        // Pre-approve staking contract
        vm.prank(alice);
        token.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        token.approve(address(staking), type(uint256).max);
        vm.prank(charlie);
        token.approve(address(staking), type(uint256).max);
        vm.prank(feeSource);
        usdc.approve(address(staking), type(uint256).max);
    }
}
