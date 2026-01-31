// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/ClaraCredits.sol";

/**
 * @title ClaraCredits Deployment Script
 * @notice Deploy ClaraCredits to Base Mainnet or Sepolia
 *
 * Usage:
 *   # Deploy to Base Sepolia (testnet)
 *   forge script script/Deploy.s.sol:DeployClaraCredits \
 *     --rpc-url https://sepolia.base.org \
 *     --broadcast \
 *     --verify
 *
 *   # Deploy to Base Mainnet
 *   forge script script/Deploy.s.sol:DeployClaraCredits \
 *     --rpc-url https://mainnet.base.org \
 *     --broadcast \
 *     --verify
 *
 * Environment variables:
 *   PRIVATE_KEY - Deployer private key
 *   ETHERSCAN_API_KEY - For contract verification on Basescan
 */
contract DeployClaraCredits is Script {
    // USDC addresses
    address constant BASE_MAINNET_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e; // Bridged USDC on Sepolia

    function run() external {
        // Determine USDC address based on chain ID
        uint256 chainId = block.chainid;
        address usdc;

        if (chainId == 8453) {
            // Base Mainnet
            usdc = BASE_MAINNET_USDC;
            console.log("Deploying to Base Mainnet");
        } else if (chainId == 84532) {
            // Base Sepolia
            usdc = BASE_SEPOLIA_USDC;
            console.log("Deploying to Base Sepolia");
        } else {
            revert("Unsupported chain - use Base Mainnet (8453) or Base Sepolia (84532)");
        }

        console.log("USDC address:", usdc);

        // Start broadcast
        vm.startBroadcast();

        // Deploy ClaraCredits
        ClaraCredits credits = new ClaraCredits(usdc);

        console.log("ClaraCredits deployed at:", address(credits));
        console.log("Owner:", credits.owner());

        vm.stopBroadcast();

        // Log next steps
        console.log("\n=== Next Steps ===");
        console.log("1. Update CLARA_CREDITS_ADDRESS in:");
        console.log("   - clara-proxy/src/index.js");
        console.log("   - clara-mcp/src/tools/credits.ts");
        console.log("2. Authorize the proxy as a spender:");
        console.log("   credits.setProxyAuthorization(PROXY_ADDRESS, true)");
        console.log("3. Test deposit and spending flow");
    }
}
