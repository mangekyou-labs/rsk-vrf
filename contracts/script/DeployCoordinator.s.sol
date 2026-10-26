// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VRFCoordinator} from "../src/VRFCoordinator.sol";
import {DeployPlan} from "./DeployPlan.sol";

/// @title DeployCoordinator
/// @notice A one-off deployer EOA deploys and configures the coordinator, then offers
///   ownership to the Admin Safe. The Safe must still call `acceptOwnership`.
/// @dev Run through `contracts/script/deploy.sh`, which also records and verifies the
///   deployment. Usage: `forge script ... --sig "run(address,uint256[2])" <safe> "[<x>,<y>]"`.
contract DeployCoordinator is Script {
    struct Deployment {
        address implementation;
        address proxy;
    }

    function run(address safe, uint256[2] calldata provingKey) external returns (Deployment memory) {
        // The only `--private-key` wallet is the script's sender.
        (, address deployer,) = vm.readCallers();
        return deploy(deployer, safe, provingKey);
    }

    function deploy(address deployer, address safe, uint256[2] memory provingKey) public returns (Deployment memory d) {
        require(safe.code.length != 0, "Safe has no code");
        vm.startBroadcast(deployer);
        d.implementation = address(new VRFCoordinator());
        // initialize adds the evmnet drand config and sets the default round offset,
        // Deadline and confirmations.
        d.proxy = address(
            new ERC1967Proxy(
                d.implementation, abi.encodeCall(VRFCoordinator.initialize, (deployer, DeployPlan.drand()))
            )
        );
        VRFCoordinator coordinator = VRFCoordinator(d.proxy);
        coordinator.registerProvingKey(provingKey, safe);
        coordinator.setFeeConfig(DeployPlan.FEE);
        coordinator.setCallbackGasCap(DeployPlan.CALLBACK_GAS_CAP);
        coordinator.transferOwnership(safe);
        vm.stopBroadcast();
    }
}
