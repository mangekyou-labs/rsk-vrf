// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {BLSHashHarness} from "./harness/BLSHashHarness.sol";
import {DrandRoundsHarness} from "./harness/DrandRoundsHarness.sol";

/// Pins BLS.hashToPoint for drand evmnet rounds against tools/bn254-svdw:
/// an independent Python RFC 9380 SVDW port and gnark-crypto v0.22.0
/// (550a513d798df79d8324697332e085498285bb63) bn254.MapToCurve1.
/// Message is keccak256 of the uint64 big-endian round.
contract DrandHashToG1Test is Test {
    string internal constant VECTORS = "../tools/bn254-svdw/vectors.json";
    bytes internal constant SSWU_DST = "BLS_SIG_BN254G1_XMD:KECCAK-256_SSWU_RO_NUL_";

    BLSHashHarness internal bls;
    DrandRoundsHarness internal drand;
    string internal json;

    function setUp() public {
        bls = new BLSHashHarness();
        drand = new DrandRoundsHarness();
        // Reads only the vector file, which foundry.toml's fs_permissions allows.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        json = vm.readFile(VECTORS);
    }

    function test_dst() public view {
        string memory dst = string(drand.dst());
        assertEq(dst, "BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_");
        assertEq(bytes(dst).length, 43);
        assertEq(vm.parseJsonString(json, ".dst"), dst);
    }

    /// These four rounds do not claim to hit u=0, tv1=0, g(x)=0, or the x3 branch.
    function test_hashToPoint_matchesGnarkAndPython() public view {
        uint256 n = roundCount();
        assertEq(n, 4, "round count");
        bool sswuDiffers;
        for (uint256 i; i < n; i++) {
            (uint64 round, uint256 x, uint256 y) = roundAt(i);
            uint256[2] memory p = bls.hashToPoint(drand.dst(), _message(round));
            assertEq(p[0], x, "x");
            assertEq(p[1], y, "y");
            if (_sswuDiffers(round)) sswuDiffers = true;
        }
        assertTrue(sswuDiffers, "SSWU DST matched SVDW on every pinned round");
    }

    function roundCount() internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(".rounds[", vm.toString(n), "]"))) {
            n++;
        }
    }

    function roundAt(uint256 i) internal view returns (uint64 round, uint256 x, uint256 y) {
        string memory at = string.concat(".rounds[", vm.toString(i), "]");
        round = uint64(vm.parseJsonUint(json, string.concat(at, ".round")));
        x = vm.parseJsonUint(json, string.concat(at, ".x"));
        y = vm.parseJsonUint(json, string.concat(at, ".y"));
    }

    function _message(uint64 round) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked(round)));
    }

    function _sswuDiffers(uint64 round) internal view returns (bool) {
        bytes memory message = _message(round);
        uint256[2] memory svdw = bls.hashToPoint(drand.dst(), message);
        uint256[2] memory sswu = bls.hashToPoint(SSWU_DST, message);
        return svdw[0] != sswu[0] || svdw[1] != sswu[1];
    }
}
