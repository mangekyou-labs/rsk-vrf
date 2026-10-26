// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {VRFConsumer} from "../src/VRFConsumer.sol";
import {VRFCoordinator} from "../src/VRFCoordinator.sol";
import {VRFDerivation} from "../src/VRFDerivation.sol";
import {DemoDice} from "../src/demo/DemoDice.sol";
import {RevertingConsumer} from "../src/demo/RevertingConsumer.sol";
import {CoordinatorVectorFixture} from "./VRFCoordinator.t.sol";

contract DemoConsumersTest is CoordinatorVectorFixture {
    VRFCoordinator private coordinator;
    address private admin = makeAddr("Admin");
    address private payee = makeAddr("Payee");
    address private fulfiller = makeAddr("Fulfiller");
    address private player = makeAddr("Player");

    function setUp() public {
        loadVectors();
        RequestVector memory v = vector(0);
        vm.chainId(v.chainId);
        bytes memory init = abi.encodeCall(
            VRFCoordinator.initialize,
            (admin, VRFCoordinator.DrandConfig(drandPublicKey(), drandGenesis(), drandPeriod()))
        );
        deployCodeTo("ERC1967Proxy.sol:ERC1967Proxy", abi.encode(address(new VRFCoordinator()), init), v.coordinator);
        coordinator = VRFCoordinator(v.coordinator);
        vm.startPrank(admin);
        coordinator.registerProvingKey(v.proof.pk, payee);
        coordinator.setFeeConfig(2e13);
        vm.stopPrank();
        vm.warp(v.requestTimestamp);
        vm.deal(player, 1 ether);
    }

    /// @dev The vector binds its requester address, so the consumer's code goes there.
    function placeAt(address consumer, address at) private {
        vm.etch(at, consumer.code);
    }

    function fulfill(RequestVector memory v) private returns (Vm.Log[] memory) {
        vm.roll(block.number + 12);
        vm.recordLogs();
        vm.prank(fulfiller, fulfiller);
        coordinator.fulfill{gas: 4_000_000}(v.requestId, v.proof, v.drandSignature);
        return vm.getRecordedLogs();
    }

    function test_DiceStoresBetaInItsCallbackAndRollsFromTheDeriveView() public {
        RequestVector memory v = vector(0);
        placeAt(address(new DemoDice(address(coordinator))), v.requester);
        DemoDice dice = DemoDice(payable(v.requester));

        vm.prank(player);
        assertEq(dice.roll{value: 2e13}(v.tag), v.requestId);
        assertEq(dice.playerOf(v.requestId), player);
        assertEq(dice.betaOf(v.requestId), bytes32(0));
        vm.expectRevert(DemoDice.NotRolled.selector);
        dice.face(v.requestId);

        Vm.Log[] memory logs = fulfill(v);
        assertEq(dice.betaOf(v.requestId), v.beta, "callback stored the verified Beta");
        uint256 face = dice.face(v.requestId);
        assertGe(face, 1);
        assertLe(face, 6);
        assertEq(face, VRFDerivation.randomInRange(v.beta, dice.ROLL_CONTEXT(), 1, 6));
        assertEq(face, coordinator.deriveRandomInRange(v.requestId, dice.ROLL_CONTEXT(), 1, 6));
        assertEq(logs[logs.length - 1].topics[0], DemoDice.Rolled.selector, "no CallbackFailed");
        assertEq(coordinator.payeeBalance(payee), 2e13);
    }

    function test_DiceAcceptsOnlyItsCoordinator() public {
        DemoDice dice = new DemoDice(address(coordinator));
        vm.expectRevert(VRFConsumer.OnlyCoordinator.selector);
        dice.onRandomness(bytes32("id"), bytes32("beta"));
    }

    function test_RevertingConsumerFailsItsCallbackWhileTheFeeSettles() public {
        RequestVector memory v = vector(0);
        placeAt(address(new RevertingConsumer(address(coordinator))), v.requester);
        RevertingConsumer consumer = RevertingConsumer(payable(v.requester));

        vm.prank(player);
        assertEq(consumer.request{value: 2e13}(v.tag), v.requestId);

        Vm.Log[] memory logs = fulfill(v);
        assertEq(logs.length, 2);
        assertEq(logs[1].topics[0], VRFCoordinator.CallbackFailed.selector);
        assertEq(logs[1].topics[1], v.requestId);
        VRFCoordinator.Request memory r = coordinator.getRequest(v.requestId);
        assertEq(uint8(r.status), uint8(VRFCoordinator.Status.Fulfilled));
        assertEq(r.beta, v.beta);
        assertEq(coordinator.payeeBalance(payee), 2e13, "fee settles despite the failed callback");

        vm.prank(payee);
        coordinator.withdrawFees();
        assertEq(payee.balance, 2e13);
        assertEq(coordinator.payeeBalance(payee), 0);
    }

    function test_ConsumersAcceptTheirRefunds() public {
        DemoDice dice = new DemoDice(address(coordinator));
        RevertingConsumer consumer = new RevertingConsumer(address(coordinator));
        (bool diceRefunded,) = address(dice).call{value: 1}("");
        (bool consumerRefunded,) = address(consumer).call{value: 1}("");
        assertTrue(diceRefunded && consumerRefunded);
    }
}
