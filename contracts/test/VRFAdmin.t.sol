// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VRFCoordinator} from "../src/VRFCoordinator.sol";
import {CoordinatorVectorFixture} from "./VRFCoordinator.t.sol";

contract RevertingRequester {
    function onRandomness(bytes32, bytes32) external pure {
        revert("callback rejected");
    }
}

contract RecordingRequester {
    bytes32 public beta;
    uint256 public entryGas;

    function onRandomness(bytes32, bytes32 value) external {
        entryGas = gasleft();
        beta = value;
    }
}

contract VRFAdminTest is CoordinatorVectorFixture {
    VRFCoordinator internal coordinator;
    address internal owner = makeAddr("admin");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        loadVectors();
        RequestVector memory v = vector(0);
        vm.chainId(v.chainId);
        bytes memory init = abi.encodeCall(
            VRFCoordinator.initialize,
            (owner, VRFCoordinator.DrandConfig(drandPublicKey(), drandGenesis(), drandPeriod()))
        );
        deployCodeTo("ERC1967Proxy.sol:ERC1967Proxy", abi.encode(address(new VRFCoordinator()), init), v.coordinator);
        coordinator = VRFCoordinator(v.coordinator);
        vm.warp(v.requestTimestamp);
    }

    function assertSetter(string memory setter, string memory getter, bytes32 param, uint256 minimum, uint256 maximum)
        internal
    {
        bytes4 selector = bytes4(keccak256(bytes(setter)));
        vm.startPrank(owner);
        (bool success,) = address(coordinator).call(abi.encodeWithSelector(selector, minimum));
        assertTrue(success, "lower bound accepted");
        (bool readSuccess, bytes memory result) = address(coordinator).staticcall(abi.encodeWithSignature(getter));
        assertTrue(readSuccess);
        assertEq(abi.decode(result, (uint256)), minimum);
        (success,) = address(coordinator).call(abi.encodeWithSelector(selector, maximum));
        assertTrue(success, "upper bound accepted");
        (success, result) = address(coordinator).staticcall(abi.encodeWithSignature(getter));
        assertTrue(success);
        assertEq(abi.decode(result, (uint256)), maximum);
        if (minimum > 0) {
            (success, result) = address(coordinator).call(abi.encodeWithSelector(selector, minimum - 1));
            assertFalse(success);
            assertEq(result, abi.encodeWithSelector(VRFCoordinator.ValueOutOfBounds.selector, param));
        }
        (success, result) = address(coordinator).call(abi.encodeWithSelector(selector, maximum + 1));
        assertFalse(success);
        assertEq(result, abi.encodeWithSelector(VRFCoordinator.ValueOutOfBounds.selector, param));
        vm.stopPrank();
        vm.prank(stranger);
        (success, result) = address(coordinator).call(abi.encodeWithSelector(selector, minimum));
        assertFalse(success);
        assertEq(result, abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
    }

    function test_FeeBoundsAndOwnerAuthorization() public {
        assertSetter("setFeeConfig(uint256)", "fee()", "fee", 0, type(uint96).max);
    }

    function test_CallbackGasCapBoundsAndOwnerAuthorization() public {
        assertSetter("setCallbackGasCap(uint256)", "callbackGasCap()", "callbackGasCap", 25_000, 2_500_000);
    }

    function test_RoundOffsetBoundsAndOwnerAuthorization() public {
        assertSetter("setRoundOffset(uint256)", "roundOffset()", "roundOffset", 40, type(uint64).max);
    }

    function test_TimeoutBlocksBoundsAndOwnerAuthorization() public {
        assertSetter("setTimeoutBlocks(uint256)", "timeoutBlocks()", "timeoutBlocks", 600, 2400);
    }

    function test_ConfirmationsBoundsAndOwnerAuthorization() public {
        assertSetter("setConfirmations(uint256)", "confirmations()", "confirmations", 6, 100);
    }

    function test_RequestFreezesFeeAndNewRequestUsesChangedFee() public {
        vm.prank(owner);
        coordinator.registerProvingKey(vector(0).proof.pk, owner);
        vm.deal(address(this), 1 ether);
        (bool success, bytes memory result) =
            address(coordinator).call{value: 2e13}(abi.encodeCall(VRFCoordinator.request, (bytes32("old"))));
        assertTrue(success, "request accepts exact configured fee");
        bytes32 id = abi.decode(result, (bytes32));
        assertEq(coordinator.getRequest(id).fee, 2e13);
        vm.prank(owner);
        coordinator.setFeeConfig(123);
        assertEq(coordinator.getRequest(id).fee, 2e13);
        (success, result) =
            address(coordinator).call{value: 123}(abi.encodeCall(VRFCoordinator.request, (bytes32("new"))));
        assertTrue(success);
        assertEq(coordinator.getRequest(abi.decode(result, (bytes32))).fee, 123);
    }

    function test_DrandConfigsAreAppendOnlyAndOldRequestStillFulfills() public {
        RequestVector memory v = vector(0);
        vm.startPrank(owner);
        coordinator.registerProvingKey(v.proof.pk, owner);
        coordinator.setFeeConfig(0);
        vm.stopPrank();
        vm.prank(v.requester);
        coordinator.request(v.tag);
        VRFCoordinator.DrandConfig memory other = coordinator.getDrandConfig(0);
        // Negating a valid G2 point gives a different valid public key.
        uint256 field = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
        other.publicKey[2] = field - other.publicKey[2];
        other.publicKey[3] = field - other.publicKey[3];
        other.period = 6;
        vm.prank(owner);
        (bool success, bytes memory result) =
            address(coordinator).call(abi.encodeWithSignature("addDrandConfig((uint256[4],uint64,uint64))", other));
        assertTrue(success, "append drand config");
        assertEq(abi.decode(result, (uint8)), 1);
        assertEq(coordinator.getDrandConfig(0).period, 3);
        assertEq(coordinator.getRequest(v.requestId).drandConfigId, 0);
        bytes32 later = coordinator.request(bytes32("new config"));
        assertEq(coordinator.getRequest(later).drandConfigId, 1);
        vm.roll(block.number + 12);
        vm.prank(stranger, stranger);
        coordinator.fulfill(v.requestId, v.proof, v.drandSignature);
        assertEq(coordinator.getRequest(v.requestId).beta, v.beta);
    }

    function test_ConfirmationsAreEnforcedFromFrozenRequest() public {
        RequestVector memory v = vector(0);
        vm.startPrank(owner);
        coordinator.registerProvingKey(v.proof.pk, owner);
        coordinator.setFeeConfig(0);
        vm.stopPrank();
        vm.prank(v.requester);
        coordinator.request(v.tag);
        vm.prank(owner);
        coordinator.setConfirmations(6);
        vm.roll(block.number + 6);
        vm.prank(stranger, stranger);
        vm.expectRevert(VRFCoordinator.TooEarly.selector);
        coordinator.fulfill(v.requestId, v.proof, v.drandSignature);
        vm.roll(block.number + 6);
        vm.prank(stranger, stranger);
        coordinator.fulfill(v.requestId, v.proof, v.drandSignature);
        assertEq(coordinator.getRequest(v.requestId).beta, v.beta);
    }

    function test_CallbackCapIsFrozenAndCallbackRunsAfterAdminChange() public {
        RequestVector memory v = vector(0);
        vm.etch(v.requester, address(new RecordingRequester()).code);
        vm.startPrank(owner);
        coordinator.registerProvingKey(v.proof.pk, owner);
        coordinator.setFeeConfig(0);
        vm.stopPrank();
        vm.prank(v.requester);
        coordinator.requestWithCallback(v.tag);
        vm.prank(owner);
        coordinator.setCallbackGasCap(25_000);
        assertEq(coordinator.getRequest(v.requestId).callbackGasCap, 200_000);
        vm.prank(v.requester);
        bytes32 later = coordinator.requestWithCallback(bytes32("new cap"));
        assertEq(coordinator.getRequest(later).callbackGasCap, 25_000);
        vm.roll(block.number + 12);
        vm.prank(stranger, stranger);
        coordinator.fulfill(v.requestId, v.proof, v.drandSignature);
        assertEq(RecordingRequester(v.requester).beta(), v.beta);
        assertGt(RecordingRequester(v.requester).entryGas(), 199_000);
        assertLe(RecordingRequester(v.requester).entryGas(), 200_000);
    }

    function test_InitialParametersMatchSpec() public view {
        assertEq(coordinator.fee(), 2e13);
        assertEq(coordinator.callbackGasCap(), 200_000);
        assertEq(coordinator.roundOffset(), 40);
        assertEq(coordinator.timeoutBlocks(), 1200);
        assertEq(coordinator.confirmations(), 12);
        assertEq(coordinator.drandConfigCount(), 1);
    }

    function test_EachSetterEmitsItsEvent() public {
        vm.startPrank(owner);
        vm.expectEmit(address(coordinator));
        emit VRFCoordinator.FeeConfigChanged(123);
        coordinator.setFeeConfig(123);
        vm.expectEmit(address(coordinator));
        emit VRFCoordinator.CallbackGasCapChanged(25_000);
        coordinator.setCallbackGasCap(25_000);
        vm.expectEmit(address(coordinator));
        emit VRFCoordinator.RoundOffsetChanged(80);
        coordinator.setRoundOffset(80);
        vm.expectEmit(address(coordinator));
        emit VRFCoordinator.TimeoutBlocksChanged(600);
        coordinator.setTimeoutBlocks(600);
        vm.expectEmit(address(coordinator));
        emit VRFCoordinator.ConfirmationsChanged(6);
        coordinator.setConfirmations(6);
        vm.stopPrank();
    }

    function test_OffsetTimeoutAndConfirmationsAreFrozenForOpenRequests() public {
        vm.startPrank(owner);
        coordinator.registerProvingKey(vector(0).proof.pk, owner);
        coordinator.setFeeConfig(0);
        vm.stopPrank();
        bytes32 oldId = coordinator.request(bytes32("before"));
        VRFCoordinator.Request memory before = coordinator.getRequest(oldId);
        vm.startPrank(owner);
        coordinator.setRoundOffset(80);
        coordinator.setTimeoutBlocks(600);
        coordinator.setConfirmations(6);
        vm.stopPrank();
        VRFCoordinator.Request memory unchanged = coordinator.getRequest(oldId);
        assertEq(unchanged.targetRound, before.targetRound);
        assertEq(unchanged.deadline, before.deadline);
        assertEq(unchanged.confirmations, 12);
        bytes32 newId = coordinator.request(bytes32("after"));
        VRFCoordinator.Request memory changed = coordinator.getRequest(newId);
        assertEq(changed.targetRound, before.targetRound + 40);
        assertEq(changed.deadline, before.deadline - 600);
        assertEq(changed.confirmations, 6);
        assertEq(changed.callbackGasCap, 0, "plain requests never enable callbacks");
    }

    function test_DeadlineIsEnforcedFromFrozenRequest() public {
        RequestVector memory v = vector(0);
        vm.startPrank(owner);
        coordinator.registerProvingKey(v.proof.pk, owner);
        coordinator.setFeeConfig(0);
        vm.stopPrank();
        vm.prank(v.requester);
        coordinator.request(v.tag);
        vm.prank(owner);
        coordinator.setTimeoutBlocks(2400);
        vm.roll(block.number + 1201);
        vm.prank(stranger, stranger);
        vm.expectRevert(VRFCoordinator.DeadlinePassed.selector);
        coordinator.fulfill(v.requestId, v.proof, v.drandSignature);
    }

    function test_ExactFeeRequiredAndCallbackRequesterMustHaveCode() public {
        vm.prank(owner);
        coordinator.registerProvingKey(vector(0).proof.pk, owner);
        vm.expectRevert(abi.encodeWithSelector(VRFCoordinator.IncorrectFee.selector, 2e13, 0));
        coordinator.request(bytes32(0));
        vm.prank(stranger);
        vm.expectRevert(VRFCoordinator.RequesterHasNoCode.selector);
        coordinator.requestWithCallback(bytes32(0));
        assertEq(coordinator.requesterNonce(stranger), 0);
    }

    function test_TargetRoundOverflowRevertsRatherThanTruncates() public {
        vm.startPrank(owner);
        coordinator.registerProvingKey(vector(0).proof.pk, owner);
        coordinator.setFeeConfig(0);
        coordinator.setRoundOffset(type(uint64).max);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(VRFCoordinator.ValueOutOfBounds.selector, bytes32("targetRound")));
        coordinator.request(bytes32(0));
    }

    function test_DrandConfigValidationAndEvent() public {
        VRFCoordinator.DrandConfig memory config = coordinator.getDrandConfig(0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        coordinator.addDrandConfig(config);
        vm.startPrank(owner);
        config.period = 0;
        vm.expectRevert(abi.encodeWithSelector(VRFCoordinator.ValueOutOfBounds.selector, bytes32("drandConfig")));
        coordinator.addDrandConfig(config);
        config.period = 3;
        config.publicKey[0] += 1;
        vm.expectRevert(abi.encodeWithSelector(VRFCoordinator.ValueOutOfBounds.selector, bytes32("drandConfig")));
        coordinator.addDrandConfig(config);
        config = coordinator.getDrandConfig(0);
        vm.expectEmit(address(coordinator));
        emit VRFCoordinator.DrandConfigAdded(1, config.publicKey, config.genesis, config.period);
        assertEq(coordinator.addDrandConfig(config), 1);
        assertEq(coordinator.drandConfigCount(), 2);
        vm.stopPrank();
    }

    function test_DrandConfigIdsNeverWrap() public {
        VRFCoordinator.DrandConfig memory config = coordinator.getDrandConfig(0);
        vm.startPrank(owner);
        for (uint256 i = 1; i < 256; i++) {
            assertEq(coordinator.addDrandConfig(config), i);
        }
        vm.expectRevert(abi.encodeWithSelector(VRFCoordinator.ValueOutOfBounds.selector, bytes32("drandConfigCount")));
        coordinator.addDrandConfig(config);
        assertEq(coordinator.drandConfigCount(), 256);
        assertEq(coordinator.getDrandConfig(0).period, 3);
        vm.stopPrank();
    }

    function test_CallbackRevertDoesNotRejectBeta() public {
        RequestVector memory v = vector(0);
        vm.etch(v.requester, address(new RevertingRequester()).code);
        vm.startPrank(owner);
        coordinator.registerProvingKey(v.proof.pk, owner);
        coordinator.setFeeConfig(0);
        vm.stopPrank();
        vm.prank(v.requester);
        coordinator.requestWithCallback(v.tag);
        vm.roll(block.number + 12);
        vm.expectEmit(address(coordinator));
        emit VRFCoordinator.CallbackFailed(v.requestId);
        vm.prank(stranger, stranger);
        coordinator.fulfill(v.requestId, v.proof, v.drandSignature);
        assertEq(coordinator.getRequest(v.requestId).beta, v.beta);
        assertEq(uint8(coordinator.getRequest(v.requestId).status), uint8(VRFCoordinator.Status.Fulfilled));
    }

    function test_InsufficientGasDoesNotConsumeCallbackRequest() public {
        RequestVector memory v = vector(0);
        vm.etch(v.requester, address(new RecordingRequester()).code);
        vm.startPrank(owner);
        coordinator.registerProvingKey(v.proof.pk, owner);
        coordinator.setFeeConfig(0);
        coordinator.setCallbackGasCap(2_500_000);
        vm.stopPrank();
        vm.prank(v.requester);
        coordinator.requestWithCallback(v.tag);
        vm.roll(block.number + 12);
        vm.prank(stranger, stranger);
        vm.expectRevert(VRFCoordinator.InsufficientGasForCallback.selector);
        coordinator.fulfill{gas: 1_000_000}(v.requestId, v.proof, v.drandSignature);
        assertEq(uint8(coordinator.getRequest(v.requestId).status), uint8(VRFCoordinator.Status.Pending));
        assertEq(coordinator.getRequest(v.requestId).beta, bytes32(0));
        vm.prank(stranger, stranger);
        coordinator.fulfill(v.requestId, v.proof, v.drandSignature);
        assertEq(RecordingRequester(v.requester).beta(), v.beta);
    }

    function test_AdminMigrationCannotResetNewDeploymentOrBeCalledByStranger() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        coordinator.initializeAdminParameters();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VRFCoordinator.ValueOutOfBounds.selector, bytes32("adminInitialized")));
        coordinator.initializeAdminParameters();
        assertEq(coordinator.fee(), 2e13);
    }

    function test_MaxCallbackCapIsFullyForwardedWithAmpleFulfillGas() public {
        RequestVector memory v = vector(0);
        vm.etch(v.requester, address(new RecordingRequester()).code);
        vm.startPrank(owner);
        coordinator.registerProvingKey(v.proof.pk, owner);
        coordinator.setFeeConfig(0);
        coordinator.setCallbackGasCap(2_500_000);
        vm.stopPrank();
        vm.prank(v.requester);
        coordinator.requestWithCallback(v.tag);
        vm.roll(block.number + 12);
        // Foundry applies EIP-150, unlike Rootstock. The rskj integration suite
        // checks full-cap forwarding at the minimum accepted transaction gas.
        vm.prank(stranger, stranger);
        coordinator.fulfill{gas: 4_000_000}(v.requestId, v.proof, v.drandSignature);
        assertEq(RecordingRequester(v.requester).beta(), v.beta);
        assertGt(RecordingRequester(v.requester).entryGas(), 2_499_000);
        assertLe(RecordingRequester(v.requester).entryGas(), 2_500_000);
    }
}
