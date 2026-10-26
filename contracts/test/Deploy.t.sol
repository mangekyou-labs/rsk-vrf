// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VRFCoordinator} from "../src/VRFCoordinator.sol";
import {DeployCoordinator} from "../script/DeployCoordinator.s.sol";
import {DeployPlan} from "../script/DeployPlan.sol";
import {DeploymentCheck} from "../script/DeploymentCheck.sol";
import {SafeStandIn} from "./helpers/SafeStandIn.sol";
import {VRFCoordinatorV2} from "./helpers/VRFCoordinatorV2.sol";

contract DeployTest is Test {
    // keccak256("eip1967.proxy.implementation") - 1
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    // Kyber wire words [x.im, x.re, y.im, y.re] of the evmnet key from api.drand.sh/v2/beacons/evmnet/info.
    uint256 internal constant EVMNET_X_IM = 0x07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382;
    uint256 internal constant EVMNET_X_RE = 0x0557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808f;
    uint256 internal constant EVMNET_Y_IM = 0x0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6;
    uint256 internal constant EVMNET_Y_RE = 0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0b;

    address internal signer = makeAddr("signer");
    address internal safe;
    address internal deployer;
    // The secp256k1 generator, a valid Proving Key public key.
    uint256[2] internal provingKey = [
        0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798,
        0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8
    ];
    DeployCoordinator internal script;

    function setUp() public {
        deployer = makeAddr("deployer");
        safe = address(new SafeStandIn(signer));
        script = new DeployCoordinator();
    }

    function deploy() internal returns (DeployCoordinator.Deployment memory d) {
        d = script.deploy(deployer, safe, provingKey);
    }

    function test_DeployConfiguresThePlanAndLeavesTheSafePending() public {
        DeployCoordinator.Deployment memory d = deploy();
        VRFCoordinator coordinator = VRFCoordinator(d.proxy);

        assertEq(coordinator.owner(), deployer, "deployer owns until hand-off");
        assertEq(coordinator.pendingOwner(), safe, "Safe is pending");
        assertEq(address(uint160(uint256(vm.load(d.proxy, IMPLEMENTATION_SLOT)))), d.implementation);

        assertEq(coordinator.fee(), 2e13);
        assertEq(coordinator.callbackGasCap(), 200_000);
        assertEq(coordinator.roundOffset(), 40);
        assertEq(coordinator.timeoutBlocks(), 1200);
        assertEq(coordinator.confirmations(), 12);

        assertEq(coordinator.drandConfigCount(), 1, "one drand config, added at initialize");
        VRFCoordinator.DrandConfig memory drand = coordinator.getDrandConfig(0);
        assertEq(drand.publicKey[0], EVMNET_X_RE);
        assertEq(drand.publicKey[1], EVMNET_X_IM);
        assertEq(drand.publicKey[2], EVMNET_Y_RE);
        assertEq(drand.publicKey[3], EVMNET_Y_IM);
        assertEq(drand.genesis, 1727521075);
        assertEq(drand.period, 3);

        assertEq(coordinator.activeKeyId(), 1);
        VRFCoordinator.ProvingKey memory key = coordinator.getProvingKey(1);
        assertEq(key.keyHash, keccak256(abi.encode(provingKey)));
        assertEq(key.payee, safe, "Payee is the Safe");
        assertEq(uint8(key.state), uint8(VRFCoordinator.KeyState.Active));
    }

    function handOff(DeployCoordinator.Deployment memory d) internal {
        vm.prank(signer);
        SafeStandIn(safe).execute(d.proxy, abi.encodeWithSignature("acceptOwnership()"));
    }

    function planned(DeployCoordinator.Deployment memory d) internal view returns (DeploymentCheck.Expected memory) {
        return DeploymentCheck.planned(d.proxy, d.implementation, safe, provingKey);
    }

    /// External so `expectRevert` sees the library's revert.
    function check(DeploymentCheck.Expected memory e) external view {
        DeploymentCheck.check(e);
    }

    function test_CheckPassesAfterTheSafeAccepts() public {
        DeployCoordinator.Deployment memory d = deploy();
        handOff(d);
        this.check(planned(d));
        assertEq(VRFCoordinator(d.proxy).owner(), safe);
    }

    function expectMismatch(DeploymentCheck.Expected memory e, string memory field) internal {
        vm.expectRevert(abi.encodeWithSelector(DeploymentCheck.Mismatch.selector, field));
        this.check(e);
    }

    function asSafe(address target, bytes memory data) internal {
        vm.prank(signer);
        SafeStandIn(safe).execute(target, data);
    }

    function test_CheckFailsBeforeTheSafeAccepts() public {
        DeployCoordinator.Deployment memory d = deploy();
        expectMismatch(planned(d), "owner");
    }

    /// Each Admin change the Safe could make after hand-off moves exactly one checked value.
    function test_CheckFailsOnEachChangedOnchainValue() public {
        DeployCoordinator.Deployment memory d = deploy();
        handOff(d);
        DeploymentCheck.Expected memory e = planned(d);
        address stranger = makeAddr("stranger");
        address v2 = address(new VRFCoordinatorV2());
        VRFCoordinator.DrandConfig memory drand = DeployPlan.drand();
        uint256[2] memory otherKey = [
            0xc6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5,
            0x1ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a
        ];

        bytes[11] memory changes = [
            abi.encodeWithSignature("transferOwnership(address)", stranger),
            abi.encodeWithSignature("upgradeToAndCall(address,bytes)", v2, ""),
            abi.encodeCall(VRFCoordinator.addDrandConfig, (drand)),
            abi.encodeCall(VRFCoordinator.setFeeConfig, (DeployPlan.FEE + 1)),
            abi.encodeCall(VRFCoordinator.setCallbackGasCap, (DeployPlan.CALLBACK_GAS_CAP + 1)),
            abi.encodeCall(VRFCoordinator.setRoundOffset, (DeployPlan.ROUND_OFFSET + 1)),
            abi.encodeCall(VRFCoordinator.setTimeoutBlocks, (DeployPlan.TIMEOUT_BLOCKS + 1)),
            abi.encodeCall(VRFCoordinator.setConfirmations, (DeployPlan.CONFIRMATIONS + 1)),
            abi.encodeCall(VRFCoordinator.registerProvingKey, (otherKey, safe)),
            abi.encodeCall(VRFCoordinator.revoke, (keccak256(abi.encode(provingKey)))),
            // Ownership leaves the Safe entirely: the stranger accepts below.
            abi.encodeWithSignature("transferOwnership(address)", stranger)
        ];
        string[11] memory fields = [
            "pendingOwner",
            "implementation",
            "drandConfigCount",
            "fee",
            "callbackGasCap",
            "roundOffset",
            "timeoutBlocks",
            "confirmations",
            "activeKeyId",
            "activeKeyId",
            "owner"
        ];
        for (uint256 i; i < changes.length; i++) {
            uint256 snapshot = vm.snapshotState();
            asSafe(d.proxy, changes[i]);
            if (i == changes.length - 1) {
                vm.prank(stranger);
                VRFCoordinator(d.proxy).acceptOwnership();
            }
            expectMismatch(e, fields[i]);
            vm.revertToState(snapshot);
        }
        this.check(e);
    }

    /// Values fixed at deploy cannot change onchain, so each case expects a different one.
    function test_CheckFailsOnEachExpectedValueTheChainDoesNotHold() public {
        DeployCoordinator.Deployment memory d = deploy();
        handOff(d);

        DeploymentCheck.Expected memory e = planned(d);
        e.coordinator = makeAddr("not a contract");
        expectMismatch(e, "coordinator");

        e = planned(d);
        e.safe = makeAddr("other safe");
        expectMismatch(e, "owner");

        e = planned(d);
        e.implementation = makeAddr("other implementation");
        expectMismatch(e, "implementation");

        e = planned(d);
        e.drand.publicKey[3] ^= 1;
        expectMismatch(e, "drand.publicKey");

        e = planned(d);
        e.drand.genesis += 1;
        expectMismatch(e, "drand.genesis");

        e = planned(d);
        e.drand.period += 1;
        expectMismatch(e, "drand.period");

        e = planned(d);
        e.provingKey[1] ^= 1;
        expectMismatch(e, "provingKey");
    }

    /// The Payee is fixed at registration, so this coordinator is built by hand with the
    /// Proving Key paying the deployer instead of the Safe.
    function test_CheckFailsWhenThePayeeIsNotTheSafe() public {
        address implementation = address(new VRFCoordinator());
        VRFCoordinator c = VRFCoordinator(
            address(
                new ERC1967Proxy(
                    implementation, abi.encodeCall(VRFCoordinator.initialize, (address(this), DeployPlan.drand()))
                )
            )
        );
        c.registerProvingKey(provingKey, address(this));
        c.setCallbackGasCap(DeployPlan.CALLBACK_GAS_CAP);
        c.transferOwnership(safe);
        asSafe(address(c), abi.encodeWithSignature("acceptOwnership()"));

        expectMismatch(DeploymentCheck.planned(address(c), implementation, safe, provingKey), "payee");
    }
}
