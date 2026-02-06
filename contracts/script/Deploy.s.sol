// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "../src/ClaraToken.sol";
import "../src/ClaraStaking.sol";
import "../src/MerkleDrop.sol";

contract DeployCLARA is Script {
    address constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 constant MERKLE_DROP_ALLOCATION = 10_000_000e18; // 10M CLARA for airdrop
    uint256 constant TIMELOCK_DELAY = 7 days; // 604800 seconds

    function run() external {
        address deployer = msg.sender;
        address feeSource = vm.envAddress("FEE_SOURCE");
        address guardian = vm.envAddress("GUARDIAN");
        bytes32 merkleRoot = vm.envBytes32("MERKLE_ROOT");
        uint256 claimDuration = vm.envUint("CLAIM_DURATION");
        address treasury = vm.envAddress("TREASURY");

        vm.startBroadcast();

        // ── 1. ClaraToken (immutable, no proxy) ─────────
        ClaraToken token = new ClaraToken(deployer);
        console.log("ClaraToken:", address(token));

        // ── 2. ClaraStaking (UUPS proxy) ────────────────
        ClaraStaking stakingImpl = new ClaraStaking();
        console.log("ClaraStaking impl:", address(stakingImpl));

        ERC1967Proxy stakingProxy = new ERC1967Proxy(
            address(stakingImpl),
            abi.encodeCall(ClaraStaking.initialize, (
                address(token),
                USDC_BASE,
                feeSource,
                guardian
            ))
        );
        console.log("ClaraStaking proxy:", address(stakingProxy));

        // ── 3. MerkleDrop (immutable) ───────────────────
        MerkleDrop merkleDrop = new MerkleDrop(
            address(token),
            merkleRoot,
            claimDuration,
            treasury
        );
        console.log("MerkleDrop:", address(merkleDrop));

        // ── 4. TimelockController (7-day delay) ─────────
        address[] memory proposers = new address[](1);
        proposers[0] = deployer;
        address[] memory executors = new address[](1);
        executors[0] = deployer;

        TimelockController timelock = new TimelockController(
            TIMELOCK_DELAY,
            proposers,
            executors,
            deployer // admin (renounce after mainnet setup)
        );
        console.log("TimelockController:", address(timelock));

        // ── 5. Transfer staking ownership to timelock ───
        ClaraStaking(address(stakingProxy)).transferOwnership(address(timelock));
        console.log("Staking ownership -> timelock");

        // ── 6. Fund MerkleDrop with 10M CLARA ──────────
        token.transfer(address(merkleDrop), MERKLE_DROP_ALLOCATION);
        console.log("MerkleDrop funded:", MERKLE_DROP_ALLOCATION / 1e18, "CLARA");

        vm.stopBroadcast();

        // ── Summary ─────────────────────────────────────
        console.log("\n=== Deployment Summary ===");
        console.log("ClaraToken:          ", address(token));
        console.log("ClaraStaking proxy:  ", address(stakingProxy));
        console.log("ClaraStaking impl:   ", address(stakingImpl));
        console.log("MerkleDrop:          ", address(merkleDrop));
        console.log("TimelockController:  ", address(timelock));
        console.log("Deployer:            ", deployer);
        console.log("Merkle root:         ");
        console.logBytes32(merkleRoot);
    }
}
