// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {VRFCoordinator} from "../src/VRFCoordinator.sol";
import {LegacyCoordinator} from "./harness/LegacyCoordinator.sol";
import {CoordinatorVectorFixture} from "./VRFCoordinator.t.sol";

contract VRFUpgradeTest is CoordinatorVectorFixture {
    address internal owner = makeAddr("admin");
    address internal stranger = makeAddr("stranger");
    VRFCoordinator internal coordinator;

    function setUp() public {
        loadVectors();
        vm.chainId(vector(0).chainId);
        vm.warp(vector(0).requestTimestamp);
    }

    function test_LegacyUpgradeInitializesAdminFieldsAndKeepsPendingRequestFulfillable() public {
        RequestVector memory v = vector(0);
        bytes memory init = abi.encodeCall(
            LegacyCoordinator.initialize,
            (owner, LegacyCoordinator.DrandConfig(drandPublicKey(), drandGenesis(), drandPeriod()))
        );
        deployCodeTo("ERC1967Proxy.sol:ERC1967Proxy", abi.encode(address(new LegacyCoordinator()), init), v.coordinator);
        LegacyCoordinator legacy = LegacyCoordinator(v.coordinator);
        coordinator = VRFCoordinator(v.coordinator);
        vm.prank(owner);
        legacy.registerProvingKey(v.proof.pk, owner);
        vm.prank(v.requester);
        legacy.request(v.tag);
        bytes memory frozen = abi.encode(legacy.getRequest(v.requestId));
        vm.prank(owner);
        legacy.transferOwnership(stranger);
        address next = address(new VRFCoordinator());
        vm.prank(owner);
        (bool success,) = address(legacy)
            .call(
                abi.encodeWithSignature(
                    "upgradeToAndCall(address,bytes)", next, abi.encodeWithSignature("initializeAdminParameters()")
                )
            );
        assertTrue(success, "atomic legacy migration");
        assertEq(abi.encode(coordinator.getRequest(v.requestId)), frozen);
        assertEq(coordinator.owner(), owner);
        assertEq(coordinator.pendingOwner(), stranger);
        assertEq(coordinator.activeKeyId(), 1);
        assertEq(coordinator.getProvingKey(1).payee, owner);
        assertEq(coordinator.requesterNonce(v.requester), 1);
        assertEq(coordinator.fee(), 2e13);
        assertEq(coordinator.callbackGasCap(), 200_000);
        assertEq(coordinator.timeoutBlocks(), 1200);
        assertEq(coordinator.confirmations(), 12);
        assertEq(coordinator.roundOffset(), 40);
        assertEq(coordinator.getDrandConfig(0).genesis, drandGenesis());
        vm.roll(block.number + 12);
        vm.prank(stranger, stranger);
        coordinator.fulfill(v.requestId, v.proof, v.drandSignature);
        assertEq(coordinator.getRequest(v.requestId).beta, v.beta);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        coordinator.initializeAdminParameters();
    }
}
