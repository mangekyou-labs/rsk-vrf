// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {VRFCoordinator} from "../src/VRFCoordinator.sol";
import {DeployPlan} from "./DeployPlan.sol";

/// @title DeploymentCheck
/// @notice The post-hand-off check: the Safe owns the coordinator, no transfer is
///   pending, the proxy runs the expected implementation, and every config value matches.
/// @dev Reverts with `Mismatch(field)` on the first value that differs.
library DeploymentCheck {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    // keccak256("eip1967.proxy.implementation") - 1
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    error Mismatch(string field);

    struct Expected {
        address coordinator;
        address implementation;
        address safe;
        uint256[2] provingKey;
        VRFCoordinator.DrandConfig drand;
        uint96 fee;
        uint32 callbackGasCap;
        uint64 roundOffset;
        uint48 timeoutBlocks;
        uint16 confirmations;
    }

    function planned(address coordinator, address implementation, address safe, uint256[2] memory provingKey)
        internal
        pure
        returns (Expected memory)
    {
        return Expected({
            coordinator: coordinator,
            implementation: implementation,
            safe: safe,
            provingKey: provingKey,
            drand: DeployPlan.drand(),
            fee: DeployPlan.FEE,
            callbackGasCap: DeployPlan.CALLBACK_GAS_CAP,
            roundOffset: DeployPlan.ROUND_OFFSET,
            timeoutBlocks: DeployPlan.TIMEOUT_BLOCKS,
            confirmations: DeployPlan.CONFIRMATIONS
        });
    }

    function check(Expected memory e) internal view {
        VRFCoordinator c = VRFCoordinator(e.coordinator);
        require(e.coordinator.code.length != 0, Mismatch("coordinator"));
        require(c.owner() == e.safe, Mismatch("owner"));
        require(c.pendingOwner() == address(0), Mismatch("pendingOwner"));
        address implementation = address(uint160(uint256(VM.load(e.coordinator, IMPLEMENTATION_SLOT))));
        require(implementation == e.implementation, Mismatch("implementation"));

        require(c.drandConfigCount() == 1, Mismatch("drandConfigCount"));
        VRFCoordinator.DrandConfig memory drand = c.getDrandConfig(0);
        require(
            keccak256(abi.encode(drand.publicKey)) == keccak256(abi.encode(e.drand.publicKey)),
            Mismatch("drand.publicKey")
        );
        require(drand.genesis == e.drand.genesis, Mismatch("drand.genesis"));
        require(drand.period == e.drand.period, Mismatch("drand.period"));

        require(c.fee() == e.fee, Mismatch("fee"));
        require(c.callbackGasCap() == e.callbackGasCap, Mismatch("callbackGasCap"));
        require(c.roundOffset() == e.roundOffset, Mismatch("roundOffset"));
        require(c.timeoutBlocks() == e.timeoutBlocks, Mismatch("timeoutBlocks"));
        require(c.confirmations() == e.confirmations, Mismatch("confirmations"));

        // The plan registers exactly one key. Key 1 stays Active only while no other key
        // is registered and it is not revoked.
        require(c.activeKeyId() == 1, Mismatch("activeKeyId"));
        VRFCoordinator.ProvingKey memory key = c.getProvingKey(1);
        require(key.keyHash == keccak256(abi.encode(e.provingKey)), Mismatch("provingKey"));
        require(key.payee == e.safe, Mismatch("payee"));
    }
}
