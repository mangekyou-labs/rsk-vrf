# Consume a verified Beta

The coordinator accepts a `bytes32` Request Tag and exactly the current native rBTC fee. `request(tag)` works for EOAs and contracts and never attempts a callback. `requestWithCallback(tag)` requires deployed contract code and freezes the Admin's current Callback Gas Cap for that request.

Inherit `VRFConsumer`, pass the coordinator address to its constructor, and implement `fulfillRandomness(bytes32 requestId, bytes32 beta)`. The base's immutable `coordinator` authenticates `onRandomness`; callers other than that address revert with `OnlyCoordinator`. Make the request from the consumer itself, because delivery and Refund always go to the Requester.

```solidity
import {VRFConsumer} from "./VRFConsumer.sol";
import {VRFDerivation} from "./VRFDerivation.sol";

// Inside a VRFConsumer subclass:
function fulfillRandomness(bytes32 requestId, bytes32 beta) internal override {
    uint256 die = VRFDerivation.randomInRange(beta, keccak256("dice"), 1, 6);
    // Record the result for the already locked inputs associated with requestId.
}
```

Only use the library with verified Beta received through the authenticated hook, or recovered from the coordinator's Fulfilled request record. The coordinator's public `deriveRandomBytes`, `deriveRandom` and `deriveRandomInRange` views reject Unknown, Pending and Refunded requests. Beta remains readable forever.

`deriveRandomBytes(requestId, context)` hashes `abi.encode(keccak256("rsk-vrf/v1/derive"), context, beta)`. `deriveRandom` returns that entire 256-bit word. A Derivation Context separates uses of the same Beta; it adds no entropy. Request Tags identify requests and are separate from Derivation Contexts.

`deriveRandomInRange(requestId, context, min, max)` includes both endpoints and reverts with `InvalidRange` if `min > max`. The full `[0, type(uint256).max]` range returns the `deriveRandom` word. Other spans hash `abi.encode(keccak256("rsk-vrf/v1/range"), context, beta, counter)` starting at counter zero, accept the first word below `2**256 - (2**256 % span)`, and return `min + word % span`. Rejection sampling has no retry cap, so there is no modulo bias. Singleton ranges return their sole value.

## Callbacks

Fulfillment commits the verified Beta and credits the Payee before attempting one capped callback. A revert or out-of-gas callback emits `CallbackFailed(requestId)` and leaves the request Fulfilled and its fee settled. Return data is not copied. There is no callback retry or stored callback status.

Reverting in a callback does not reject the Beta. The Beta stays Fulfilled, and the fee stays with the Payee. Recover a missed callback through the derive views or `getRequest(requestId)`. Callback code may make new requests, but must budget their fee and gas.

## Rootstock has no 63/64 rule

Rootstock does not apply the EIP-150 63/64 rule, and its maximum call depth is 400. These are the results for consumers:

- The coordinator gives the callback exactly the frozen Callback Gas Cap. Before the call, `fulfill` reverts with `InsufficientGasForCallback` if `gasleft()` is less than the cap plus `CALLBACK_RESERVE` (10,000 gas). Thus a Fulfiller cannot send a short gas limit to make your callback fail. That `fulfill` reverts, and the request stays Pending until a fulfillment with sufficient gas.
- Inside your callback, a call that forwards all of `gasleft()` keeps no 1/64 for your code. Give each sub-call an explicit gas limit, and keep sufficient gas to complete your own work after the sub-call.
- Foundry applies the 63/64 rule. Thus a Foundry test can pass for a gas-sensitive callback that fails on Rootstock. Test such callbacks on an RSK node, as `worker/integration/callbacks.test.ts` does on regtest.

## Selective Abort rules

These four rules are binding. They are also in the `VRFConsumer` NatSpec. The holder of the Proving Key learns Beta first and can withhold fulfillment until the Deadline (a Selective Abort). It cannot select a different Beta. These rules make sure that a Selective Abort gives the holder of the Proving Key no advantage.

1. Lock every input that affects the outcome before you call `request`.
2. Never make a new request to replace a request that got a Refund. A new request is a reroll.
3. When fulfillment is withheld, use a neutral default that does not favour the operator, for example void the round and return the stakes. Operator-affiliated parties must not be players in a consumer whose default benefits them.
4. Treat a Revocation Refund exactly like a timeout Refund.

## Refunds

Callback consumers must accept native rBTC Refunds, for example with `receive() external payable {}`. Anyone may trigger a Refund after the Deadline or after key Revocation; the transfer still goes to the original Requester. A reverting receiver prevents that Refund transaction from completing. The request then stays Pending, and its Escrow stays in the coordinator until the Requester accepts the transfer.

## Security status

The verifier code and the coordinator are not externally audited. Use this service only on testnet, and not for value. See the [Security status](../README.md#security-status) table for each component.
