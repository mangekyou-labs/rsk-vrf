// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {VRFCoordinator} from "../src/VRFCoordinator.sol";
import {DeploymentCheck} from "./DeploymentCheck.sol";

/// @title CheckDeployment
/// @notice The hand-off check, run after the Safe calls `acceptOwnership`. It reads a
///   deployment record, checks the chain against it, then checks the record against the plan.
/// @dev Read-only. Usage:
///   `forge script script/CheckDeployment.s.sol --rpc-url <rpc> --sig "run(string)" ../deployments/31.json`.
///   Exits non-zero with `Mismatch(field)` on the first value that differs.
contract CheckDeployment is Script {
    function run(string calldata path) external view {
        check(vm.readFile(path));
    }

    function check(string memory json) public view {
        require(vm.parseJsonUint(json, ".chainId") == block.chainid, DeploymentCheck.Mismatch("chainId"));
        DeploymentCheck.Expected memory e = expected(json);
        DeploymentCheck.check(e);
        DeploymentCheck.Expected memory plan =
            DeploymentCheck.planned(e.coordinator, e.implementation, e.safe, e.provingKey);
        require(keccak256(abi.encode(e)) == keccak256(abi.encode(plan)), DeploymentCheck.Mismatch("plan"));
    }

    function expected(string memory json) public pure returns (DeploymentCheck.Expected memory e) {
        e.coordinator = vm.parseJsonAddress(json, ".contracts.proxy.address");
        e.implementation = vm.parseJsonAddress(json, ".contracts.implementation.address");
        e.safe = vm.parseJsonAddress(json, ".safe");
        uint256[] memory point = vm.parseJsonUintArray(json, ".config.provingKey.publicKey");
        e.provingKey = [point[0], point[1]];

        uint256[] memory words = vm.parseJsonUintArray(json, ".config.drand.publicKey");
        e.drand = VRFCoordinator.DrandConfig({
            publicKey: [words[0], words[1], words[2], words[3]],
            genesis: uint64(vm.parseJsonUint(json, ".config.drand.genesis")),
            period: uint64(vm.parseJsonUint(json, ".config.drand.period"))
        });
        e.fee = uint96(vm.parseJsonUint(json, ".config.fee"));
        e.callbackGasCap = uint32(vm.parseJsonUint(json, ".config.callbackGasCap"));
        e.roundOffset = uint64(vm.parseJsonUint(json, ".config.roundOffset"));
        e.timeoutBlocks = uint48(vm.parseJsonUint(json, ".config.timeoutBlocks"));
        e.confirmations = uint16(vm.parseJsonUint(json, ".config.confirmations"));
    }
}
