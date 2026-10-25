// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title VRFDerivation
/// @notice The only code path that turns a request's Beta into consumer randomness.
///   The coordinator's derive views and consumers both use it.
library VRFDerivation {
    bytes32 internal constant DOMAIN_DERIVE = keccak256("rsk-vrf/v1/derive");
    bytes32 internal constant DOMAIN_RANGE = keccak256("rsk-vrf/v1/range");

    error InvalidRange();

    /// @notice keccak256(abi.encode(DOMAIN_DERIVE, context, beta)).
    function randomBytes(bytes32 beta, bytes32 context) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_DERIVE, context, beta));
    }

    /// @notice randomBytes as a whole uint256 word.
    function random(bytes32 beta, bytes32 context) internal pure returns (uint256) {
        return uint256(randomBytes(beta, context));
    }

    /// @notice Uniform inclusive [min, max] by uncapped counter rejection sampling.
    /// @dev The full uint256 range returns random(beta, context). Other spans draw
    ///   keccak256(abi.encode(DOMAIN_RANGE, context, beta, counter)), starting at 0,
    ///   and discard words below 2**256 % span before reduction. That leaves an
    ///   exact multiple of span possible words, avoiding modulo bias.
    function randomInRange(bytes32 beta, bytes32 context, uint256 min, uint256 max)
        internal
        pure
        returns (uint256 result)
    {
        if (min > max) revert InvalidRange();
        // After the bounds check, span can wrap only for the full uint256 range.
        // The returned min + word % span is always <= max, so it cannot overflow.
        unchecked {
            uint256 span = max - min + 1;
            if (span == 0) return random(beta, context);
            // Wrapped subtraction represents 2**256 - span.
            uint256 threshold = (0 - span) % span;
            for (uint256 counter;; counter++) {
                uint256 word = uint256(keccak256(abi.encode(DOMAIN_RANGE, context, beta, counter)));
                if (word >= threshold) return min + word % span;
            }
        }
    }
}
