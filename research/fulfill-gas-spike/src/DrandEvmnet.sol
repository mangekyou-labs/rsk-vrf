// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BLS} from "./vendor/bls-bn254/BLS.sol";

/// @title drand evmnet round verification (scheme bls-bn254-unchained-on-g1) over bls-bn254's BLS - SPIKE
/// @notice m = keccak256(uint64be(round)), H = hash_to_curve(G1, XMD/keccak256, SVDW) with the drand DST,
///         check e(sig, -G2) * e(H(m), pk) == 1, randomness = sha256(sig).
library DrandEvmnet {
    /// @dev pk in the order BLS.verifySingle expects: it reorders [1],[0],[3],[2] into the EIP-197
    ///      (x_imag, x_real, y_imag, y_real) pairing input, so pk = [x_real, x_imag, y_real, y_imag].
    struct Config {
        uint256[4] pk;
        uint64 genesis;
        uint32 period;
    }

    bytes internal constant DST = "BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_";

    function verify(Config storage cfg, uint64 round, uint256[2] calldata sig)
        internal
        view
        returns (bool valid, bytes32 randomness)
    {
        uint256[2] memory s = sig;
        if (!BLS.isValidSignature(s)) return (false, 0);
        uint256[2] memory h = BLS.hashToPoint(DST, abi.encodePacked(keccak256(abi.encodePacked(round))));
        (bool pairingSuccess, bool callSuccess) = BLS.verifySingle(s, cfg.pk, h);
        if (!(pairingSuccess && callSuccess)) return (false, 0);
        randomness = sha256(abi.encodePacked(s[0], s[1]));
        valid = true;
    }
}
