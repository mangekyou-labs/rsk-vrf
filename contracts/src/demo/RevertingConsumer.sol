// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VRFConsumer} from "../VRFConsumer.sol";
import {VRFCoordinator} from "../VRFCoordinator.sol";

/// @title RevertingConsumer
/// @notice Demo only; unaudited testnet pilot, do not use for value. Its callback always
///   reverts, to show that the coordinator emits `CallbackFailed` while the request is
///   still Fulfilled and its fee is credited to the Payee.
contract RevertingConsumer is VRFConsumer {
    error RejectedBeta(bytes32 requestId);

    constructor(address coordinator_) VRFConsumer(coordinator_) {}

    /// @notice Requests randomness with a callback; send exactly the coordinator's fee.
    function request(bytes32 tag) external payable returns (bytes32) {
        return VRFCoordinator(coordinator).requestWithCallback{value: msg.value}(tag);
    }

    function fulfillRandomness(bytes32 requestId, bytes32) internal pure override {
        revert RejectedBeta(requestId);
    }

    /// @notice Receives a Refund if the request is never fulfilled.
    receive() external payable {}
}
