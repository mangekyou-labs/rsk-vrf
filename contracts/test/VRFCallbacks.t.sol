// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {VRF} from "../src/vendor/chainlink/VRF.sol";
import {VRFCoordinator} from "../src/VRFCoordinator.sol";
import {CoordinatorVectorFixture} from "./VRFCoordinator.t.sol";

contract CallbackObserver {
    VRFCoordinator private immutable coordinator;
    address private immutable payee;
    bytes32 public receivedId;
    bytes32 public receivedBeta;
    bytes32 public nextRequest;
    bytes4 public reentryError;

    constructor(VRFCoordinator coordinator_, address payee_) {
        coordinator = coordinator_;
        payee = payee_;
    }

    function onRandomness(bytes32 requestId, bytes32 beta) external {
        require(msg.sender == address(coordinator), "coordinator only");
        VRFCoordinator.Request memory r = coordinator.getRequest(requestId);
        require(r.status == VRFCoordinator.Status.Fulfilled && r.beta == beta, "effects first");
        require(coordinator.payeeBalance(payee) == r.fee, "fee credited first");
        receivedId = requestId;
        receivedBeta = beta;
        VRF.Proof memory proof;
        uint256[2] memory signature;
        (bool success, bytes memory errorData) =
            address(coordinator).call(abi.encodeCall(VRFCoordinator.fulfill, (requestId, proof, signature)));
        require(!success, "reentry rejected");
        reentryError = bytes4(errorData);
        nextRequest = coordinator.request{value: r.fee}(bytes32("next request"));
    }
}

contract CallbackReverter {
    function onRandomness(bytes32, bytes32) external pure {
        revert("consumer rejected Beta");
    }
}

contract CallbackBurner {
    function onRandomness(bytes32, bytes32) external pure {
        assembly ("memory-safe") {
            for {} 1 {} {}
        }
    }
}

contract CallbackReturnBomb {
    bool private immutable reverts;

    constructor(bool reverts_) {
        reverts = reverts_;
    }

    function onRandomness(bytes32, bytes32) external view {
        bool shouldRevert = reverts;
        assembly ("memory-safe") {
            let start := mload(0x40)
            let length := 0x40000
            mstore(0x40, add(start, length))
            switch shouldRevert
            case 0 { return(start, length) }
            default { revert(start, length) }
        }
    }
}

contract VRFCallbacksTest is CoordinatorVectorFixture {
    VRFCoordinator private coordinator;
    address private admin = makeAddr("Admin");
    address private payee = makeAddr("Payee");
    address private fulfiller = makeAddr("Fulfiller");

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
        vm.prank(admin);
        coordinator.registerProvingKey(v.proof.pk, payee);
        vm.warp(v.requestTimestamp);
        vm.deal(v.requester, 1 ether);
    }

    function requestCallback(bytes memory code) private returns (RequestVector memory v) {
        v = vector(0);
        vm.etch(v.requester, code);
        vm.prank(v.requester);
        assertEq(coordinator.requestWithCallback{value: 2e13}(v.tag), v.requestId);
        vm.roll(block.number + 12);
    }

    function fulfill(RequestVector memory v) private {
        // Foundry applies EIP-150. The Rootstock boundary is tested on rskj.
        vm.prank(fulfiller, fulfiller);
        coordinator.fulfill{gas: 4_000_000}(v.requestId, v.proof, v.drandSignature);
    }

    function assertSettled(RequestVector memory v) private view {
        VRFCoordinator.Request memory r = coordinator.getRequest(v.requestId);
        assertEq(uint8(r.status), uint8(VRFCoordinator.Status.Fulfilled));
        assertEq(r.beta, v.beta);
        assertEq(coordinator.payeeBalance(payee), 2e13);
        assertEq(address(coordinator).balance, 2e13);
        assertEq(coordinator.deriveRandomBytes(v.requestId, v.derivations[0].context), v.derivations[0].randomBytes);
    }

    function assertCallbackFailed(Vm.Log[] memory logs, bytes32 requestId) private view {
        assertEq(logs.length, 2, "exactly Fulfilled and CallbackFailed");
        assertEq(logs[0].emitter, address(coordinator));
        assertEq(logs[0].topics[0], keccak256("Fulfilled(bytes32,bytes32,address)"));
        assertEq(logs[1].emitter, address(coordinator));
        assertEq(logs[1].topics[0], keccak256("CallbackFailed(bytes32)"));
        assertEq(logs[1].topics[1], requestId);
    }

    function test_CallbackSeesSettledBetaAndFeeCanRequestAgainButCannotReenterFulfill() public {
        RequestVector memory v = requestCallback(address(new CallbackObserver(coordinator, payee)).code);
        fulfill(v);
        CallbackObserver requester = CallbackObserver(v.requester);
        assertEq(requester.receivedId(), v.requestId);
        assertEq(requester.receivedBeta(), v.beta);
        assertEq(requester.reentryError(), VRFCoordinator.FulfillerNotEOA.selector);
        VRFCoordinator.Request memory next = coordinator.getRequest(requester.nextRequest());
        assertEq(uint8(next.status), uint8(VRFCoordinator.Status.Pending));
        assertEq(next.requester, v.requester);
        assertEq(next.callbackGasCap, 0);
        assertEq(coordinator.payeeBalance(payee), 2e13);
        assertEq(address(coordinator).balance, 4e13, "new request locks separate Escrow");
    }

    function test_RevertingCallbackStillSettlesFeeAndVerifiedBetaAndHasNoRetry() public {
        RequestVector memory v = requestCallback(address(new CallbackReverter()).code);
        vm.recordLogs();
        fulfill(v);
        assertCallbackFailed(vm.getRecordedLogs(), v.requestId);
        assertSettled(v);
        vm.prank(fulfiller, fulfiller);
        vm.expectRevert(
            abi.encodeWithSelector(VRFCoordinator.RequestNotPending.selector, VRFCoordinator.Status.Fulfilled)
        );
        coordinator.fulfill(v.requestId, v.proof, v.drandSignature);
        assertEq(coordinator.payeeBalance(payee), 2e13, "no double credit");
    }

    function test_OutOfGasCallbackStillSettlesFeeAndVerifiedBeta() public {
        RequestVector memory v = requestCallback(address(new CallbackBurner()).code);
        vm.recordLogs();
        fulfill(v);
        assertCallbackFailed(vm.getRecordedLogs(), v.requestId);
        assertSettled(v);
    }

    function test_LargeReturnDataIsIgnored() public {
        RequestVector memory v = requestCallback(address(new CallbackReturnBomb(false)).code);
        vm.recordLogs();
        fulfill(v);
        assertEq(vm.getRecordedLogs().length, 1, "successful callback emits no outcome event");
        assertSettled(v);
    }

    function test_LargeRevertDataDoesNotUndoFulfillment() public {
        RequestVector memory v = requestCallback(address(new CallbackReturnBomb(true)).code);
        vm.recordLogs();
        fulfill(v);
        assertCallbackFailed(vm.getRecordedLogs(), v.requestId);
        assertSettled(v);
    }

    function test_PlainRequestFromContractSkipsCallback() public {
        RequestVector memory v = vector(0);
        vm.etch(v.requester, address(new CallbackBurner()).code);
        vm.prank(v.requester);
        coordinator.request{value: 2e13}(v.tag);
        assertEq(coordinator.getRequest(v.requestId).callbackGasCap, 0);
        vm.roll(block.number + 12);
        vm.recordLogs();
        fulfill(v);
        assertEq(vm.getRecordedLogs().length, 1);
        assertSettled(v);
    }

    function test_InsufficientGasRollsBackFeeBetaAndStatusAndRequestCanBeFulfilledLater() public {
        vm.prank(admin);
        coordinator.setCallbackGasCap(2_500_000);
        RequestVector memory v = requestCallback(address(new CallbackReverter()).code);
        vm.prank(fulfiller, fulfiller);
        vm.expectRevert(VRFCoordinator.InsufficientGasForCallback.selector);
        coordinator.fulfill{gas: 1_000_000}(v.requestId, v.proof, v.drandSignature);
        VRFCoordinator.Request memory r = coordinator.getRequest(v.requestId);
        assertEq(uint8(r.status), uint8(VRFCoordinator.Status.Pending));
        assertEq(r.beta, bytes32(0));
        assertEq(coordinator.payeeBalance(payee), 0);
        assertEq(address(coordinator).balance, 2e13);
        fulfill(v);
        assertSettled(v);
    }
}
