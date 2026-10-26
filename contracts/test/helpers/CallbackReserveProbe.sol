// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev Isolates the reserve needed for CALL, failure event and ABI return on
/// real rskj. It is deliberately unguarded: the test binary-searches the smallest
/// successful transaction and reads the gas just before CALL. The production
/// coordinator's guarded fulfillment is exercised separately through its proxy.
contract CallbackReserveProbe {
    event CallbackFailed(bytes32 indexed requestId);

    // Self-calls with the onRandomness selector enter this unconditional burner.
    // Unlike production consumers, this fixture has no sender check that could
    // reject the probe before it consumes the cap.
    fallback() external {
        assembly ("memory-safe") {
            invalid()
        }
    }

    function probe(address requester, uint32 cap) external returns (uint256 gasBeforeCall, uint256 gasAfterCall) {
        bytes memory data = abi.encodeWithSignature("onRandomness(bytes32,bytes32)", bytes32(0), bytes32(0));
        bool hasCode = requester.code.length != 0;
        bool success;
        assembly ("memory-safe") {
            gasBeforeCall := gas()
            success := call(cap, requester, 0, add(data, 32), mload(data), 0, 0)
        }
        gasAfterCall = gasleft();
        // Without enough gas, rskj can fail CALL before entering the burner.
        // Require cap consumption so that cheap pre-entry failure cannot pass
        // the search as a successful measurement of a worst-case callback.
        require(hasCode ? gasBeforeCall - gasAfterCall >= cap : success, "callback did not run");
        if (!success) emit CallbackFailed(bytes32(0));
    }
}
