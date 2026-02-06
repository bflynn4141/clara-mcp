// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/ClaraToken.sol";
import "../src/ClaraStaking.sol";

contract DeployCLARA is Script {
    address constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external {
        address deployer = msg.sender;
        address feeSource = vm.envAddress("FEE_SOURCE");
        address guardian = vm.envAddress("GUARDIAN");

        vm.startBroadcast();

        // 1. Deploy ClaraToken (immutable, no proxy)
        ClaraToken token = new ClaraToken(deployer);
        console.log("ClaraToken deployed at:", address(token));

        // 2. Deploy ClaraStaking implementation
        ClaraStaking stakingImpl = new ClaraStaking();
        console.log("ClaraStaking impl at:", address(stakingImpl));

        // 3. Deploy ClaraStaking proxy
        ERC1967Proxy stakingProxy = new ERC1967Proxy(
            address(stakingImpl),
            abi.encodeCall(ClaraStaking.initialize, (
                address(token),
                USDC_BASE,
                feeSource,
                guardian
            ))
        );
        console.log("ClaraStaking proxy at:", address(stakingProxy));

        vm.stopBroadcast();

        console.log("\n=== Next Steps ===");
        console.log("1. Transfer ClaraToken supply to treasury multisig");
        console.log("2. Deploy TimelockController (7-day delay)");
        console.log("3. Transfer ClaraStaking ownership to timelock");
        console.log("4. Configure x402 facilitator settlement address");
        console.log("5. Verify all contracts on BaseScan");
    }
}
