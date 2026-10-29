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
        vm.deal(address(this), 1 ether);
    }

    // ---------------------------------------------------------------- helpers

    function registerGoldenKey() internal {
        vm.prank(owner);
        coordinator.registerProvingKey(vector(0).proof.pk, payee);
    }

    /// Makes the vector's request at its timestamp, from its requester.
    function requestAs(RequestVector memory v) internal returns (bytes32 requestId) {
        vm.warp(v.requestTimestamp);
        uint96 requestFee = coordinator.fee();
        vm.deal(v.requester, 1 ether);
        vm.prank(v.requester);
        requestId = coordinator.request{value: requestFee}(v.tag);
    }

    /// Registers the key and makes every vector's request, in file order.
    function requestAll() internal {
        registerGoldenKey();
        for (uint256 i; i < count; i++) {
            requestAs(vector(i));
        }
        vm.roll(block.number + 12);
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
                2e13,
                0
            );
            assertEq(requestAs(v), v.requestId, string.concat(v.name, ": requestId"));

            vm.expectEmit(address(coordinator));
            emit VRFCoordinator.Fulfilled(v.requestId, v.beta, fulfiller);
            vm.roll(block.number + 12);
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

    function test_FulfillWaitsForFrozenConfirmationsAndHardDeadline() public {
        registerGoldenKey();
        RequestVector memory v = vector(0);
        requestAs(v);
        VRFCoordinator.Request memory r = coordinator.getRequest(v.requestId);
        vm.expectRevert(abi.encodeWithSignature("TooEarly()"));
        fulfillAs(fulfiller, v);
        vm.roll(r.requestBlock + r.confirmations - 1);
        vm.expectRevert(abi.encodeWithSignature("TooEarly()"));
        fulfillAs(fulfiller, v);
        vm.roll(r.requestBlock + r.confirmations);
        fulfillAs(fulfiller, v);
    }

    function test_FulfillSucceedsAtDeadline() public {
        requestAll();
        RequestVector memory v = vector(0);
        vm.roll(coordinator.getRequest(v.requestId).deadline);
        fulfillAs(fulfiller, v);
        assertEq(uint8(coordinator.getRequest(v.requestId).status), uint8(VRFCoordinator.Status.Fulfilled));
    }

    function test_FulfillRejectsAfterDeadlineBeforeProofChecks() public {
        requestAll();
        RequestVector memory v = vector(0);
        vm.roll(coordinator.getRequest(v.requestId).deadline + 1);
        v.proof.pk[1] += 1;
        vm.expectRevert(abi.encodeWithSignature("DeadlinePassed()"));
        fulfillAs(fulfiller, v);
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
        uint256 escrow = address(coordinator).balance;
        vm.expectRevert(bytes("addr(c*pk+s*g)!=_uWitness"));
        fulfillAs(fulfiller, v);
        assertEq(coordinator.payeeBalance(payee), 0);
        assertEq(address(coordinator).balance, escrow);
        assertEq(uint8(coordinator.getRequest(v.requestId).status), uint8(VRFCoordinator.Status.Pending));
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

    /// A second encoding of the same G1 point would give a second drand randomness,
    /// so a second Alpha and a second Beta for one request.
    function test_FulfillRejectsNonCanonicalEncodingOfValidDrandSignature() public {
        requestAll();
        uint256 bn254FieldModulus = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
        for (uint256 i; i < 2; i++) {
            RequestVector memory v = vector(0);
            v.drandSignature[i] += bn254FieldModulus;
            vm.expectRevert(VRFCoordinator.InvalidDrandSignature.selector);
            fulfillAs(fulfiller, v);
        }
    }

    function test_FulfillRejectsContractCaller() public {
        requestAll();
        RequestVector memory v = vector(0);
        vm.prank(fulfiller); // tx.origin stays the default sender
        vm.expectRevert(VRFCoordinator.FulfillerNotEOA.selector);
        coordinator.fulfill(v.requestId, v.proof, v.drandSignature);
    }

    function test_RequestRequiresExactFee() public {
        registerGoldenKey();
        vm.warp(vector(0).requestTimestamp);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(abi.encodeWithSignature("IncorrectFee(uint256,uint256)", 2e13, 0));
        coordinator.request(bytes32(0));
        vm.expectRevert(abi.encodeWithSignature("IncorrectFee(uint256,uint256)", 2e13, 2e13 + 1));
        coordinator.request{value: 2e13 + 1}(bytes32(0));
        bytes32 id = coordinator.request{value: 2e13}(bytes32(0));
        assertEq(coordinator.getRequest(id).fee, 2e13);
        assertEq(address(coordinator).balance, 2e13);
    }

    // ------------------------------------------------------------- request

    function test_RequestBeforeDrandGenesisRejectsWithDomainError() public {
        registerGoldenKey();
        vm.warp(drandGenesis() - 1);
        // The 12-byte parameter label fits in bytes32.
        // forge-lint: disable-next-line(unsafe-typecast)
        vm.expectRevert(abi.encodeWithSelector(VRFCoordinator.ValueOutOfBounds.selector, bytes32("drandGenesis")));
        coordinator.request{value: 2e13}(bytes32(0));
    }

    function test_RequestAtDrandGenesisBindsFutureRound() public {
        registerGoldenKey();
        vm.warp(drandGenesis());
        bytes32 requestId = coordinator.request{value: 2e13}(bytes32(0));
        assertEq(coordinator.getRequest(requestId).targetRound, 41);
    }

    function test_RequestRequiresAnActiveKey() public {
        RequestVector memory v = vector(0);
        vm.warp(v.requestTimestamp);
        vm.expectRevert(VRFCoordinator.NoActiveKey.selector);
        coordinator.request{value: 2e13}(v.tag);
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
        vm.roll(coordinator.getRequest(requestId).deadline + 1);
        coordinator.timeoutRefund(requestId);

        vm.expectRevert(VRFCoordinator.RequestRefunded.selector);
        coordinator.deriveRandomBytes(requestId, bytes32(0));
    }

    function test_AnyoneRefundsOnlyAfterDeadlineAndOnlyOnce() public {
        requestAll();
        RequestVector memory v = vector(0);
        VRFCoordinator.Request memory r = coordinator.getRequest(v.requestId);
        vm.roll(r.deadline);
        vm.expectRevert(VRFCoordinator.NotRefundableYet.selector);
        coordinator.timeoutRefund(v.requestId);
        uint256 before = v.requester.balance;
        uint256 escrow = address(coordinator).balance;
        vm.roll(r.deadline + 1);
        vm.expectEmit(address(coordinator));
        emit VRFCoordinator.Refunded(v.requestId, VRFCoordinator.RefundReason.Deadline);
        vm.prank(makeAddr("refund caller"));
        coordinator.timeoutRefund(v.requestId);
        assertEq(v.requester.balance, before + 2e13);
        assertEq(address(coordinator).balance, escrow - 2e13);
        assertEq(uint8(coordinator.getRequest(v.requestId).status), uint8(VRFCoordinator.Status.Refunded));
        vm.expectRevert(
            abi.encodeWithSelector(VRFCoordinator.RequestNotPending.selector, VRFCoordinator.Status.Refunded)
        );
        coordinator.timeoutRefund(v.requestId);
        vm.expectRevert(
            abi.encodeWithSelector(VRFCoordinator.RequestNotPending.selector, VRFCoordinator.Status.Refunded)
        );
        fulfillAs(fulfiller, v);
    }

    function test_RefundRejectsUnknownAndFulfilledRequests() public {
        vm.expectRevert(VRFCoordinator.UnknownRequest.selector);
        coordinator.timeoutRefund(bytes32(0));
        requestAll();
        RequestVector memory v = vector(0);
        fulfillAs(fulfiller, v);
        vm.roll(coordinator.getRequest(v.requestId).deadline + 1);
        vm.expectRevert(
            abi.encodeWithSelector(VRFCoordinator.RequestNotPending.selector, VRFCoordinator.Status.Fulfilled)
        );
        coordinator.timeoutRefund(v.requestId);
    }

    function test_FailedRefundKeepsEscrowAndPendingStatusUntilRequesterAccepts() public {
        registerGoldenKey();
        vm.warp(vector(0).requestTimestamp);
        FeeReceiver receiver = new FeeReceiver(coordinator);
        bytes32 id = receiver.request{value: 2e13}();
        uint256 escrow = address(coordinator).balance;
        receiver.configure(true, false, id);
        vm.roll(coordinator.getRequest(id).deadline + 1);
        vm.expectRevert(VRFCoordinator.RefundTransferFailed.selector);
        coordinator.timeoutRefund(id);
        assertEq(uint8(coordinator.getRequest(id).status), uint8(VRFCoordinator.Status.Pending));
        assertEq(address(coordinator).balance, escrow);
        assertEq(address(receiver).balance, 0);
        receiver.configure(false, true, id);
        coordinator.timeoutRefund(id);
        assertEq(address(receiver).balance, 2e13);
        assertEq(uint8(receiver.observedStatus()), uint8(VRFCoordinator.Status.Refunded), "effects precede transfer");
        assertTrue(receiver.refundBlocked(), "refund cannot reenter refund");
        assertTrue(receiver.withdrawalBlocked(), "refund cannot reenter withdrawal");
    }

    function test_FailedWithdrawalKeepsCreditAndBlocksBothReentrantEntrypoints() public {
        FeeReceiver receiver = new FeeReceiver(coordinator);
        payee = address(receiver);
        requestAll();
        RequestVector memory v = vector(0);
        fulfillAs(fulfiller, v);
        uint256 escrow = address(coordinator).balance;
        receiver.configure(true, false, v.requestId);
        vm.expectRevert(VRFCoordinator.FeeTransferFailed.selector);
        receiver.withdraw();
        assertEq(coordinator.payeeBalance(payee), 2e13);
        assertEq(address(coordinator).balance, escrow);
        receiver.configure(false, true, v.requestId);
        receiver.withdraw();
        assertEq(address(receiver).balance, 2e13);
        assertEq(coordinator.payeeBalance(payee), 0);
        assertTrue(receiver.refundBlocked(), "withdrawal cannot reenter refund");
        assertTrue(receiver.withdrawalBlocked(), "withdrawal cannot reenter withdrawal");
    }

    function test_MultipleFulfillmentsAccumulateForOneWithdrawal() public {
        requestAll();
        fulfillAs(fulfiller, vector(0));
        fulfillAs(fulfiller, vector(1));
        assertEq(coordinator.payeeBalance(payee), 4e13);
        vm.prank(payee);
        coordinator.withdrawFees();
        assertEq(payee.balance, 4e13);
        assertEq(coordinator.payeeBalance(payee), 0);
    }

    function test_ZeroFeeRequestsCanFulfill() public {
        vm.prank(owner);
        coordinator.setFeeConfig(0);
        requestAll();
        fulfillAs(fulfiller, vector(0));
        assertEq(coordinator.getRequest(vector(0).requestId).beta, vector(0).beta);
        assertEq(coordinator.payeeBalance(payee), 0);
        assertEq(address(coordinator).balance, 0);
    }

    function test_FulfillmentCreditsBoundPayeeWhoWithdrawsOnce() public {
        requestAll();
        RequestVector memory v = vector(0);
        uint256 escrow = address(coordinator).balance;
        uint256 beforePayee = payee.balance;
        uint256 beforeFulfiller = fulfiller.balance;
        uint256[2] memory other = [
            0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
            0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
        ];
        address otherPayee = makeAddr("new Active Key Payee");
        vm.prank(owner);
        coordinator.registerProvingKey(other, otherPayee);
        fulfillAs(fulfiller, v);
        assertEq(coordinator.payeeBalance(otherPayee), 0, "new Active Key cannot redirect a bound key's fee");
        assertEq(coordinator.payeeBalance(payee), 2e13);
        assertEq(address(coordinator).balance, escrow, "fulfillment credits without push");
        assertEq(payee.balance, beforePayee);
        assertEq(fulfiller.balance, beforeFulfiller);
        vm.prank(owner);
        coordinator.withdrawFees();
        assertEq(coordinator.payeeBalance(payee), 2e13, "Admin cannot claim Payee fees");
        vm.expectEmit(address(coordinator));
        emit VRFCoordinator.FeesWithdrawn(payee, 2e13);
        vm.prank(payee);
        coordinator.withdrawFees();
        assertEq(coordinator.payeeBalance(payee), 0);
        assertEq(payee.balance, beforePayee + 2e13);
        assertEq(address(coordinator).balance, escrow - 2e13);
        vm.prank(payee);
        coordinator.withdrawFees();
        assertEq(payee.balance, beforePayee + 2e13, "zero balance is a no-op");
    }

    function test_ConfigChangesFreezeOpenRequestsAndSetNewRequestTerms() public {
        requestAll();
        RequestVector memory v = vector(0);
        VRFCoordinator.Request memory original = coordinator.getRequest(v.requestId);
        vm.startPrank(owner);
        vm.expectEmit(address(coordinator));
        emit VRFCoordinator.FeeConfigChanged(0);
        coordinator.setFeeConfig(0);
        vm.expectEmit(address(coordinator));
        emit VRFCoordinator.ConfirmationsChanged(100);
        coordinator.setConfirmations(100);
        vm.expectEmit(address(coordinator));
        emit VRFCoordinator.TimeoutBlocksChanged(2400);
        coordinator.setTimeoutBlocks(2400);
        vm.stopPrank();
        assertEq(coordinator.fee(), 0);
        assertEq(coordinator.confirmations(), 100);
        assertEq(coordinator.timeoutBlocks(), 2400);
        vm.prank(makeAddr("zero fee requester"));
        bytes32 newId = coordinator.request(bytes32(0));
        VRFCoordinator.Request memory fresh = coordinator.getRequest(newId);
        assertEq(fresh.fee, 0);
        assertEq(fresh.confirmations, 100);
        assertEq(fresh.deadline, block.number + 2400);
        VRFCoordinator.Request memory frozen = coordinator.getRequest(v.requestId);
        assertEq(frozen.fee, 2e13);
        assertEq(frozen.confirmations, 12);
        assertEq(frozen.deadline, original.deadline);
        fulfillAs(fulfiller, v);
        assertEq(coordinator.payeeBalance(payee), 2e13, "payout uses stored fee despite current zero fee");
        RequestVector memory refund = vector(1);
        uint256 before = refund.requester.balance;
        vm.roll(coordinator.getRequest(refund.requestId).deadline + 1);
        coordinator.timeoutRefund(refund.requestId);
        assertEq(refund.requester.balance, before + 2e13, "refund uses stored fee despite current zero fee");
        vm.roll(fresh.deadline + 1);
        coordinator.timeoutRefund(newId);
        assertEq(uint8(coordinator.getRequest(newId).status), uint8(VRFCoordinator.Status.Refunded));
    }

    function test_OnlyOwnerSetsFeeAndTimingWithinBounds() public {
        assertEq(coordinator.fee(), 2e13);
        assertEq(coordinator.confirmations(), 12);
        assertEq(coordinator.timeoutBlocks(), 1200);
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        coordinator.setFeeConfig(0);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        coordinator.setConfirmations(6);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        coordinator.setTimeoutBlocks(600);
        vm.stopPrank();
        bytes32 feeParam = "fee";
        bytes32 confirmationsParam = "confirmations";
        bytes32 timeoutParam = "timeoutBlocks";
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(VRFCoordinator.ValueOutOfBounds.selector, feeParam));
        coordinator.setFeeConfig(uint256(type(uint96).max) + 1);
        vm.expectRevert(abi.encodeWithSelector(VRFCoordinator.ValueOutOfBounds.selector, confirmationsParam));
        coordinator.setConfirmations(5);
        vm.expectRevert(abi.encodeWithSelector(VRFCoordinator.ValueOutOfBounds.selector, confirmationsParam));
        coordinator.setConfirmations(101);
        vm.expectRevert(abi.encodeWithSelector(VRFCoordinator.ValueOutOfBounds.selector, timeoutParam));
        coordinator.setTimeoutBlocks(599);
        vm.expectRevert(abi.encodeWithSelector(VRFCoordinator.ValueOutOfBounds.selector, timeoutParam));
        coordinator.setTimeoutBlocks(2401);
        coordinator.setFeeConfig(type(uint96).max);
        coordinator.setConfirmations(6);
        coordinator.setTimeoutBlocks(600);
        vm.stopPrank();
        assertEq(coordinator.fee(), type(uint96).max);
        assertEq(coordinator.confirmations(), 6);
        assertEq(coordinator.timeoutBlocks(), 600);
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

    // ---------------------------------------------------- rotation/revocation

    // Any other point on the curve: the secp256k1 generator.
    function otherKey() internal pure returns (uint256[2] memory) {
        return [
            0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
            0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
        ];
    }

    function keyState(uint32 keyId) internal view returns (uint8) {
        return uint8(coordinator.getProvingKey(keyId).state);
    }

    function test_RevokeStopsFulfillAndMakesPendingRequestsRefundableAtOnce() public {
        requestAll();
        RequestVector memory v = vector(0);
        vm.expectEmit(address(coordinator));
        emit VRFCoordinator.KeyStateChanged(1, VRFCoordinator.KeyState.Revoked);
        vm.prank(owner);
        coordinator.revoke(keccak256(abi.encode(v.proof.pk)));
        assertEq(keyState(1), uint8(VRFCoordinator.KeyState.Revoked));
        assertEq(coordinator.activeKeyId(), 0, "revoking the Active Key is the emergency stop");

        vm.expectRevert(VRFCoordinator.KeyRevoked.selector);
        fulfillAs(fulfiller, v);

        VRFCoordinator.Request memory r = coordinator.getRequest(v.requestId);
        assertLe(block.number, r.deadline, "refund happens before the Deadline");
        uint256 before = v.requester.balance;
        vm.expectEmit(address(coordinator));
        emit VRFCoordinator.Refunded(v.requestId, VRFCoordinator.RefundReason.KeyRevoked);
        coordinator.timeoutRefund(v.requestId);
        assertEq(v.requester.balance, before + 2e13);

        vm.deal(address(this), 1 ether);
        vm.expectRevert(VRFCoordinator.NoActiveKey.selector);
        coordinator.request{value: 2e13}(bytes32(0));
    }

    function test_RequestBeforeRotationIsFulfilledWithOldKeyAndAfterIsBoundToNew() public {
        registerGoldenKey();
        RequestVector memory v0 = vector(0);
        RequestVector memory v1 = vector(1);
        requestAs(v0);
        vm.prank(owner);
        coordinator.registerProvingKey(otherKey(), payee);
        requestAs(v1);
        vm.roll(block.number + 12);

        assertEq(coordinator.getRequest(v0.requestId).keyId, 1);
        assertEq(coordinator.getRequest(v1.requestId).keyId, 2);
        fulfillAs(fulfiller, v0);
        assertEq(uint8(coordinator.getRequest(v0.requestId).status), uint8(VRFCoordinator.Status.Fulfilled));
        // The old key never serves a request bound to the new one.
        vm.expectRevert(VRFCoordinator.WrongProvingKey.selector);
        fulfillAs(fulfiller, v1);
    }

    function test_DrainingKeyRetiresAfterTheLongestPossibleDeadline() public {
        registerGoldenKey();
        vm.prank(owner);
        coordinator.registerProvingKey(otherKey(), payee);
        uint256 since = block.number;
        vm.roll(since + coordinator.MAX_TIMEOUT_BLOCKS());
        assertEq(keyState(1), uint8(VRFCoordinator.KeyState.Draining));
        vm.roll(since + coordinator.MAX_TIMEOUT_BLOCKS() + 1);
        assertEq(keyState(1), uint8(VRFCoordinator.KeyState.Retired));
        assertEq(keyState(2), uint8(VRFCoordinator.KeyState.Active));
    }

    function test_DrainingKeyCanBeRevoked() public {
        registerGoldenKey();
        vm.startPrank(owner);
        coordinator.registerProvingKey(otherKey(), payee);
        vm.expectEmit(address(coordinator));
        emit VRFCoordinator.KeyStateChanged(1, VRFCoordinator.KeyState.Revoked);
        coordinator.revoke(keccak256(abi.encode(vector(0).proof.pk)));
        vm.stopPrank();
        assertEq(keyState(1), uint8(VRFCoordinator.KeyState.Revoked));
        assertEq(coordinator.activeKeyId(), 2, "revoking a Draining Key leaves the Active Key");
    }

    function test_RevokeRejectsUnknownKeysAndInvalidTransitions() public {
        bytes32 golden = keccak256(abi.encode(vector(0).proof.pk));
        vm.startPrank(owner);
        vm.expectRevert(VRFCoordinator.UnknownKey.selector);
        coordinator.revoke(golden);
        coordinator.registerProvingKey(vector(0).proof.pk, payee);
        coordinator.revoke(golden);
        vm.expectRevert(VRFCoordinator.InvalidKeyTransition.selector);
        coordinator.revoke(golden);
        // A revoked key is never reused.
        vm.expectRevert(VRFCoordinator.KeyAlreadyRegistered.selector);
        coordinator.registerProvingKey(vector(0).proof.pk, payee);

        coordinator.registerProvingKey(otherKey(), payee);
        // 2G, a third point on the curve.
        uint256[2] memory third = [
            0xC6047F9441ED7D6D3045406E95C07CD85C778E4B8CEF3CA7ABAC09B95C709EE5,
            0x1AE168FEA63DC339A3C58419466CEAEEF7F632653266D0E1236431A950CFE52A
        ];
        coordinator.registerProvingKey(third, payee);
        vm.roll(block.number + coordinator.MAX_TIMEOUT_BLOCKS() + 1);
        assertEq(keyState(2), uint8(VRFCoordinator.KeyState.Retired));
        vm.expectRevert(VRFCoordinator.InvalidKeyTransition.selector);
        coordinator.revoke(keccak256(abi.encode(otherKey())));
        vm.stopPrank();
    }

    function test_OnlyOwnerRevokes() public {
        registerGoldenKey();
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        coordinator.revoke(keccak256(abi.encode(vector(0).proof.pk)));
    }

    function test_PayeeIsFixedAtRegistration() public {
        registerGoldenKey();
        VRFCoordinator.ProvingKey memory k = coordinator.getProvingKey(1);
        assertEq(k.payee, payee);
        assertEq(k.keyHash, keccak256(abi.encode(vector(0).proof.pk)));
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

/// A Requester or Payee whose transfer behavior can reject or attempt both guarded calls.
contract FeeReceiver {
    VRFCoordinator internal immutable COORDINATOR;
    bytes32 internal requestId;
    bool internal reject;
    bool internal reenter;
    VRFCoordinator.Status public observedStatus;
    bool public refundBlocked;
    bool public withdrawalBlocked;

    constructor(VRFCoordinator c) {
        COORDINATOR = c;
    }

    function request() external payable returns (bytes32) {
        requestId = COORDINATOR.request{value: msg.value}(bytes32(0));
        return requestId;
    }

    function configure(bool reject_, bool reenter_, bytes32 id) external {
        reject = reject_;
        reenter = reenter_;
        requestId = id;
    }

    function withdraw() external {
        COORDINATOR.withdrawFees();
    }

    receive() external payable {
        require(!reject, "reject transfer");
        observedStatus = COORDINATOR.getRequest(requestId).status;
        if (reenter) {
            (bool refundOk, bytes memory refundError) =
                address(COORDINATOR).call(abi.encodeCall(VRFCoordinator.timeoutRefund, (requestId)));
            (bool withdrawOk, bytes memory withdrawError) =
                address(COORDINATOR).call(abi.encodeCall(VRFCoordinator.withdrawFees, ()));
            bytes32 guardError = keccak256(abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
            refundBlocked = !refundOk && keccak256(refundError) == guardError;
            withdrawalBlocked = !withdrawOk && keccak256(withdrawError) == guardError;
        }
    }
}
