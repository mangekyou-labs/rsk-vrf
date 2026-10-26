# Resilient worker

Node 24+, `npm ci`, `npm run typecheck`, `npm test`.

`npm start` runs the polling worker. Configure:

- `RSK_RPC_URL`: Rootstock JSON-RPC endpoint.
- `COORDINATOR_ADDRESS`: deployed coordinator proxy. Alternatively, `COORDINATOR_DEPLOYMENT_FILE` names a `deployments/<chainId>.json` record from `contracts/script/deploy.sh`, and the worker reads the proxy address from it. The record's `chainId` must match the RPC's. Set one or the other, not both.
- `DRAND_RELAY_URLS`: comma-separated relay base URLs tried in order. The first well-formed `/public/<round>` wins. `DRAND_RELAY_URL` sets one relay. With neither set, the process uses `https://api.drand.sh`, `https://api2.drand.sh`, and `https://api3.drand.sh`.
- `DRAND_PIN_PUBLIC_KEY`, `DRAND_PIN_GENESIS`, `DRAND_PIN_PERIOD`: required pin of the frozen beacon. A mismatch is reported once and that config is not served.
- `GRACE_BLOCKS`: blocks after the request's confirmations. Unset or empty is `0` (primary). A backup uses `100`.
- `FULFILLER_PRIVATE_KEY`: funded Fulfiller EOA's 0x-prefixed key, supplied through the process environment. It is removed from `process.env` after loading. Production signing custody is a later ticket.

At startup the worker loads every Active and Draining Proving Key into memory from AWS Secrets Manager at `rsk-vrf/proving-key/<keyHash>`, and prints one line per key with its keyId, keyHash, whether it is held using structured JSON. A key with no secret is reported as not held. On each `KeyStateChanged` event it reloads the key set and evicts Revoked keys; Retired keys emit no event, so each request also checks its key's state and evicts a Revoked or Retired key. After rotation the worker serves both the Draining Key (for requests made before) and the new Active Key; it never fulfills for a Revoked or Retired key, and anyone may refund a request bound to a Revoked key at once with `timeoutRefund`. Keys load using the AWS credential provider chain. Use `worker keygen` and `worker check-key <keyHash>` for provisioning and verification. The worker logs only public request outcomes. Requests pay the exact current `fee()` in native rBTC (default 2e13 wei). Fulfillment credits the bound key's Payee, who claims it with `withdrawFees()`. Anyone may call `timeoutRefund(requestId)` after the frozen Deadline; the Escrow returns to the Requester. This worker never calls `timeoutRefund`.

Each poll scans `latest − 2,400 − 100`, keeps an id until Fulfilled or Refunded is 12 blocks deep, and does not delete or send on deadline. It waits for confirmations, grace, and the pinned round, simulates `fulfill`, and sends a legacy transaction only when simulation succeeds. At most eight fulfills stay in flight, earliest deadline first, from 1.1× the quoted gas price up to `80 × minimumGasPrice − 1`. Each fulfillment budgets 652k gas plus 20k per additional hash-to-curve try and the entire frozen callback cap. Below the cost of twenty maximum-cap fulfills it sends nothing; larger proofs or replacement prices raise that reserve. A missing nonce is rebroadcast or filled with a self-transfer. A beacon still down 30 seconds after the round is reported once; the id stays pending. Failed simulations wait for the next poll (10 seconds). Refunded requests leave the queue after twelve blocks; Pending requests past their Deadline stay tracked for proof publication without sending a fulfillment.

Pending ids live in memory and are rediscovered from the chain. Run one primary per key, and optionally the same binary as a backup with `GRACE_BLOCKS=100` and its own Fulfiller. Same-Fulfiller restart before mining is covered by regtest. Reorg recovery and three-block replacement timing are covered by `pollOnce` unit tests, not the pinned regtest node: `evm_mine` cannot omit one pending transaction.

## Offline full loop

The integration test requires an actual **rskj regtest** node (chain ID 33) with manual mining enabled. It does not skip if the node is absent. CI starts pinned `rsksmart/rskj:VETIVER-9.0.4` with:

```
DEFAULT_JVM_OPTS=-Xms256m -Xmx1g
RSKJ_OPTS=--regtest
RSKJ_SYS_PROPS=-Drpc.providers.web.http.bind_address=0.0.0.0 -Drpc.providers.web.http.hosts.0=localhost -Drpc.providers.web.http.hosts.1=127.0.0.1 -Drpc.providers.web.http.hosts.2=::1 -Dminer.client.enabled=false -Dminer.server.enabled=true -Dtransaction.accountTxRateLimit.enabled=false
```

The final property disables the development node's per-account transaction quota for deployment bursts; it is not a production configuration recommendation. For a Java 17 jar invocation use the same properties and `co.rsk.Start --regtest`.

```sh
(cd contracts && forge build)
(cd tools/vrf-vectors-go && go build -o /tmp/rsk-vrf-test-relay .)
cd worker
RSK_RPC_URL=http://127.0.0.1:4444 TEST_RELAY_BIN=/tmp/rsk-vrf-test-relay npm run test:integration
```

The test spawns a loopback-only Go relay signing arbitrary rounds with the **public test drand key** from `coordinator-vectors.json`; no live beacon, credentials, AWS, or network relay is needed. It deploys implementation and proxy, funds separate Requester and Fulfiller EOAs from rskj's public genesis key, registers a noble Proving Key, and fulfills through the worker. It checks that a future round is retained; a wrong-round signature fails real `eth_call` without changing the Fulfiller nonce; retry fulfills; and onchain Beta and `deriveRandom` match the independent pinned Go prover. It also checks Payee settlement and withdrawal, mines past the frozen Deadline, refunds after a fee change, and verifies that the worker retains an outcome for twelve blocks and keeps expired Pending requests without sending. Further cases check that the worker holds every Active and Draining key at startup, follows `KeyStateChanged` (evicting a Revoked key, loading a new Active one), and reports a missing secret or load failure as not held without exposing provider error messages.

The same regtest flow populates custom Admin parameters, a second drand config, a pending ownership transfer, and a Pending request. It mines a rejected non-Admin upgrade, upgrades the proxy as the Admin, checks that state, earned fees and prior Beta survive, and fulfills the pre-upgrade request with an independently cross-checked Beta. The upgrade target is a test-only `VRFCoordinatorV2` contract.

`deploy.test.ts` runs `contracts/script/deploy.sh` against the node with a Safe stand-in contract. It checks the written deployment record against the receipts. It then requires `CheckDeployment` to fail before the stand-in accepts ownership, pass after it, and fail on an edited record. See [the deploy guide](../docs/development/deploy.md).

The committed golden traces bind chain 31, fixed addresses and timestamps. They cannot be used verbatim on a dynamic chain-33 deployment. Worker unit tests reproduce their Alpha, proof bytes and Beta exactly; a Go regression test binds the fake relay's expected-value endpoint to the same golden trace. The live test asks that independent Go endpoint to bind the actual chain, addresses, request ID and round. Worker time is injected only to exercise future-round waiting immediately; the coordinator still verifies the real BLS signature and noble proof on rskj.

## Watchdog and alert delivery

Each primary and Backup Worker independently monitors requests and sends pages to a private ntfy topic and warnings to a chat webhook. Configure each process with:

- `WORKER_ID`: a distinct public label, such as `primary-eu` or `backup-us`.
- `ALERT_PAGE_URL`: the full private ntfy topic URL. `ALERT_PAGE_TOKEN` optionally supplies its Bearer token. Restrict topic access in ntfy; topic names alone are not access control.
- `ALERT_WARNING_URL`: a chat webhook accepting JSON `{ "text": "<alert JSON>" }`.
- `OWN_FULFILLER_ADDRESSES`: comma-separated addresses of both workers' Fulfillers. The local Fulfiller is always included. Any other fulfillment pages as a possible leaked Proving Key.
- `TOP_UP_FULFILLMENTS`: warn below this many maximum-cap fulfillment costs, default `100`; must exceed the page floor of `20`.
- `HEALTHCHECKS_PING_URL`: this worker's unique healthchecks.io ping URL. Configure a 1-minute period and a 4-minute grace for the external dead-man's-switch page.

Alerts and runtime logs are structured JSON; integer quantities are decimal strings so publication preserves the complete proof. Pages use ntfy's `urgent` priority. Warnings contain the same JSON in the webhook's `text` field. Failed deliveries log `alert_delivery_failed` without the destination or response body, and retry on the next poll while the condition persists. Configure separate checks and worker identifiers in each region.

A heartbeat follows a completed poll at most once per minute. A stalled or failed poll sends no heartbeat; no independent timer can mask a blocked worker. A failed heartbeat is retried after the next completed poll. Alert and heartbeat requests time out after five seconds and reject redirects.

Pages cover the oldest Pending request reaching 50% of its frozen request-to-Deadline window, any missed Deadline, fulfillment by an unrecognized Fulfiller, every Key Registry event, a balance below twenty fulfillment costs, a drand pin mismatch, and a Pending request whose serving key is absent. Warnings cover the oldest request reaching 25%, the configured top-up threshold, an overdue unavailable drand round, RPC failures, and a syncing node. Reserve checks subtract locally reserved transaction costs and increase for larger proofs and replacement prices. Conditions rearm after recovery; event pages deduplicate by block hash and log position.

A missed-Deadline page and its JSON log include the withheld public proof, Alpha, Beta, drand signature, key binding and request context. This also covers Deadline refunds discovered after restart. The worker validates the complete fulfillment with a historical call at the request's final valid block; its RPC must retain that state. A Retired held key may produce this incident proof without being enabled for fulfillment; a Revoked key cannot. If the key, beacon or historical validation is unavailable, the worker pages immediately with `proof: null` and a public reason, then retries and sends a new proof-bearing page on recovery. Deadline refunds remain tracked until proof delivery succeeds. No proving secret or signing key is included.
