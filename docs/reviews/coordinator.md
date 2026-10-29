# VRFCoordinator review

Internal self-review of `contracts/src/VRFCoordinator.sol` at commit `07dd2e6`. The reviewer is an AI coding agent that works for the author. No second person reviewed the code. This is not an external audit. The review checks the code against `docs/spec.md`, ADR 0001, and the decisions in issues #5, #6, #7, #9, #11, #12 and #19.

This note does not cover the vendored `VRF.sol` or `BLS.sol`. `VRF.sol` has the bar from #12: a verbatim copy and our own tests. `BLS.sol` hash-to-point is in [svdw-hash-to-point.md](svdw-hash-to-point.md). `VRFDerivation` is in [vrf-derivation.md](vrf-derivation.md).

Severity scale:

- **Critical**: a Fulfiller, Requester or stranger can steal Escrow or fees, or can choose Beta.
- **High**: an attacker can lock funds of other users, or can make the coordinator accept a wrong Beta.
- **Medium**: a user can lose their own funds through a documented mistake, or the Admin trust is wider than the spec says.
- **Low**: a limit or an Admin error case that the spec does not name.
- **Info**: a fact that a later reader needs. No defect.

## Result

No Critical or High finding. One guard test was added (finding 8). No contract code changed.

## What was checked

- [x] **Identifiers.** `requestId`, Alpha and Beta use `abi.encode` with the domains and fields in the spec. `address(this)` is the proxy. `proof.seed` is not read. `_randomValueFromVRFProof` gets `uint256(alpha)` as the seed. The golden vectors pin all three values (`test_RequestFulfillDeriveMatchesGoldenVectors`, `test_FulfillIgnoresProofSeed`).
- [x] **`fulfill` check order.** The code runs the ten checks in the order of the spec table. Each check has a negative test in `VRFCoordinator.t.sol`, `VRFNegative.t.sol`, `VRFCallbacks.t.sol` or `VRFAdmin.t.sol`. The Deadline check runs before the proof checks (`test_FulfillRejectsAfterDeadlineBeforeProofChecks`).
- [x] **Beta is unique for each request.** The drand signature is a G1 point. G1 has prime order and the pairing is non-degenerate, so only one point passes for one round. `BLS.isValidSignature` rejects a coordinate `>= N`, so that point has only one encoding. The VRF output is `keccak256(gamma)`, and `gamma` is fixed by the key and Alpha. A Fulfiller cannot choose between two Betas.
- [x] **Effects before interactions.** `fulfill` writes the status, Beta and the Payee credit, then emits `Fulfilled`, then calls the callback. Nothing is written after the call. `timeoutRefund` and `withdrawFees` write state before the transfer and are `nonReentrant`.
- [x] **Reentrancy.** `fulfill` has no lock. A callback is a contract, so `msg.sender != tx.origin` stops a call back into `fulfill` (`test_CallbackSeesSettledBetaAndFeeCanRequestAgainButCannotReenterFulfill`). A callback can call `timeoutRefund` for another request. That is safe because the current request is already Fulfilled.
- [x] **Callback call.** The call passes exactly the cap, with value 0 and `retOffset = retSize = 0`. Large return data and large revert data do not cost the coordinator gas (`test_LargeReturnDataIsIgnored`, `test_LargeRevertDataDoesNotUndoFulfillment`). The gas check runs two times: before effects and after calldata encoding.
- [x] **Fee accounting.** The coordinator balance equals the open Escrow plus the Payee balances. Only `request` adds value. Only `timeoutRefund` and `withdrawFees` remove value, and each one first sets the matching record to zero or to Refunded. The contract has no `receive` or `fallback`. No Admin function moves Escrow or Payee balances.
- [x] **Frozen terms.** Each request stores its fee, Callback Gas Cap, confirmations, Deadline, Target Round, drand config and key. Admin changes do not change open requests (`test_ConfigChangesFreezeOpenRequestsAndSetNewRequestTerms`, `test_OffsetTimeoutAndConfirmationsAreFrozenForOpenRequests`).
- [x] **Key lifecycle.** Keys are never reused or deleted. A Draining Key can still fulfill its own requests until each Deadline. Revocation is final. Retired is safe to derive: a key goes to Draining in block `drainingSince`. After that block, no new request binds to it. So every request bound to it has `deadline <= drainingSince + MAX_TIMEOUT_BLOCKS`.
- [x] **Request record.** Slot 0 holds 20 + 1 + 4 + 6 + 1 = 32 bytes. Slot 1 holds 12 + 8 + 6 + 2 + 4 = 32 bytes. Slot 2 holds Beta. This matches the spec table.
- [x] **Storage.** `STORAGE_LOCATION` was computed again with `cast keccak` and the ERC-7201 formula. It is `0x93e4…8900`, the same as the constant. OpenZeppelin is v5.7.0. Its `ReentrancyGuard` uses a namespaced slot, so it does not use proxy slot 0.
- [x] **Upgrade and initialize.** The implementation constructor calls `_disableInitializers` (`test_ImplementationCannotBeInitialized`). The deploy script creates the proxy and calls `initialize` in one transaction. `_authorizeUpgrade` is `onlyOwner`. `initializeAdminParameters` reverts on a new deployment (`test_AdminMigrationCannotResetNewDeploymentOrBeCalledByStranger`).
- [x] **Overflow.** Target Round, `requestBlock + timeoutBlocks` and the drand config count revert before a cast can truncate (`test_TargetRoundOverflowRevertsRatherThanTruncates`, `test_DrandConfigIdsNeverWrap`).

## Findings

1. **Medium. A Requester that cannot accept rBTC keeps its Escrow locked.** `timeoutRefund` pushes the Escrow to the Requester. If the Requester reverts on receive, the Refund reverts and the request stays Pending. After the Deadline or a Revocation, nobody can fulfill it. The funds are the Requester's own funds. Issue #6 chose the push model. Handled: no code change. The consumer guide and the `VRFConsumer` NatSpec tell callback consumers to accept rBTC Refunds. `test_FailedRefundKeepsEscrowAndPendingStatusUntilRequesterAccepts` pins the behaviour.

2. **Low. `registerProvingKey` accepts Payee `address(0)`.** Fees credited to `address(0)` can never be withdrawn. Only the Admin can cause this. Handled: no code change. `DeploymentAssertions` requires Payee = Safe for the first key. For each later Rotation, check the Payee in the Safe transaction before you sign it.

3. **Low. The owner can call `renounceOwnership`.** `Ownable2StepUpgradeable` keeps this function. After it, nobody can upgrade, register a key or revoke a key. Revocation is the emergency stop, so this removes it. Only the Admin Safe can call it. Handled: no code change. Do not sign a Safe transaction that calls it.

4. **Low. Target Round uses `block.timestamp`.** A Rootstock miner can move the timestamp a small amount. If a block timestamp is late by more than the round offset (40 rounds, 120 s for `evmnet`), the Target Round is already public when the request lands. Beta still needs the Proving Key, so a Requester alone gains nothing. Handled: no code change. The Admin can increase `roundOffset` if Rootstock timestamps drift.

5. **Info. The EOA rule depends on Rootstock not having EIP-7702.** With EIP-7702, an EOA can run code, and `msg.sender == tx.origin` no longer proves call depth 1. Handled: no code change. Read ADR 0001 again if Rootstock adds EIP-7702.

6. **Info. The owner can add a drand config with any valid G2 key.** A key that the owner controls makes the drand part of Alpha known in advance. The owner can already upgrade the contract, so this adds no new power. The spec names `upgrade` as the trust boundary. Handled: no code change.

7. **Info. Any EOA can copy a proof from the mempool and submit it.** Beta, the Payee credit and the callback are the same. Only the `fulfiller` field of `Fulfilled` changes. Handled: no code change.

8. **Info. No coordinator test used a second encoding of a valid drand signature.** The library suite (`DrandNegative.t.sol`) covers coordinates `>= p`. The coordinator relies on this check for Beta uniqueness, so a coordinator-level test is useful. Handled: added `test_FulfillRejectsNonCanonicalEncodingOfValidDrandSignature`. It adds `N` to x, then to y, of a real signature and expects `InvalidDrandSignature`. It passed on the first run, because the code was already correct.

9. **Info. Foundry applies the 63/64 rule and Rootstock does not.** Foundry tests cannot find the exact `CALLBACK_RESERVE` boundary. The spec puts that search on an RSK node (`CallbackReserveProbe`). Handled: no code change.

## Not covered

- The worker, the deploy scripts and the runbooks.
- Gas costs on a real Rootstock node, other than the probe in finding 9.
- Selective Abort by the operator. Issue #11 handles it with deterrence, not with code.
