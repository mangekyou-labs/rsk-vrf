// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VRF} from "./vendor/chainlink/VRF.sol";
import {VRFCoordinator} from "./VRFCoordinator.sol";
import {DrandEvmnet} from "./DrandEvmnet.sol";
import {Vectors} from "./Vectors.sol";

/// @notice Measurement-only subclass. Lets contract callers fulfill (the harness runs inside one constructor,
///         so there is no EOA) and lets the harness rewrite request fields it cannot reach in one eth_call:
///         block heights, the drand round (pinned to the vendored round), and the requester address.
contract VRFCoordinatorProbe is VRFCoordinator {
    constructor(uint256 callbackReserve) VRFCoordinator(callbackReserve) {}

    /// @dev Same three opcodes as the EOA check, compared against itself so no caller is rejected.
    function _checkFulfiller() internal view override {
        if (msg.sender != msg.sender) revert FulfillerNotEOA();
    }

    function poke(bytes32 requestId, uint48 requestBlock, uint48 deadline, uint64 round, address requester) external {
        Request storage r = _s().requests[requestId];
        r.requestBlock = requestBlock;
        r.deadline = deadline;
        r.targetRound = round;
        if (requester != address(0)) r.requester = requester;
    }

    function pokeCap(bytes32 requestId, uint32 cap) external {
        _s().requests[requestId].callbackGasCap = cap;
    }

    function alphaFor(bytes32 requestId, bytes32 drandRandomness) external view returns (uint256) {
        Request storage r = _s().requests[requestId];
        return _alpha(r.requester, requestId, r.targetRound, drandRandomness);
    }

    function segVrf(Proof calldata proof, uint256 alpha) external view returns (uint256 gasUsed, uint256 output) {
        uint256 g = gasleft();
        output = _randomValueFromVRFProof(proof, alpha);
        gasUsed = g - gasleft();
    }

    function segDrand(uint64 round, uint256[2] calldata sig) external view returns (uint256 gasUsed, bytes32 rnd) {
        DrandEvmnet.Config storage cfg = _s().drandConfigs[0];
        uint256 g = gasleft();
        bool ok;
        (ok, rnd) = DrandEvmnet.verify(cfg, round, sig);
        gasUsed = g - gasleft();
        require(ok, "drand");
    }
}

/// @notice A typical consumer: requests with a callback, stores beta, accepts refunds.
contract Consumer {
    VRFCoordinator public immutable coordinator;
    mapping(bytes32 => bytes32) public betaOf;

    constructor(VRFCoordinator c) {
        coordinator = c;
    }

    function doRequest(bytes32 tag) external payable returns (bytes32) {
        return coordinator.requestWithCallback{value: msg.value}(tag);
    }

    function onRandomness(bytes32 requestId, bytes32 beta) external virtual {
        require(msg.sender == address(coordinator));
        betaOf[requestId] = beta;
    }

    receive() external payable {}
}

/// @notice Worst-case consumer: the callback burns every unit of gas it is given (OOG, all consumed).
contract Burner is Consumer {
    constructor(VRFCoordinator c) Consumer(c) {}

    function onRandomness(bytes32, bytes32) external pure override {
        while (true) {}
    }
}

/// @notice Runs a whole scenario inside its constructor so eth_call / eth_estimateGas on Rootstock can execute
///         it against real chain state without any account, funds or broadcast. Returns uint256[8] as "code".
///
///         Setup is identical in every mode so every CREATE address, requestId and Alpha is stable across calls.
///         mode 0  -> Alphas for the four fulfillable requests (pass 1; Python proves them)
///         mode 1  -> fulfill, success consumer        mode 2 -> fulfill, burner consumer (CallbackFailed)
///         mode 3  -> fulfill, requester has no code   mode 4 -> fulfill, plain request (cap 0, no callback)
///         mode 5  -> timeoutRefund to consumer, then to a nonexistent account
///         mode 6  -> fulfill plain, then withdrawFees mode 7 -> VRF / drand segments
///         mode 8  -> baseline (setup only)            mode 9/10 -> fulfill burner/success with exactly `g` gas
///         mode 11/12 -> fulfill success/burner and return nothing (min tx gas limit delta against mode 8)
///         mode 14 -> as 9/10 for the requester-has-no-account request with its cap cut to 1, isolating the
///                    25,000 new-account CALL surcharge the reserve must also cover
///         mode 15 -> as 14 at the request's real 200k cap (callee gets min(remaining, cap) on RSK)
///         mode 13 -> VRF.sol verify gas for each proofs[i] against its own seed (hash-to-curve iteration cost)
contract Harness {
    uint256 internal constant FEE = 40_000_000_000_000; // any nonzero uint96; only its byte shape matters
    address internal constant NOBODY_C = address(uint160(uint256(keccak256("rsk-vrf spike nobody C"))));
    address internal constant NOBODY_R = address(uint160(uint256(keccak256("rsk-vrf spike nobody R"))));

    VRFCoordinatorProbe internal coord;
    bytes32[6] internal ids; // S, B, C, P (fulfillable); S2, P2 (refundable)
    uint256[4] internal setupGas;

    constructor(uint256 mode, uint256 g, uint256 reserve, VRF.Proof[4] memory proofs) payable {
        _setup(reserve);
        uint256[8] memory out;
        if (mode == 11 || mode == 12) {
            // estimate-only: the fulfill call and nothing else, to diff against mode 8 with eth_estimateGas
            uint256 i = mode - 11;
            coord.fulfill(ids[i], proofs[i], [Vectors.DR_SIG_X, Vectors.DR_SIG_Y]);
            assembly {
                return(out, 256)
            }
        }
        for (uint256 i; i < 4; ++i) out[i] = setupGas[i];
        if (mode == 0) {
            for (uint256 i; i < 4; ++i) out[i] = coord.alphaFor(ids[i], Vectors.DR_RANDOMNESS);
        } else if (mode >= 1 && mode <= 4) {
            out[4] = _fulfill(mode - 1, proofs[mode - 1]);
            VRFCoordinator.Request memory r = coord.getRequest(ids[mode - 1]);
            out[5] = uint256(r.status);
            out[6] = uint256(r.beta);
            out[7] = coord.payeeBalance(address(this));
        } else if (mode == 5) {
            uint256 g0 = gasleft();
            coord.timeoutRefund(ids[4]);
            out[4] = g0 - gasleft();
            g0 = gasleft();
            coord.timeoutRefund(ids[5]);
            out[5] = g0 - gasleft();
            out[6] = NOBODY_R.balance;
        } else if (mode == 6) {
            out[4] = _fulfill(3, proofs[3]);
            uint256 g0 = gasleft();
            coord.withdrawFees();
            out[5] = g0 - gasleft();
            out[6] = coord.payeeBalance(address(this));
        } else if (mode == 7) {
            uint256 alpha = coord.alphaFor(ids[0], Vectors.DR_RANDOMNESS);
            (out[4], out[5]) = coord.segVrf(proofs[0], alpha);
            bytes32 rnd;
            (out[6], rnd) = coord.segDrand(Vectors.DR_ROUND, [Vectors.DR_SIG_X, Vectors.DR_SIG_Y]);
            out[7] = uint256(rnd);
        } else if (mode == 13) {
            for (uint256 i; i < 4; ++i) {
                (out[i],) = coord.segVrf(proofs[i], proofs[i].seed);
            }
        } else if (mode == 9 || mode == 10 || mode == 14 || mode == 15) {
            uint256 i = mode == 9 ? 1 : mode == 10 ? 0 : 2;
            if (mode == 14) coord.pokeCap(ids[2], 1);
            (bool ok, bytes memory ret) = address(coord).call{gas: g}(
                abi.encodeCall(VRFCoordinator.fulfill, (ids[i], proofs[i], [Vectors.DR_SIG_X, Vectors.DR_SIG_Y]))
            );
            out[4] = ok ? 1 : 0;
            out[5] = ret.length >= 4 ? uint256(uint32(bytes4(ret))) : 0;
            out[6] = uint256(coord.getRequest(ids[i]).status);
        }
        assembly {
            return(out, 256)
        }
    }

    function _fulfill(uint256 i, VRF.Proof memory proof) internal returns (uint256 used) {
        uint256 g0 = gasleft();
        coord.fulfill(ids[i], proof, [Vectors.DR_SIG_X, Vectors.DR_SIG_Y]);
        used = g0 - gasleft();
    }

    function _setup(uint256 reserve) internal {
        DrandEvmnet.Config memory drand = DrandEvmnet.Config({
            pk: [Vectors.DR_PK_1, Vectors.DR_PK_0, Vectors.DR_PK_3, Vectors.DR_PK_2],
            genesis: 1727521075,
            period: 3
        });
        VRFCoordinatorProbe impl = new VRFCoordinatorProbe(reserve);
        coord = VRFCoordinatorProbe(
            payable(address(new ERC1967Proxy(address(impl), abi.encodeCall(VRFCoordinator.initialize, (address(this), drand)))))
        );
        coord.setFeeConfig(uint96(FEE));
        coord.registerKey([Vectors.CL_PK_X, Vectors.CL_PK_Y], address(this));

        Consumer s = new Consumer(coord);
        Consumer b = new Burner(coord);
        Consumer c = new Consumer(coord);

        uint256 g0 = gasleft();
        ids[0] = s.doRequest{value: FEE}("S");
        setupGas[0] = g0 - gasleft(); // requestWithCallback via consumer, first request of this requester
        g0 = gasleft();
        ids[4] = s.doRequest{value: FEE}("S2");
        setupGas[1] = g0 - gasleft(); // requestWithCallback via consumer, steady state
        ids[1] = b.doRequest{value: FEE}("B");
        ids[2] = c.doRequest{value: FEE}("C");
        g0 = gasleft();
        ids[3] = coord.request{value: FEE}("P");
        setupGas[2] = g0 - gasleft(); // plain request, first of this requester
        g0 = gasleft();
        ids[5] = coord.request{value: FEE}("P2");
        setupGas[3] = g0 - gasleft(); // plain request, steady state

        uint48 bn = uint48(block.number);
        for (uint256 i; i < 4; ++i) {
            coord.poke(ids[i], bn - 12, bn + 1000, Vectors.DR_ROUND, i == 2 ? NOBODY_C : address(0));
        }
        coord.poke(ids[4], bn - 1300, bn - 100, Vectors.DR_ROUND, address(0));
        coord.poke(ids[5], bn - 1300, bn - 100, Vectors.DR_ROUND, NOBODY_R);
    }
}
