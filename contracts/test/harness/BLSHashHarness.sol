// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BLS} from "../../src/vendor/bls-bn254/BLS.sol";

/// Exposes the vendored BLS hash-to-G1. Test-only.
contract BLSHashHarness {
    // Keeps the name of the vendored function it exposes.
    // forge-lint: disable-next-line(mixed-case-function)
    function hashToPoint(bytes memory dst, bytes memory message) external view returns (uint256[2] memory) {
        return BLS.hashToPoint(dst, message);
    }
}
