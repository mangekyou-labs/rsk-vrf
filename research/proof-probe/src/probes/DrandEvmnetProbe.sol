// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DrandEvmnetVerifier as D} from "../drand/DrandEvmnetVerifier.sol";
import {Vectors as V} from "../Vectors.sol";

/// Constructor-only gas probe for drand evmnet (bls-bn254-unchained-on-g1) round verification.
/// Runtime code returned = abi.encode(bool ok, uint256 verifyGas, bytes32 randomness).
/// mode 0 = valid round 1000000, 1 = wrong round, 2 = tampered signature (still on curve: -sig),
/// 3 = hash-to-G1 (expand_message_xmd + 2x SVDW + G1 add) alone, ok = matches drand's H(m),
/// 4 = off-curve signature (sy + 1): the pairing precompile must not make verify return true.
contract DrandEvmnetProbe {
    constructor(uint256 mode) {
        uint64 round = V.DR_ROUND;
        uint256 sx = V.DR_SIG_X;
        uint256 sy = V.DR_SIG_Y;
        if (mode == 1) round += 1;
        if (mode == 2) sy = D.P - sy;
        if (mode == 4) sy = addmod(sy, 1, D.P);
        if (mode == 3) {
            uint256 h0 = gasleft();
            (uint256 hx, uint256 hy) = D.hashToG1(round);
            uint256 hused = h0 - gasleft();
            bytes memory hr = abi.encode(hx == V.DR_HM_X && hy == V.DR_HM_Y, hused, bytes32(hx));
            assembly {
                return(add(hr, 0x20), mload(hr))
            }
        }
        uint256 g0 = gasleft();
        (bool ok, bytes32 rnd) = D.verify(round, sx, sy);
        uint256 used = g0 - gasleft();
        bytes memory r = abi.encode(ok && rnd == V.DR_RANDOMNESS, used, rnd);
        assembly {
            return(add(r, 0x20), mload(r))
        }
    }
}
