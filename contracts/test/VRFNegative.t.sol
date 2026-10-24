// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VRF} from "../src/vendor/chainlink/VRF.sol";
import {VRFVectorFixture} from "./VRFVectors.t.sol";
import {SECP256K1_FIELD_SIZE} from "./harness/VRFHarness.sol";

/// Every way a proof can be wrong must make VRF.sol revert. Each test takes a
/// valid vector from vrfkey, breaks one thing, and expects VRF.sol's own
/// revert reason, so it also shows which check caught the change.
///
/// "Seed" here is VRF.sol's raw `seed` input, where a request's Alpha will
/// go. The vectors use arbitrary seeds, not domain Alphas.
contract VRFNegativeTest is VRFVectorFixture {
    uint256 internal constant P = SECP256K1_FIELD_SIZE;
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    Vector internal v;

    function setUp() public override {
        super.setUp();
        v = vector(0);
    }

    /// Verifies proof against its own seed field.
    function verify(VRF.Proof memory proof) internal view returns (uint256) {
        return verifyWithSeed(proof, proof.seed);
    }

    function verifyWithSeed(VRF.Proof memory proof, uint256 seed) internal view returns (uint256) {
        return vrf.randomValueFromVRFProof(proof, seed);
    }

    function neg(uint256[2] memory pt) internal pure returns (uint256[2] memory) {
        return [pt[0], P - pt[1]];
    }

    function offCurve(uint256[2] memory pt) internal pure returns (uint256[2] memory) {
        return [pt[0], addmod(pt[1], 1, P)];
    }

    function test_BaseVectorVerifies() public view {
        assertEq(verify(v.proof), v.output);
    }

    // Tampered gamma

    function test_RevertWhen_GammaIsOffCurve() public {
        v.proof.gamma = offCurve(v.proof.gamma);
        vm.expectRevert("gamma is not on curve");
        verify(v.proof);
    }

    function test_RevertWhen_GammaIsAnotherCurvePoint() public {
        v.proof.gamma = neg(v.proof.gamma);
        vm.expectRevert("First mul check failed");
        verify(v.proof);
    }

    /// The prover supplies witnesses that are consistent with a forged gamma,
    /// so only the final challenge comparison can catch it.
    function test_RevertWhen_GammaIsForgedWithConsistentWitnesses() public {
        v.proof.gamma = neg(v.proof.gamma);
        v.proof.cGammaWitness = neg(v.proof.cGammaWitness);
        v.proof.zInv = vrf.zInv(v.proof.cGammaWitness, v.proof.sHashWitness);
        vm.expectRevert("invalid proof");
        verify(v.proof);
    }

    // Tampered c and s

    function test_RevertWhen_CIsTampered() public {
        v.proof.c = addmod(v.proof.c, 1, N);
        vm.expectRevert("addr(c*pk+s*g)!=_uWitness");
        verify(v.proof);
    }

    function test_RevertWhen_SIsTampered() public {
        v.proof.s = addmod(v.proof.s, 1, N);
        vm.expectRevert("addr(c*pk+s*g)!=_uWitness");
        verify(v.proof);
    }

    function testFuzz_RevertWhen_CIsAnyOtherValue(uint256 c) public {
        vm.assume(c != v.proof.c);
        v.proof.c = c;
        vm.expectRevert();
        verify(v.proof);
    }

    function testFuzz_RevertWhen_SIsAnyOtherValueModN(uint256 s) public {
        vm.assume(s % N != v.proof.s);
        v.proof.s = s;
        vm.expectRevert();
        verify(v.proof);
    }

    // Wrong public key

    function test_RevertWhen_PublicKeyBelongsToAnotherKey() public {
        Vector memory other = vector(vectorCount() - 1);
        assertTrue(other.proof.pk[0] != v.proof.pk[0], "fixture needs a second key");
        v.proof.pk = other.proof.pk;
        vm.expectRevert("addr(c*pk+s*g)!=_uWitness");
        verify(v.proof);
    }

    function test_RevertWhen_PublicKeyIsOffCurve() public {
        v.proof.pk = offCurve(v.proof.pk);
        vm.expectRevert("public key is not on curve");
        verify(v.proof);
    }

    // Wrong alpha (the seed argument)

    function test_RevertWhen_VerifiedAgainstAnotherAlpha() public {
        vm.expectRevert("Second mul check failed");
        verifyWithSeed(v.proof, v.proof.seed + 1);
    }

    /// VRF.sol verifies the seed argument and ignores proof.seed, so callers
    /// must pass the seed they derived themselves.
    function test_ProofSeedFieldIsIgnored() public {
        uint256 seed = v.proof.seed;
        v.proof.seed = seed + 1;
        assertEq(verifyWithSeed(v.proof, seed), v.output);
        vm.expectRevert("Second mul check failed");
        verifyWithSeed(v.proof, v.proof.seed);
    }

    // Points not on the curve

    function test_RevertWhen_CGammaWitnessIsOffCurve() public {
        v.proof.cGammaWitness = offCurve(v.proof.cGammaWitness);
        vm.expectRevert("cGammaWitness is not on curve");
        verify(v.proof);
    }

    function test_RevertWhen_SHashWitnessIsOffCurve() public {
        v.proof.sHashWitness = offCurve(v.proof.sHashWitness);
        vm.expectRevert("sHashWitness is not on curve");
        verify(v.proof);
    }

    // Out-of-range ordinates and scalars

    function test_RevertWhen_XOrdinateIsFieldSize() public {
        v.proof.pk[0] = P;
        vm.expectRevert("invalid x-ordinate");
        verify(v.proof);
    }

    function test_RevertWhen_YOrdinateIsFieldSize() public {
        v.proof.gamma[1] = P;
        vm.expectRevert("invalid y-ordinate");
        verify(v.proof);
    }

    function test_RevertWhen_OrdinateIsMaxUint() public {
        v.proof.sHashWitness[0] = type(uint256).max;
        vm.expectRevert("invalid x-ordinate");
        verify(v.proof);
    }

    function test_RevertWhen_CIsZero() public {
        v.proof.c = 0;
        vm.expectRevert("addr(c*pk+s*g)!=_uWitness");
        verify(v.proof);
    }

    function test_RevertWhen_CIsGroupOrder() public {
        v.proof.c = N;
        vm.expectRevert("addr(c*pk+s*g)!=_uWitness");
        verify(v.proof);
    }

    function test_RevertWhen_SIsMaxUint() public {
        v.proof.s = type(uint256).max;
        vm.expectRevert("addr(c*pk+s*g)!=_uWitness");
        verify(v.proof);
    }

    /// With s = 0 and a uWitness forged to match c*pk, the zero-scalar guard
    /// in the second ecmul check still rejects the proof.
    function test_RevertWhen_SIsZero() public {
        v.proof.s = 0;
        v.proof.uWitness = vm.addr(mulmod(v.proof.c, v.secretKey, N));
        vm.expectRevert("zero scalar");
        verify(v.proof);
    }

    /// s = N is 0 mod N but not zero, so it gets past the zero-scalar guard and
    /// the ecrecover-based ecmul check rejects it instead.
    function test_RevertWhen_SIsGroupOrder() public {
        v.proof.s = N;
        v.proof.uWitness = vm.addr(mulmod(v.proof.c, v.secretKey, N));
        vm.expectRevert("Second mul check failed");
        verify(v.proof);
    }

    // Bad uWitness

    function test_RevertWhen_UWitnessIsWrong() public {
        v.proof.uWitness = address(uint160(v.proof.uWitness) ^ 1);
        vm.expectRevert("addr(c*pk+s*g)!=_uWitness");
        verify(v.proof);
    }

    function test_RevertWhen_UWitnessIsZero() public {
        v.proof.uWitness = address(0);
        vm.expectRevert("bad witness");
        verify(v.proof);
    }

    // Bad cGammaWitness and sHashWitness

    function test_RevertWhen_CGammaWitnessIsWrongPoint() public {
        v.proof.cGammaWitness = neg(v.proof.cGammaWitness);
        vm.expectRevert("First mul check failed");
        verify(v.proof);
    }

    function test_RevertWhen_SHashWitnessIsWrongPoint() public {
        v.proof.sHashWitness = neg(v.proof.sHashWitness);
        vm.expectRevert("Second mul check failed");
        verify(v.proof);
    }

    function test_RevertWhen_WitnessesAreEqual() public {
        v.proof.sHashWitness = v.proof.cGammaWitness;
        vm.expectRevert("points in sum must be distinct");
        verify(v.proof);
    }

    // Bad zInv

    function test_RevertWhen_ZInvIsWrong() public {
        v.proof.zInv = addmod(v.proof.zInv, 1, P);
        vm.expectRevert("invZ must be inverse of z");
        verify(v.proof);
    }

    function test_RevertWhen_ZInvIsZero() public {
        v.proof.zInv = 0;
        vm.expectRevert("invZ must be inverse of z");
        verify(v.proof);
    }

    function testFuzz_RevertWhen_ZInvIsAnyOtherValue(uint256 zInv) public {
        vm.assume(zInv != v.proof.zInv);
        v.proof.zInv = zInv;
        vm.expectRevert("invZ must be inverse of z");
        verify(v.proof);
    }
}
