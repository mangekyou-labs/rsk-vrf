// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EcvrfSecp256k1Rskip516 as E} from "../ecvrf/EcvrfSecp256k1Rskip516.sol";
import {Vectors as V} from "../Vectors.sol";

/// Constructor-only gas probe for the RFC 9381-structured secp256k1 ECVRF using RSKIP516.
/// Runtime code returned = abi.encode(bool ok, uint256 verifyGas, bytes32 beta).
/// mode 0 = valid, 1 = tampered s, 2 = tampered alpha, 3 = off-curve public key.
contract EcvrfRskip516Probe {
    constructor(uint256 mode) {
        uint256[2] memory pk = [V.EC_PK_X, V.EC_PK_Y];
        uint256[4] memory proof = [V.EC_GAMMA_X, V.EC_GAMMA_Y, V.EC_C, V.EC_S];
        bytes memory alpha = abi.encodePacked(V.EC_ALPHA);
        if (mode == 1) proof[3] ^= 1;
        if (mode == 2) alpha[0] ^= 0x01;
        if (mode == 3) pk[1] ^= 1;
        uint256 g0 = gasleft();
        (bool ok, bytes32 beta) = E.verify(pk, proof, alpha);
        uint256 used = g0 - gasleft();
        bytes memory r = abi.encode(ok && beta == V.EC_BETA, used, beta);
        assembly {
            return(add(r, 0x20), mload(r))
        }
    }
}
