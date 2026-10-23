// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {VRF} from "./vendor/chainlink/VRF.sol";
import {DrandEvmnet} from "./DrandEvmnet.sol";

/// @title VRFCoordinator - THROWAWAY GAS SPIKE of the shape chosen in "Coordinator Contract Boundaries and
///        Fulfill Error Set". Not reviewed, not the product. Admin surface is reduced to what the gas
///        measurement needs; request/fulfill/timeoutRefund/withdrawFees follow the decided behaviour.
/// @dev   CALLBACK_RESERVE is an immutable here only so the spike can measure it; the product makes it a constant.
contract VRFCoordinator is VRF, Initializable, UUPSUpgradeable, Ownable2StepUpgradeable, ReentrancyGuard {
    enum Status {
        None,
        Pending,
        Fulfilled,
        Refunded
    }

    enum KeyState {
        None,
        Active,
        Draining,
        Revoked
    }

    enum RefundReason {
        Deadline,
        KeyRevoked
    }

    /// 3 slots
    struct Request {
        // slot 0
        address requester;
        Status status;
        uint32 callbackGasCap;
        uint48 requestBlock;
        uint8 drandConfigId;
        // slot 1
        uint96 fee;
        uint64 targetRound;
        uint48 deadline;
        uint16 confirmations;
        uint32 keyId;
        // slot 2
        bytes32 beta;
    }

    struct ProvingKey {
        bytes32 keyHash;
        address payee;
        KeyState state;
        uint48 drainingSince;
    }

    /// @custom:storage-location erc7201:rsk-vrf.storage.VRFCoordinator
    struct CoordinatorStorage {
        mapping(bytes32 => Request) requests;
        mapping(address => uint256) requesterNonce;
        mapping(address => uint256) payeeBalance;
        mapping(bytes32 => bool) keySeen;
        ProvingKey[] keys;
        DrandEvmnet.Config[] drandConfigs;
        // packed config slot
        uint96 fee;
        uint32 callbackGasCap;
        uint32 activeKeyIdPlusOne;
        uint16 timeoutBlocks;
        uint16 confirmations;
        uint16 roundOffset;
        uint8 drandConfigId;
    }

    // keccak256(abi.encode(uint256(keccak256("rsk-vrf.storage.VRFCoordinator")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_SLOT = 0x93e472312740d9d8ceb01cbb3b48eb9a4521b1f1a04d71a14a7e0f61bd068900;

    bytes32 public constant DOMAIN_ALPHA = keccak256("rsk-vrf/v1/alpha");
    bytes32 public constant DOMAIN_VRF_BETA = keccak256("rsk-vrf/v1/beta");
    bytes32 public constant DOMAIN_REQUEST_ID = keccak256("rsk-vrf/v1/request-id");

    uint32 public constant MIN_CALLBACK_GAS_CAP = 25_000;
    uint32 public constant MAX_CALLBACK_GAS_CAP = 2_500_000;
    uint16 public constant MIN_TIMEOUT_BLOCKS = 600;
    uint16 public constant MAX_TIMEOUT_BLOCKS = 2400;
    uint16 public constant MIN_CONFIRMATIONS = 6;
    uint16 public constant MAX_CONFIRMATIONS = 100;
    uint16 public constant MIN_ROUND_OFFSET = 40;

    bytes4 private constant ON_RANDOMNESS = bytes4(keccak256("onRandomness(bytes32,bytes32)"));

    uint256 public immutable CALLBACK_RESERVE;

    error FulfillerNotEOA();
    error UnknownRequest();
    error RequestNotPending(Status status);
    error TooEarly();
    error DeadlinePassed();
    error KeyRevoked();
    error WrongProvingKey();
    error InvalidDrandSignature();
    error InsufficientGasForCallback();
    error NoActiveKey();
    error IncorrectFee(uint256 expected, uint256 sent);
    error RequesterHasNoCode();
    error NotRefundableYet();
    error RefundTransferFailed();
    error InvalidProvingKey();
    error KeyAlreadyRegistered();
    error ValueOutOfBounds(bytes32 param);

    event RandomnessRequested(
        bytes32 indexed requestId,
        address indexed requester,
        bytes32 tag,
        uint32 keyId,
        uint64 targetRound,
        uint48 requestBlock,
        uint48 deadline,
        uint96 fee,
        uint32 callbackGasCap
    );
    event Fulfilled(bytes32 indexed requestId, bytes32 beta, address indexed fulfiller);
    event CallbackFailed(bytes32 indexed requestId);
    event Refunded(bytes32 indexed requestId, RefundReason reason);
    event FeesWithdrawn(address indexed payee, uint256 amount);
    event KeyRegistered(uint32 keyId, bytes32 keyHash, address payee);
    event KeyStateChanged(uint32 keyId, KeyState state);
    event DrandConfigSet(uint8 drandConfigId);
    event FeeConfigSet(uint96 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(uint256 callbackReserve) {
        CALLBACK_RESERVE = callbackReserve;
        _disableInitializers();
    }

    function initialize(address admin, DrandEvmnet.Config calldata drand) external initializer {
        __Ownable_init(admin);
        CoordinatorStorage storage $ = _s();
        $.callbackGasCap = 200_000;
        $.timeoutBlocks = 1200;
        $.confirmations = 12;
        $.roundOffset = MIN_ROUND_OFFSET;
        $.drandConfigs.push(drand);
        // ReentrancyGuard's slot only gets NOT_ENTERED from its constructor, i.e. in the implementation's
        // storage. Seed it in the proxy so the first nonReentrant call pays the steady-state 2 x 5,000.
        assembly {
            sstore(0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00, 1)
        }
    }

    // ------------------------------------------------------------------ requests

    function request(bytes32 tag) external payable returns (bytes32) {
        return _request(tag, 0);
    }

    function requestWithCallback(bytes32 tag) external payable returns (bytes32) {
        if (msg.sender.code.length == 0) revert RequesterHasNoCode();
        return _request(tag, _s().callbackGasCap);
    }

    function _request(bytes32 tag, uint32 cap) private returns (bytes32 requestId) {
        CoordinatorStorage storage $ = _s();
        uint32 activePlusOne = $.activeKeyIdPlusOne;
        if (activePlusOne == 0) revert NoActiveKey();
        uint96 fee = $.fee;
        if (msg.value != fee) revert IncorrectFee(fee, msg.value);

        uint256 nonce = $.requesterNonce[msg.sender]++;
        requestId = keccak256(abi.encode(DOMAIN_REQUEST_ID, block.chainid, address(this), msg.sender, nonce, tag));

        Request memory req;
        req.requester = msg.sender;
        req.status = Status.Pending;
        req.callbackGasCap = cap;
        req.requestBlock = uint48(block.number);
        req.drandConfigId = $.drandConfigId;
        req.fee = fee;
        DrandEvmnet.Config storage d = $.drandConfigs[req.drandConfigId];
        req.targetRound = uint64((block.timestamp - d.genesis) / d.period + 1 + $.roundOffset);
        req.deadline = req.requestBlock + $.timeoutBlocks;
        req.confirmations = $.confirmations;
        req.keyId = activePlusOne - 1;
        $.requests[requestId] = req;
        _emitRequested(requestId, tag, req);
    }

    function _emitRequested(bytes32 requestId, bytes32 tag, Request memory req) private {
        emit RandomnessRequested(
            requestId,
            req.requester,
            tag,
            req.keyId,
            req.targetRound,
            req.requestBlock,
            req.deadline,
            req.fee,
            req.callbackGasCap
        );
    }

    // ------------------------------------------------------------------ fulfill

    function fulfill(bytes32 requestId, Proof calldata proof, uint256[2] calldata drandSig) external {
        _checkFulfiller();
        CoordinatorStorage storage $ = _s();
        Request storage r = $.requests[requestId];
        Status status = r.status;
        if (status == Status.None) revert UnknownRequest();
        if (status != Status.Pending) revert RequestNotPending(status);
        if (block.number < uint256(r.requestBlock) + r.confirmations) revert TooEarly();
        if (block.number > r.deadline) revert DeadlinePassed();
        ProvingKey storage key = $.keys[r.keyId];
        if (key.state == KeyState.Revoked) revert KeyRevoked();
        if (keccak256(abi.encodePacked(proof.pk)) != key.keyHash) revert WrongProvingKey();

        uint64 targetRound = r.targetRound;
        (bool drandOk, bytes32 drandRandomness) = DrandEvmnet.verify($.drandConfigs[r.drandConfigId], targetRound, drandSig);
        if (!drandOk) revert InvalidDrandSignature();

        address requester = r.requester;
        uint256 alpha = _alpha(requester, requestId, targetRound, drandRandomness);
        bytes32 beta = keccak256(abi.encode(DOMAIN_VRF_BETA, _randomValueFromVRFProof(proof, alpha)));

        r.status = Status.Fulfilled;
        r.beta = beta;
        $.payeeBalance[key.payee] += r.fee;
        emit Fulfilled(requestId, beta, msg.sender);

        uint256 cap = r.callbackGasCap;
        if (cap == 0) return;
        bytes memory data = abi.encodeWithSelector(ON_RANDOMNESS, requestId, beta);
        if (gasleft() < cap + CALLBACK_RESERVE) revert InsufficientGasForCallback();
        bool ok;
        assembly {
            ok := call(cap, requester, 0, add(data, 0x20), mload(data), 0, 0)
        }
        if (!ok) emit CallbackFailed(requestId);
    }

    function _alpha(address requester, bytes32 requestId, uint64 round, bytes32 drandRandomness)
        internal
        view
        returns (uint256)
    {
        return uint256(
            keccak256(abi.encode(DOMAIN_ALPHA, block.chainid, address(this), requester, requestId, round, drandRandomness))
        );
    }

    function _checkFulfiller() internal view virtual {
        if (msg.sender != tx.origin) revert FulfillerNotEOA();
    }

    // ------------------------------------------------------------------ refunds and fees

    function timeoutRefund(bytes32 requestId) external nonReentrant {
        CoordinatorStorage storage $ = _s();
        Request storage r = $.requests[requestId];
        Status status = r.status;
        if (status == Status.None) revert UnknownRequest();
        if (status != Status.Pending) revert RequestNotPending(status);
        RefundReason reason;
        if (block.number > r.deadline) {
            reason = RefundReason.Deadline;
        } else if ($.keys[r.keyId].state == KeyState.Revoked) {
            reason = RefundReason.KeyRevoked;
        } else {
            revert NotRefundableYet();
        }
        r.status = Status.Refunded;
        (bool ok,) = r.requester.call{value: r.fee}("");
        if (!ok) revert RefundTransferFailed();
        emit Refunded(requestId, reason);
    }

    function withdrawFees() external nonReentrant {
        CoordinatorStorage storage $ = _s();
        uint256 amount = $.payeeBalance[msg.sender];
        if (amount == 0) return;
        $.payeeBalance[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok);
        emit FeesWithdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------ admin (reduced)

    function registerKey(uint256[2] calldata pk, address payee) external onlyOwner returns (uint32 keyId) {
        if (pk[0] == 0 || !_isOnCurve(pk)) revert InvalidProvingKey();
        CoordinatorStorage storage $ = _s();
        bytes32 keyHash = keccak256(abi.encodePacked(pk));
        if ($.keySeen[keyHash]) revert KeyAlreadyRegistered();
        $.keySeen[keyHash] = true;
        keyId = uint32($.keys.length);
        $.keys.push(ProvingKey({keyHash: keyHash, payee: payee, state: KeyState.Active, drainingSince: 0}));
        uint32 prev = $.activeKeyIdPlusOne;
        if (prev != 0) {
            $.keys[prev - 1].state = KeyState.Draining;
            $.keys[prev - 1].drainingSince = uint48(block.number);
            emit KeyStateChanged(prev - 1, KeyState.Draining);
        }
        $.activeKeyIdPlusOne = keyId + 1;
        emit KeyRegistered(keyId, keyHash, payee);
        emit KeyStateChanged(keyId, KeyState.Active);
    }

    function revoke(uint32 keyId) external onlyOwner {
        CoordinatorStorage storage $ = _s();
        $.keys[keyId].state = KeyState.Revoked;
        if ($.activeKeyIdPlusOne == keyId + 1) $.activeKeyIdPlusOne = 0;
        emit KeyStateChanged(keyId, KeyState.Revoked);
    }

    function setFeeConfig(uint96 amount) external onlyOwner {
        _s().fee = amount;
        emit FeeConfigSet(amount);
    }

    function setCallbackGasCap(uint32 cap) external onlyOwner {
        if (cap < MIN_CALLBACK_GAS_CAP || cap > MAX_CALLBACK_GAS_CAP) revert ValueOutOfBounds("callbackGasCap");
        _s().callbackGasCap = cap;
    }

    function setDrandConfig(DrandEvmnet.Config calldata drand) external onlyOwner {
        CoordinatorStorage storage $ = _s();
        $.drandConfigs.push(drand);
        $.drandConfigId = uint8($.drandConfigs.length - 1);
        emit DrandConfigSet($.drandConfigId);
    }

    // ------------------------------------------------------------------ views

    function getRequest(bytes32 requestId) external view returns (Request memory) {
        return _s().requests[requestId];
    }

    function payeeBalance(address payee) external view returns (uint256) {
        return _s().payeeBalance[payee];
    }

    // ------------------------------------------------------------------ internals

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function _s() internal pure returns (CoordinatorStorage storage $) {
        assembly {
            $.slot := STORAGE_SLOT
        }
    }
}
