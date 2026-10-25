// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {DrandNegativeHarness} from "./harness/DrandNegativeHarness.sol";

/// A bad evmnet round or point must make DrandEvmnet.verify return false.
/// The group key and signatures are pinned from the beacon, not produced by
/// the contract under test.
///
/// Group key: https://api.drand.sh/v2/beacons/evmnet/info
/// Signatures: https://api.drand.sh/v2/beacons/evmnet/rounds/1 and /2
///
/// Kyber marshals a G2 point as [x.im, x.re, y.im, y.re] because its Fp2
/// element is xi + y. DrandEvmnet stores [x.re, x.im, y.re, y.im]. The limbs
/// below are the wire words swapped inside each Fp2 element. That layout is
/// the one verify accepts; raw wire order in those slots does not.
contract DrandNegativeTest is Test {
    /// bn254 base field, the N in BLS.sol.
    uint256 internal constant N = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    bytes internal constant SVDW_DST = "BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_";
    bytes internal constant SSWU_DST = "BLS_SIG_BN254G1_XMD:KECCAK-256_SSWU_RO_NUL_";

    /// sha256 of the 64-byte round-1 signature (x || y). Python hashlib, not sha256 inside this test.
    bytes32 internal constant ROUND_1_RANDOMNESS = 0x781b75698adc3af62cfa55db83cf0c73ae54e1ac8c0d4c3a2224126b65369ec5;

    uint256[4] internal publicKey = [
        0x0557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808f,
        0x07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382,
        0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0b,
        0x0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6
    ];

    uint256[2] internal sig1 = [
        0x11f812d738a36b2210dc88c2d635ad8039588205f42445d6de09e6530165c346,
        0x2a23aca348c84badcf8df5321ac24577b7963d5b0d780bc4626baedb45cde373
    ];

    uint256[2] internal sig2 = [
        0x1dbfe644485f31e2a7978fb551b50933b0001e64397fd2b7dc4022e8e2fcdbc3,
        0x25798cea5506deec489c8db3b4697f6b1bb6be8934b95bd9c0db88923487d9ad
    ];

    DrandNegativeHarness internal harness;

    function setUp() public {
        harness = new DrandNegativeHarness();
    }

    function test_RealRoundVerifies() public view {
        assertTrue(harness.verify(publicKey, 1, sig1));
        assertTrue(harness.verify(publicKey, 2, sig2));
    }

    function test_WrongRoundIsFalse() public view {
        assertFalse(harness.verify(publicKey, 2, sig1));
    }

    function test_NeighbouringSignatureIsFalse() public view {
        assertFalse(harness.verify(publicKey, 1, sig2));
    }

    /// The SSWU DST does not revert. It hashes the same round message to a
    /// different point, and the real signature does not verify against that point.
    function test_WrongDstDoesNotVerify() public view {
        bytes memory message = abi.encodePacked(keccak256(abi.encodePacked(uint64(1))));
        uint256[2] memory svdw = harness.hashToPoint(SVDW_DST, message);
        uint256[2] memory sswu = harness.hashToPoint(SSWU_DST, message);
        assertTrue(svdw[0] != sswu[0] || svdw[1] != sswu[1]);

        (bool pairingSuccess, bool callSuccess) = harness.verifySingle(sig1, publicKey, sswu);
        assertTrue(callSuccess);
        assertFalse(pairingSuccess);
        assertTrue(harness.verify(publicKey, 1, sig1));
    }

    /// Negate Y. The result is a different point of G2.
    function test_WrongGroupKeyIsFalse() public view {
        assertTrue(publicKey[2] != 0 && publicKey[3] != 0);
        uint256[4] memory negated = publicKey;
        negated[2] = N - publicKey[2];
        negated[3] = N - publicKey[3];
        assertFalse(harness.verify(negated, 1, sig1));
    }

    function test_OffCurveSignatureIsFalse() public view {
        uint256[2] memory off = sig1;
        off[1] = addmod(sig1[1], 1, N);
        assertLt(off[0], N);
        assertLt(off[1], N);
        assertFalse(_onCurveG1(off[0], off[1]));
        assertFalse(harness.verify(publicKey, 1, off));
    }

    /// Issue #34's non-canonical case: the other G1 point with the same x.
    /// y' = N - y is on the curve and in range. It is not the signature.
    function test_NegatedOnCurveSignatureIsFalse() public view {
        assertTrue(sig1[1] != 0);
        uint256[2] memory neg = [sig1[0], N - sig1[1]];
        assertLt(neg[1], N);
        assertTrue(neg[1] != sig1[1]);
        assertTrue(_onCurveG1(neg[0], neg[1]));
        assertFalse(harness.verify(publicKey, 1, neg));
    }

    /// x + N is the same residue as the real signature, so a curve check that
    /// reduced first would accept it. The range check rejects it before that.
    function test_CoordinateAtLeastFieldModulusIsFalse() public view {
        uint256[2] memory over = [sig1[0] + N, sig1[1]];
        assertGe(over[0], N);
        assertFalse(harness.verify(publicKey, 1, over));
    }

    function test_RandomnessIsSha256OfSignature() public view {
        assertEq(harness.randomness(sig1), ROUND_1_RANDOMNESS);
    }

    function _onCurveG1(uint256 x, uint256 y) internal pure returns (bool) {
        return mulmod(y, y, N) == addmod(mulmod(mulmod(x, x, N), x, N), 3, N);
    }
}
