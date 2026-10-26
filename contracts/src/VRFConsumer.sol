// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title VRFConsumer
/// @notice Authenticates delivery of a request's verified Beta by its coordinator.
/// @dev Lock every outcome input before requesting randomness. Never re-request to
///   replace a Refund; use a neutral default that does not favour the operator.
///   Treat a Revocation Refund exactly like a timeout. Callback consumers must be
///   able to receive native rBTC refunds. Reverting here does not reject Beta:
///   fulfillment and fee settlement remain final, with no callback retry. Recover
///   through the coordinator's Fulfilled-only derive views or stored Beta.
abstract contract VRFConsumer {
    address public immutable coordinator;

    error OnlyCoordinator();

    constructor(address coordinator_) {
        coordinator = coordinator_;
    }

    /// @notice Coordinator-only entry point; consumers implement fulfillRandomness.
    function onRandomness(bytes32 requestId, bytes32 beta) external {
        if (msg.sender != coordinator) revert OnlyCoordinator();
        fulfillRandomness(requestId, beta);
    }

    function fulfillRandomness(bytes32 requestId, bytes32 beta) internal virtual;
}
