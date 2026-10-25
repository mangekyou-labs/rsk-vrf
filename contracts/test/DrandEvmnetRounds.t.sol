// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {DrandRoundsHarness} from "./harness/DrandRoundsHarness.sol";

/// Rounds 1 through 300 from the evmnet beacon, with sha256 digests from Python hashlib.
contract DrandEvmnetRoundsTest is Test {
    string internal constant FIXTURE = "./test/fixtures/evmnet-rounds.json";
    string internal constant CHAIN_HASH = "04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3";

    DrandRoundsHarness internal drand;
    string internal json;
    // [x.im, x.re, y.im, y.re]. See evmnetPublicKey.
    uint256[4] internal publicKey;

    struct Round {
        uint64 round;
        uint256[2] signature;
        bytes32 randomness;
    }

    function setUp() public {
        drand = new DrandRoundsHarness();
        // Reads only the fixture, which foundry.toml's fs_permissions allows.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        json = vm.readFile(FIXTURE);
        publicKey = evmnetPublicKey();
    }

    function test_FixtureIsThePinnedEvmnetBeacon() public view {
        assertEq(vm.parseJsonString(json, ".dst"), string(drand.dst()));
        assertEq(vm.parseJsonString(json, ".chainHash"), CHAIN_HASH);
        assertEq(roundCount(), 300);
        assertEq(roundAt(0).round, 1);
        assertEq(roundAt(299).round, 300);
    }

    function test_EveryRoundVerifiesAndMatchesPythonRandomness() public view {
        uint256 n = roundCount();
        assertEq(n, 300, "round count");
        for (uint256 i; i < n; i++) {
            Round memory got = roundAt(i);
            assertEq(got.round, uint64(i + 1), "rounds are 1 through 300 with no gaps");
            string memory label = string.concat("round ", vm.toString(got.round));
            assertTrue(drand.verify(publicKey, got.round, got.signature), label);
            assertEq(drand.randomness(got.signature), got.randomness, label);
        }
    }

    /// The beacon publishes the G2 key as 128 bytes, four big-endian words.
    /// Wire order [x.re, x.im, y.re, y.im] is not on the G2 twist, so verify is false.
    /// Swapped Fp2 limbs [x.im, x.re, y.im, y.re] are on the curve and verify.
    function evmnetPublicKey() internal view returns (uint256[4] memory key) {
        bytes memory raw = vm.parseBytes(string.concat("0x", vm.parseJsonString(json, ".publicKey")));
        require(raw.length == 128, "public key length");
        uint256 w0 = word(raw, 0);
        uint256 w1 = word(raw, 32);
        uint256 w2 = word(raw, 64);
        uint256 w3 = word(raw, 96);
        key = [w1, w0, w3, w2];
    }

    function roundCount() internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(".rounds[", vm.toString(n), "]"))) {
            n++;
        }
    }

    function roundAt(uint256 i) internal view returns (Round memory got) {
        string memory at = string.concat(".rounds[", vm.toString(i), "]");
        got.round = uint64(vm.parseJsonUint(json, string.concat(at, ".round")));
        bytes memory signature =
            vm.parseBytes(string.concat("0x", vm.parseJsonString(json, string.concat(at, ".signature"))));
        require(signature.length == 64, "signature length");
        got.signature = [word(signature, 0), word(signature, 32)];
        got.randomness =
            vm.parseBytes32(string.concat("0x", vm.parseJsonString(json, string.concat(at, ".randomness"))));
    }

    function word(bytes memory raw, uint256 offset) private pure returns (uint256 w) {
        for (uint256 i; i < 32; i++) {
            w = (w << 8) | uint8(raw[offset + i]);
        }
    }
}
