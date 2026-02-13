// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/Challenge.sol";
import "../src/ChallengeFactory.sol";

/// @notice Deploy Challenge contracts on Base mainnet.
///         Uses the real ERC-8004 IdentityRegistry (already deployed).
///
///         IdentityRegistry: 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
///
/// Usage:
///   DEPLOYER_PRIVATE_KEY=0x... \
///   BASE_RPC_URL=https://mainnet.base.org \
///   BASESCAN_API_KEY=... \
///   forge script contracts/script/DeployChallengeMainnet.s.sol:DeployChallengeMainnet \
///     --rpc-url $BASE_RPC_URL --broadcast --verify \
///     --etherscan-api-key $BASESCAN_API_KEY
contract DeployChallengeMainnet is Script {
    // Real ERC-8004 IdentityRegistry on Base mainnet
    address constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("=== Challenge Deploy (Base Mainnet) ===");
        console.log("Deployer:", deployer);
        console.log("IdentityRegistry:", IDENTITY_REGISTRY);

        vm.startBroadcast(deployerKey);

        // 1. Deploy Challenge implementation template
        Challenge impl = new Challenge();
        console.log("Challenge implementation:", address(impl));

        // 2. Deploy ChallengeFactory with real identity registry
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
        console.log("Next steps:");
        console.log("  1. Update clara-contracts.ts challengeFactory address");
        console.log("  2. Set CHALLENGE_FACTORY_DEPLOY_BLOCK to deployment block");
        console.log("  3. Rebuild clara-mcp (npm run build)");
    }
}
