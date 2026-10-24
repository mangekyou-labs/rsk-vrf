// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title VRFDerivation
/// @notice The only code path that turns a request's Beta into consumer randomness.
///   The coordinator's derive views and consumers both use it.
library VRFDerivation {
    bytes32 internal constant DOMAIN_DERIVE = keccak256("rsk-vrf/v1/derive");

    /// @notice keccak256(abi.encode(DOMAIN_DERIVE, context, beta)).
    function randomBytes(bytes32 beta, bytes32 context) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_DERIVE, context, beta));
    }

    /// @notice randomBytes as a whole uint256 word.
    function random(bytes32 beta, bytes32 context) internal pure returns (uint256) {
        return uint256(randomBytes(beta, context));
    }
}
