# Consume verified randomness

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

`deriveRandomInRange(requestId, context, min, max)` includes both endpoints and reverts with `InvalidRange` if `min > max`. The full `[0, type(uint256).max]` range returns the `deriveRandom` word. Other spans hash `abi.encode(keccak256("rsk-vrf/v1/range"), context, beta, counter)` starting at counter zero, reject words below `2**256 % span`, and return `min + word % span`. Rejection sampling has no retry cap, so there is no modulo bias. Singleton ranges return their sole value.

Fulfillment commits the verified Beta and credits the Payee before attempting one capped callback. A revert or out-of-gas callback emits `CallbackFailed(requestId)` and leaves the request Fulfilled and its fee settled. Return data is not copied. There is no callback retry or stored callback status. Recover a missed callback through the derive views or `getRequest(requestId)`; reverting in a callback cannot reject the randomness. Callback code may make new requests, but must budget their fee and gas.

Consumers must implement these Selective Abort rules:

1. Lock all outcome inputs before requesting randomness.
2. Never make a replacement request because an earlier request received a Refund.
3. Use a neutral default that does not favour the operator when fulfillment is withheld.
4. Treat a Revocation Refund exactly like a timeout Refund.

Callback consumers must accept native rBTC Refunds, for example with `receive() external payable {}`. Anyone may trigger a Refund after the Deadline or after key Revocation; the transfer still goes to the original Requester. A reverting receiver prevents that Refund transaction from completing.
