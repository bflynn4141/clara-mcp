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
    uint256 public constant DEFAULT_BOND_RATE = 1000; // 10%

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

        // Fund poster (extra for bonds)
        usdc.mint(poster, 10_000e6);

        // Fund agent1 for worker bonds
        usdc.mint(agent1, 1_000e6);

        // Register agent1 as ERC-8004 agent (id=42)
        mockIdRegistry.setAgentId(agent1, 42);
    }

    /// @dev Calculate poster bond for a given amount
    function _posterBondFor(uint256 amt) internal view returns (uint256) {
        return (amt * factory.bondRate()) / 10000;
    }

    /// @dev Calculate worker bond for a given amount
    function _workerBondFor(uint256 amt) internal view returns (uint256) {
        return (amt * factory.bondRate()) / 10000;
    }

    /// @dev Helper: create a bounty through the factory, returns the Bounty proxy
    function _createBounty(uint256 amt, uint256 deadlineOffset) internal returns (Bounty) {
        uint256 dl = block.timestamp + deadlineOffset;
        uint256 pBond = _posterBondFor(amt);
        vm.startPrank(poster);
        usdc.approve(address(factory), amt + pBond);
        address proxy = factory.createBounty(
            address(usdc), amt, dl, "data:task/test", new string[](0)
        );
        vm.stopPrank();
        return Bounty(proxy);
    }

    function _createDefaultBounty() internal returns (Bounty) {
        return _createBounty(BOUNTY_AMOUNT, ONE_WEEK);
    }

    /// @dev Helper: claim a bounty as agent1, handling worker bond approval
    function _claimAsAgent1(Bounty b) internal {
        uint256 wBond = _workerBondFor(b.amount());
        vm.startPrank(agent1);
        usdc.approve(address(b), wBond);
        b.claim(42);
        vm.stopPrank();
    }

    /// @dev Helper: submit work as agent1
    function _submitAsAgent1(Bounty b, string memory proof) internal {
        vm.prank(agent1);
        b.submitWork(proof);
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

        uint256 pBond = _posterBondFor(BOUNTY_AMOUNT);
        assertEq(before_ - after_, BOUNTY_AMOUNT + pBond);
        assertEq(usdc.balanceOf(address(b)), BOUNTY_AMOUNT + pBond);
    }

    function test_createBounty_transfersPosterBond() public {
        uint256 before_ = usdc.balanceOf(poster);
        Bounty b = _createDefaultBounty();

        uint256 pBond = _posterBondFor(BOUNTY_AMOUNT);
        // Poster paid amount + posterBond
        assertEq(before_ - usdc.balanceOf(poster), BOUNTY_AMOUNT + pBond);
        // Bounty holds amount + posterBond
        assertEq(usdc.balanceOf(address(b)), BOUNTY_AMOUNT + pBond);
        // Bounty state records the poster bond
        assertEq(b.posterBond(), pBond);
        assertEq(b.bondRate(), DEFAULT_BOND_RATE);
    }

    function test_createBounty_emitsEvent() public {
        uint256 dl = block.timestamp + ONE_WEEK;
        string[] memory tags = new string[](2);
        tags[0] = "solidity";
        tags[1] = "audit";

        uint256 pBond = _posterBondFor(BOUNTY_AMOUNT);

        vm.startPrank(poster);
        usdc.approve(address(factory), BOUNTY_AMOUNT + pBond);

        // Check indexed poster field; skip non-deterministic bountyAddress
        vm.expectEmit(false, true, false, false);
        emit BountyFactory.BountyCreated(address(0), poster, address(usdc), BOUNTY_AMOUNT, pBond, DEFAULT_BOND_RATE, dl, "data:task/test", tags);

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
        b.initialize(poster, address(usdc), 1e6, block.timestamp + 1 days, "x", address(mockIdRegistry), address(mockRepRegistry), 1000, 0);
    }

    function test_initialize_rejectsZeroPoster() public {
        address proxy = Clones.clone(address(bountyImpl));
        vm.expectRevert(Bounty.ZeroAddress.selector);
        Bounty(proxy).initialize(address(0), address(usdc), 1e6, block.timestamp + 1 days, "x", address(mockIdRegistry), address(mockRepRegistry), 1000, 0);
    }

    function test_initialize_rejectsZeroToken() public {
        address proxy = Clones.clone(address(bountyImpl));
        vm.expectRevert(Bounty.ZeroAddress.selector);
        Bounty(proxy).initialize(poster, address(0), 1e6, block.timestamp + 1 days, "x", address(mockIdRegistry), address(mockRepRegistry), 1000, 0);
    }

    function test_initialize_rejectsZeroAmount() public {
        address proxy = Clones.clone(address(bountyImpl));
        vm.expectRevert(Bounty.ZeroAmount.selector);
        Bounty(proxy).initialize(poster, address(usdc), 0, block.timestamp + 1 days, "x", address(mockIdRegistry), address(mockRepRegistry), 1000, 0);
    }

    function test_initialize_rejectsPastDeadline() public {
        address proxy = Clones.clone(address(bountyImpl));
        vm.expectRevert(Bounty.DeadlineTooSoon.selector);
        Bounty(proxy).initialize(poster, address(usdc), 1e6, block.timestamp, "x", address(mockIdRegistry), address(mockRepRegistry), 1000, 0);
    }

    function test_initialize_rejectsZeroIdentityRegistry() public {
        address proxy = Clones.clone(address(bountyImpl));
        vm.expectRevert(Bounty.ZeroAddress.selector);
        Bounty(proxy).initialize(poster, address(usdc), 1e6, block.timestamp + 1 days, "x", address(0), address(mockRepRegistry), 1000, 0);
    }

    function test_initialize_rejectsZeroReputationRegistry() public {
        address proxy = Clones.clone(address(bountyImpl));
        vm.expectRevert(Bounty.ZeroAddress.selector);
        Bounty(proxy).initialize(poster, address(usdc), 1e6, block.timestamp + 1 days, "x", address(mockIdRegistry), address(0), 1000, 0);
    }
}

// ─────────────────── Claim Tests ────────────────────

contract BountyClaimTest is BountyTestBase {

    function test_claim_byRegisteredAgent() public {
        Bounty b = _createDefaultBounty();

        _claimAsAgent1(b);

        assertEq(b.claimer(), agent1);
        assertEq(uint256(b.status()), uint256(Bounty.Status.Claimed));
    }

    function test_claim_transfersWorkerBond() public {
        Bounty b = _createDefaultBounty();

        uint256 agent1Before = usdc.balanceOf(agent1);
        uint256 bountyBefore = usdc.balanceOf(address(b));

        _claimAsAgent1(b);

        uint256 wBond = _workerBondFor(BOUNTY_AMOUNT);
        assertEq(agent1Before - usdc.balanceOf(agent1), wBond);
        assertEq(usdc.balanceOf(address(b)), bountyBefore + wBond);
        assertEq(b.workerBond(), wBond);
    }

    function test_claim_revertsIfInsufficientAllowance() public {
        Bounty b = _createDefaultBounty();

        // Don't approve enough for the worker bond
        vm.prank(agent1);
        vm.expectRevert(); // SafeERC20 will revert
        b.claim(42);
    }

    function test_claim_emitsEvent() public {
        Bounty b = _createDefaultBounty();
        uint256 wBond = _workerBondFor(BOUNTY_AMOUNT);

        // Approve first, then expectEmit right before claim to avoid matching Approval event
        vm.startPrank(agent1);
        usdc.approve(address(b), wBond);

        vm.expectEmit(true, false, false, true);
        emit Bounty.BountyClaimed(agent1, 42);

        b.claim(42);
        vm.stopPrank();
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

        _claimAsAgent1(b);

        // Register agent2 so the agent check passes
        mockIdRegistry.setAgentId(agent2, 99);
        usdc.mint(agent2, 100e6);

        vm.startPrank(agent2);
        usdc.approve(address(b), _workerBondFor(BOUNTY_AMOUNT));
        vm.expectRevert(abi.encodeWithSelector(Bounty.InvalidStatus.selector, Bounty.Status.Claimed, Bounty.Status.Open));
        b.claim(99);
        vm.stopPrank();
    }

    function test_claim_revertsAfterDeadline() public {
        Bounty b = _createDefaultBounty();

        vm.warp(block.timestamp + ONE_WEEK);

        vm.startPrank(agent1);
        usdc.approve(address(b), _workerBondFor(BOUNTY_AMOUNT));
        vm.expectRevert(Bounty.DeadlinePassed.selector);
        b.claim(42);
        vm.stopPrank();
    }
}

// ─────────────────── Submit Tests ───────────────────

contract BountySubmitTest is BountyTestBase {

    function test_submitWork_byClaimer() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);

        _submitAsAgent1(b, "ipfs://proof123");

        assertEq(b.proofURI(), "ipfs://proof123");
        assertEq(uint256(b.status()), uint256(Bounty.Status.Submitted));
    }

    function test_submitWork_emitsEvent() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);

        vm.expectEmit(true, false, false, true);
        emit Bounty.WorkSubmitted(agent1, "ipfs://proof123");

        _submitAsAgent1(b, "ipfs://proof123");
    }

    function test_submitWork_revertsIfNotClaimer() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);

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
        _claimAsAgent1(b);
        _submitAsAgent1(b, "ipfs://proof");

        uint256 before_ = usdc.balanceOf(agent1);
        uint256 wBond = b.workerBond();

        vm.prank(poster);
        b.approve();

        // Agent gets bounty amount + worker bond returned
        assertEq(usdc.balanceOf(agent1), before_ + BOUNTY_AMOUNT + wBond);
        assertEq(usdc.balanceOf(address(b)), 0);
        assertEq(uint256(b.status()), uint256(Bounty.Status.Approved));
    }

    function test_approve_returnsBothBonds() public {
        Bounty b = _createDefaultBounty();
        uint256 pBond = b.posterBond();

        _claimAsAgent1(b);
        uint256 wBond = b.workerBond();
        _submitAsAgent1(b, "ipfs://proof");

        uint256 posterBefore = usdc.balanceOf(poster);
        uint256 agentBefore  = usdc.balanceOf(agent1);

        vm.prank(poster);
        b.approve();

        // Poster gets poster bond back
        assertEq(usdc.balanceOf(poster), posterBefore + pBond);
        // Agent gets bounty amount + worker bond back
        assertEq(usdc.balanceOf(agent1), agentBefore + BOUNTY_AMOUNT + wBond);
        // Bounty contract is empty
        assertEq(usdc.balanceOf(address(b)), 0);
    }

    function test_approveWithFeedback_returnsBothBonds() public {
        Bounty b = _createDefaultBounty();
        uint256 pBond = b.posterBond();

        _claimAsAgent1(b);
        uint256 wBond = b.workerBond();
        _submitAsAgent1(b, "ipfs://proof");

        uint256 posterBefore = usdc.balanceOf(poster);
        uint256 agentBefore  = usdc.balanceOf(agent1);

        vm.prank(poster);
        b.approveWithFeedback(
            int128(5), 0,
            "solidity", "audit",
            "https://agent.example.com",
            "ipfs://feedback",
            keccak256("feedback")
        );

        // Poster gets poster bond back
        assertEq(usdc.balanceOf(poster), posterBefore + pBond);
        // Agent gets bounty amount + worker bond back
        assertEq(usdc.balanceOf(agent1), agentBefore + BOUNTY_AMOUNT + wBond);
        assertEq(usdc.balanceOf(address(b)), 0);
    }

    function test_approve_emitsEvent() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);
        _submitAsAgent1(b, "ipfs://proof");

        vm.expectEmit(true, false, false, true);
        emit Bounty.BountyApproved(agent1, BOUNTY_AMOUNT);

        vm.prank(poster);
        b.approve();
    }

    function test_approve_revertsIfNotPoster() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);
        _submitAsAgent1(b, "ipfs://proof");

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
        _claimAsAgent1(b);
        _submitAsAgent1(b, "ipfs://proof");

        uint256 wBond = b.workerBond();

        vm.prank(poster);
        b.approveWithFeedback(
            int128(5), 0,
            "solidity", "audit",
            "https://agent.example.com",
            "ipfs://feedback",
            keccak256("feedback")
        );

        assertEq(uint256(b.status()), uint256(Bounty.Status.Approved));
        // Agent started with 1_000e6, paid wBond, then got BOUNTY_AMOUNT + wBond back
        assertEq(usdc.balanceOf(agent1), 1_000e6 - wBond + BOUNTY_AMOUNT + wBond);

        // Verify reputation registry was called
        assertTrue(mockRepRegistry.wasCalled());
        assertEq(mockRepRegistry.lastAgentId(), 42);
        assertEq(mockRepRegistry.lastValue(), int128(5));
    }
}

// ─────────────────── Rejection Tests ─────────────────

contract BountyRejectTest is BountyTestBase {

    function test_reject_firstRejection_slashesWorkerBond() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);
        uint256 wBond = b.workerBond();
        _submitAsAgent1(b, "ipfs://proof");

        uint256 posterBefore = usdc.balanceOf(poster);
        uint256 deadBefore   = usdc.balanceOf(address(0xdead));

        vm.prank(poster);
        b.reject();

        // 50% of worker bond to poster
        uint256 halfBond = wBond / 2;
        assertEq(usdc.balanceOf(poster), posterBefore + halfBond);
        // 50% of worker bond burned
        assertEq(usdc.balanceOf(address(0xdead)), deadBefore + (wBond - halfBond));
        // Worker bond zeroed
        assertEq(b.workerBond(), 0);
    }

    function test_reject_setsStatusToRejected() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);
        _submitAsAgent1(b, "ipfs://proof");

        vm.prank(poster);
        b.reject();

        assertEq(uint256(b.status()), uint256(Bounty.Status.Rejected));
        assertEq(b.rejectionCount(), 1);
    }

    function test_reject_onlyPoster() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);
        _submitAsAgent1(b, "ipfs://proof");

        vm.prank(nobody);
        vm.expectRevert(Bounty.NotPoster.selector);
        b.reject();
    }

    function test_reject_onlyFromSubmitted() public {
        Bounty b = _createDefaultBounty();

        // Try from Open status
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(Bounty.InvalidStatus.selector, Bounty.Status.Open, Bounty.Status.Submitted));
        b.reject();
    }

    function test_resubmit_afterRejection() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);
        _submitAsAgent1(b, "ipfs://proof-v1");

        // First rejection
        vm.prank(poster);
        b.reject();
        assertEq(uint256(b.status()), uint256(Bounty.Status.Rejected));

        // Resubmit from Rejected status
        _submitAsAgent1(b, "ipfs://proof-v2");
        assertEq(uint256(b.status()), uint256(Bounty.Status.Submitted));
        assertEq(b.proofURI(), "ipfs://proof-v2");
    }

    function test_resubmit_afterRejection_revertsIfMaxRejections() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);
        _submitAsAgent1(b, "ipfs://proof-v1");

        // First rejection
        vm.prank(poster);
        b.reject();

        // Resubmit
        _submitAsAgent1(b, "ipfs://proof-v2");

        // Second rejection — terminal
        vm.prank(poster);
        b.reject();
        assertEq(uint256(b.status()), uint256(Bounty.Status.Resolved));

        // Can't resubmit after Resolved
        vm.prank(agent1);
        vm.expectRevert();
        b.submitWork("ipfs://proof-v3");
    }

    function test_doubleReject_burnsBothBonds() public {
        Bounty b = _createDefaultBounty();
        uint256 pBond = b.posterBond();

        _claimAsAgent1(b);
        _submitAsAgent1(b, "ipfs://proof-v1");

        // First rejection (slashes first worker bond)
        vm.prank(poster);
        b.reject();

        // Resubmit (no new worker bond — already slashed)
        _submitAsAgent1(b, "ipfs://proof-v2");

        uint256 deadBefore = usdc.balanceOf(address(0xdead));

        // Second rejection — burns poster bond, returns escrow
        vm.prank(poster);
        b.reject();

        // posterBond burned
        assertEq(usdc.balanceOf(address(0xdead)), deadBefore + pBond);
        assertEq(b.posterBond(), 0);
        assertEq(b.workerBond(), 0);
    }

    function test_doubleReject_returnsEscrow() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);
        _submitAsAgent1(b, "ipfs://proof-v1");

        vm.prank(poster);
        b.reject();

        _submitAsAgent1(b, "ipfs://proof-v2");

        uint256 posterBefore = usdc.balanceOf(poster);

        vm.prank(poster);
        b.reject();

        // Poster gets escrow back
        assertEq(usdc.balanceOf(poster), posterBefore + BOUNTY_AMOUNT);
    }

    function test_doubleReject_isTerminal() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);
        _submitAsAgent1(b, "ipfs://proof-v1");

        vm.prank(poster);
        b.reject();

        _submitAsAgent1(b, "ipfs://proof-v2");

        vm.prank(poster);
        b.reject();

        // Status is Resolved (7)
        assertEq(uint256(b.status()), uint256(Bounty.Status.Resolved));
        assertEq(uint256(b.status()), 7);
        assertEq(b.rejectionCount(), 2);
    }
}

// ─────────────────── Auto-Approve Tests ──────────────

contract BountyAutoApproveTest is BountyTestBase {

    function test_autoApprove_afterReviewPeriod() public {
        Bounty b = _createDefaultBounty();
        uint256 pBond = b.posterBond();

        _claimAsAgent1(b);
        uint256 wBond = b.workerBond();
        _submitAsAgent1(b, "ipfs://proof");

        uint256 agentBefore  = usdc.balanceOf(agent1);
        uint256 posterBefore = usdc.balanceOf(poster);

        // Warp past 72h review period
        vm.warp(block.timestamp + 72 hours);

        vm.prank(nobody);
        b.autoApprove();

        assertEq(uint256(b.status()), uint256(Bounty.Status.Approved));
        // Agent gets bounty + worker bond
        assertEq(usdc.balanceOf(agent1), agentBefore + BOUNTY_AMOUNT + wBond);
        // Poster gets poster bond back
        assertEq(usdc.balanceOf(poster), posterBefore + pBond);
        assertEq(usdc.balanceOf(address(b)), 0);
    }

    function test_autoApprove_revertsBeforeReviewPeriod() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);
        _submitAsAgent1(b, "ipfs://proof");

        // Only 71 hours
        vm.warp(block.timestamp + 71 hours);

        vm.expectRevert(Bounty.ReviewPeriodNotElapsed.selector);
        b.autoApprove();
    }

    function test_autoApprove_onlyFromSubmitted() public {
        Bounty b = _createDefaultBounty();

        vm.warp(block.timestamp + 72 hours);

        vm.expectRevert(abi.encodeWithSelector(Bounty.InvalidStatus.selector, Bounty.Status.Open, Bounty.Status.Submitted));
        b.autoApprove();
    }

    function test_autoApprove_anyoneCanCall() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);
        _submitAsAgent1(b, "ipfs://proof");

        vm.warp(block.timestamp + 72 hours);

        // A random address can trigger auto-approve
        vm.prank(nobody);
        b.autoApprove();

        assertEq(uint256(b.status()), uint256(Bounty.Status.Approved));
    }
}

// ─────────────────── Expire Tests ───────────────────

contract BountyExpireTest is BountyTestBase {

    function test_expire_whenOpen() public {
        Bounty b = _createDefaultBounty();
        uint256 pBond = b.posterBond();

        vm.warp(block.timestamp + ONE_WEEK);

        uint256 before_ = usdc.balanceOf(poster);

        vm.prank(nobody); // anyone can call
        b.expire();

        // Poster gets escrow + poster bond
        assertEq(usdc.balanceOf(poster), before_ + BOUNTY_AMOUNT + pBond);
        assertEq(usdc.balanceOf(address(b)), 0);
        assertEq(uint256(b.status()), uint256(Bounty.Status.Expired));
    }

    function test_expire_whenClaimed() public {
        Bounty b = _createDefaultBounty();

        _claimAsAgent1(b);

        vm.warp(block.timestamp + ONE_WEEK);

        vm.prank(nobody);
        b.expire();

        assertEq(uint256(b.status()), uint256(Bounty.Status.Expired));
    }

    function test_expire_claimed_slashesWorkerBond() public {
        Bounty b = _createDefaultBounty();

        _claimAsAgent1(b);
        uint256 wBond = b.workerBond();

        vm.warp(block.timestamp + ONE_WEEK);

        uint256 posterBefore = usdc.balanceOf(poster);

        b.expire();

        // Worker bond goes 100% to poster
        // Poster also gets escrow + poster bond
        uint256 pBond = _posterBondFor(BOUNTY_AMOUNT);
        assertEq(usdc.balanceOf(poster), posterBefore + BOUNTY_AMOUNT + pBond + wBond);
    }

    function test_expire_claimed_returnsPosterBond() public {
        Bounty b = _createDefaultBounty();
        uint256 pBond = b.posterBond();

        _claimAsAgent1(b);

        vm.warp(block.timestamp + ONE_WEEK);

        uint256 posterBefore = usdc.balanceOf(poster);

        b.expire();

        // Poster gets at least escrow + poster bond back (plus worker bond slash)
        assertTrue(usdc.balanceOf(poster) >= posterBefore + BOUNTY_AMOUNT + pBond);
    }

    function test_expire_open_returnsPosterBond() public {
        Bounty b = _createDefaultBounty();
        uint256 pBond = b.posterBond();

        vm.warp(block.timestamp + ONE_WEEK);

        uint256 posterBefore = usdc.balanceOf(poster);

        b.expire();

        // Poster gets escrow + poster bond
        assertEq(usdc.balanceOf(poster), posterBefore + BOUNTY_AMOUNT + pBond);
        assertEq(b.posterBond(), 0);
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
        _claimAsAgent1(b);
        _submitAsAgent1(b, "ipfs://proof");

        vm.warp(block.timestamp + ONE_WEEK);

        vm.expectRevert(abi.encodeWithSelector(Bounty.InvalidStatus.selector, Bounty.Status.Submitted, Bounty.Status.Open));
        b.expire();
    }

    function test_expire_revertsIfApproved() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);
        _submitAsAgent1(b, "ipfs://proof");
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
        uint256 pBond = b.posterBond();

        vm.prank(poster);
        b.cancel();

        // Poster gets back escrow + poster bond
        assertEq(usdc.balanceOf(poster), before_ + BOUNTY_AMOUNT + pBond);
        assertEq(usdc.balanceOf(address(b)), 0);
        assertEq(uint256(b.status()), uint256(Bounty.Status.Cancelled));
    }

    function test_cancel_returnsPosterBondAndEscrow() public {
        Bounty b = _createDefaultBounty();

        uint256 posterBefore = usdc.balanceOf(poster);
        uint256 pBond = b.posterBond();

        vm.prank(poster);
        b.cancel();

        assertEq(usdc.balanceOf(poster), posterBefore + BOUNTY_AMOUNT + pBond);
        assertEq(b.posterBond(), 0);
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
        _claimAsAgent1(b);

        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(Bounty.InvalidStatus.selector, Bounty.Status.Claimed, Bounty.Status.Open));
        b.cancel();
    }
}

// ─────────────────── Unclaim Tests ──────────────────

contract BountyUnclaimTest is BountyTestBase {

    function test_unclaim_withinGrace_returnsBond() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);
        uint256 wBond = b.workerBond();

        uint256 agentBefore = usdc.balanceOf(agent1);

        // Within 20% of (deadline - claimedAt) grace window
        // 20% of 7 days = 1.4 days ~= 120960 seconds
        vm.warp(block.timestamp + 1 days);

        vm.prank(agent1);
        b.unclaim();

        // Worker bond returned
        assertEq(usdc.balanceOf(agent1), agentBefore + wBond);
        assertEq(b.workerBond(), 0);
    }

    function test_unclaim_resetsToOpen() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);

        vm.prank(agent1);
        b.unclaim();

        assertEq(uint256(b.status()), uint256(Bounty.Status.Open));
        assertEq(b.claimer(), address(0));
        assertEq(b.claimerAgentId(), 0);
        assertEq(b.claimedAt(), 0);
    }

    function test_unclaim_afterGrace_reverts() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);

        // Warp past 20% of 7 days (~1.4 days)
        vm.warp(block.timestamp + 2 days);

        vm.prank(agent1);
        vm.expectRevert(Bounty.UnclaimWindowClosed.selector);
        b.unclaim();
    }

    function test_unclaim_onlyClaimer() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);

        vm.prank(nobody);
        vm.expectRevert(Bounty.NotClaimer.selector);
        b.unclaim();
    }
}

// ─────────────────── Factory Bond Rate Tests ─────────

contract BountyFactoryBondRateTest is BountyTestBase {

    function test_setBondRate_ownerOnly() public {
        vm.prank(nobody);
        vm.expectRevert(BountyFactory.NotOwner.selector);
        factory.setBondRate(2000);
    }

    function test_setBondRate_maxCap() public {
        // Owner is address(this) since setUp deploys factory
        vm.expectRevert(BountyFactory.BondRateTooHigh.selector);
        factory.setBondRate(5001);
    }

    function test_setBondRate_works() public {
        factory.setBondRate(2000);
        assertEq(factory.bondRate(), 2000);
    }

    function test_zeroBondRate_works() public {
        // Set bond rate to 0
        factory.setBondRate(0);
        assertEq(factory.bondRate(), 0);

        // Create bounty — no poster bond
        Bounty b = _createDefaultBounty();
        assertEq(b.posterBond(), 0);
        assertEq(b.bondRate(), 0);

        // Claim — no worker bond
        _claimAsAgent1(b);
        assertEq(b.workerBond(), 0);

        // Full lifecycle still works
        _submitAsAgent1(b, "ipfs://proof");

        vm.prank(poster);
        b.approve();

        assertEq(uint256(b.status()), uint256(Bounty.Status.Approved));
        assertEq(usdc.balanceOf(agent1), 1_000e6 + BOUNTY_AMOUNT); // initial mint + bounty
    }
}

// ─────────────────── Full Lifecycle Tests ────────────

contract BountyLifecycleTest is BountyTestBase {

    function test_fullLifecycle_happyPath() public {
        // 1. Poster creates bounty
        Bounty b = _createDefaultBounty();
        assertEq(uint256(b.status()), uint256(Bounty.Status.Open));

        // 2. Agent claims
        _claimAsAgent1(b);
        assertEq(uint256(b.status()), uint256(Bounty.Status.Claimed));

        // 3. Agent submits work
        _submitAsAgent1(b, "ipfs://QmProof");
        assertEq(uint256(b.status()), uint256(Bounty.Status.Submitted));

        // 4. Poster approves
        vm.prank(poster);
        b.approve();
        assertEq(uint256(b.status()), uint256(Bounty.Status.Approved));

        // Verify final balances — agent gets bounty + worker bond
        uint256 wBond = _workerBondFor(BOUNTY_AMOUNT);
        assertEq(usdc.balanceOf(agent1), 1_000e6 - wBond + BOUNTY_AMOUNT + wBond);
        assertEq(usdc.balanceOf(address(b)), 0);
    }

    function test_lifecycle_createAndCancel() public {
        uint256 posterBefore = usdc.balanceOf(poster);
        Bounty b = _createDefaultBounty();

        vm.prank(poster);
        b.cancel();

        // Poster gets everything back (escrow + poster bond)
        assertEq(usdc.balanceOf(poster), posterBefore);
    }

    function test_lifecycle_claimAndExpire() public {
        uint256 posterBefore = usdc.balanceOf(poster);
        Bounty b = _createDefaultBounty();

        _claimAsAgent1(b);
        uint256 wBond = b.workerBond();

        vm.warp(block.timestamp + ONE_WEEK);
        b.expire();

        // Poster gets escrow + poster bond + slashed worker bond
        assertEq(usdc.balanceOf(poster), posterBefore + wBond);
        // Agent loses worker bond
        assertEq(usdc.balanceOf(agent1), 1_000e6 - wBond);
    }

    function test_lifecycle_multipleBounties() public {
        Bounty b1 = _createBounty(50e6, ONE_WEEK);
        Bounty b2 = _createBounty(75e6, 2 * ONE_WEEK);

        assertEq(factory.getBountyCount(), 2);

        // Claim and complete b1
        uint256 wBond1 = _workerBondFor(50e6);
        vm.startPrank(agent1);
        usdc.approve(address(b1), wBond1);
        b1.claim(42);
        b1.submitWork("ipfs://proof1");
        vm.stopPrank();
        vm.prank(poster);
        b1.approve();

        // Cancel b2
        vm.prank(poster);
        b2.cancel();

        assertEq(uint256(b1.status()), uint256(Bounty.Status.Approved));
        assertEq(uint256(b2.status()), uint256(Bounty.Status.Cancelled));
        // Agent gets initial 1000 - workerBond + bountyAmount + workerBond = 1000 + 50
        assertEq(usdc.balanceOf(agent1), 1_000e6 + 50e6);
    }

    /// @dev Ensure no state transition after terminal states
    function test_noTransitionFromApproved() public {
        Bounty b = _createDefaultBounty();
        _claimAsAgent1(b);
        _submitAsAgent1(b, "proof");
        vm.prank(poster);
        b.approve();

        // Can't claim again
        mockIdRegistry.setAgentId(agent2, 99);
        usdc.mint(agent2, 100e6);
        vm.startPrank(agent2);
        usdc.approve(address(b), _workerBondFor(BOUNTY_AMOUNT));
        vm.expectRevert();
        b.claim(99);
        vm.stopPrank();

        // Can't cancel
        vm.prank(poster);
        vm.expectRevert();
        b.cancel();
    }

    function test_noTransitionFromCancelled() public {
        Bounty b = _createDefaultBounty();
        vm.prank(poster);
        b.cancel();

        vm.startPrank(agent1);
        usdc.approve(address(b), _workerBondFor(BOUNTY_AMOUNT));
        vm.expectRevert();
        b.claim(42);
        vm.stopPrank();
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
