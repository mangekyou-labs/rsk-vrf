// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {ChainlinkVRFProbe} from "../src/probes/ChainlinkVRFProbe.sol";
import {EcvrfRskip516Probe} from "../src/probes/EcvrfRskip516Probe.sol";
import {DrandEvmnetProbe} from "../src/probes/DrandEvmnetProbe.sol";
import {Secp256k1PrecompileMock} from "./mocks/Secp256k1PrecompileMock.sol";
import {Vectors as V} from "../src/Vectors.sol";

/// Correctness checks for the probes. Gas numbers printed here are revm/forge numbers
/// (Ethereum gas schedule); Rootstock numbers come from scripts/measure_rsk.py over RPC.
contract ProbesTest is Test {
    function _read(address a) internal view returns (bool ok, uint256 used, bytes32 out) {
        return abi.decode(a.code, (bool, uint256, bytes32));
    }

    function test_chainlink_valid() public {
        (bool ok, uint256 used, bytes32 out) = _read(address(new ChainlinkVRFProbe(0)));
        assertTrue(ok);
        assertEq(uint256(out), V.CL_OUTPUT);
        console2.log("forge chainlink verify gas", used);
    }

    function test_chainlink_tampered_s_reverts() public {
        vm.expectRevert();
        new ChainlinkVRFProbe(1);
    }

    function test_chainlink_tampered_seed_reverts() public {
        vm.expectRevert();
        new ChainlinkVRFProbe(2);
    }

    function _etchSecp() internal {
        vm.etch(address(0x01000016), address(new Secp256k1PrecompileMock(false)).code);
        vm.etch(address(0x01000017), address(new Secp256k1PrecompileMock(true)).code);
    }

    function test_ecvrf_rskip516_valid_with_mock() public {
        _etchSecp();
        (bool ok, uint256 used, bytes32 beta) = _read(address(new EcvrfRskip516Probe(0)));
        assertTrue(ok);
        assertEq(beta, V.EC_BETA);
        console2.log("forge ecvrf gas (MOCK precompile, not meaningful)", used);
    }

    function test_ecvrf_rskip516_negatives_with_mock() public {
        _etchSecp();
        for (uint256 m = 1; m <= 3; m++) {
            (bool ok,,) = _read(address(new EcvrfRskip516Probe(m)));
            assertFalse(ok);
        }
    }

    function test_drand_valid() public {
        (bool ok, uint256 used, bytes32 rnd) = _read(address(new DrandEvmnetProbe(0)));
        assertTrue(ok);
        assertEq(rnd, V.DR_RANDOMNESS);
        console2.log("forge drand verify gas", used);
    }

    function test_drand_negatives() public {
        for (uint256 m = 1; m <= 2; m++) {
            (bool ok,,) = _read(address(new DrandEvmnetProbe(m)));
            assertFalse(ok);
        }
        (bool ok4,,) = _read(address(new DrandEvmnetProbe(4)));
        assertFalse(ok4);
    }

    function test_drand_hash_to_g1() public {
        (bool ok, uint256 used,) = _read(address(new DrandEvmnetProbe(3)));
        assertTrue(ok);
        console2.log("forge drand hash-to-G1 gas", used);
    }

    function test_witnet() public {
        for (uint256 m = 0; m < 4; m++) {
            address a = deployCode("WitnetVRFProbe.sol:WitnetVRFProbe", abi.encode(m));
            (bool ok, uint256 used,) = _read(a);
            assertEq(ok, m < 2);
            console2.log("forge witnet mode/gas", m, used);
        }
    }
}
