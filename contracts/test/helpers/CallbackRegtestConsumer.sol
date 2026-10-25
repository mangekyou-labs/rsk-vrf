// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VRFCoordinator} from "../../src/VRFCoordinator.sol";

/// @dev Real-rskj fixtures. Mode 0 reports callback entry gas; mode 1 burns the cap.
contract CallbackRegtestConsumer {
    VRFCoordinator private immutable coordinator;
    uint256 private mode;

    event CallbackEntered(uint256 gasAtEntry, bytes32 requestId, bytes32 beta);

    constructor(VRFCoordinator coordinator_) {
        coordinator = coordinator_;
    }

    function setMode(uint256 value) external {
        mode = value;
    }

    function request(bytes32 tag) external payable returns (bytes32) {
        return coordinator.requestWithCallback{value: msg.value}(tag);
    }

    function onRandomness(bytes32 requestId, bytes32 beta) external {
        uint256 gasAtEntry = gasleft();
        require(msg.sender == address(coordinator), "coordinator only");
        if (mode == 1) {
            assembly ("memory-safe") {
                invalid()
            }
        }
        emit CallbackEntered(gasAtEntry, requestId, beta);
    }

    // Rootstock still deletes accounts on SELFDESTRUCT. This fixture measures the
    // extra CALL cost when a previously valid callback Requester no longer exists.
    function destroy() external {
        selfdestruct(payable(msg.sender));
    }
}
