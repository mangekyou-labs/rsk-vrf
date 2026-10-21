// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title drand evmnet beacon verifier (scheme bls-bn254-unchained-on-g1) - PROBE ONLY
/// @notice Verifies e(sig, G2) == e(H(m), pk) with m = keccak256(uint64be(round)) and
///         H = hash_to_curve(G1, expand_message_xmd/keccak256, SVDW), DST
///         "BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_", as in drand crypto/schemes.go and
///         kyber pairing/bn254/point.go. randomness = sha256(sig) (drand RandomnessFromSignature).
/// @dev    Uses alt_bn128 precompiles 0x06 (add) and 0x08 (pairing) and modexp 0x05.
///         Unaudited research code; no constant-time or gas optimisations (no sqrt hints).
library DrandEvmnetVerifier {
    uint256 internal constant P = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    // 2^256 mod P
    uint256 internal constant R256 = 0x0e0a77c19a07df2f666ea36f7879462c0a78eb28f5c70b3dd35d438dc58f0d9d;
    // SVDW constants for Z = 1 (RFC 9380 6.6.1), checked against kyber bn254 constants
    uint256 internal constant C1 = 4;
    uint256 internal constant C2 = 0x183227397098d014dc2822db40c0ac2ecbc0b548b438e5469e10460b6c3e7ea3;
    uint256 internal constant C3 = 0x16789af3a83522eb353c98fc6b36d713d5d8d1cc5dffffffa;
    uint256 internal constant C4 = 0x10216f7ba065e00de81ac1e7808072c9dd2b2385cd7b438469602eb24829a9bd;

    // drand evmnet group public key (G2), chain hash 04f1e906...6ec8c3, from /v2/beacons/evmnet/info
    uint256 internal constant PK0 = 0x07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382;
    uint256 internal constant PK1 = 0x0557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808f;
    uint256 internal constant PK2 = 0x0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6;
    uint256 internal constant PK3 = 0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0b;

    // BN254 G2 generator, EIP-197 order (x_imag, x_real, y_imag, y_real)
    uint256 internal constant G2X1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 internal constant G2X0 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 internal constant G2Y1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 internal constant G2Y0 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;

    bytes internal constant DST = "BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_";

    function _modexp(uint256 b, uint256 e) private view returns (uint256 r) {
        bool ok;
        assembly {
            let m := mload(0x40)
            mstore(m, 0x20)
            mstore(add(m, 0x20), 0x20)
            mstore(add(m, 0x40), 0x20)
            mstore(add(m, 0x60), b)
            mstore(add(m, 0x80), e)
            mstore(add(m, 0xa0), P)
            ok := staticcall(gas(), 0x05, m, 0xc0, m, 0x20)
            r := mload(m)
        }
        require(ok, "modexp");
    }

    function _g(uint256 x) private pure returns (uint256) {
        return addmod(mulmod(x, mulmod(x, x, P), P), 3, P);
    }

    function _sqrt(uint256 a) private view returns (uint256 r, bool ok) {
        r = _modexp(a, (P + 1) / 4);
        ok = mulmod(r, r, P) == a;
    }

    function hashToField(bytes32 msgHash) internal pure returns (uint256 u0, uint256 u1) {
        bytes memory dst = DST;
        bytes32 b0 = keccak256(abi.encodePacked(new bytes(136), msgHash, uint16(96), uint8(0), dst, uint8(dst.length)));
        bytes32 b1 = keccak256(abi.encodePacked(b0, uint8(1), dst, uint8(dst.length)));
        bytes32 b2 = keccak256(abi.encodePacked(b0 ^ b1, uint8(2), dst, uint8(dst.length)));
        bytes32 b3 = keccak256(abi.encodePacked(b0 ^ b2, uint8(3), dst, uint8(dst.length)));
        // u0 = OS2IP(bytes[0:48]) mod P ; u1 = OS2IP(bytes[48:96]) mod P
        uint256 hi = uint256(b1) >> 128;
        uint256 lo = (uint256(b1) << 128) | (uint256(b2) >> 128);
        u0 = addmod(mulmod(hi, R256, P), lo, P);
        hi = uint256(b2) & type(uint128).max;
        lo = uint256(b3);
        u1 = addmod(mulmod(hi, R256, P), lo, P);
    }

    function mapToPoint(uint256 u) internal view returns (uint256 x, uint256 y) {
        uint256 tv1 = mulmod(mulmod(u, u, P), C1, P);
        uint256 tv2 = addmod(1, tv1, P);
        tv1 = addmod(1, P - tv1, P);
        uint256 tv3 = _modexp(mulmod(tv1, tv2, P), P - 2);
        uint256 tv5 = mulmod(mulmod(mulmod(u, tv1, P), tv3, P), C3, P);
        uint256 x1 = addmod(C2, P - tv5, P);
        uint256 x2 = addmod(C2, tv5, P);
        uint256 t = mulmod(mulmod(tv2, tv2, P), tv3, P);
        uint256 x3 = addmod(1, mulmod(C4, mulmod(t, t, P), P), P);
        bool ok;
        (y, ok) = _sqrt(_g(x1));
        if (ok) {
            x = x1;
        } else {
            (y, ok) = _sqrt(_g(x2));
            if (ok) {
                x = x2;
            } else {
                (y, ok) = _sqrt(_g(x3));
                require(ok, "svdw");
                x = x3;
            }
        }
        if ((u & 1) != (y & 1)) y = P - y;
    }

    function _bnAdd(uint256 ax, uint256 ay, uint256 bx, uint256 by) private view returns (uint256 x, uint256 y) {
        bool ok;
        assembly {
            let m := mload(0x40)
            mstore(m, ax)
            mstore(add(m, 0x20), ay)
            mstore(add(m, 0x40), bx)
            mstore(add(m, 0x60), by)
            ok := staticcall(gas(), 0x06, m, 0x80, m, 0x40)
            x := mload(m)
            y := mload(add(m, 0x20))
        }
        require(ok, "bn add");
    }

    function hashToG1(uint64 round) internal view returns (uint256 x, uint256 y) {
        (uint256 u0, uint256 u1) = hashToField(keccak256(abi.encodePacked(round)));
        (uint256 ax, uint256 ay) = mapToPoint(u0);
        (uint256 bx, uint256 by) = mapToPoint(u1);
        return _bnAdd(ax, ay, bx, by);
    }

    /// @return valid true iff sig is the evmnet beacon signature for `round`
    /// @return randomness sha256(sig) - the drand beacon randomness for the round
    function verify(uint64 round, uint256 sigX, uint256 sigY) internal view returns (bool valid, bytes32 randomness) {
        (uint256 hx, uint256 hy) = hashToG1(round);
        uint256[12] memory inp = [sigX, sigY, G2X1, G2X0, G2Y1, G2Y0, hx, (P - hy) % P, PK0, PK1, PK2, PK3];
        uint256[1] memory out;
        bool ok;
        assembly {
            ok := staticcall(gas(), 0x08, inp, 384, out, 0x20)
            // Rootstock pre-RSKIP197 returned success with EMPTY output on invalid input; post-RSKIP197
            // it returns failure. Require exactly 32 bytes AND value 1 so neither path can pass.
            ok := and(ok, eq(returndatasize(), 0x20))
        }
        valid = ok && out[0] == 1;
        if (valid) randomness = sha256(abi.encodePacked(sigX, sigY));
    }
}
