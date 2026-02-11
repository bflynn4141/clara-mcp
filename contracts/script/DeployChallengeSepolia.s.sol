// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/Challenge.sol";
import "../src/ChallengeFactory.sol";

/// @notice Deploy Challenge contracts on Base Sepolia.
///         Reuses existing mocks from Bounty deployment (same identity system).
///
///         MockIdentityRegistry: 0xAee21064f9f7c24fd052CC3598A60Cc50591d1B3
///         MockUSDC:             0xfc4568a4d4cdf01eb929346e215889a5d12d0113
contract DeployChallengeSepolia is Script {
    // Existing mocks from Bounty deployment (already on Base Sepolia)
    address constant MOCK_IDENTITY = 0xAee21064f9f7c24fd052CC3598A60Cc50591d1B3;
    address constant MOCK_USDC = 0xfC4568A4d4cdF01eb929346E215889a5d12d0113;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("=== Challenge Deploy (Base Sepolia) ===");
        console.log("Deployer:", deployer);

        vm.startBroadcast(deployerKey);

        // 1. Deploy Challenge implementation template
        Challenge impl = new Challenge();
        console.log("Challenge implementation:", address(impl));

        // 2. Deploy ChallengeFactory with shared identity registry
        ChallengeFactory factory = new ChallengeFactory(
            address(impl),
            MOCK_IDENTITY
        );
        console.log("ChallengeFactory:", address(factory));

        // 3. Mint 100,000 MockUSDC to deployer for testing challenges
        //    MockUSDC.mint(address, uint256) — public function
        (bool ok,) = MOCK_USDC.call(
            abi.encodeWithSignature("mint(address,uint256)", deployer, 100_000 * 1e6)
        );
        require(ok, "MockUSDC mint failed");
        console.log("Minted 100,000 MockUSDC to deployer");

        vm.stopBroadcast();

        console.log("");
        console.log("=== Deployment Summary ===");
        console.log("Challenge implementation:", address(impl));
        console.log("ChallengeFactory:", address(factory));
        console.log("IdentityRegistry (reused):", MOCK_IDENTITY);
        console.log("MockUSDC (reused):", MOCK_USDC);
        console.log("posterBondRate:", factory.posterBondRate(), "bps (5%)");
        console.log("");
        console.log("Next: Update clara-contracts.ts with ChallengeFactory address");
    }
}
