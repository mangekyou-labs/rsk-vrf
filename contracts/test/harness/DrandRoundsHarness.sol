// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DrandEvmnet} from "../../src/DrandEvmnet.sol";

/// Exposes DrandEvmnet's internal beacon checks. Test-only.
contract DrandRoundsHarness {
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

    function dst() external pure returns (bytes memory) {
        return DrandEvmnet.DST;
    }
}
