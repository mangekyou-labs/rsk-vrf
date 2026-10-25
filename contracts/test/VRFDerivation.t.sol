// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VRFCoordinatorTest} from "./VRFCoordinator.t.sol";
import {VRFCoordinator} from "../src/VRFCoordinator.sol";

contract VRFDerivationTest is VRFCoordinatorTest {
    function test_RangeReadsOnlyFulfilledBeta() public {
        RequestVector memory v = vector(0);
        vm.expectRevert(VRFCoordinator.UnknownRequest.selector);
        coordinator.deriveRandomInRange(v.requestId, bytes32(0), 1, 6);
        registerGoldenKey();
        requestAs(v);
        vm.expectRevert(VRFCoordinator.RequestPending.selector);
        coordinator.deriveRandomInRange(v.requestId, bytes32(0), 1, 6);
        vm.roll(coordinator.getRequest(v.requestId).deadline + 1);
        coordinator.timeoutRefund(v.requestId);
        vm.expectRevert(VRFCoordinator.RequestRefunded.selector);
        coordinator.deriveRandomInRange(v.requestId, bytes32(0), 1, 6);
    }

    function testFuzz_InclusiveRangeStaysInsideBounds(uint256 min, uint256 max, bytes32 context) public {
        vm.assume(min <= max);
        requestAll();
        RequestVector memory v = vector(0);
        fulfillAs(fulfiller, v);
        uint256 result = coordinator.deriveRandomInRange(v.requestId, context, min, max);
        assertGe(result, min);
        assertLe(result, max);
    }

    function test_RangesMatchGoGoldenVectorsIncludingRejection() public {
        requestAll();
        bool rejected;
        for (uint256 i; i < count; i++) {
            RequestVector memory v = vector(i);
            fulfillAs(fulfiller, v);
            for (uint256 j; j < v.derivations.length; j++) {
                for (uint256 k; k < 5; k++) {
                    string memory at = string.concat(
                        ".vectors[", vm.toString(i), "].derivations[", vm.toString(j), "].ranges[", vm.toString(k), "]"
                    );
                    uint256 min = vm.parseJsonUint(json, string.concat(at, ".min"));
                    uint256 max = vm.parseJsonUint(json, string.concat(at, ".max"));
                    uint256 expected = vm.parseJsonUint(json, string.concat(at, ".random"));
                    if (vm.parseJsonUint(json, string.concat(at, ".counter")) > 0) rejected = true;
                    assertEq(
                        coordinator.deriveRandomInRange(v.requestId, v.derivations[j].context, min, max), expected, at
                    );
                }
            }
        }
        assertTrue(rejected, "golden vectors exercise rejection sampling");
    }

    function test_FullRangeReturnsGoldenDerivedWord() public {
        requestAll();
        RequestVector memory v = vector(0);
        fulfillAs(fulfiller, v);
        assertEq(
            coordinator.deriveRandomInRange(v.requestId, v.derivations[0].context, 0, type(uint256).max),
            v.derivations[0].random
        );
    }

    function test_RangeRejectsReversedBounds() public {
        requestAll();
        RequestVector memory v = vector(0);
        fulfillAs(fulfiller, v);
        vm.expectRevert(bytes4(keccak256("InvalidRange()")));
        coordinator.deriveRandomInRange(v.requestId, bytes32(0), 2, 1);
    }
}
