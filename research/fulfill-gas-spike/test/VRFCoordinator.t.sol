// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VRF} from "../src/vendor/chainlink/VRF.sol";
import {VRFCoordinator} from "../src/VRFCoordinator.sol";
import {DrandEvmnet} from "../src/DrandEvmnet.sol";
import {Consumer, Burner} from "../src/Harness.sol";
import {Vectors} from "../src/Vectors.sol";

/// Behaviour of the spike coordinator under Foundry's (Ethereum) gas schedule. Gas numbers that matter are
/// measured on Rootstock by scripts/measure_rsk.py, not here.
contract VRFCoordinatorTest is Test {
    uint96 constant FEE = 4e13;
    uint64 constant GENESIS = 1727521075;
    address constant FULFILLER = address(0xF00D);
    address constant PAYEE = address(0xBEEF);

    VRFCoordinator coord;
    Consumer consumer;

    function setUp() public {
        vm.chainId(31);
        // targetRound = (ts - genesis) / 3 + 1 + 40 == DR_ROUND, so the real request path lands on the vendored round.
        vm.warp(GENESIS + (uint256(Vectors.DR_ROUND) - 41) * 3);
        vm.roll(1_000_000);
        DrandEvmnet.Config memory drand = DrandEvmnet.Config({
            pk: [Vectors.DR_PK_1, Vectors.DR_PK_0, Vectors.DR_PK_3, Vectors.DR_PK_2],
            genesis: GENESIS,
            period: 3
        });
        VRFCoordinator impl = new VRFCoordinator(20_000);
        coord = VRFCoordinator(
            payable(address(new ERC1967Proxy(address(impl), abi.encodeCall(VRFCoordinator.initialize, (address(this), drand)))))
        );
        coord.setFeeConfig(FEE);
        coord.registerKey([Vectors.CL_PK_X, Vectors.CL_PK_Y], PAYEE);
        consumer = new Consumer(coord);
        vm.deal(address(this), 100 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _request(Consumer c) internal returns (bytes32 id) {
        id = c.doRequest{value: FEE}("tag");
        vm.roll(block.number + 12);
    }

    function _proof(bytes32 id) internal returns (VRF.Proof memory) {
        VRFCoordinator.Request memory r = coord.getRequest(id);
        uint256 alpha = uint256(
            keccak256(
                abi.encode(
                    keccak256("rsk-vrf/v1/alpha"),
                    uint256(31),
                    address(coord),
                    r.requester,
                    id,
                    r.targetRound,
                    Vectors.DR_RANDOMNESS
                )
            )
        );
        string[] memory cmd = new string[](4);
        cmd[0] = "python3";
        cmd[1] = "-I";
        cmd[2] = "scripts/prove.py";
        cmd[3] = vm.toString(bytes32(alpha));
        return abi.decode(vm.ffi(cmd), (VRF.Proof));
    }

    function _sig() internal pure returns (uint256[2] memory) {
        return [Vectors.DR_SIG_X, Vectors.DR_SIG_Y];
    }

    function _fulfill(bytes32 id, VRF.Proof memory p, uint256[2] memory sig) internal {
        vm.prank(FULFILLER, FULFILLER);
        coord.fulfill(id, p, sig);
    }

    // ------------------------------------------------------------------ request

    function test_request_derivesTargetRoundAndDeadline() public {
        bytes32 id = consumer.doRequest{value: FEE}("tag");
        VRFCoordinator.Request memory r = coord.getRequest(id);
        assertEq(r.targetRound, Vectors.DR_ROUND);
        assertEq(r.deadline, block.number + 1200);
        assertEq(r.callbackGasCap, 200_000);
        assertEq(uint8(r.status), uint8(VRFCoordinator.Status.Pending));
    }

    function test_request_rejectsWrongFee() public {
        vm.expectRevert(abi.encodeWithSelector(VRFCoordinator.IncorrectFee.selector, FEE, FEE - 1));
        consumer.doRequest{value: FEE - 1}("tag");
    }

    function test_requestWithCallback_rejectsCodelessRequester() public {
        vm.prank(address(0xCAFE));
        vm.deal(address(0xCAFE), 1 ether);
        vm.expectRevert(VRFCoordinator.RequesterHasNoCode.selector);
        coord.requestWithCallback{value: FEE}("tag");
    }

    function test_plainRequest_storesZeroCap() public {
        bytes32 id = coord.request{value: FEE}("tag");
        assertEq(coord.getRequest(id).callbackGasCap, 0);
    }

    // ------------------------------------------------------------------ fulfill

    function test_fulfill_deliversBetaAndCreditsPayee() public {
        bytes32 id = _request(consumer);
        _fulfill(id, _proof(id), _sig());
        VRFCoordinator.Request memory r = coord.getRequest(id);
        assertEq(uint8(r.status), uint8(VRFCoordinator.Status.Fulfilled));
        assertTrue(r.beta != bytes32(0));
        assertEq(consumer.betaOf(id), r.beta);
        assertEq(coord.payeeBalance(PAYEE), FEE);
    }

    function test_fulfill_burnerCallbackStillFulfills() public {
        Burner b = new Burner(coord);
        bytes32 id = _request(b);
        VRF.Proof memory p = _proof(id);
        vm.expectEmit(true, false, false, false, address(coord));
        emit VRFCoordinator.CallbackFailed(id);
        _fulfill(id, p, _sig());
        assertEq(uint8(coord.getRequest(id).status), uint8(VRFCoordinator.Status.Fulfilled));
    }

    function test_fulfill_rejectsContractCaller() public {
        bytes32 id = _request(consumer);
        VRF.Proof memory p = _proof(id);
        vm.expectRevert(VRFCoordinator.FulfillerNotEOA.selector);
        coord.fulfill(id, p, _sig());
    }

    function test_fulfill_rejectsUnknownAndNotPending() public {
        VRF.Proof memory p;
        vm.prank(FULFILLER, FULFILLER);
        vm.expectRevert(VRFCoordinator.UnknownRequest.selector);
        coord.fulfill(bytes32(uint256(1)), p, _sig());

        bytes32 id = _request(consumer);
        p = _proof(id);
        _fulfill(id, p, _sig());
        vm.prank(FULFILLER, FULFILLER);
        vm.expectRevert(abi.encodeWithSelector(VRFCoordinator.RequestNotPending.selector, VRFCoordinator.Status.Fulfilled));
        coord.fulfill(id, p, _sig());
    }

    function test_fulfill_rejectsTooEarlyAndAfterDeadline() public {
        bytes32 id = consumer.doRequest{value: FEE}("tag");
        VRF.Proof memory p = _proof(id);
        vm.roll(block.number + 11);
        vm.prank(FULFILLER, FULFILLER);
        vm.expectRevert(VRFCoordinator.TooEarly.selector);
        coord.fulfill(id, p, _sig());

        vm.roll(block.number + 1190);
        vm.prank(FULFILLER, FULFILLER);
        vm.expectRevert(VRFCoordinator.DeadlinePassed.selector);
        coord.fulfill(id, p, _sig());
    }

    function test_fulfill_rejectsWrongKeyBadDrandAndBadProof() public {
        bytes32 id = _request(consumer);
        VRF.Proof memory p = _proof(id);

        VRF.Proof memory wrongKey = p;
        wrongKey.pk[1] = p.pk[1] + 1;
        vm.prank(FULFILLER, FULFILLER);
        vm.expectRevert(VRFCoordinator.WrongProvingKey.selector);
        coord.fulfill(id, wrongKey, _sig());
        wrongKey.pk[1] = p.pk[1] - 1; // restore (memory alias)

        uint256[2] memory badSig = _sig();
        badSig[1] = badSig[1] ^ 1;
        vm.prank(FULFILLER, FULFILLER);
        vm.expectRevert(VRFCoordinator.InvalidDrandSignature.selector);
        coord.fulfill(id, p, badSig);

        p.s = p.s ^ 1;
        vm.prank(FULFILLER, FULFILLER);
        vm.expectRevert();
        coord.fulfill(id, p, _sig());
    }

    function test_fulfill_rejectsRevokedKey() public {
        bytes32 id = _request(consumer);
        VRF.Proof memory p = _proof(id);
        coord.revoke(0);
        vm.prank(FULFILLER, FULFILLER);
        vm.expectRevert(VRFCoordinator.KeyRevoked.selector);
        coord.fulfill(id, p, _sig());
    }

    // ------------------------------------------------------------------ refunds and fees

    function test_timeoutRefund_onlyAfterDeadline() public {
        bytes32 id = _request(consumer);
        vm.expectRevert(VRFCoordinator.NotRefundableYet.selector);
        coord.timeoutRefund(id);
        vm.roll(block.number + 1200);
        uint256 before = address(consumer).balance;
        coord.timeoutRefund(id);
        assertEq(address(consumer).balance - before, FEE);
        assertEq(uint8(coord.getRequest(id).status), uint8(VRFCoordinator.Status.Refunded));
    }

    function test_timeoutRefund_onRevokedKeyBeforeDeadline() public {
        bytes32 id = _request(consumer);
        coord.revoke(0);
        vm.expectEmit(true, false, false, true, address(coord));
        emit VRFCoordinator.Refunded(id, VRFCoordinator.RefundReason.KeyRevoked);
        coord.timeoutRefund(id);
    }

    function test_withdrawFees_paysPayeeOnce() public {
        bytes32 id = _request(consumer);
        _fulfill(id, _proof(id), _sig());
        vm.prank(PAYEE);
        coord.withdrawFees();
        assertEq(PAYEE.balance, FEE);
        vm.prank(PAYEE);
        coord.withdrawFees();
        assertEq(PAYEE.balance, FEE);
    }

    function test_noActiveKey_afterRevokingTheActiveKey() public {
        coord.revoke(0);
        vm.expectRevert(VRFCoordinator.NoActiveKey.selector);
        consumer.doRequest{value: FEE}("tag");
    }
}
