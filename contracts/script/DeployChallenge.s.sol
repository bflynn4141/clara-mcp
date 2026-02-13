// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/Challenge.sol";
import "../src/ChallengeFactory.sol";

/// @notice Deploy Challenge contracts on Base mainnet.
///         Uses the same ERC-8004 IdentityRegistry as BountyFactory.
///
///         IdentityRegistry: 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
contract DeployChallenge is Script {
    // ERC-8004 IdentityRegistry on Base mainnet (shared with BountyFactory)
    address constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("=== Challenge Deploy (Base Mainnet) ===");
        console.log("Deployer:", deployer);

        vm.startBroadcast(deployerKey);

        // 1. Deploy Challenge implementation template
        Challenge impl = new Challenge();
        console.log("Challenge implementation:", address(impl));

        // 2. Deploy ChallengeFactory with identity registry
        ChallengeFactory factory = new ChallengeFactory(
            address(impl),
            IDENTITY_REGISTRY
        );
        console.log("ChallengeFactory:", address(factory));

        vm.stopBroadcast();

        console.log("");
        console.log("=== Deployment Summary ===");
        console.log("Challenge implementation:", address(impl));
        console.log("ChallengeFactory:", address(factory));
        console.log("IdentityRegistry:", IDENTITY_REGISTRY);
        console.log("posterBondRate:", factory.posterBondRate(), "bps (5%)");
        console.log("");
        console.log("Next: Update clara-contracts.ts with ChallengeFactory address");
    }
}
