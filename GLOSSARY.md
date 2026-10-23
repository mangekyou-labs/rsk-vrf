# Rootstock VRF Service

A verifiable randomness service on Rootstock testnet: consumers request randomness, an oracle proves the output, and the coordinator verifies it on-chain.

## Language

### Roles

**Proving Key**:
The oracle's secp256k1 VRF secret and its registered public key; the only authority over what output a request receives.
_Avoid_: oracle key, signing key, VRF keypair

**Fulfiller**:
An externally owned account that submits fulfillment transactions directly and pays their gas; it holds no authority over outputs.
_Avoid_: oracle address, relayer, submitter

**Admin**:
The party that controls the coordinator's key registry and parameters.
_Avoid_: owner, operator

**Payee**:
The address that receives the oracle's fees for a given Proving Key, fixed when the key is registered.
_Avoid_: fee recipient, beneficiary

### Key lifecycle

**Key Registry**:
The coordinator's permanent record of every Proving Key it has ever accepted and that key's state.

**Active Key**:
The single Proving Key that new requests are bound to.
_Avoid_: current key, default key

**Draining Key**:
A formerly Active Key that may still fulfill only the requests already bound to it.

**Retired Key**:
A Proving Key with no remaining requests it may fulfill, kept on record so its past proofs stay attributable.

**Revoked Key**:
A Proving Key the Admin has declared compromised; it may fulfill nothing and its pending requests become refundable at once.
_Avoid_: disabled key, banned key

**Rotation**:
Replacing the Active Key with a new one in the routine course of operation, letting the old key drain.
_Avoid_: key swap, rekey

**Revocation**:
The Admin's response to a compromised Proving Key; distinct from Rotation.

**Backup Worker**:
A second oracle worker holding the same Proving Key that fulfills only requests the primary has left unfulfilled for a set grace period.
_Avoid_: standby, failover node

**Operator Funding Wallet**:
The operator's own account that tops up each Fulfiller's gas balance; it holds no authority over the coordinator or outputs.
_Avoid_: treasury, hot wallet

**Incident Note**:
A public written account of an operational event (a missed Deadline, a Revocation and its reason), published so consumers can judge it was not a Selective Abort.
_Avoid_: postmortem, status update

### Randomness

**Alpha**:
The VRF input for one request, fixing that request's identity, its consumer, and its Target Round's published value.
_Avoid_: seed, pre-seed, message

**Beta**:
The request's verified random output, derived from the proof over Alpha; the only value consumers receive.
_Avoid_: randomness, result, random word

**Derivation Context**:
A label a reader supplies to draw an independent value from a request's Beta; it carries no entropy.
_Avoid_: context (alone), request context, salt

### Requests

**Requester**:
The account that made a request; the only party a request's callback is delivered to and its refund returned to.
_Avoid_: caller, consumer (when meaning the request's owner)

**Request Tag**:
A label the Requester attaches to a request to tell its own requests apart; it carries no entropy.
_Avoid_: seed, user seed, request context

**Target Round**:
The future drand round a request is bound to, fixed at the moment the request is made; its value is unknown to everyone, the oracle included, until drand publishes it.
_Avoid_: committed round, seed round

**Fulfillable**:
A pending request whose confirmation wait has passed, so a proof for it will now be accepted; it stays Fulfillable until its Deadline.
_Avoid_: eligible, ready, mature

**Deadline**:
The last block in which a request may still be fulfilled; after it, the request can only be refunded.
_Avoid_: expiry, timeout window

**Selective Abort**:
Withholding fulfillment of a request after its Beta is knowable, so that it ends in Refund rather than delivery.
_Avoid_: withholding attack, griefing, last-revealer

**Callback Gas Cap**:
The gas a request's callback is both guaranteed and limited to, fixed when the request is made.
_Avoid_: callback gas limit (when meaning the per-request value), gas stipend

**Failed Callback**:
A callback that reverted or ran out of gas; the request stays Fulfilled and is never called back again.
_Avoid_: failed fulfillment, retry

### Fees

**Escrow**:
The fee a request locks when it is made, held by the coordinator until it is credited to the Payee on fulfillment or returned to the Requester on refund.
_Avoid_: deposit, payment

**Refund**:
The return of a request's Escrow to its Requester, allowed only once its Deadline has passed or its Proving Key is Revoked.
_Avoid_: cancellation, reimbursement

