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
}
