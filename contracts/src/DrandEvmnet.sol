// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BLS} from "./vendor/bls-bn254/BLS.sol";

/// @title DrandEvmnet
/// @notice Verifies drand `evmnet` beacon signatures: BLS on bn254, signature on G1,
///   public key on G2, message keccak256(uint64_be(round)) hashed to G1 with
///   keccak256 expand_message_xmd and SvdW.
library DrandEvmnet {
    bytes internal constant DST = "BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_";

    /// @notice Whether `signature` is the beacon's signature for `round` under `publicKey`
    ///   (BLS.sol layout [x.re, x.im, y.re, y.im]).
    function verify(uint256[4] memory publicKey, uint64 round, uint256[2] memory signature)
        internal
        view
        returns (bool)
    {
        if (!BLS.isValidSignature(signature)) return false;
        uint256[2] memory message = BLS.hashToPoint(DST, abi.encodePacked(keccak256(abi.encodePacked(round))));
        (bool pairingSuccess, bool callSuccess) = BLS.verifySingle(signature, publicKey, message);
        return pairingSuccess && callSuccess;
    }

    /// @notice The round's randomness, sha256 of the canonical 64-byte signature.
    /// @dev drand/kyber pairing/bn254 pointG1.MarshalBinary serializes uncompressed
    ///   x || y (32 bytes each), and drand RandomnessFromSignature hashes those bytes.
    ///   https://github.com/drand/kyber/blob/master/pairing/bn254/point.go
    ///   https://github.com/drand/drand/blob/master/crypto/schemes.go
    function randomness(uint256[2] memory signature) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(signature[0], signature[1]));
    }
}
