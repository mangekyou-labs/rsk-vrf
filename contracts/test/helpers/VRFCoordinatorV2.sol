// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VRFCoordinator} from "../../src/VRFCoordinator.sol";

/// @dev Test-only upgrade target: inherited storage and behavior stay intact while
///      the proxy exposes a new public function to prove the upgrade took effect.
contract VRFCoordinatorV2 is VRFCoordinator {
    function revision() external pure returns (uint256) {
        return 2;
    }
}
