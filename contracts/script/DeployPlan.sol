// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VRFCoordinator} from "../src/VRFCoordinator.sol";

/// @title DeployPlan
/// @notice The chain 31 configuration from issue #24, shared by the deploy and check scripts.
library DeployPlan {
    uint96 internal constant FEE = 2e13;
    uint32 internal constant CALLBACK_GAS_CAP = 200_000;
    uint64 internal constant ROUND_OFFSET = 40;
    uint48 internal constant TIMEOUT_BLOCKS = 1200;
    uint16 internal constant CONFIRMATIONS = 12;

    /// @notice The drand `evmnet` beacon, from api.drand.sh/v2/beacons/evmnet/info.
    string internal constant DRAND_BEACON = "evmnet";
    bytes32 internal constant DRAND_CHAIN_HASH = 0x04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3;
    uint64 internal constant DRAND_GENESIS = 1727521075;
    uint64 internal constant DRAND_PERIOD = 3;

    /// @dev The beacon publishes Kyber words [x.im, x.re, y.im, y.re]; this is BLS.sol's
    ///   [x.re, x.im, y.re, y.im].
    function drand() internal pure returns (VRFCoordinator.DrandConfig memory) {
        return VRFCoordinator.DrandConfig({
            publicKey: [
                0x0557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808f,
                0x07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382,
                0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0b,
                0x0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6
            ],
            genesis: DRAND_GENESIS,
            period: DRAND_PERIOD
        });
    }
}
