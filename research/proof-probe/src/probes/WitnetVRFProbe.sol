// SPDX-License-Identifier: MIT
pragma solidity >=0.5.3 <0.7.0;

import "../witnet/VRF.sol";
import "../witnet/WitnetVectors.sol";

/// Constructor-only gas probe for witnet/vrf-solidity at commit 653dc85 (pure-EVM ECVRF, draft-04 style,
/// SECP256K1_SHA256_TAI, suite 0xFE). mode 0 = verify, 1 = fastVerify, 2 = verify tampered s,
/// 3 = fastVerify tampered s. Runtime code = abi.encode(bool ok, uint256 verifyGas, bytes32 beta).
contract WitnetVRFProbe is WitnetVectors {
    constructor(uint256 mode) public {
        uint256[2] memory pk = [PK_X, PK_Y];
        uint256[4] memory proof = [GAMMA_X, GAMMA_Y, C, S];
        bytes memory message = MESSAGE;
        if (mode >= 2) proof[3] ^= 1;
        bool ok;
        uint256 g0 = gasleft();
        if (mode == 0 || mode == 2) {
            ok = VRF.verify(pk, proof, message);
        } else {
            ok = VRF.fastVerify(
                pk, proof, message,
                [U_X, U_Y],
                [SH_X, SH_Y, CG_X, CG_Y]);
        }
        uint256 used = g0 - gasleft();
        bytes32 beta = VRF.gammaToHash(proof[0], proof[1]);
        bytes memory r = abi.encode(ok, used, beta);
        assembly {
            return(add(r, 0x20), mload(r))
        }
    }
}
