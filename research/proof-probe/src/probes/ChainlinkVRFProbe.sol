// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {VRF} from "../chainlink/VRF.sol";
import {Vectors as V} from "../Vectors.sol";

/// Constructor-only gas probe for the Chainlink-style VRF.sol (copy from
/// mangekyou-labs/vrf-server at 71fdd87 crosschain-prover/contracts/src/VRF.sol, code-identical to
/// smartcontractkit/chainlink-evm contracts/src/v0.8/vrf/VRF.sol apart from identifier names).
/// The deployed "runtime code" is abi.encode(bool ok, uint256 verifyGas, uint256 output), so an
/// eth_call of the creation transaction returns the measurement without deploying anything.
/// mode 0 = valid proof, 1 = tampered s, 2 = tampered seed.
contract ChainlinkVRFProbe is VRF {
    constructor(uint256 mode) {
        Proof memory p = Proof({
            pk: [V.CL_PK_X, V.CL_PK_Y],
            gamma: [V.CL_GAMMA_X, V.CL_GAMMA_Y],
            c: V.CL_C,
            s: V.CL_S,
            seed: V.CL_SEED,
            uWitness: V.CL_UWITNESS,
            cGammaWitness: [V.CL_CGAMMAWITNESS_X, V.CL_CGAMMAWITNESS_Y],
            sHashWitness: [V.CL_SHASHWITNESS_X, V.CL_SHASHWITNESS_Y],
            zInv: V.CL_ZINV
        });
        uint256 seed = p.seed;
        if (mode == 1) p.s ^= 1;
        if (mode == 2) seed ^= 1;
        uint256 g0 = gasleft();
        uint256 out = randomValueFromVRFProof(p, seed); // reverts on an invalid proof
        uint256 used = g0 - gasleft();
        bytes memory r = abi.encode(out == V.CL_OUTPUT, used, out);
        assembly {
            return(add(r, 0x20), mload(r))
        }
    }
}
