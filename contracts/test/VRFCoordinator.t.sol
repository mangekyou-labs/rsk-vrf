// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
// Imported so deployCodeTo can find the proxy artifact.
// forge-lint: disable-next-line(unused-import)
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VRF} from "../src/vendor/chainlink/VRF.sol";
import {VRFCoordinator} from "../src/VRFCoordinator.sol";

/// Loads the request -> fulfill -> read traces that tools/vrf-vectors-go generates.
abstract contract CoordinatorVectorFixture is Test {
    string internal constant VECTORS = "../tools/vrf-vectors-go/coordinator-vectors.json";

    struct Derivation {
        bytes32 context;
        bytes32 randomBytes;
        uint256 random;
    }

    struct RequestVector {
        string name;
        uint256 chainId;
        address coordinator;
        address requester;
        uint256 requesterNonce;
        bytes32 tag;
        uint256 requestTimestamp;
        uint64 targetRound;
        bytes32 requestId;
        uint256[2] drandSignature;
        bytes32 alpha;
        VRF.Proof proof;
        bytes32 beta;
        Derivation[] derivations;
    }

    string internal json;

    function loadVectors() internal {
        // Reads only the vector file, which foundry.toml's fs_permissions allows.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        json = vm.readFile(VECTORS);
    }

    function vectorCount() internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(".vectors[", vm.toString(n), "]"))) {
            n++;
        }
    }

    function drandPublicKey() internal view returns (uint256[4] memory pk) {
        uint256[] memory xs = vm.parseJsonUintArray(json, ".drand.publicKey");
        require(xs.length == 4, "expected a G2 point");
        pk = [xs[0], xs[1], xs[2], xs[3]];
    }

    function drandGenesis() internal view returns (uint64) {
        return uint64(vm.parseJsonUint(json, ".drand.genesis"));
    }

    function drandPeriod() internal view returns (uint64) {
        return uint64(vm.parseJsonUint(json, ".drand.period"));
    }

    function vector(uint256 i) internal view returns (RequestVector memory v) {
        string memory at = string.concat(".vectors[", vm.toString(i), "]");
        v.name = vm.parseJsonString(json, string.concat(at, ".name"));
        v.chainId = vm.parseJsonUint(json, string.concat(at, ".chainId"));
        v.coordinator = vm.parseJsonAddress(json, string.concat(at, ".coordinator"));
        v.requester = vm.parseJsonAddress(json, string.concat(at, ".requester"));
        v.requesterNonce = vm.parseJsonUint(json, string.concat(at, ".requesterNonce"));
        v.tag = vm.parseJsonBytes32(json, string.concat(at, ".tag"));
        v.requestTimestamp = vm.parseJsonUint(json, string.concat(at, ".requestTimestamp"));
        v.targetRound = uint64(vm.parseJsonUint(json, string.concat(at, ".targetRound")));
        v.requestId = vm.parseJsonBytes32(json, string.concat(at, ".requestId"));
        v.drandSignature = point(string.concat(at, ".drandSignature"));
        v.alpha = vm.parseJsonBytes32(json, string.concat(at, ".alpha"));
        v.beta = vm.parseJsonBytes32(json, string.concat(at, ".beta"));

        string memory proofAt = string.concat(at, ".vrf.proof");
        v.proof.pk = point(string.concat(proofAt, ".pk"));
        v.proof.gamma = point(string.concat(proofAt, ".gamma"));
        v.proof.c = vm.parseJsonUint(json, string.concat(proofAt, ".c"));
        v.proof.s = vm.parseJsonUint(json, string.concat(proofAt, ".s"));
        v.proof.seed = vm.parseJsonUint(json, string.concat(proofAt, ".seed"));
        v.proof.uWitness = vm.parseJsonAddress(json, string.concat(proofAt, ".uWitness"));
        v.proof.cGammaWitness = point(string.concat(proofAt, ".cGammaWitness"));
        v.proof.sHashWitness = point(string.concat(proofAt, ".sHashWitness"));
        v.proof.zInv = vm.parseJsonUint(json, string.concat(proofAt, ".zInv"));

        uint256 n;
        while (vm.keyExistsJson(json, string.concat(at, ".derivations[", vm.toString(n), "]"))) {
            n++;
        }
        v.derivations = new Derivation[](n);
        for (uint256 j; j < n; j++) {
            string memory d = string.concat(at, ".derivations[", vm.toString(j), "]");
            v.derivations[j] = Derivation({
                context: vm.parseJsonBytes32(json, string.concat(d, ".context")),
                randomBytes: vm.parseJsonBytes32(json, string.concat(d, ".randomBytes")),
                random: vm.parseJsonUint(json, string.concat(d, ".random"))
            });
        }
    }

    function point(string memory key) private view returns (uint256[2] memory out) {
        uint256[] memory xs = vm.parseJsonUintArray(json, key);
        require(xs.length == 2, "expected a point");
        out = [xs[0], xs[1]];
    }
}

contract VRFCoordinatorTest is CoordinatorVectorFixture {
    address internal owner = makeAddr("owner");
    address internal payee = makeAddr("payee");
    address internal fulfiller = makeAddr("fulfiller");

    // ERC-7201 slot of "rsk-vrf.storage.VRFCoordinator"; requests is its first member.
    bytes32 internal constant STORAGE_LOCATION = 0x93e472312740d9d8ceb01cbb3b48eb9a4521b1f1a04d71a14a7e0f61bd068900;
    // ERC-1967: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1).
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    VRFCoordinator internal coordinator;
    uint256 internal count;

    function setUp() public {
        loadVectors();
        count = vectorCount();
        assertGt(count, 1, "need at least two vectors");
        RequestVector memory v0 = vector(0);

        // The vectors bind Alpha to a fixed chain id and proxy address.
        vm.chainId(v0.chainId);
        VRFCoordinator implementation = new VRFCoordinator();
        bytes memory init = abi.encodeCall(
            VRFCoordinator.initialize,
            (owner, VRFCoordinator.DrandConfig(drandPublicKey(), drandGenesis(), drandPeriod()))
        );
        deployCodeTo("ERC1967Proxy.sol:ERC1967Proxy", abi.encode(address(implementation), init), v0.coordinator);
        coordinator = VRFCoordinator(v0.coordinator);
        vm.prank(owner);
        coordinator.setFeeConfig(0);
    }

    // ---------------------------------------------------------------- helpers

    function registerGoldenKey() internal {
        vm.prank(owner);
        coordinator.registerProvingKey(vector(0).proof.pk, payee);
    }

    /// Makes the vector's request at its timestamp, from its requester.
    function requestAs(RequestVector memory v) internal returns (bytes32 requestId) {
        vm.warp(v.requestTimestamp);
        vm.prank(v.requester);
        requestId = coordinator.request(v.tag);
    }

    /// Registers the key and makes every vector's request, in file order.
    function requestAll() internal {
        registerGoldenKey();
        for (uint256 i; i < count; i++) {
            requestAs(vector(i));
        }
    }

    function fulfillAs(address who, RequestVector memory v) internal {
        vm.roll(block.number + 12);
        vm.prank(who, who);
        coordinator.fulfill(v.requestId, v.proof, v.drandSignature);
    }

    // -------------------------------------------------------------- tracer

    function test_RequestFulfillDeriveMatchesGoldenVectors() public {
        registerGoldenKey();
        for (uint256 i; i < count; i++) {
            RequestVector memory v = vector(i);

            vm.expectEmit(address(coordinator));
            emit VRFCoordinator.RandomnessRequested(
                v.requestId,
                v.requester,
                v.tag,
                1,
                v.targetRound,
                uint48(block.number),
                uint48(block.number + 1200),
                0,
                0
            );
            assertEq(requestAs(v), v.requestId, string.concat(v.name, ": requestId"));

            vm.expectEmit(address(coordinator));
            emit VRFCoordinator.Fulfilled(v.requestId, v.beta, fulfiller);
            fulfillAs(fulfiller, v);

            VRFCoordinator.Request memory r = coordinator.getRequest(v.requestId);
            assertEq(uint8(r.status), uint8(VRFCoordinator.Status.Fulfilled), string.concat(v.name, ": status"));
            assertEq(r.beta, v.beta, string.concat(v.name, ": beta"));
            assertEq(r.requester, v.requester, string.concat(v.name, ": requester"));
            assertEq(r.targetRound, v.targetRound, string.concat(v.name, ": targetRound"));

            for (uint256 j; j < v.derivations.length; j++) {
                Derivation memory d = v.derivations[j];
                assertEq(coordinator.deriveRandomBytes(v.requestId, d.context), d.randomBytes, v.name);
                assertEq(coordinator.deriveRandom(v.requestId, d.context), d.random, v.name);
            }
        }
    }

    // ------------------------------------------------------------- fulfill

    function test_FulfillIgnoresProofSeed() public {
        requestAll();
        RequestVector memory v = vector(0);
        v.proof.seed = uint256(keccak256("not the alpha"));
        fulfillAs(fulfiller, v);
        assertEq(coordinator.getRequest(v.requestId).beta, v.beta);
    }

    function test_FulfillRejectsProofOverDifferentAlpha() public {
        requestAll();
        RequestVector memory v = vector(0);
        // A valid proof under the same key, but over another request's Alpha.
        v.proof = vector(1).proof;
        vm.expectRevert(bytes("Second mul check failed"));
        fulfillAs(fulfiller, v);
    }

    function test_FulfillRejectsTamperedProof() public {
        requestAll();
        RequestVector memory v = vector(0);
        v.proof.c ^= 1;
        vm.expectRevert(bytes("addr(c*pk+s*g)!=_uWitness"));
        fulfillAs(fulfiller, v);
    }

    function test_FulfillRejectsUnknownRequest() public {
        registerGoldenKey();
        vm.expectRevert(VRFCoordinator.UnknownRequest.selector);
        fulfillAs(fulfiller, vector(0));
    }

    function test_FulfillRejectsRepeatedFulfill() public {
        requestAll();
        fulfillAs(fulfiller, vector(0));
        vm.expectRevert(
            abi.encodeWithSelector(VRFCoordinator.RequestNotPending.selector, VRFCoordinator.Status.Fulfilled)
        );
        fulfillAs(fulfiller, vector(0));
    }

    function test_FulfillRejectsWrongProvingKey() public {
        requestAll();
        RequestVector memory v = vector(0);
        v.proof.pk[1] += 1;
        vm.expectRevert(VRFCoordinator.WrongProvingKey.selector);
        fulfillAs(fulfiller, v);
    }

    function test_FulfillRejectsDrandSignatureForAnotherRound() public {
        requestAll();
        RequestVector memory v = vector(0);
        v.drandSignature = vector(1).drandSignature;
        vm.expectRevert(VRFCoordinator.InvalidDrandSignature.selector);
        fulfillAs(fulfiller, v);
    }

    function test_FulfillRejectsMalformedDrandSignature() public {
        requestAll();
        RequestVector memory v = vector(0);
        v.drandSignature[1] += 1;
        vm.expectRevert(VRFCoordinator.InvalidDrandSignature.selector);
        fulfillAs(fulfiller, v);
    }

    function test_FulfillRejectsContractCaller() public {
        requestAll();
        RequestVector memory v = vector(0);
        vm.prank(fulfiller); // tx.origin stays the default sender
        vm.expectRevert(VRFCoordinator.FulfillerNotEOA.selector);
        coordinator.fulfill(v.requestId, v.proof, v.drandSignature);
    }

    // ------------------------------------------------------------- request

    function test_RequestBeforeDrandGenesisRejectsWithDomainError() public {
        registerGoldenKey();
        vm.warp(drandGenesis() - 1);
        // The 12-byte parameter label fits in bytes32.
        // forge-lint: disable-next-line(unsafe-typecast)
        vm.expectRevert(abi.encodeWithSelector(VRFCoordinator.ValueOutOfBounds.selector, bytes32("drandGenesis")));
        coordinator.request(bytes32(0));
    }

    function test_RequestAtDrandGenesisBindsFutureRound() public {
        registerGoldenKey();
        vm.warp(drandGenesis());
        bytes32 requestId = coordinator.request(bytes32(0));
        assertEq(coordinator.getRequest(requestId).targetRound, 41);
    }

    function test_RequestRequiresAnActiveKey() public {
        vm.expectRevert(VRFCoordinator.NoActiveKey.selector);
        requestAs(vector(0));
    }

    // --------------------------------------------------------------- reads

    function test_DeriveRevertsForUnknownRequest() public {
        bytes32 requestId = vector(0).requestId;
        vm.expectRevert(VRFCoordinator.UnknownRequest.selector);
        coordinator.deriveRandomBytes(requestId, bytes32(0));
        vm.expectRevert(VRFCoordinator.UnknownRequest.selector);
        coordinator.deriveRandom(requestId, bytes32(0));
    }

    function test_DeriveRevertsForPendingRequest() public {
        requestAll();
        bytes32 requestId = vector(0).requestId;
        vm.expectRevert(VRFCoordinator.RequestPending.selector);
        coordinator.deriveRandomBytes(requestId, bytes32(0));
        vm.expectRevert(VRFCoordinator.RequestPending.selector);
        coordinator.deriveRandom(requestId, bytes32(0));
    }

    function test_DeriveRevertsForRefundedRequest() public {
        requestAll();
        bytes32 requestId = vector(0).requestId;
        // Refunds land in a later slice; set the status byte (bits 160..167) directly.
        bytes32 slot = keccak256(abi.encode(requestId, STORAGE_LOCATION));
        uint256 word = uint256(vm.load(address(coordinator), slot));
        word = (word & ~(uint256(0xff) << 160)) | (uint256(uint8(VRFCoordinator.Status.Refunded)) << 160);
        vm.store(address(coordinator), slot, bytes32(word));
        assertEq(uint8(coordinator.getRequest(requestId).status), uint8(VRFCoordinator.Status.Refunded));

        vm.expectRevert(VRFCoordinator.RequestRefunded.selector);
        coordinator.deriveRandomBytes(requestId, bytes32(0));
    }

    // --------------------------------------------------------------- admin

    function test_RegisteringAKeyDrainsThePreviousOne() public {
        registerGoldenKey();
        // Any other point on the curve: the secp256k1 generator.
        uint256[2] memory other = [
            0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
            0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
        ];
        vm.prank(owner);
        coordinator.registerProvingKey(other, payee);
        assertEq(coordinator.activeKeyId(), 2);
        assertEq(uint8(coordinator.getProvingKey(1).state), uint8(VRFCoordinator.KeyState.Draining));
        assertEq(uint8(coordinator.getProvingKey(2).state), uint8(VRFCoordinator.KeyState.Active));
    }

    function test_RegisterProvingKeyRejectsDuplicatesAndOffCurvePoints() public {
        registerGoldenKey();
        uint256[2] memory pk = vector(0).proof.pk;
        vm.startPrank(owner);
        vm.expectRevert(VRFCoordinator.KeyAlreadyRegistered.selector);
        coordinator.registerProvingKey(pk, payee);
        pk[1] += 1;
        vm.expectRevert(VRFCoordinator.InvalidProvingKey.selector);
        coordinator.registerProvingKey(pk, payee);
        vm.stopPrank();
    }

    function test_OnlyOwnerRegistersKeysAndUpgrades() public {
        address stranger = makeAddr("stranger");
        uint256[2] memory pk = vector(0).proof.pk;
        address next = address(new VRFCoordinator());

        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        coordinator.registerProvingKey(pk, payee);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        coordinator.upgradeToAndCall(next, "");
        vm.stopPrank();

        vm.prank(owner);
        coordinator.upgradeToAndCall(next, "");
        assertEq(address(uint160(uint256(vm.load(address(coordinator), IMPLEMENTATION_SLOT)))), next);
    }

    function test_ImplementationCannotBeInitialized() public {
        VRFCoordinator implementation = new VRFCoordinator();
        VRFCoordinator.DrandConfig memory drand = coordinator.getDrandConfig(0);
        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        implementation.initialize(owner, drand);
    }
}
