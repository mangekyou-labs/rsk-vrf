// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title VRFConsumer
/// @notice Authenticates delivery of a request's verified Beta by its coordinator.
/// @dev Binding consumer rules (Selective Abort, docs/consumer-guide.md):
///   1. Lock every input that affects the outcome before you call `request`.
///   2. Never make a new request to replace a request that got a Refund.
///   3. When fulfillment is withheld, use a neutral default that does not favour
///      the operator.
///   4. Treat a Revocation Refund exactly like a timeout Refund.
///   Callback consumers must accept native rBTC Refunds, for example with
///   `receive() external payable {}`. A revert in `fulfillRandomness` does not
///   reject Beta: fulfillment and fee settlement stay final, and there is no
///   callback retry. Recover Beta through the coordinator's Fulfilled-only derive
///   views or `getRequest`. Rootstock has no EIP-150 63/64 rule; the coordinator
///   checks that the full Callback Gas Cap is available before the callback.
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
