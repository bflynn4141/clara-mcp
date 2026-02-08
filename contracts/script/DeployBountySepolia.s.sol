// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/Bounty.sol";
import "../src/BountyFactory.sol";

/// @notice Mock ERC-20 token for testnet bounties
contract MockUSDC {
    string public name = "Mock USDC";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        require(balanceOf[from] >= amount, "insufficient balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @notice Mock IdentityRegistry for testnet (ERC-8004 not on Sepolia).
///         Implements ERC-721 ownerOf/balanceOf for agent ID verification.
contract MockIdentityRegistry {
    uint256 private _nextAgentId = 1;
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(address => uint256) private _agentIds; // convenience reverse lookup

    function register(string calldata) external returns (uint256) {
        if (_agentIds[msg.sender] == 0) {
            uint256 id = _nextAgentId++;
            _owners[id] = msg.sender;
            _balances[msg.sender]++;
            _agentIds[msg.sender] = id;
        }
        return _agentIds[msg.sender];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "ERC721: invalid token ID");
        return owner;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return _balances[owner];
    }

    /// @notice Register an address directly (for testing convenience)
    function registerAddress(address wallet) external returns (uint256) {
        if (_agentIds[wallet] == 0) {
            uint256 id = _nextAgentId++;
            _owners[id] = wallet;
            _balances[wallet]++;
            _agentIds[wallet] = id;
        }
        return _agentIds[wallet];
    }
}

/// @notice Mock ReputationRegistry for testnet
contract MockReputationRegistry {
    event FeedbackGiven(uint256 agentId, int128 value, string tag1, string tag2);

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8,
        string calldata tag1,
        string calldata tag2,
        string calldata,
        string calldata,
        bytes32
    ) external {
        emit FeedbackGiven(agentId, value, tag1, tag2);
    }
}

/// @notice Deploy everything needed for testing on Base Sepolia.
///         Deploys mocks for ERC-8004 contracts that don't exist on testnet,
///         plus a mock USDC for bounty funding.
contract DeployBountySepolia is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        // 1. Deploy mock contracts (not on Sepolia)
        MockIdentityRegistry mockIdentity = new MockIdentityRegistry();
        MockReputationRegistry mockReputation = new MockReputationRegistry();
        MockUSDC mockUsdc = new MockUSDC();

        // 2. Mint test USDC to deployer (10,000 USDC)
        mockUsdc.mint(deployer, 10_000 * 1e6);

        // 3. Register the deployer as an agent
        mockIdentity.registerAddress(deployer);

        // 4. Deploy the Bounty implementation template
        Bounty impl = new Bounty();

        // 5. Deploy the factory with mock registry addresses
        BountyFactory factory = new BountyFactory(
            address(impl),
            address(mockIdentity),
            address(mockReputation)
        );

        vm.stopBroadcast();

        console.log("=== Base Sepolia Deployment ===");
        console.log("");
        console.log("Mock contracts:");
        console.log("  MockIdentityRegistry:", address(mockIdentity));
        console.log("  MockReputationRegistry:", address(mockReputation));
        console.log("  MockUSDC:", address(mockUsdc));
        console.log("");
        console.log("Bounty contracts:");
        console.log("  Bounty implementation:", address(impl));
        console.log("  BountyFactory:", address(factory));
        console.log("");
        console.log("Deployer:", deployer);
        console.log("Deployer USDC balance: 10,000.000000");
    }
}
