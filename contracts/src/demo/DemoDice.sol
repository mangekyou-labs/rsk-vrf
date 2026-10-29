// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VRFConsumer} from "../VRFConsumer.sol";
import {VRFCoordinator} from "../VRFCoordinator.sol";

/// @title DemoDice
/// @notice Demo only; testnet pilot, not externally audited; do not use for value. A die whose face
///   comes from the coordinator's `deriveRandomInRange(1, 6)` once the callback has
///   stored the request's verified Beta.
contract DemoDice is VRFConsumer {
    /// @notice The derivation context of a roll.
    bytes32 public constant ROLL_CONTEXT = keccak256("rsk-vrf/demo/dice");

    mapping(bytes32 requestId => address) public playerOf;
    mapping(bytes32 requestId => bytes32) public betaOf;

    error NotRolled();

    event Rolled(bytes32 indexed requestId, bytes32 beta);

    constructor(address coordinator_) VRFConsumer(coordinator_) {}

    /// @notice Requests a roll; send exactly the coordinator's fee.
    function roll(bytes32 tag) external payable returns (bytes32 requestId) {
        requestId = VRFCoordinator(coordinator).requestWithCallback{value: msg.value}(tag);
        playerOf[requestId] = msg.sender;
    }

    /// @notice The face, 1 to 6, once the callback has delivered Beta.
    function face(bytes32 requestId) external view returns (uint256) {
        if (betaOf[requestId] == bytes32(0)) revert NotRolled();
        return VRFCoordinator(coordinator).deriveRandomInRange(requestId, ROLL_CONTEXT, 1, 6);
    }

    function fulfillRandomness(bytes32 requestId, bytes32 beta) internal override {
        betaOf[requestId] = beta;
        emit Rolled(requestId, beta);
    }

    /// @notice Receives a Refund if the request is never fulfilled.
    receive() external payable {}
}
