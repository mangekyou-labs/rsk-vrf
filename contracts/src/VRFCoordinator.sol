// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {BLS} from "./vendor/bls-bn254/BLS.sol";
import {VRF} from "./vendor/chainlink/VRF.sol";
import {DrandEvmnet} from "./DrandEvmnet.sol";
import {VRFDerivation} from "./VRFDerivation.sol";

/// @title VRFCoordinator
/// @notice Requesters ask for randomness bound to the Active Proving Key and a future
///   drand round; any Fulfiller EOA submits the drand signature and a VRF proof over
///   Alpha; anyone reads Beta and derived values afterwards.
/// @dev Lives behind a UUPS (ERC-1967) proxy with ERC-7201 namespaced storage. This is
///   the first slice: fees, confirmations, Deadlines, refunds, revocation and callbacks
///   come later, though the request record already has room for them.
contract VRFCoordinator is VRF, UUPSUpgradeable, Ownable2StepUpgradeable {
    bytes32 internal constant DOMAIN_ALPHA = keccak256("rsk-vrf/v1/alpha");
    bytes32 internal constant DOMAIN_VRF_BETA = keccak256("rsk-vrf/v1/beta");

    uint64 internal constant DEFAULT_ROUND_OFFSET = 40;
    uint48 internal constant DEFAULT_TIMEOUT_BLOCKS = 1200;
    uint16 internal constant DEFAULT_CONFIRMATIONS = 12;

    enum Status {
        None,
        Pending,
        Fulfilled,
        Refunded
    }

    enum KeyState {
        None,
        Active,
        Draining
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
    event Fulfilled(bytes32 indexed requestId, bytes32 beta, address indexed fulfiller);
    event KeyRegistered(uint32 keyId, bytes32 keyHash, address payee);
    event KeyStateChanged(uint32 keyId, KeyState state);
    event DrandConfigAdded(uint8 drandConfigId, uint256[4] publicKey, uint64 genesis, uint64 period);

    error FulfillerNotEOA();
    error UnknownRequest();
    error RequestNotPending(Status status);
    error RequestPending();
    error RequestRefunded();
    error WrongProvingKey();
    error InvalidDrandSignature();
    error NoActiveKey();
    error InvalidProvingKey();
    error KeyAlreadyRegistered();
    error ValueOutOfBounds(bytes32 param);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner, DrandConfig calldata drand) external initializer {
        __Ownable_init(owner);
        CoordinatorStorage storage $ = _storage();
        $.roundOffset = DEFAULT_ROUND_OFFSET;
        if (drand.period == 0 || !BLS.isValidPublicKey(drand.publicKey)) revert ValueOutOfBounds("drandConfig");
        $.drandConfigs.push(drand);
        emit DrandConfigAdded(0, drand.publicKey, drand.genesis, drand.period);
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
            emit KeyStateChanged(previous, KeyState.Draining);
        }
        keyId = ++$.keyCount;
        $.keys[keyId] = ProvingKey({keyHash: keyHash, payee: payee, state: KeyState.Active});
        $.keyIds[keyHash] = keyId;
        $.activeKeyId = keyId;
        emit KeyRegistered(keyId, keyHash, payee);
        emit KeyStateChanged(keyId, KeyState.Active);
    }

    // -------------------------------------------------------------- lifecycle

    /// @notice Requests randomness bound to the Active Key and a future drand round.
    function request(bytes32 tag) external returns (bytes32 requestId) {
        CoordinatorStorage storage $ = _storage();
        uint32 keyId = $.activeKeyId;
        if (keyId == 0) revert NoActiveKey();

        uint256 nonce = $.requesterNonces[msg.sender]++;
        requestId = keccak256(abi.encode(block.chainid, address(this), msg.sender, nonce, tag));

        uint8 drandConfigId = uint8($.drandConfigs.length - 1);
        DrandConfig storage drand = $.drandConfigs[drandConfigId];
        if (block.timestamp < drand.genesis) revert ValueOutOfBounds("drandGenesis");
        uint64 targetRound = uint64((block.timestamp - drand.genesis) / drand.period + 1 + $.roundOffset);
        uint48 requestBlock = uint48(block.number);
        uint48 deadline = requestBlock + DEFAULT_TIMEOUT_BLOCKS;

        $.requests[requestId] = Request({
            requester: msg.sender,
            status: Status.Pending,
            callbackGasCap: 0,
            requestBlock: requestBlock,
            drandConfigId: drandConfigId,
            fee: 0,
            targetRound: targetRound,
            deadline: deadline,
            confirmations: DEFAULT_CONFIRMATIONS,
            keyId: keyId,
            beta: bytes32(0)
        });
        emit RandomnessRequested(requestId, msg.sender, tag, keyId, targetRound, requestBlock, deadline, 0, 0);
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
        if (keccak256(abi.encode(proof.pk)) != $.keys[r.keyId].keyHash) revert WrongProvingKey();

        uint64 targetRound = r.targetRound;
        if (!DrandEvmnet.verify($.drandConfigs[r.drandConfigId].publicKey, targetRound, drandSignature)) {
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

        r.status = Status.Fulfilled;
        r.beta = beta;
        emit Fulfilled(requestId, beta, msg.sender);
    }

    // ------------------------------------------------------------------ reads

    function getRequest(bytes32 requestId) external view returns (Request memory) {
        return _storage().requests[requestId];
    }

    function deriveRandomBytes(bytes32 requestId, bytes32 context) external view returns (bytes32) {
        return VRFDerivation.randomBytes(_fulfilledBeta(requestId), context);
    }

    function deriveRandom(bytes32 requestId, bytes32 context) external view returns (uint256) {
        return VRFDerivation.random(_fulfilledBeta(requestId), context);
    }

    function getProvingKey(uint32 keyId) external view returns (ProvingKey memory) {
        return _storage().keys[keyId];
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
