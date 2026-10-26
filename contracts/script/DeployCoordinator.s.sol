// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VRFCoordinator} from "../src/VRFCoordinator.sol";
import {DeployPlan} from "./DeployPlan.sol";

/// @title DeployCoordinator
/// @notice A one-off deployer EOA deploys and configures the coordinator, then offers the
///   Admin role to the Admin Safe. The Safe must still call `acceptOwnership`.
/// @dev Run through `contracts/script/deploy.sh`, which merges the receipts into the record
///   and verifies the contracts. `run` writes the record to `DEPLOYMENT_FILE`, by default
///   `../deployments/<chainId>.json`.
contract DeployCoordinator is Script {
    struct Deployment {
        address implementation;
        address proxy;
    }

    /// @param deployer The one-off EOA that deploys and is the Admin until hand-off.
    /// @param safe The Admin Safe, which is also the Proving Key's Payee.
    /// @param provingKey The Proving Key's public point.
    struct Inputs {
        address deployer;
        address safe;
        uint256[2] provingKey;
    }

    function run(address safe, uint256[2] calldata provingKey) external returns (Deployment memory) {
        // The only `--private-key` wallet is the script's sender.
        (, address deployer,) = vm.readCallers();
        Inputs memory inputs = Inputs({deployer: deployer, safe: safe, provingKey: provingKey});
        Deployment memory d = deploy(inputs);
        string memory path =
            vm.envOr("DEPLOYMENT_FILE", string.concat("../deployments/", vm.toString(block.chainid), ".json"));
        vm.writeJson(record(d, inputs), path);
        return d;
    }

    function deploy(Inputs memory inputs) public returns (Deployment memory d) {
        require(inputs.safe.code.length != 0, "Safe has no code");
        vm.startBroadcast(inputs.deployer);
        d.implementation = address(new VRFCoordinator());
        // initialize adds the evmnet drand config and sets the default round offset,
        // Deadline and confirmations.
        d.proxy = address(
            new ERC1967Proxy(
                d.implementation, abi.encodeCall(VRFCoordinator.initialize, (inputs.deployer, DeployPlan.drand()))
            )
        );
        VRFCoordinator coordinator = VRFCoordinator(d.proxy);
        coordinator.registerProvingKey(inputs.provingKey, inputs.safe);
        coordinator.setFeeConfig(DeployPlan.FEE);
        coordinator.setCallbackGasCap(DeployPlan.CALLBACK_GAS_CAP);
        coordinator.transferOwnership(inputs.safe);
        vm.stopBroadcast();
    }

    /// @notice The deployment record. Config values are read back from the coordinator, so
    ///   the record shows what the chain holds rather than what the plan asked for. The
    ///   exceptions are the drand beacon name and chain hash: the coordinator does not store
    ///   them, so they are DeployPlan constants.
    /// @dev Forge's serialize object keys ("deployment", "config", ...) are global to the
    ///   script, so a second call adds to the first call's objects. Every call writes the
    ///   same keys, so the output is unchanged; keep it that way.
    function record(Deployment memory d, Inputs memory inputs) public returns (string memory) {
        string memory configJson = configRecord(VRFCoordinator(d.proxy), inputs.provingKey);
        string memory implementationJson = vm.serializeAddress("implementation", "address", d.implementation);
        string memory proxyJson = vm.serializeAddress("proxy", "address", d.proxy);
        vm.serializeString("contracts", "implementation", implementationJson);
        string memory contractsJson = vm.serializeString("contracts", "proxy", proxyJson);

        vm.serializeUint("deployment", "chainId", block.chainid);
        vm.serializeAddress("deployment", "deployer", inputs.deployer);
        vm.serializeAddress("deployment", "safe", inputs.safe);
        vm.serializeString("deployment", "contracts", contractsJson);
        return vm.serializeString("deployment", "config", configJson);
    }

    function configRecord(VRFCoordinator coordinator, uint256[2] memory provingKey) internal returns (string memory) {
        vm.serializeString("config", "drand", drandRecord(coordinator));
        vm.serializeString("config", "provingKey", keyRecord(coordinator, provingKey));
        vm.serializeUint("config", "fee", coordinator.fee());
        vm.serializeUint("config", "callbackGasCap", coordinator.callbackGasCap());
        vm.serializeUint("config", "roundOffset", coordinator.roundOffset());
        vm.serializeUint("config", "timeoutBlocks", coordinator.timeoutBlocks());
        return vm.serializeUint("config", "confirmations", coordinator.confirmations());
    }

    function drandRecord(VRFCoordinator coordinator) internal returns (string memory) {
        VRFCoordinator.DrandConfig memory drand = coordinator.getDrandConfig(0);
        bytes32[] memory words = new bytes32[](4);
        for (uint256 i; i < 4; i++) {
            words[i] = bytes32(drand.publicKey[i]);
        }
        vm.serializeString("drand", "beacon", DeployPlan.DRAND_BEACON);
        vm.serializeBytes32("drand", "chainHash", DeployPlan.DRAND_CHAIN_HASH);
        vm.serializeBytes32("drand", "publicKey", words);
        vm.serializeUint("drand", "genesis", drand.genesis);
        return vm.serializeUint("drand", "period", drand.period);
    }

    function keyRecord(VRFCoordinator coordinator, uint256[2] memory provingKey) internal returns (string memory) {
        uint32 keyId = coordinator.activeKeyId();
        VRFCoordinator.ProvingKey memory key = coordinator.getProvingKey(keyId);
        bytes32[] memory point = new bytes32[](2);
        point[0] = bytes32(provingKey[0]);
        point[1] = bytes32(provingKey[1]);
        vm.serializeBytes32("provingKey", "publicKey", point);
        vm.serializeBytes32("provingKey", "keyHash", key.keyHash);
        vm.serializeUint("provingKey", "keyId", keyId);
        return vm.serializeAddress("provingKey", "payee", key.payee);
    }
}
