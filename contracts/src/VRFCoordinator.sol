// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {VRF} from "./vendor/chainlink/VRF.sol";
import {DrandEvmnet, DrandEvmnetVerifier} from "./DrandEvmnet.sol";
import {VRFDerivation} from "./VRFDerivation.sol";

/// @title VRFCoordinator
/// @notice Requesters ask for randomness bound to the Active Proving Key and a future
///   drand round; any Fulfiller EOA submits the drand signature and a VRF proof over
///   Alpha; anyone reads Beta and derived values afterwards.
/// @dev Lives behind a UUPS (ERC-1967) proxy with ERC-7201 namespaced storage.
///   Admin parameters are frozen per request. Revoking a key stops its fulfillment and
///   makes its pending requests refundable at once.
contract VRFCoordinator is VRF, UUPSUpgradeable, Ownable2StepUpgradeable, ReentrancyGuard {
    bytes32 internal constant DOMAIN_ALPHA = keccak256("rsk-vrf/v1/alpha");
    bytes32 internal constant DOMAIN_VRF_BETA = keccak256("rsk-vrf/v1/beta");

    uint256 public constant CALLBACK_RESERVE = 10_000;
    uint64 internal constant DEFAULT_ROUND_OFFSET = 40;
    uint48 internal constant DEFAULT_TIMEOUT_BLOCKS = 1200;
    uint16 internal constant DEFAULT_CONFIRMATIONS = 12;
    /// @notice The longest Deadline a request can have; a Draining Key retires after it.
    uint48 public constant MAX_TIMEOUT_BLOCKS = 2400;

    enum Status {
        None,
        Pending,
        Fulfilled,
        Refunded
    }

    enum RefundReason {
        Deadline,
        KeyRevoked
    }

    enum KeyState {
        None,
        Active,
        Draining,
        Revoked,
        /// @dev Never stored: derived in `getProvingKey` once a Draining Key outlives every Deadline.
        Retired
    }

    /// @notice A request record; three storage slots.
    struct Request {
        address requester;
        Status status;
        uint32 callbackGasCap;
        uint48 requestBlock;
        uint8 drandConfigId;
        uint96 fee;
        uint64 targetRound;
        uint48 deadline;
        uint16 confirmations;
        uint32 keyId;
        bytes32 beta;
    }

    struct ProvingKey {
        bytes32 keyHash;
        address payee;
        KeyState state;
        uint48 drainingSince;
    }

    /// @notice A drand beacon. `publicKey` uses BLS.sol's G2 layout [x.re, x.im, y.re, y.im].
    struct DrandConfig {
        uint256[4] publicKey;
        uint64 genesis;
        uint64 period;
    }

    /// @custom:storage-location erc7201:rsk-vrf.storage.VRFCoordinator
    struct CoordinatorStorage {
        mapping(bytes32 requestId => Request) requests;
        mapping(address requester => uint256) requesterNonces;
        mapping(uint32 keyId => ProvingKey) keys;
        mapping(bytes32 keyHash => uint32) keyIds;
        uint32 keyCount;
        uint32 activeKeyId;
        uint64 roundOffset;
        DrandConfig[] drandConfigs;
        uint96 fee;
        uint48 timeoutBlocks;
        uint16 confirmations;
        mapping(address payee => uint256) payeeBalances;
        uint32 callbackGasCap;
    }

    // keccak256(abi.encode(uint256(keccak256("rsk-vrf.storage.VRFCoordinator")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0x93e472312740d9d8ceb01cbb3b48eb9a4521b1f1a04d71a14a7e0f61bd068900;

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
    event Refunded(bytes32 indexed requestId, RefundReason reason);
    event FeesWithdrawn(address indexed payee, uint256 amount);
    event CallbackFailed(bytes32 indexed requestId);
    event Fulfilled(bytes32 indexed requestId, bytes32 beta, address indexed fulfiller);
    event KeyRegistered(uint32 keyId, bytes32 keyHash, address payee);
    event KeyStateChanged(uint32 keyId, KeyState state);
    event CallbackGasCapChanged(uint32 cap);
    event RoundOffsetChanged(uint64 value);
    event TimeoutBlocksChanged(uint48 value);
    event ConfirmationsChanged(uint16 value);
    event FeeConfigChanged(uint96 amount);
    event DrandConfigAdded(uint8 drandConfigId, uint256[4] publicKey, uint64 genesis, uint64 period);

    error FulfillerNotEOA();
    error TooEarly();
    error DeadlinePassed();
    error IncorrectFee(uint256 expected, uint256 sent);
    error RequesterHasNoCode();
    error InsufficientGasForCallback();
    error UnknownRequest();
    error RequestNotPending(Status status);
    error RequestPending();
    error RequestRefunded();
    error WrongProvingKey();
    error InvalidDrandSignature();
    error NotRefundableYet();
    error RefundTransferFailed();
    error FeeTransferFailed();
    error NoActiveKey();
    error InvalidProvingKey();
    error KeyAlreadyRegistered();
    error UnknownKey();
    error InvalidKeyTransition();
    error KeyRevoked();
    error ValueOutOfBounds(bytes32 param);

    /// @notice Stateless drand BLS verifier this implementation deploys for itself.
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    DrandEvmnetVerifier internal immutable DRAND_VERIFIER;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        DRAND_VERIFIER = new DrandEvmnetVerifier();
        _disableInitializers();
    }

    function initialize(address owner, DrandConfig calldata drand) external initializer {
        __Ownable_init(owner);
        CoordinatorStorage storage $ = _storage();
        $.roundOffset = DEFAULT_ROUND_OFFSET;
        $.fee = 2e13;
        $.callbackGasCap = 200_000;
        $.confirmations = DEFAULT_CONFIRMATIONS;
        $.timeoutBlocks = DEFAULT_TIMEOUT_BLOCKS;
        _addDrandConfig(drand);
    }

    /// @notice Initializes appended Admin fields when upgrading an earlier coordinator.
    /// @dev Call atomically through upgradeToAndCall. Existing request records and
    ///   the selected drand config/round offset are preserved.
    function initializeAdminParameters() external onlyOwner reinitializer(2) {
        CoordinatorStorage storage $ = _storage();
        if ($.callbackGasCap != 0) revert ValueOutOfBounds("adminInitialized");
        if ($.timeoutBlocks == 0) {
            $.fee = 2e13;
            $.timeoutBlocks = DEFAULT_TIMEOUT_BLOCKS;
            $.confirmations = DEFAULT_CONFIRMATIONS;
        }
        $.callbackGasCap = 200_000;
        emit FeeConfigChanged($.fee);
        emit CallbackGasCapChanged($.callbackGasCap);
        emit TimeoutBlocksChanged($.timeoutBlocks);
        emit ConfirmationsChanged($.confirmations);
    }

    /// @notice Appends and selects a config for new requests; old entries cannot be changed.
    function addDrandConfig(DrandConfig calldata drand) external onlyOwner returns (uint8) {
        return _addDrandConfig(drand);
    }

    function drandConfigCount() external view returns (uint256) {
        return _storage().drandConfigs.length;
    }

    function _addDrandConfig(DrandConfig calldata drand) private returns (uint8 id) {
        CoordinatorStorage storage $ = _storage();
        if ($.drandConfigs.length >= 256) revert ValueOutOfBounds("drandConfigCount");
        if (drand.period == 0 || !DRAND_VERIFIER.isValidPublicKey(drand.publicKey)) revert ValueOutOfBounds("drandConfig");
        id = uint8($.drandConfigs.length);
        $.drandConfigs.push(drand);
        emit DrandConfigAdded(id, drand.publicKey, drand.genesis, drand.period);
    }

    function setCallbackGasCap(uint256 cap) external onlyOwner {
        if (cap < 25_000 || cap > 2_500_000) revert ValueOutOfBounds("callbackGasCap");
        _storage().callbackGasCap = uint32(cap);
        emit CallbackGasCapChanged(uint32(cap));
    }

    function callbackGasCap() external view returns (uint32) {
        return _storage().callbackGasCap;
    }

    function setRoundOffset(uint256 value) external onlyOwner {
        if (value < 40 || value > type(uint64).max) revert ValueOutOfBounds("roundOffset");
        _storage().roundOffset = uint64(value);
        emit RoundOffsetChanged(uint64(value));
    }

    function roundOffset() external view returns (uint64) {
        return _storage().roundOffset;
    }

    function setTimeoutBlocks(uint256 value) external onlyOwner {
        if (value < 600 || value > MAX_TIMEOUT_BLOCKS) revert ValueOutOfBounds("timeoutBlocks");
        _storage().timeoutBlocks = uint48(value);
        emit TimeoutBlocksChanged(uint48(value));
    }

    function timeoutBlocks() external view returns (uint48) {
        return _storage().timeoutBlocks;
    }

    function setConfirmations(uint256 value) external onlyOwner {
        if (value < 6 || value > 100) revert ValueOutOfBounds("confirmations");
        _storage().confirmations = uint16(value);
        emit ConfirmationsChanged(uint16(value));
    }

    function confirmations() external view returns (uint16) {
        return _storage().confirmations;
    }

    function setFeeConfig(uint256 amount) external onlyOwner {
        if (amount > type(uint96).max) revert ValueOutOfBounds("fee");
        _storage().fee = uint96(amount);
        emit FeeConfigChanged(uint96(amount));
    }

    function fee() external view returns (uint96) {
        return _storage().fee;
    }

    // ------------------------------------------------------------------ admin

    /// @notice Registers a Proving Key and makes it Active; the previous Active Key
    ///   moves to Draining. The Payee is fixed here.
    function registerProvingKey(uint256[2] calldata publicKey, address payee)
        external
        onlyOwner
        returns (uint32 keyId)
    {
        if (!_isOnCurve(publicKey)) revert InvalidProvingKey();
        CoordinatorStorage storage $ = _storage();
        bytes32 keyHash = keccak256(abi.encode(publicKey));
        if ($.keyIds[keyHash] != 0) revert KeyAlreadyRegistered();

        uint32 previous = $.activeKeyId;
        if (previous != 0) {
            $.keys[previous].state = KeyState.Draining;
            $.keys[previous].drainingSince = uint48(block.number);
            emit KeyStateChanged(previous, KeyState.Draining);
        }
        keyId = ++$.keyCount;
        $.keys[keyId] = ProvingKey({keyHash: keyHash, payee: payee, state: KeyState.Active, drainingSince: 0});
        $.keyIds[keyHash] = keyId;
        $.activeKeyId = keyId;
        emit KeyRegistered(keyId, keyHash, payee);
        emit KeyStateChanged(keyId, KeyState.Active);
    }

    // -------------------------------------------------------------- lifecycle

    /// @notice Revokes an Active or Draining key immediately. Its pending requests can no
    ///   longer be fulfilled and are refundable at once. Revoking the Active Key leaves
    ///   no Active Key, so new requests stop until another key is registered.
    function revoke(bytes32 keyHash) external onlyOwner {
        CoordinatorStorage storage $ = _storage();
        uint32 keyId = $.keyIds[keyHash];
        if (keyId == 0) revert UnknownKey();
        KeyState state = _provingKey(keyId).state;
        // A registered key is never None, so only Revoked and Retired follow Draining.
        if (state > KeyState.Draining) revert InvalidKeyTransition();
        $.keys[keyId].state = KeyState.Revoked;
        if ($.activeKeyId == keyId) $.activeKeyId = 0;
        emit KeyStateChanged(keyId, KeyState.Revoked);
    }

    /// @dev The stored record with Retired derived for a Draining Key past every Deadline.
    function _provingKey(uint32 keyId) private view returns (ProvingKey memory key) {
        key = _storage().keys[keyId];
        if (key.state == KeyState.Draining && block.number > uint256(key.drainingSince) + MAX_TIMEOUT_BLOCKS) {
            key.state = KeyState.Retired;
        }
    }

    /// @notice Requests randomness bound to the Active Key and a future drand round.
    function request(bytes32 tag) external payable returns (bytes32 requestId) {
        return _request(tag, 0);
    }

    function requestWithCallback(bytes32 tag) external payable returns (bytes32 requestId) {
        if (msg.sender.code.length == 0) revert RequesterHasNoCode();
        return _request(tag, _storage().callbackGasCap);
    }

    function _request(bytes32 tag, uint32 cap) private returns (bytes32 requestId) {
        CoordinatorStorage storage $ = _storage();
        uint32 keyId = $.activeKeyId;
        if (keyId == 0) revert NoActiveKey();
        if (msg.value != $.fee) revert IncorrectFee($.fee, msg.value);

        uint256 nonce = $.requesterNonces[msg.sender]++;
        requestId = keccak256(abi.encode(block.chainid, address(this), msg.sender, nonce, tag));

        uint8 drandConfigId = uint8($.drandConfigs.length - 1);
        DrandConfig storage drand = $.drandConfigs[drandConfigId];
        if (block.timestamp < drand.genesis) revert ValueOutOfBounds("drandGenesis");
        uint256 round = (block.timestamp - drand.genesis) / drand.period + 1 + $.roundOffset;
        if (round > type(uint64).max) revert ValueOutOfBounds("targetRound");
        uint64 targetRound = uint64(round);
        if (block.number > type(uint48).max - $.timeoutBlocks) revert ValueOutOfBounds("requestBlock");
        uint48 requestBlock = uint48(block.number);
        uint48 deadline = requestBlock + $.timeoutBlocks;

        $.requests[requestId] = Request({
            requester: msg.sender,
            status: Status.Pending,
            callbackGasCap: cap,
            requestBlock: requestBlock,
            drandConfigId: drandConfigId,
            fee: $.fee,
            targetRound: targetRound,
            deadline: deadline,
            confirmations: $.confirmations,
            keyId: keyId,
            beta: bytes32(0)
        });
        _emitRequested(requestId, tag, $.requests[requestId]);
    }

    function _emitRequested(bytes32 requestId, bytes32 tag, Request storage r) private {
        emit RandomnessRequested(
            requestId, r.requester, tag, r.keyId, r.targetRound, r.requestBlock, r.deadline, r.fee, r.callbackGasCap
        );
    }

    /// @notice Fulfils a Pending request. `proof.seed` is ignored: the proof is checked
    ///   against the Alpha the coordinator computes, so a proof over anything else fails.
    function fulfill(bytes32 requestId, Proof calldata proof, uint256[2] calldata drandSignature) external {
        if (msg.sender != tx.origin) revert FulfillerNotEOA();
        CoordinatorStorage storage $ = _storage();
        Request storage r = $.requests[requestId];
        Status status = r.status;
        if (status == Status.None) revert UnknownRequest();
        if (status != Status.Pending) revert RequestNotPending(status);
        if (block.number < uint256(r.requestBlock) + r.confirmations) revert TooEarly();
        if (block.number > r.deadline) revert DeadlinePassed();
        ProvingKey storage key = $.keys[r.keyId];
        // Raw stored state suffices: a Retired key is past every Deadline, checked above.
        if (key.state == KeyState.Revoked) revert KeyRevoked();
        if (keccak256(abi.encode(proof.pk)) != key.keyHash) revert WrongProvingKey();

        uint64 targetRound = r.targetRound;
        if (!DRAND_VERIFIER.verify($.drandConfigs[r.drandConfigId].publicKey, targetRound, drandSignature)) {
            revert InvalidDrandSignature();
        }
        bytes32 alpha = keccak256(
            abi.encode(
                DOMAIN_ALPHA,
                block.chainid,
                address(this),
                r.requester,
                requestId,
                targetRound,
                DrandEvmnet.randomness(drandSignature)
            )
        );
        uint256 output = _randomValueFromVRFProof(proof, uint256(alpha));
        bytes32 beta = keccak256(abi.encode(DOMAIN_VRF_BETA, output));

        if (r.callbackGasCap != 0 && gasleft() < uint256(r.callbackGasCap) + CALLBACK_RESERVE) {
            revert InsufficientGasForCallback();
        }
        r.status = Status.Fulfilled;
        r.beta = beta;
        $.payeeBalances[key.payee] += r.fee;
        emit Fulfilled(requestId, beta, msg.sender);
        if (r.callbackGasCap != 0) _deliverCallback(requestId, r.requester, beta, r.callbackGasCap);
    }

    function _deliverCallback(bytes32 requestId, address requester, bytes32 beta, uint32 cap) private {
        bytes memory data = abi.encodeWithSignature("onRandomness(bytes32,bytes32)", requestId, beta);
        // Rootstock forwards the requested gas without EIP-150's 63/64 rule.
        // Check again after effects and calldata encoding so the reserve covers
        // only CALL overhead and the outcome event. A revert rolls back settlement.
        if (gasleft() < uint256(cap) + CALLBACK_RESERVE) revert InsufficientGasForCallback();
        bool success;
        assembly ("memory-safe") {
            success := call(cap, requester, 0, add(data, 32), mload(data), 0, 0)
        }
        if (!success) emit CallbackFailed(requestId);
    }

    /// @notice Anyone may return a Pending request's Escrow after its hard Deadline, or at
    ///   once if its bound key is Revoked.
    /// @dev A failed push rolls back the status change, leaving the request Pending.
    function timeoutRefund(bytes32 requestId) external nonReentrant {
        CoordinatorStorage storage $ = _storage();
        Request storage r = $.requests[requestId];
        Status status = r.status;
        if (status == Status.None) revert UnknownRequest();
        if (status != Status.Pending) revert RequestNotPending(status);
        // Raw stored state suffices: a Retired key is past every Deadline, so it refunds
        // on the Deadline branch like a Draining one.
        RefundReason reason = RefundReason.Deadline;
        if ($.keys[r.keyId].state == KeyState.Revoked) reason = RefundReason.KeyRevoked;
        else if (block.number <= r.deadline) revert NotRefundableYet();
        r.status = Status.Refunded;
        (bool sent,) = r.requester.call{value: r.fee}("");
        if (!sent) revert RefundTransferFailed();
        emit Refunded(requestId, reason);
    }

    /// @notice Withdraws only the caller's credited fees; no-op for an empty balance.
    function withdrawFees() external nonReentrant {
        CoordinatorStorage storage $ = _storage();
        uint256 amount = $.payeeBalances[msg.sender];
        if (amount == 0) return;
        $.payeeBalances[msg.sender] = 0;
        (bool sent,) = msg.sender.call{value: amount}("");
        if (!sent) revert FeeTransferFailed();
        emit FeesWithdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------ reads

    function payeeBalance(address payee) external view returns (uint256) {
        return _storage().payeeBalances[payee];
    }

    function getRequest(bytes32 requestId) external view returns (Request memory) {
        return _storage().requests[requestId];
    }

    function deriveRandomBytes(bytes32 requestId, bytes32 context) external view returns (bytes32) {
        return VRFDerivation.randomBytes(_fulfilledBeta(requestId), context);
    }

    function deriveRandom(bytes32 requestId, bytes32 context) external view returns (uint256) {
        return VRFDerivation.random(_fulfilledBeta(requestId), context);
    }

    function deriveRandomInRange(bytes32 requestId, bytes32 context, uint256 min, uint256 max)
        external
        view
        returns (uint256)
    {
        return VRFDerivation.randomInRange(_fulfilledBeta(requestId), context, min, max);
    }

    /// @notice The key's record, with Retired derived for a Draining Key past every Deadline.
    function getProvingKey(uint32 keyId) external view returns (ProvingKey memory) {
        return _provingKey(keyId);
    }

    function activeKeyId() external view returns (uint32) {
        return _storage().activeKeyId;
    }

    function getDrandConfig(uint8 drandConfigId) external view returns (DrandConfig memory) {
        return _storage().drandConfigs[drandConfigId];
    }

    function requesterNonce(address requester) external view returns (uint256) {
        return _storage().requesterNonces[requester];
    }

    // --------------------------------------------------------------- internal

    function _fulfilledBeta(bytes32 requestId) private view returns (bytes32) {
        Request storage r = _storage().requests[requestId];
        Status status = r.status;
        if (status == Status.Fulfilled) return r.beta;
        if (status == Status.None) revert UnknownRequest();
        if (status == Status.Pending) revert RequestPending();
        revert RequestRefunded();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function _storage() private pure returns (CoordinatorStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }
}
