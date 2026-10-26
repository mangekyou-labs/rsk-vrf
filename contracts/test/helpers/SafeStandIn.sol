// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev Test-only stand-in for the Admin Safe: its signer forwards calls, such as
///      `acceptOwnership`, so the coordinator sees a contract owner as on chain 31.
contract SafeStandIn {
    address public immutable SIGNER;

    constructor(address signer) {
        SIGNER = signer;
    }

    function execute(address target, bytes calldata data) external returns (bytes memory result) {
        require(msg.sender == SIGNER, "not signer");
        bool success;
        (success, result) = target.call(data);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(result, 32), mload(result))
            }
        }
    }
}
