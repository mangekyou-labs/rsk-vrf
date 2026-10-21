// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ECVRF over secp256k1, RFC 9381 structure, try-and-increment, SHA-256 - PROBE ONLY
/// @notice Verifier for an RFC 9381 section 5 style ECVRF instantiated on secp256k1 with
///         ECVRF_encode_to_curve_try_and_increment (RFC 9381 section 5.4.1.1), cLen = 16,
///         ptLen = 33 (SEC1 compressed points). RFC 9381 defines no secp256k1 ciphersuite,
///         so the suite byte 0xFE is NON-STANDARD (same value used by witnet/vrf-solidity).
/// @dev    Uses the Rootstock RSKIP516 secp256k1 precompiles (ADD at 0x01000016, MUL at
///         0x01000017; EIP-196 style 64-byte affine encoding, (0,0) = point at infinity) and the
///         modexp precompile 0x05 for square roots. Unaudited research code.
library EcvrfSecp256k1Rskip516 {
    uint256 internal constant P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;
    uint256 internal constant GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8;
    address internal constant SECP_ADD = address(0x01000016);
    address internal constant SECP_MUL = address(0x01000017);
    bytes1 internal constant SUITE = 0xFE;

    function onCurve(uint256 x, uint256 y) internal pure returns (bool) {
        if (x >= P || y >= P) return false;
        return mulmod(y, y, P) == addmod(mulmod(x, mulmod(x, x, P), P), 7, P);
    }

    function compress(uint256 x, uint256 y) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes1(uint8(2 + (y & 1))), x);
    }

    function _mul(uint256 x, uint256 y, uint256 k) private view returns (uint256 rx, uint256 ry) {
        bool ok;
        assembly {
            let m := mload(0x40)
            mstore(m, x)
            mstore(add(m, 0x20), y)
            mstore(add(m, 0x40), k)
            ok := staticcall(gas(), 0x01000017, m, 0x60, m, 0x40)
            rx := mload(m)
            ry := mload(add(m, 0x20))
        }
        require(ok, "secp mul");
    }

    function _add(uint256 ax, uint256 ay, uint256 bx, uint256 by) private view returns (uint256 rx, uint256 ry) {
        bool ok;
        assembly {
            let m := mload(0x40)
            mstore(m, ax)
            mstore(add(m, 0x20), ay)
            mstore(add(m, 0x40), bx)
            mstore(add(m, 0x60), by)
            ok := staticcall(gas(), 0x01000016, m, 0x80, m, 0x40)
            rx := mload(m)
            ry := mload(add(m, 0x20))
        }
        require(ok, "secp add");
    }

    function _sqrt(uint256 a) private view returns (uint256 r, bool ok) {
        bool success;
        assembly {
            let m := mload(0x40)
            mstore(m, 0x20)
            mstore(add(m, 0x20), 0x20)
            mstore(add(m, 0x40), 0x20)
            mstore(add(m, 0x60), a)
            mstore(add(m, 0x80), 0x3fffffffffffffffffffffffffffffffffffffffffffffffffffffffbfffff0c) // (P+1)/4
            mstore(add(m, 0xa0), P)
            success := staticcall(gas(), 0x05, m, 0xc0, m, 0x20)
            r := mload(m)
        }
        require(success, "modexp");
        ok = mulmod(r, r, P) == a;
    }

    /// RFC 9381 section 5.4.1.1 with encode_to_curve_salt = PK_string (compressed Y).
    function encodeToCurve(uint256 px, uint256 py, bytes memory alpha)
        internal
        view
        returns (uint256 hx, uint256 hy)
    {
        bytes memory pkS = compress(px, py);
        for (uint256 ctr = 0; ctr < 256; ctr++) {
            uint256 x = uint256(sha256(abi.encodePacked(SUITE, bytes1(0x01), pkS, alpha, uint8(ctr), bytes1(0x00))));
            if (x >= P) continue;
            (uint256 y, bool ok) = _sqrt(addmod(mulmod(x, mulmod(x, x, P), P), 7, P));
            if (!ok) continue;
            if (y & 1 == 1) y = P - y; // 0x02 prefix: even y
            return (x, y);
        }
        revert("encode_to_curve failed");
    }

    /// a*(ax,ay) + b*(bx,by) via two RSKIP516 MULs and one ADD
    function _lin(uint256 ax, uint256 ay, uint256 a, uint256 bx, uint256 by, uint256 b)
        private
        view
        returns (uint256[2] memory r)
    {
        (uint256 x1, uint256 y1) = _mul(ax, ay, a);
        (uint256 x2, uint256 y2) = _mul(bx, by, b);
        (r[0], r[1]) = _add(x1, y1, x2, y2);
    }

    /// RFC 9381 section 5.4.3 challenge_generation, truncated to cLen = 16 bytes
    function _challenge(
        uint256[2] memory pk,
        uint256[2] memory h,
        uint256[4] memory proof,
        uint256[2] memory u,
        uint256[2] memory v
    ) private pure returns (uint256) {
        bytes memory pts = abi.encodePacked(
            compress(pk[0], pk[1]), compress(h[0], h[1]), compress(proof[0], proof[1])
        );
        bytes32 cs = sha256(abi.encodePacked(SUITE, bytes1(0x02), pts, compress(u[0], u[1]), compress(v[0], v[1]), bytes1(0x00)));
        return uint256(cs) >> 128;
    }

    /// @param pk     [Yx, Yy] affine public key (validated here: on curve; cofactor is 1)
    /// @param proof  [Gamma_x, Gamma_y, c, s] - the RFC 81-byte proof with Gamma decompressed
    /// @return valid true iff the proof verifies; beta = proof_to_hash(Gamma)
    function verify(uint256[2] memory pk, uint256[4] memory proof, bytes memory alpha)
        internal
        view
        returns (bool valid, bytes32 beta)
    {
        if (!onCurve(pk[0], pk[1]) || !onCurve(proof[0], proof[1])) return (false, 0);
        if (proof[2] >> 128 != 0 || proof[3] >= N) return (false, 0);
        uint256[2] memory h;
        (h[0], h[1]) = encodeToCurve(pk[0], pk[1], alpha);
        uint256 nc = proof[2] == 0 ? 0 : N - proof[2];
        // U = s*B - c*Y ; V = s*H - c*Gamma
        uint256[2] memory u = _lin(GX, GY, proof[3], pk[0], pk[1], nc);
        uint256[2] memory v = _lin(h[0], h[1], proof[3], proof[0], proof[1], nc);
        if ((u[0] == 0 && u[1] == 0) || (v[0] == 0 && v[1] == 0)) return (false, 0);
        if (_challenge(pk, h, proof, u, v) != proof[2]) return (false, 0);
        beta = sha256(abi.encodePacked(SUITE, bytes1(0x03), compress(proof[0], proof[1]), bytes1(0x00)));
        valid = true;
    }
}
