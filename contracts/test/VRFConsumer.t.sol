// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {VRFConsumer} from "../src/VRFConsumer.sol";

contract RecordingConsumer is VRFConsumer {
    bytes32 public requestId;
    bytes32 public beta;

    constructor(address coordinator_) VRFConsumer(coordinator_) {}

    function fulfillRandomness(bytes32 requestId_, bytes32 beta_) internal override {
        requestId = requestId_;
        beta = beta_;
    }
}

contract VRFConsumerTest is Test {
    function test_OnlyCoordinatorCanDeliverBeta() public {
        address coordinator = makeAddr("coordinator");
        RecordingConsumer consumer = new RecordingConsumer(coordinator);
        assertEq(consumer.coordinator(), coordinator);
        bytes32 requestId = bytes32(uint256(17));
        bytes32 beta = bytes32(uint256(42));
        vm.expectRevert(VRFConsumer.OnlyCoordinator.selector);
        consumer.onRandomness(requestId, beta);
        assertEq(consumer.beta(), bytes32(0));
        vm.prank(coordinator);
        consumer.onRandomness(requestId, beta);
        assertEq(consumer.requestId(), requestId);
        assertEq(consumer.beta(), beta);
    }
}
