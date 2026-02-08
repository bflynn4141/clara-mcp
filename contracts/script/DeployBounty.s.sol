// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/Bounty.sol";
import "../src/BountyFactory.sol";

/// @notice Deploy Bounty implementation + BountyFactory to Base mainnet.
contract DeployBounty is Script {
    // ERC-8004 registries on Base mainnet
    address constant IDENTITY_REGISTRY   = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION_REGISTRY = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        // 1. Deploy the Bounty implementation template
        Bounty impl = new Bounty();

        // 2. Deploy the factory pointing to the implementation + registries
        BountyFactory factory = new BountyFactory(
            address(impl),
            IDENTITY_REGISTRY,
            REPUTATION_REGISTRY
        );

        vm.stopBroadcast();

        console.log("Bounty implementation:", address(impl));
        console.log("BountyFactory:", address(factory));
        console.log("IdentityRegistry:", IDENTITY_REGISTRY);
        console.log("ReputationRegistry:", REPUTATION_REGISTRY);
    }
}
