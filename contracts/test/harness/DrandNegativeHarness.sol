// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BLS} from "../../src/vendor/bls-bn254/BLS.sol";
import {DrandEvmnet} from "../../src/DrandEvmnet.sol";

/// Exposes DrandEvmnet's internal checks, plus hash-to-G1 and verifySingle.
/// The DST is a constant inside DrandEvmnet, so the wrong-DST case cannot go
/// through verify. Test-only.
contract DrandNegativeHarness {
    function verify(uint256[4] memory publicKey, uint64 round, uint256[2] memory signature)
        external
        view
        returns (bool)
    {
        return DrandEvmnet.verify(publicKey, round, signature);
    }

    function randomness(uint256[2] memory signature) external pure returns (bytes32) {
        return DrandEvmnet.randomness(signature);
    }

    // Keeps the name of the vendored function it exposes.
    // forge-lint: disable-next-line(mixed-case-function)
    function hashToPoint(bytes calldata dst, bytes calldata message) external view returns (uint256[2] memory) {
        return BLS.hashToPoint(dst, message);
    }

    // forge-lint: disable-next-line(mixed-case-function)
    function verifySingle(uint256[2] memory signature, uint256[4] memory pubkey, uint256[2] memory message)
        external
        view
        returns (bool pairingSuccess, bool callSuccess)
    {
        return BLS.verifySingle(signature, pubkey, message);
    }
}
