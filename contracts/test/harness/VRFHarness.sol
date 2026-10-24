// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VRF} from "../../src/vendor/chainlink/VRF.sol";

/// Exposes the vendored VRF verifier's internal functions to tests. Test-only.
contract VRFHarness is VRF {
    // Keeps the name of the vendored function it exposes.
    // forge-lint: disable-next-line(mixed-case-function)
    function randomValueFromVRFProof(Proof calldata proof, uint256 seed) external view returns (uint256) {
        return _randomValueFromVRFProof(proof, seed);
    }

    function hashToCurve(uint256[2] memory pk, uint256 seed) external view returns (uint256[2] memory) {
        return _hashToCurve(pk, seed);
    }

    /// The zInv a prover must supply to add p1 and p2, for building tampered proofs.
    function zInv(uint256[2] memory p1, uint256[2] memory p2) external view returns (uint256) {
        (,, uint256 z) = _projectiveECAdd(p1[0], p1[1], p2[0], p2[1]);
        uint256 p = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
        return _bigModExp(z, p - 2);
    }
}
