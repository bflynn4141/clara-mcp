// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "../src/Bounty.sol";
import "../src/BountyFactory.sol";

// ─────────────────────── Mocks ───────────────────────

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) { return 6; }

    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

contract MockIdentityRegistry {
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;

    function setAgentId(address wallet, uint256 id) external {
        // Clear previous owner if any
        if (_owners[id] != address(0)) {
            _balances[_owners[id]]--;
        }
        _owners[id] = wallet;
        _balances[wallet]++;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "ERC721: invalid token ID");
        return owner;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return _balances[owner];
    }
}

contract MockReputationRegistry {
    // Track calls for assertions
    uint256 public lastAgentId;
    int128  public lastValue;
    uint8   public lastDecimals;
    bool    public wasCalled;

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata,
        string calldata,
        string calldata,
        string calldata,
        bytes32
    ) external {
        lastAgentId  = agentId;
        lastValue    = value;
        lastDecimals = valueDecimals;
        wasCalled    = true;
    }
}

// ─────────────────── Test Base ───────────────────────

abstract contract BountyTestBase is Test {
    Bounty public bountyImpl;
    BountyFactory public factory;
    MockUSDC public usdc;
    MockIdentityRegistry public mockIdRegistry;
    MockReputationRegistry public mockRepRegistry;

    address public poster  = makeAddr("poster");
    address public agent1  = makeAddr("agent1");
    address public agent2  = makeAddr("agent2");
    address public nobody  = makeAddr("nobody");

    uint256 public constant BOUNTY_AMOUNT = 100e6; // 100 USDC
    uint256 public constant ONE_WEEK = 7 days;

    function setUp() public virtual {
        // Deploy mocks
        usdc = new MockUSDC();
        mockIdRegistry  = new MockIdentityRegistry();
        mockRepRegistry = new MockReputationRegistry();

        // Deploy Bounty implementation
        bountyImpl = new Bounty();

        // Deploy factory with registry addresses
        factory = new BountyFactory(
            address(bountyImpl),
            address(mockIdRegistry),
            address(mockRepRegistry)
        );

        // Fund poster
        usdc.mint(poster, 10_000e6);

        // Register agent1 as ERC-8004 agent (id=42)
        mockIdRegistry.setAgentId(agent1, 42);
    }

    /// @dev Helper: create a bounty through the factory, returns the Bounty proxy
    function _createBounty(uint256 amt, uint256 deadlineOffset) internal returns (Bounty) {
        uint256 dl = block.timestamp + deadlineOffset;
        vm.startPrank(poster);
        usdc.approve(address(factory), amt);
        address proxy = factory.createBounty(
            address(usdc), amt, dl, "data:task/test", new string[](0)
        );
        vm.stopPrank();
        return Bounty(proxy);
    }

    function _createDefaultBounty() internal returns (Bounty) {
        return _createBounty(BOUNTY_AMOUNT, ONE_WEEK);
    }
}

// ─────────────────── Factory Tests ──────────────────

contract BountyFactoryTest is BountyTestBase {

    function test_createBounty_deploysProxy() public {
        Bounty b = _createDefaultBounty();

        assertEq(b.poster(), poster);
        assertEq(address(b.token()), address(usdc));
        assertEq(b.amount(), BOUNTY_AMOUNT);
        assertEq(uint256(b.status()), uint256(Bounty.Status.Open));
        assertEq(b.taskURI(), "data:task/test");
    }

    function test_createBounty_setsRegistries() public {
        Bounty b = _createDefaultBounty();

        assertEq(address(b.identityRegistry()), address(mockIdRegistry));
        assertEq(address(b.reputationRegistry()), address(mockRepRegistry));
    }

    function test_createBounty_transfersTokens() public {
        uint256 before_ = usdc.balanceOf(poster);
        Bounty b = _createDefaultBounty();
        uint256 after_ = usdc.balanceOf(poster);

        assertEq(before_ - after_, BOUNTY_AMOUNT);
        assertEq(usdc.balanceOf(address(b)), BOUNTY_AMOUNT);
    }

    function test_createBounty_emitsEvent() public {
        uint256 dl = block.timestamp + ONE_WEEK;
        string[] memory tags = new string[](2);
        tags[0] = "solidity";
        tags[1] = "audit";

        vm.startPrank(poster);
        usdc.approve(address(factory), BOUNTY_AMOUNT);

        vm.expectEmit(false, true, false, false);
        emit BountyFactory.BountyCreated(address(0), poster, address(usdc), BOUNTY_AMOUNT, dl, "data:task/test", tags);

        factory.createBounty(address(usdc), BOUNTY_AMOUNT, dl, "data:task/test", tags);
        vm.stopPrank();
    }

    function test_createBounty_incrementsCount() public {
        assertEq(factory.getBountyCount(), 0);
        _createDefaultBounty();
        assertEq(factory.getBountyCount(), 1);
        _createDefaultBounty();
        assertEq(factory.getBountyCount(), 2);
    }

    function test_createBounty_storesBountyAddress() public {
        Bounty b = _createDefaultBounty();
        assertEq(factory.bounties(0), address(b));
    }

    function test_constructor_rejectsZeroImpl() public {
        vm.expectRevert(BountyFactory.ZeroImplementation.selector);
        new BountyFactory(address(0), address(mockIdRegistry), address(mockRepRegistry));
    }

    function test_constructor_rejectsZeroIdentityRegistry() public {
        vm.expectRevert(BountyFactory.ZeroRegistry.selector);
        new BountyFactory(address(bountyImpl), address(0), address(mockRepRegistry));
    }

    function test_constructor_rejectsZeroReputationRegistry() public {
        vm.expectRevert(BountyFactory.ZeroRegistry.selector);
        new BountyFactory(address(bountyImpl), address(mockIdRegistry), address(0));
    }

    function test_immutableImplementation() public view {
        assertEq(factory.implementation(), address(bountyImpl));
    }

    function test_immutableRegistries() public view {
        assertEq(factory.identityRegistry(), address(mockIdRegistry));
        assertEq(factory.reputationRegistry(), address(mockRepRegistry));
    }
}

// ─────────────────── Initialization Tests ───────────

contract BountyInitTest is BountyTestBase {

    function test_cannotInitializeTwice() public {
        Bounty b = _createDefaultBounty();

        vm.expectRevert(Bounty.AlreadyInitialized.selector);
        b.initialize(poster, address(usdc), 1e6, block.timestamp + 1 days, "x", address(mockIdRegistry), address(mockRepRegistry));
    }

    function test_initialize_rejectsZeroPoster() public {
        address proxy = Clones.clone(address(bountyImpl));
        vm.expectRevert(Bounty.ZeroAddress.selector);
        Bounty(proxy).initialize(address(0), address(usdc), 1e6, block.timestamp + 1 days, "x", address(mockIdRegistry), address(mockRepRegistry));
    }

    function test_initialize_rejectsZeroToken() public {
        address proxy = Clones.clone(address(bountyImpl));
        vm.expectRevert(Bounty.ZeroAddress.selector);
        Bounty(proxy).initialize(poster, address(0), 1e6, block.timestamp + 1 days, "x", address(mockIdRegistry), address(mockRepRegistry));
    }

    function test_initialize_rejectsZeroAmount() public {
        address proxy = Clones.clone(address(bountyImpl));
        vm.expectRevert(Bounty.ZeroAmount.selector);
        Bounty(proxy).initialize(poster, address(usdc), 0, block.timestamp + 1 days, "x", address(mockIdRegistry), address(mockRepRegistry));
    }

    function test_initialize_rejectsPastDeadline() public {
        address proxy = Clones.clone(address(bountyImpl));
        vm.expectRevert(Bounty.DeadlineTooSoon.selector);
        Bounty(proxy).initialize(poster, address(usdc), 1e6, block.timestamp, "x", address(mockIdRegistry), address(mockRepRegistry));
    }

    function test_initialize_rejectsZeroIdentityRegistry() public {
        address proxy = Clones.clone(address(bountyImpl));
        vm.expectRevert(Bounty.ZeroAddress.selector);
        Bounty(proxy).initialize(poster, address(usdc), 1e6, block.timestamp + 1 days, "x", address(0), address(mockRepRegistry));
    }

    function test_initialize_rejectsZeroReputationRegistry() public {
        address proxy = Clones.clone(address(bountyImpl));
        vm.expectRevert(Bounty.ZeroAddress.selector);
        Bounty(proxy).initialize(poster, address(usdc), 1e6, block.timestamp + 1 days, "x", address(mockIdRegistry), address(0));
    }
}

// ─────────────────── Claim Tests ────────────────────

contract BountyClaimTest is BountyTestBase {

    function test_claim_byRegisteredAgent() public {
        Bounty b = _createDefaultBounty();

        vm.prank(agent1);
        b.claim(42);

        assertEq(b.claimer(), agent1);
        assertEq(uint256(b.status()), uint256(Bounty.Status.Claimed));
    }

    function test_claim_emitsEvent() public {
        Bounty b = _createDefaultBounty();

        vm.expectEmit(true, false, false, true);
        emit Bounty.BountyClaimed(agent1, 42);

        vm.prank(agent1);
        b.claim(42);
    }

    function test_claim_revertsIfNotOwner() public {
        Bounty b = _createDefaultBounty();

        // nobody tries to claim with agent1's agentId (42) — they don't own it
        vm.prank(nobody);
        vm.expectRevert(Bounty.NotRegisteredAgent.selector);
        b.claim(42);
    }

    function test_claim_revertsIfTokenDoesNotExist() public {
        Bounty b = _createDefaultBounty();

        // Try to claim with a non-existent agentId
        vm.prank(nobody);
        vm.expectRevert(); // ERC721: invalid token ID
        b.claim(999);
    }

    function test_claim_revertsIfAlreadyClaimed() public {
        Bounty b = _createDefaultBounty();

        vm.prank(agent1);
        b.claim(42);

        // Register agent2 so the agent check passes
        mockIdRegistry.setAgentId(agent2, 99);

        vm.prank(agent2);
        vm.expectRevert(abi.encodeWithSelector(Bounty.InvalidStatus.selector, Bounty.Status.Claimed, Bounty.Status.Open));
        b.claim(99);
    }

    function test_claim_revertsAfterDeadline() public {
        Bounty b = _createDefaultBounty();

        vm.warp(block.timestamp + ONE_WEEK);

        vm.prank(agent1);
        vm.expectRevert(Bounty.DeadlinePassed.selector);
        b.claim(42);
    }
}

// ─────────────────── Submit Tests ───────────────────

contract BountySubmitTest is BountyTestBase {

    function test_submitWork_byClaimer() public {
        Bounty b = _createDefaultBounty();

        vm.prank(agent1);
        b.claim(42);

        vm.prank(agent1);
        b.submitWork("ipfs://proof123");

        assertEq(b.proofURI(), "ipfs://proof123");
        assertEq(uint256(b.status()), uint256(Bounty.Status.Submitted));
    }

    function test_submitWork_emitsEvent() public {
        Bounty b = _createDefaultBounty();

        vm.prank(agent1);
        b.claim(42);

        vm.expectEmit(true, false, false, true);
        emit Bounty.WorkSubmitted(agent1, "ipfs://proof123");

        vm.prank(agent1);
        b.submitWork("ipfs://proof123");
    }

    function test_submitWork_revertsIfNotClaimer() public {
        Bounty b = _createDefaultBounty();

        vm.prank(agent1);
        b.claim(42);

        vm.prank(poster);
        vm.expectRevert(Bounty.NotClaimer.selector);
        b.submitWork("ipfs://proof123");
    }

    function test_submitWork_revertsIfNotClaimed() public {
        Bounty b = _createDefaultBounty();

        vm.prank(agent1);
        vm.expectRevert(); // NotClaimer since claimer is address(0)
        b.submitWork("ipfs://proof123");
    }
}

// ─────────────────── Approve Tests ──────────────────

contract BountyApproveTest is BountyTestBase {

    function test_approve_transfersToClaimer() public {
        Bounty b = _createDefaultBounty();

        vm.prank(agent1);
        b.claim(42);
        vm.prank(agent1);
        b.submitWork("ipfs://proof");

        uint256 before_ = usdc.balanceOf(agent1);

        vm.prank(poster);
        b.approve();

        assertEq(usdc.balanceOf(agent1), before_ + BOUNTY_AMOUNT);
        assertEq(usdc.balanceOf(address(b)), 0);
        assertEq(uint256(b.status()), uint256(Bounty.Status.Approved));
    }

    function test_approve_emitsEvent() public {
        Bounty b = _createDefaultBounty();

        vm.prank(agent1);
        b.claim(42);
        vm.prank(agent1);
        b.submitWork("ipfs://proof");

        vm.expectEmit(true, false, false, true);
        emit Bounty.BountyApproved(agent1, BOUNTY_AMOUNT);

        vm.prank(poster);
        b.approve();
    }

    function test_approve_revertsIfNotPoster() public {
        Bounty b = _createDefaultBounty();

        vm.prank(agent1);
        b.claim(42);
        vm.prank(agent1);
        b.submitWork("ipfs://proof");

        vm.prank(nobody);
        vm.expectRevert(Bounty.NotPoster.selector);
        b.approve();
    }

    function test_approve_revertsIfNotSubmitted() public {
        Bounty b = _createDefaultBounty();

        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(Bounty.InvalidStatus.selector, Bounty.Status.Open, Bounty.Status.Submitted));
        b.approve();
    }

    function test_approveWithFeedback() public {
        Bounty b = _createDefaultBounty();

        vm.prank(agent1);
        b.claim(42);
        vm.prank(agent1);
        b.submitWork("ipfs://proof");

        vm.prank(poster);
        b.approveWithFeedback(
            int128(5), 0,
            "solidity", "audit",
            "https://agent.example.com",
            "ipfs://feedback",
            keccak256("feedback")
        );

        assertEq(uint256(b.status()), uint256(Bounty.Status.Approved));
        assertEq(usdc.balanceOf(agent1), BOUNTY_AMOUNT);

        // Verify reputation registry was called
        assertTrue(mockRepRegistry.wasCalled());
        assertEq(mockRepRegistry.lastAgentId(), 42);
        assertEq(mockRepRegistry.lastValue(), int128(5));
    }
}

// ─────────────────── Expire Tests ───────────────────

contract BountyExpireTest is BountyTestBase {

    function test_expire_whenOpen() public {
        Bounty b = _createDefaultBounty();

        vm.warp(block.timestamp + ONE_WEEK);

        uint256 before_ = usdc.balanceOf(poster);

        vm.prank(nobody); // anyone can call
        b.expire();

        assertEq(usdc.balanceOf(poster), before_ + BOUNTY_AMOUNT);
        assertEq(usdc.balanceOf(address(b)), 0);
        assertEq(uint256(b.status()), uint256(Bounty.Status.Expired));
    }

    function test_expire_whenClaimed() public {
        Bounty b = _createDefaultBounty();

        vm.prank(agent1);
        b.claim(42);

        vm.warp(block.timestamp + ONE_WEEK);

        vm.prank(nobody);
        b.expire();

        assertEq(uint256(b.status()), uint256(Bounty.Status.Expired));
        assertEq(usdc.balanceOf(poster), 10_000e6 - BOUNTY_AMOUNT + BOUNTY_AMOUNT);
    }

    function test_expire_emitsEvent() public {
        Bounty b = _createDefaultBounty();

        vm.warp(block.timestamp + ONE_WEEK);

        vm.expectEmit(true, false, false, true);
        emit Bounty.BountyExpired(poster, BOUNTY_AMOUNT);

        b.expire();
    }

    function test_expire_revertsBeforeDeadline() public {
        Bounty b = _createDefaultBounty();

        vm.expectRevert(Bounty.DeadlineNotReached.selector);
        b.expire();
    }

    function test_expire_revertsIfSubmitted() public {
        Bounty b = _createDefaultBounty();

        vm.prank(agent1);
        b.claim(42);
        vm.prank(agent1);
        b.submitWork("ipfs://proof");

        vm.warp(block.timestamp + ONE_WEEK);

        vm.expectRevert(abi.encodeWithSelector(Bounty.InvalidStatus.selector, Bounty.Status.Submitted, Bounty.Status.Open));
        b.expire();
    }

    function test_expire_revertsIfApproved() public {
        Bounty b = _createDefaultBounty();

        vm.prank(agent1);
        b.claim(42);
        vm.prank(agent1);
        b.submitWork("ipfs://proof");
        vm.prank(poster);
        b.approve();

        vm.warp(block.timestamp + ONE_WEEK);

        vm.expectRevert(abi.encodeWithSelector(Bounty.InvalidStatus.selector, Bounty.Status.Approved, Bounty.Status.Open));
        b.expire();
    }
}

// ─────────────────── Cancel Tests ───────────────────

contract BountyCancelTest is BountyTestBase {

    function test_cancel_refundsPoster() public {
        Bounty b = _createDefaultBounty();

        uint256 before_ = usdc.balanceOf(poster);

        vm.prank(poster);
        b.cancel();

        assertEq(usdc.balanceOf(poster), before_ + BOUNTY_AMOUNT);
        assertEq(usdc.balanceOf(address(b)), 0);
        assertEq(uint256(b.status()), uint256(Bounty.Status.Cancelled));
    }

    function test_cancel_emitsEvent() public {
        Bounty b = _createDefaultBounty();

        vm.expectEmit(true, false, false, true);
        emit Bounty.BountyCancelled(poster, BOUNTY_AMOUNT);

        vm.prank(poster);
        b.cancel();
    }

    function test_cancel_revertsIfNotPoster() public {
        Bounty b = _createDefaultBounty();

        vm.prank(nobody);
        vm.expectRevert(Bounty.NotPoster.selector);
        b.cancel();
    }

    function test_cancel_revertsIfClaimed() public {
        Bounty b = _createDefaultBounty();

        vm.prank(agent1);
        b.claim(42);

        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(Bounty.InvalidStatus.selector, Bounty.Status.Claimed, Bounty.Status.Open));
        b.cancel();
    }
}

// ─────────────────── Full Lifecycle Tests ────────────

contract BountyLifecycleTest is BountyTestBase {

    function test_fullLifecycle_happyPath() public {
        // 1. Poster creates bounty
        Bounty b = _createDefaultBounty();
        assertEq(uint256(b.status()), uint256(Bounty.Status.Open));

        // 2. Agent claims
        vm.prank(agent1);
        b.claim(42);
        assertEq(uint256(b.status()), uint256(Bounty.Status.Claimed));

        // 3. Agent submits work
        vm.prank(agent1);
        b.submitWork("ipfs://QmProof");
        assertEq(uint256(b.status()), uint256(Bounty.Status.Submitted));

        // 4. Poster approves
        vm.prank(poster);
        b.approve();
        assertEq(uint256(b.status()), uint256(Bounty.Status.Approved));

        // Verify final balances
        assertEq(usdc.balanceOf(agent1), BOUNTY_AMOUNT);
        assertEq(usdc.balanceOf(address(b)), 0);
    }

    function test_lifecycle_createAndCancel() public {
        uint256 posterBefore = usdc.balanceOf(poster);
        Bounty b = _createDefaultBounty();

        vm.prank(poster);
        b.cancel();

        assertEq(usdc.balanceOf(poster), posterBefore);
    }

    function test_lifecycle_claimAndExpire() public {
        uint256 posterBefore = usdc.balanceOf(poster);
        Bounty b = _createDefaultBounty();

        vm.prank(agent1);
        b.claim(42);

        vm.warp(block.timestamp + ONE_WEEK);
        b.expire();

        assertEq(usdc.balanceOf(poster), posterBefore);
        assertEq(usdc.balanceOf(agent1), 0);
    }

    function test_lifecycle_multipleBounties() public {
        Bounty b1 = _createBounty(50e6, ONE_WEEK);
        Bounty b2 = _createBounty(75e6, 2 * ONE_WEEK);

        assertEq(factory.getBountyCount(), 2);

        // Claim and complete b1
        vm.prank(agent1);
        b1.claim(42);
        vm.prank(agent1);
        b1.submitWork("ipfs://proof1");
        vm.prank(poster);
        b1.approve();

        // Cancel b2
        vm.prank(poster);
        b2.cancel();

        assertEq(uint256(b1.status()), uint256(Bounty.Status.Approved));
        assertEq(uint256(b2.status()), uint256(Bounty.Status.Cancelled));
        assertEq(usdc.balanceOf(agent1), 50e6);
    }

    /// @dev Ensure no state transition after terminal states
    function test_noTransitionFromApproved() public {
        Bounty b = _createDefaultBounty();
        vm.prank(agent1);
        b.claim(42);
        vm.prank(agent1);
        b.submitWork("proof");
        vm.prank(poster);
        b.approve();

        // Can't claim again
        mockIdRegistry.setAgentId(agent2, 99);
        vm.prank(agent2);
        vm.expectRevert();
        b.claim(99);

        // Can't cancel
        vm.prank(poster);
        vm.expectRevert();
        b.cancel();
    }

    function test_noTransitionFromCancelled() public {
        Bounty b = _createDefaultBounty();
        vm.prank(poster);
        b.cancel();

        vm.prank(agent1);
        vm.expectRevert();
        b.claim(42);
    }

    function test_noTransitionFromExpired() public {
        Bounty b = _createDefaultBounty();
        vm.warp(block.timestamp + ONE_WEEK);
        b.expire();

        vm.prank(poster);
        vm.expectRevert();
        b.cancel();
    }
}
