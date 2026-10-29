# Rootstock VRF Service: Build Spec

> **Testnet pilot, not externally audited; do not use for value.**

This spec turns the closed [Wayfinder map](https://github.com/mangekyou-labs/rsk-vrf/issues/1) into a build plan. Each decision lives in its ticket; this document gathers what a builder needs and links the ticket for the reasoning. Where a ticket and this spec disagree, the ticket wins and this spec is the bug. Terms are as defined in [`GLOSSARY.md`](../GLOSSARY.md).

## Goal

A working randomness service on Rootstock testnet (chain ID 31): a Solidity coordinator that verifies a secp256k1 ECVRF proof bound to a future drand round, an oracle worker, consumer libraries, tests, and a public end-to-end demo.

It must hold three security properties:

1. A request binds a future input (its Target Round) that nobody can know or control at request time.
2. Beta stays hidden from Requesters and the public until fulfillment, even with all source published.
3. The proof gives the oracle no choice among valid outputs.

The demo must show on-chain verification with deterministic output, the callback and read paths, fee settlement, timeout Refund, and rejection of invalid, mismatched and repeated proofs.

**Out of scope:** mainnet, operator bonding or slashing, an external audit, and any non-VRF fallback (see the map's Out of scope).

## Repository layout

| Path | Contents |
|---|---|
| `contracts/` | Foundry project: `src/`, `test/`, `script/`, vendored verifiers under `src/vendor/` |
| `worker/` | TypeScript worker (Node LTS, viem, `@noble/curves`) |
| `tools/vrf-vectors-go/` | Pinned Go program that generates the shared proof vectors with Chainlink `vrfkey` |
| `infra/` | Terraform for AWS |
| `deployments/31.json` | Deployed addresses and config (addresses lowercase) |
| `docs/adr/`, `docs/runbooks/`, `docs/reviews/`, `docs/demo.md` | Decisions, operator checklists, internal review checklists, demo walkthrough |

## Contracts

### Components

From [Coordinator Contract Boundaries and Fulfill Error Set](https://github.com/mangekyou-labs/rsk-vrf/issues/19):

- **`VRFCoordinator`**: a single contract behind a UUPS proxy (ERC-1967) with ERC-7201 namespaced storage. It uses `Ownable2Step` (upgradeable) and is owned by the Admin Safe. It has no `pause`: revoking the Active Key is the emergency stop. It inherits `VRF.sol`, verifies drand through an internal `DrandEvmnet` library over `BLS.sol`, and keeps the Key Registry in its own storage.
- **`VRF.sol`**: vendored **unmodified** from `chainlink-evm@23aa976` (MIT, ships the upstream LICENSE). CI pins its git blob hash `0aa7ffe`. See [Verifier Source and License](https://github.com/mangekyou-labs/rsk-vrf/issues/13).
- **`BLS.sol` + `ModExp.sol`**: vendored unmodified from `kevincharm/bls-bn254@9f70fb4` (MIT, not externally audited), also blob-hash pinned.
- **`VRFDerivation`**: a pure internal library and the only derivation code path. Consumers and the coordinator both use it.
- **`VRFConsumer`**: an abstract base for callback consumers.

Bytecode budget: the gas spike measured 21,236 B runtime, a 3,340 B margin under the 24,576 B limit. If the full product doesn't fit, move `DrandEvmnet`/`BLS` into a stateless contract called with `staticcall`, or lower the optimizer runs ([Fulfill Gas Budget and Fee Amount](https://github.com/mangekyou-labs/rsk-vrf/issues/20)).

### Lifecycle

1. **Request.** `request(tag)` or `requestWithCallback(tag)`, paying exactly the fee as `msg.value`. Requester = `msg.sender`. The callback variant reverts with `RequesterHasNoCode` for EOAs. Both revert with `NoActiveKey` when no key is Active. The request is bound to the Active Key and freezes its fee, Callback Gas Cap (0 for plain `request`), confirmations, Deadline, Target Round and drand config.
2. **Wait.** The request becomes Fulfillable at `requestBlock + confirmations` and stays so through `deadline`.
3. **Fulfill.** `fulfill(requestId, proof, drandSig)` from an EOA, open to anyone. It runs the ordered checks below. Then effects (status Fulfilled, store Beta), then credit the Payee, then emit `Fulfilled`, then the capped callback.
4. **Read.** Derive functions work for any Fulfilled request, forever. Beta is never deleted.
5. **Refund.** Anyone may call `timeoutRefund(requestId)` once `block.number > deadline` or the bound key is Revoked. It pushes the Escrow to the Requester and reverts if that push fails. A drand stall is never a reason to refund.

Sources: [Request and Callback Semantics](https://github.com/mangekyou-labs/rsk-vrf/issues/5), [Fee Escrow and Refunds](https://github.com/mangekyou-labs/rsk-vrf/issues/6), [Callback Delivery Policy](https://github.com/mangekyou-labs/rsk-vrf/issues/9).

### Identifiers and cryptographic inputs

From [Request and Callback Semantics](https://github.com/mangekyou-labs/rsk-vrf/issues/5) and [Verifier Scheme and Input Composition](https://github.com/mangekyou-labs/rsk-vrf/issues/10):

```solidity
bytes32 constant DOMAIN_ALPHA    = keccak256("rsk-vrf/v1/alpha");
bytes32 constant DOMAIN_VRF_BETA = keccak256("rsk-vrf/v1/beta");
bytes32 constant DOMAIN_DERIVE   = keccak256("rsk-vrf/v1/derive");
bytes32 constant DOMAIN_RANGE    = keccak256("rsk-vrf/v1/range");

requestId   = keccak256(abi.encode(block.chainid, address(this), requester, requesterNonce, tag))
targetRound = (block.timestamp - genesis) / period + 1 + roundOffset   // drand config frozen per request
alpha       = keccak256(abi.encode(DOMAIN_ALPHA, block.chainid, address(this), requester,
                                   requestId, targetRound, drandRandomness))
beta        = keccak256(abi.encode(DOMAIN_VRF_BETA, vrfOutput))  // vrfOutput from VRF.sol
```

- Use `abi.encode`, never `encodePacked`. `address(this)` is the proxy, so upgrades don't change Alpha.
- `fulfill` computes Alpha itself and passes `uint256(alpha)` as the seed to `_randomValueFromVRFProof`. It ignores `proof.seed`, so a mismatched proof fails as an invalid one.
- `drandRandomness` is derived from the drand signature that `fulfill` verifies under the request's frozen drand config.
- The `requestId` formula comes from #5. The Request Tag is emitted, not stored ([#19](https://github.com/mangekyou-labs/rsk-vrf/issues/19)).

### Request record

From [#19](https://github.com/mangekyou-labs/rsk-vrf/issues/19):

| Slot | Fields |
|---|---|
| 0 | `requester` (160), `status` (8: None/Pending/Fulfilled/Refunded), `callbackGasCap` (32), `requestBlock` (48), `drandConfigId` (8) |
| 1 | `fee` (uint96), `targetRound` (uint64), `deadline` (uint48), `confirmations` (uint16), `keyId` (uint32) |
| 2 | `beta` |

### `fulfill` checks, in order

| # | Condition | Error |
|---|---|---|
| 1 | `msg.sender != tx.origin` | `FulfillerNotEOA` ([ADR 0001](adr/0001-fulfill-requires-eoa-caller.md)) |
| 2 | status None | `UnknownRequest` |
| 3 | status not Pending | `RequestNotPending(status)` |
| 4 | `block.number < requestBlock + confirmations` | `TooEarly` |
| 5 | `block.number > deadline` | `DeadlinePassed` |
| 6 | bound key Revoked | `KeyRevoked` |
| 7 | `keccak256(proof.pk) != boundKeyHash` | `WrongProvingKey` |
| 8 | drand signature invalid for `targetRound` | `InvalidDrandSignature` |
| 9 | VRF proof invalid | upstream `VRF.sol` `require` strings, unchanged |
| 10 | cap > 0 and `gasleft() < cap + CALLBACK_RESERVE` | `InsufficientGasForCallback` |

- `fulfill` has **no reentrancy lock**. The EOA check stops re-entry, and callbacks may make new requests.
- The callback is a low-level `call` passing exactly the cap, with `retOffset = retSize = 0`. A failure emits `CallbackFailed(requestId)`. Nothing is written after the call.
- Rootstock has no EIP-150 63/64 rule and a maximum call depth of 400. This is why the gas check and the EOA rule exist ([Callback Delivery Policy](https://github.com/mangekyou-labs/rsk-vrf/issues/9)).

### Other errors

- `timeoutRefund`: `UnknownRequest`, `RequestNotPending`, `NotRefundableYet`, `RefundTransferFailed`. It is `nonReentrant`.
- `withdrawFees()`: pays the caller's full credited balance and is a no-op at zero. It is `nonReentrant`.
- Requests: `NoActiveKey`, `IncorrectFee(expected, sent)`, `RequesterHasNoCode`.
- Admin: `InvalidProvingKey`, `InvalidPayee`, `KeyAlreadyRegistered`, `UnknownKey`, `InvalidKeyTransition`, `ValueOutOfBounds(param)`.
- Derive views: distinct errors for unknown, Pending and Refunded requests.

### Admin surface and parameters

All Admin functions are owner-only (the Safe) and take effect only for new requests; values are frozen per request.

| Parameter | Default | Bounds | Source |
|---|---|---|---|
| Fee (`setFeeConfig(amount)`, native rBTC) | 2e13 wei | ≥ 0 | [#6](https://github.com/mangekyou-labs/rsk-vrf/issues/6), [#20](https://github.com/mangekyou-labs/rsk-vrf/issues/20) |
| Callback Gas Cap | 200,000 | 25,000–2,500,000 | [#9](https://github.com/mangekyou-labs/rsk-vrf/issues/9) |
| `CALLBACK_RESERVE` (constant) | 10,000 | n/a | [#20](https://github.com/mangekyou-labs/rsk-vrf/issues/20) |
| `roundOffset` | 40 | ≥ 40 | [#5](https://github.com/mangekyou-labs/rsk-vrf/issues/5) |
| Timeout (blocks) | 1,200 | 600–2,400 (`MAX_TIMEOUT_BLOCKS`) | [#19](https://github.com/mangekyou-labs/rsk-vrf/issues/19) |
| Confirmations | 12 | 6–100 | [#19](https://github.com/mangekyou-labs/rsk-vrf/issues/19) |
| drand config | `evmnet` `{pk, genesis 1727521075, period 3}` | append-only list | [#19](https://github.com/mangekyou-labs/rsk-vrf/issues/19), [#16](https://github.com/mangekyou-labs/rsk-vrf/issues/16) |

- **Fee rule:** re-size the fee in the same Safe batch whenever the cap changes, at about +2.5e12 wei per +100k gas.
- **Key Registry** ([Oracle Key Rotation and Operations](https://github.com/mangekyou-labs/rsk-vrf/issues/7)):
  - Keys are identified by `keyHash = keccak256(pk)`, have `pk` checked to be on the curve, and are never reused or deleted.
  - Register and activate is one step; it moves the old key to Draining.
  - `revoke(keyHash)` takes effect immediately and makes the key's pending requests refundable.
  - Retired is derived in the view: Draining and `block.number > drainingSince + MAX_TIMEOUT_BLOCKS`.
  - The Payee is fixed when the key is registered. It must not be `address(0)`.
- No Admin function moves Escrow or Payee balances. `upgrade` is the trust boundary.

### Events

- `RandomnessRequested(requestId indexed, requester indexed, tag, keyId, targetRound, requestBlock, deadline, fee, callbackGasCap)`
- `Fulfilled(requestId indexed, beta, fulfiller indexed)`
- `CallbackFailed(requestId indexed)`
- `Refunded(requestId indexed, reason)`, where `reason` is Deadline or KeyRevoked
- `FeesWithdrawn(payee indexed, amount)`
- `KeyRegistered(keyId, keyHash, payee)` and `KeyStateChanged(keyId, state)`
- one event per Admin setter, plus ERC-1967 `Upgraded`

### Consumer API

From [Consumer-Facing Derivation API](https://github.com/mangekyou-labs/rsk-vrf/issues/8):

- `getRequest(requestId)` returns the status and Beta.
- `deriveRandomBytes(requestId, ctx) → bytes32` = `keccak256(abi.encode(DOMAIN_DERIVE, ctx, beta))`.
- `deriveRandom(requestId, ctx) → uint256` returns the whole word.
- `deriveRandomInRange(requestId, ctx, min, max)` is inclusive and reverts if `min > max`. A full-width span returns the word directly. Otherwise it draws `x_i = keccak256(abi.encode(DOMAIN_RANGE, ctx, beta, i))` by uncapped rejection sampling.
- The callback is `onRandomness(bytes32 requestId, bytes32 beta)`. `VRFConsumer` checks `msg.sender == coordinator` (immutable) and forwards to `internal virtual fulfillRandomness`.
- **Binding consumer rules**, which go in the consumer guide and the `VRFConsumer` NatSpec ([Selective Abort Deterrence](https://github.com/mangekyou-labs/rsk-vrf/issues/11)):
  1. Never re-request to replace a Refund.
  2. Lock every outcome input before calling `request`.
  3. The neutral default must not favour the operator.
  4. Treat a Revocation Refund like a timeout.

  The guide also notes that callback consumers must be able to receive rBTC refunds and that reverting in a callback doesn't reject randomness.

## Oracle worker

From [Oracle Worker Design](https://github.com/mangekyou-labs/rsk-vrf/issues/21), with chain facts from [#18](https://github.com/mangekyou-labs/rsk-vrf/issues/18) and [#22](https://github.com/mangekyou-labs/rsk-vrf/issues/22):

- **Runtime:** stateless TypeScript on viem. The prover is a `@noble/curves` port of Chainlink's ECVRF with a deterministic RFC 6979 nonce over `sk ‖ alpha`. It must produce byte-identical proofs to the Go vectors before going live. The Proving Key lives only in memory; it is never written to disk, logs or error traces.
- **Chain access:** the worker reads its own rskj node (`VETIVER-9.0.4`).
  - On start it backfills `RandomnessRequested`, `Fulfilled` and `Refunded` from `latest − 2,400 − margin`, then polls every 10 s.
  - Logs are hints only. Before proving, the worker reads the request record at `latest`.
  - A request is dropped once its Fulfilled or Refunded event is 12 blocks deep, and a reorged-out fulfillment is re-sent.
- **drand:**
  - The round time is computed from the frozen config, which must match a locally pinned copy (page on a mismatch).
  - The beacon comes from `api`, `api2` and `api3.drand.sh` in failover order.
  - There's no off-chain BLS check: every `fulfill` is simulated with `eth_call` first.
  - If a round is 30 s late, check `/health` and warn.
- **Transactions:**
  - One KMS-backed Fulfiller EOA per worker, sending legacy transactions with local nonce tracking.
  - At most 8 transactions in flight, earliest Deadline first.
  - Gas price starts at `max(eth_gasPrice, minimumGasPrice) × 1.1`, with a ×1.5 replacement after 3 blocks.
  - The gas limit is sized for the full Callback Gas Cap: about 453k–476k needed, about 507k worst case for 1 try, plus about 15k per extra hash-to-curve try.
  - Below the cost of 20 fulfillments, the worker pages and stops sending.
- **Backup Worker:** the same binary with `graceBlocks = 100`; the primary uses 0.
- **Keys:** at start the worker loads its secrets for the Active and Draining keys and reloads them on `KeyStateChanged`. It pages if a pending request is bound to a key it doesn't hold, and never proves for a Revoked key.
- **Watchdog:**
  - It alerts on a fulfillment from an account that isn't ours, any Key Registry change, oldest-pending age at 25% (warn) and 50% (page), and a missed Deadline.
  - On a missed Deadline it logs the withheld proof and includes it in the page.
- **CLI subcommands:** `worker keygen` and `worker check-key <keyHash>`, as used by the runbooks.

## Hosting and operations

From [Worker Hosting and Operator Runbooks](https://github.com/mangekyou-labs/rsk-vrf/issues/23):

- **AWS, all in Terraform (`infra/`):**
  - Two regions, each with an `m7i.large`-class host and a 250 GB gp3 disk running Docker Compose (`rskj` + `worker`).
  - rskj RPC is bound to the host. The only inbound traffic is P2P on 50505. Access is through SSM, with no SSH.
- **Keys and config:**
  - KMS `ECC_SECG_P256K1` holds each Fulfiller key, and each worker may sign with its own only.
  - Secrets Manager holds `rsk-vrf/proving-key/<keyHash>`.
  - An `age`-encrypted offline backup sits on two media.
  - Config lives in SSM Parameter Store. The image is built by GitHub Actions, pushed to GHCR and pinned by digest.
- **Money:**
  - The Payee is the Admin Safe.
  - Fulfillers are topped up by hand from the Operator Funding Wallet, a hardware wallet EOA.
- **Alerts:**
  - Pages go to phone push and warnings to a chat webhook.
  - Each worker pings healthchecks.io every minute; a 5-minute gap pages.
  - Logs go to CloudWatch, kept 90 days.
- **Runbooks:** `docs/runbooks/rotation.md`, `compromise.md` and `outage.md`. Incident Notes are `incident`-labelled issues.
- **Measure at provisioning:** rskj disk size and growth on chain 31, the Docker data mount, and Import Sync inside Docker.

## Validation

From [Validation, Deployment and Demo Plan](https://github.com/mangekyou-labs/rsk-vrf/issues/24) and [Verifier Review Expectation](https://github.com/mangekyou-labs/rsk-vrf/issues/12):

- **Unit layer (CI, every PR):**
  - Foundry tests with a negative test for every rejection, plus Alpha/Beta golden vectors shared with the worker.
  - Blob-hash pins on the vendored files.
  - The `VRF.sol` negative suite.
  - BN254 coverage: real `evmnet` rounds, hash-to-G1 differential vectors pinned to DST `BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_` ([BN254 Hash-to-Curve Reference Vectors](https://github.com/mangekyou-labs/rsk-vrf/issues/14)), and the BLS negative suite.
  - Upgrade authorization tests and a storage-layout snapshot diff.
  - A bytecode size gate: fail over 24,576 B, warn under a 1,024 B margin.
- **Cross-check:** `tools/vrf-vectors-go/` generates one committed vector file, including multi-try proofs, used by both the noble and `VRF.sol` tests. A CI Go job regenerates it and fails on any diff.
- **rskj regtest layer (CI):**
  - The `CALLBACK_RESERVE` boundary search, which needs an RSK node because Foundry applies 63/64.
  - Worker integration tests against a test drand config with a fake relay.
  - An upgrade test.
- **Internal review:** written checklists in `docs/reviews/` for the coordinator, `VRFDerivation` and the SVDW `hashToPoint`/`mapToPoint`.
- **README "Security status" table:**
  - One row per component: source and pin, the bar it passed, links to its tests and reviews, and "not externally audited".
  - It also records the known gap of no constant-time guarantee in the prover.
  - Banned phrases: "audited", "production-ready".
- **Demo gate:** all suites green and every High-or-above finding fixed.

## Deployment (chain 31)

From [#24](https://github.com/mangekyou-labs/rsk-vrf/issues/24):

1. Create a SafeL2 v1.4.1, 2-of-3, on safe.rootstock.io, with hardware signers held by at least two people.
2. A one-off deployer EOA runs a single `forge script`:
   1. deploy the implementation and the `ERC1967Proxy` with `initialize(owner = deployer)`;
   2. add the `evmnet` drand config;
   3. register the Proving Key with Payee = Safe;
   4. set the fee to 2e13 and the Callback Gas Cap to 200k;
   5. `transferOwnership(Safe)`.
3. The Safe calls `acceptOwnership`. A check script then asserts the owner, an empty `pendingOwner`, the implementation slot and every config value. Discard the deployer key only after it passes.
4. Verify the implementation and the proxy on Blockscout and Sourcify (both required). The Rootstock Explorer is best-effort.
5. Commit `deployments/31.json`.

## Demo

From [#24](https://github.com/mangekyou-labs/rsk-vrf/issues/24):

- **Order:**
  1. deploy;
  2. chain 31 gate (demo scripts with assertions);
  3. drill (failover → Rotation → Revocation);
  4. an announced outage window of at least 1,250 blocks for the timeout Refund, with an Incident Note publishing the withheld proof;
  5. the final demo run against the post-rotation Active Key, then publish `docs/demo.md`.
- **Scenarios** (each with a Blockscout link):
  - An independent script recomputes Beta, and the noble and Go proofs match.
  - `DemoDice` uses the callback plus `deriveRandomInRange(1, 6)`.
  - An EOA request uses the read path.
  - `RevertingConsumer` emits `CallbackFailed` while the fee still settles.
  - The Safe calls `withdrawFees`.
  - `timeoutRefund` runs after the outage window.
  - Mined reverted transactions show the rejections: invalid (a corrupted Gamma or `s`), mismatched (request A's proof on request B, or the wrong drand round) and repeated (a resubmit on a Fulfilled request).
- **Reporting:** the missed-Deadline count is reported, with a target of 0.

## Build order

Each slice is meant to become one implementation issue. A slice starts when the slices it depends on are done.

1. **Scaffold:** the Foundry project, CI, vendored `VRF.sol` and `BLS.sol` with blob-hash pins.
2. **Proof vectors:** `tools/vrf-vectors-go/`, the committed vector file, the `VRF.sol` positive and negative suites. *(after 1)*
3. **drand verification:** `DrandEvmnet`, the evmnet round vectors, the hash-to-G1 differential vectors, the BLS negative suite. *(after 1)*
4. **`VRFDerivation` + `VRFConsumer`** with the Alpha/Beta/derive golden vectors. *(after 1)*
5. **Coordinator core:**
   - request, fulfill, callback, the derive views, timeout Refund, `withdrawFees`;
   - the Key Registry and the Admin setters;
   - UUPS and `Ownable2Step`;
   - the full error set and its negative tests, the storage-layout and size gates.

   *(after 2, 3, 4)*
6. **rskj regtest CI:** the `CALLBACK_RESERVE` boundary search and the upgrade test. *(after 5)*
7. **Worker prover:** the noble ECVRF and RFC 6979 nonce, byte-equal to the Go vectors, plus `keygen` and `check-key`. *(after 2)*
8. **Worker service:** chain polling, the readiness and reorg rules, drand fetch, `eth_call` simulation, transaction management, grace blocks, the watchdog and alerts, and integration tests on regtest with the fake drand relay. *(after 5, 6, 7)*
9. **Infra:** Terraform, the Docker Compose stack, the image pipeline, alert wiring, and the provisioning measurements. *(after 8)*
10. **Deploy scripts:** the `forge` deploy script, the Safe hand-off check, verification, `deployments/31.json`. *(after 5)*
11. **Runbooks and reviews:** `docs/runbooks/*`, the `docs/reviews/*` checklists, the README Security status, and the consumer guide. *(after 5, 8)*
12. **Chain 31 rollout:** deploy, then the gate, the drill, the outage window, and the demo scripts with `docs/demo.md`. *(after 9, 10, 11)*
