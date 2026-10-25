// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {VRF} from "../src/vendor/chainlink/VRF.sol";
import {VRFHarness} from "./harness/VRFHarness.sol";

/// Loads the proof vectors that tools/vrf-vectors-go generates with Chainlink's vrfkey.
abstract contract VRFVectorFixture is Test {
    string internal constant VECTORS = "../tools/vrf-vectors-go/vrf-proofs.json";

    struct Vector {
        string name;
        uint256 secretKey;
        uint256 hashToCurveTries;
        uint256[2] hash;
        VRF.Proof proof;
        bytes proofBytes;
        uint256 output;
    }

    VRFHarness internal vrf;
    string internal json;

    function setUp() public virtual {
        vrf = new VRFHarness();
        // Reads only the vector file, which foundry.toml's fs_permissions allows.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        json = vm.readFile(VECTORS);
    }

    function vectorCount() internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(".vectors[", vm.toString(n), "]"))) {
            n++;
        }
    }

    function vector(uint256 i) internal view returns (Vector memory v) {
        string memory at = string.concat(".vectors[", vm.toString(i), "]");
        string memory proofAt = string.concat(at, ".proof");
        v.name = vm.parseJsonString(json, string.concat(at, ".name"));
        v.secretKey = vm.parseJsonUint(json, string.concat(at, ".secretKey"));
        v.hashToCurveTries = vm.parseJsonUint(json, string.concat(at, ".hashToCurveTries"));
        v.hash = point(string.concat(at, ".hash"));
        v.output = vm.parseJsonUint(json, string.concat(at, ".output"));
        v.proofBytes = vm.parseJsonBytes(json, string.concat(at, ".proofBytes"));
        v.proof.pk = point(string.concat(proofAt, ".pk"));
        v.proof.gamma = point(string.concat(proofAt, ".gamma"));
        v.proof.c = vm.parseJsonUint(json, string.concat(proofAt, ".c"));
        v.proof.s = vm.parseJsonUint(json, string.concat(proofAt, ".s"));
        v.proof.seed = vm.parseJsonUint(json, string.concat(proofAt, ".seed"));
        v.proof.uWitness = vm.parseJsonAddress(json, string.concat(proofAt, ".uWitness"));
        v.proof.cGammaWitness = point(string.concat(proofAt, ".cGammaWitness"));
        v.proof.sHashWitness = point(string.concat(proofAt, ".sHashWitness"));
        v.proof.zInv = vm.parseJsonUint(json, string.concat(proofAt, ".zInv"));
    }

    function point(string memory key) private view returns (uint256[2] memory out) {
        uint256[] memory xs = vm.parseJsonUintArray(json, key);
        require(xs.length == 2, "expected a point");
        out = [xs[0], xs[1]];
    }
}

contract VRFVectorsTest is VRFVectorFixture {
    function test_VectorFileCoversOneToFiveHashToCurveTries() public view {
        bool[6] memory seen;
        uint256 n = vectorCount();
        assertGt(n, 0, "no vectors");
        for (uint256 i; i < n; i++) {
            uint256 tries = vector(i).hashToCurveTries;
            if (tries < seen.length) seen[tries] = true;
        }
        for (uint256 tries = 1; tries <= 5; tries++) {
            assertTrue(seen[tries], string.concat("no vector needs tries=", vm.toString(tries)));
        }
    }

    function test_HashToCurveMatchesGo() public view {
        uint256 n = vectorCount();
        for (uint256 i; i < n; i++) {
            Vector memory v = vector(i);
            uint256[2] memory h = vrf.hashToCurve(v.proof.pk, v.proof.seed);
            assertEq(h[0], v.hash[0], string.concat(v.name, ": hash x"));
            assertEq(h[1], v.hash[1], string.concat(v.name, ": hash y"));
        }
    }

    function test_OutputMatchesGo() public view {
        uint256 n = vectorCount();
        for (uint256 i; i < n; i++) {
            Vector memory v = vector(i);
            assertEq(vrf.randomValueFromVRFProof(v.proof, v.proof.seed), v.output, v.name);
        }
    }

    /// proofBytes is what the worker submits, so it must be abi.encode of the proof.
    function test_ProofBytesAreTheAbiEncodedProof() public view {
        uint256 n = vectorCount();
        for (uint256 i; i < n; i++) {
            Vector memory v = vector(i);
            assertEq(v.proofBytes, abi.encode(v.proof), v.name);
        }
    }
}
