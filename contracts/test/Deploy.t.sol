// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "../src/ClaraToken.sol";
import "../src/ClaraStaking.sol";

/// @title Deployment Tests for ClaraToken and ClaraStaking
/// @notice Covers DS-001 through DS-006: constructor invariants, proxy init,
///         double-init protection, impl lockdown, and ownership transfer.
contract DeployTest is Test {
    ClaraToken public token;
    ClaraStaking public stakingImpl;
    ClaraStaking public staking;
    ERC1967Proxy public stakingProxy;

    // Use a separate mock USDC since we don't import Base.t.sol
    MockUSDC public usdc;

    address public treasury = makeAddr("treasury");
    address public feeSource = makeAddr("feeSource");
    address public guardian = makeAddr("guardian");
    address public deployer;

    function setUp() public {
        deployer = address(this);

        // Deploy ClaraToken
        token = new ClaraToken(treasury);

        // Deploy MockUSDC
        usdc = new MockUSDC();

        // Deploy ClaraStaking via proxy
        stakingImpl = new ClaraStaking();
        stakingProxy = new ERC1967Proxy(
            address(stakingImpl),
            abi.encodeCall(ClaraStaking.initialize, (
                address(token), address(usdc), feeSource, guardian
            ))
        );
        staking = ClaraStaking(address(stakingProxy));
    }

    // ═════════════════════════════════════════════════════
    // DS-001: ClaraToken deployment invariants
    // ═════════════════════════════════════════════════════

    /// @notice DS-001: Verify name, symbol, decimals, totalSupply, balanceOf(treasury)
    function test_DS001_tokenDeploymentInvariants() public view {
        assertEq(token.name(), "Clara", "name");
        assertEq(token.symbol(), "CLARA", "symbol");
        assertEq(token.decimals(), 18, "decimals");
        assertEq(token.totalSupply(), 100_000_000e18, "totalSupply");
        assertEq(token.balanceOf(treasury), 100_000_000e18, "treasury balance");
    }

    // ═════════════════════════════════════════════════════
    // DS-002: ClaraToken immutability
    // ═════════════════════════════════════════════════════

    /// @notice DS-002: ClaraToken is immutable — no initialize, no mint, no burn.
    /// totalSupply is fixed at deployment and cannot change.
    function test_DS002_tokenImmutability() public view {
        // totalSupply is fixed at MAX_SUPPLY
        assertEq(token.totalSupply(), token.MAX_SUPPLY(), "totalSupply == MAX_SUPPLY");

        // There is no public mint() or burn() function — this is verified by
        // the absence of such functions in the ABI. We check that the supply
        // is exactly 100M and the entire supply is in the treasury.
        assertEq(
            token.balanceOf(treasury),
            token.totalSupply(),
            "All supply in treasury"
        );
    }

    // ═════════════════════════════════════════════════════
    // DS-003: ClaraStaking proxy initialization
    // ═════════════════════════════════════════════════════

    /// @notice DS-003: Verify all initialization parameters and default state
    function test_DS003_stakingProxyInit() public view {
        assertEq(address(staking.claraToken()), address(token), "claraToken");
        assertEq(address(staking.usdc()), address(usdc), "usdc");
        assertEq(staking.feeSource(), feeSource, "feeSource");
        assertEq(staking.guardian(), guardian, "guardian");
        assertEq(staking.totalStaked(), 0, "totalStaked starts at 0");
        assertEq(staking.rewardPerTokenStored(), 0, "rPTS starts at 0");
        assertEq(staking.owner(), deployer, "owner is deployer (test contract)");
    }

    // ═════════════════════════════════════════════════════
    // DS-004: Double initialization reverts
    // ═════════════════════════════════════════════════════

    /// @notice DS-004: Proxy already initialized. Calling initialize() again reverts.
    function test_DS004_doubleInitReverts() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        staking.initialize(
            address(token),
            address(usdc),
            feeSource,
            guardian
        );
    }

    // ═════════════════════════════════════════════════════
    // DS-005: Implementation cannot be initialized
    // ═════════════════════════════════════════════════════

    /// @notice DS-005: _disableInitializers() in constructor prevents init on impl
    function test_DS005_implCannotBeInitialized() public {
        ClaraStaking freshImpl = new ClaraStaking();

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        freshImpl.initialize(
            address(token),
            address(usdc),
            feeSource,
            guardian
        );
    }

    // ═════════════════════════════════════════════════════
    // DS-006: Ownership transfer gates admin functions
    // ═════════════════════════════════════════════════════

    /// @notice DS-006: transferOwnership(timelock). Old owner setFeeSource() -> reverts.
    /// Timelock executes setFeeSource() -> succeeds.
    function test_DS006_ownershipTransferGatesAdmin() public {
        address proposer = makeAddr("proposer");
        address executor = makeAddr("executor");
        address newFeeSource = makeAddr("newFeeSource");

        // Deploy TimelockController
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = executor;

        TimelockController timelock = new TimelockController(
            1 days,
            proposers,
            executors,
            address(0)
        );

        // Transfer ownership to timelock
        staking.transferOwnership(address(timelock));
        assertEq(staking.owner(), address(timelock), "Timelock is new owner");

        // Old owner (this test contract) cannot call setFeeSource
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                deployer
            )
        );
        staking.setFeeSource(newFeeSource);

        // Schedule setFeeSource via timelock
        bytes memory setFeeSourceCall = abi.encodeCall(
            staking.setFeeSource,
            (newFeeSource)
        );
        bytes32 predecessor = bytes32(0);
        bytes32 salt = keccak256("set-fee-source");

        vm.prank(proposer);
        timelock.schedule(
            address(staking),
            0,
            setFeeSourceCall,
            predecessor,
            salt,
            1 days
        );

        // Warp past delay
        vm.warp(block.timestamp + 1 days);

        // Execute
        vm.prank(executor);
        timelock.execute(
            address(staking),
            0,
            setFeeSourceCall,
            predecessor,
            salt
        );

        // Verify
        assertEq(staking.feeSource(), newFeeSource, "feeSource updated via timelock");
    }
}

/// @notice Minimal mock USDC for deployment tests (standalone, no Base.t.sol dependency)
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
