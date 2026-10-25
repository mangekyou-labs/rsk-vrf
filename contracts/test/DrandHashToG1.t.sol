// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {BLSHashHarness} from "./harness/BLSHashHarness.sol";

/// Pins BLS.hashToPoint for drand evmnet rounds against tools/bn254-svdw:
/// an independent Python RFC 9380 SVDW port and gnark-crypto v0.22.0
/// (550a513d798df79d8324697332e085498285bb63) bn254.MapToCurve1.
/// Message is keccak256 of the uint64 big-endian round.
contract DrandHashToG1Test is Test {
    bytes internal constant DST = "BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_";
    bytes internal constant SSWU_DST = "BLS_SIG_BN254G1_XMD:KECCAK-256_SSWU_RO_NUL_";

    BLSHashHarness internal bls;

    function setUp() public {
        bls = new BLSHashHarness();
    }

    function test_dst() public pure {
        assertEq(DST, "BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_");
        assertEq(DST.length, 43);
    }

    /// These four rounds do not claim to hit u=0, tv1=0, g(x)=0, or the x3 branch.
    function test_hashToPoint_matchesGnarkAndPython() public view {
        _pin(
            1,
            3274388634597322850260789370149388140895047873973358019313287818327097230193,
            10513082672822249208187315831936923759893212599696164836629308721715663163524
        );
        _pin(
            2,
            18317723016741019748785203421045033357307032407854456469553834413816111332559,
            10046275344722710246332100944108000885325816999051527696506478977097568618528
        );
        _pin(
            1000,
            1366964896061899794172844183715123429959122507397452434947464136574533357494,
            6038363838577457341278926859099152931929377660248798415206716263238053888986
        );
        _pin(
            10000000,
            8493442658328757949118642978353267516431746673774324677617041033794688891737,
            18936670607862944953131286196397830185641071413513452655470411974908183112402
        );

        assertTrue(
            _sswuDiffers(1) || _sswuDiffers(2) || _sswuDiffers(1000) || _sswuDiffers(10000000),
            "SSWU DST matched SVDW on every pinned round"
        );
    }

    function _message(uint64 round) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked(round)));
    }

    function _pin(uint64 round, uint256 x, uint256 y) internal view {
        uint256[2] memory p = bls.hashToPoint(DST, _message(round));
        assertEq(p[0], x, "x");
        assertEq(p[1], y, "y");
    }

    function _sswuDiffers(uint64 round) internal view returns (bool) {
        bytes memory message = _message(round);
        uint256[2] memory svdw = bls.hashToPoint(DST, message);
        uint256[2] memory sswu = bls.hashToPoint(SSWU_DST, message);
        return svdw[0] != sswu[0] || svdw[1] != sswu[1];
    }
}
