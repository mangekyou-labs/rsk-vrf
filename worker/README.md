# Worker tracer

Node 24+, `npm ci`, `npm run typecheck`, `npm test`.

`npm start` runs the polling tracer. Configure:

- `RSK_RPC_URL`: Rootstock JSON-RPC endpoint.
- `COORDINATOR_ADDRESS`: deployed coordinator proxy.
- `DRAND_RELAY_URL`: drand relay base URL exposing `/public/<round>` (the beacon must match the coordinator's frozen config).
- `FROM_BLOCK`: first block to scan, inclusive. Use the deployment block for a new process.
- `FULFILLER_PRIVATE_KEY`: funded Fulfiller EOA's 0x-prefixed key, supplied through the process environment. It is removed from `process.env` after loading. Production signing custody is a later ticket.

At startup the worker loads every Active and Draining Proving Key into memory from AWS Secrets Manager at `rsk-vrf/proving-key/<keyHash>`, and prints one line per key with its keyId, keyHash, whether it is held and any load error message. A key with no secret is reported as not held. On each `KeyStateChanged` event it reloads the key set and evicts Revoked keys; Retired keys emit no event, so each request also checks its key's state and evicts a Revoked or Retired key. After rotation the worker serves both the Draining Key (for requests made before) and the new Active Key; it never proves for a Revoked or Retired key, and requests bound to a Revoked key can be refunded at once with `timeoutRefund`. Keys load using the AWS credential provider chain. Use `worker keygen` and `worker check-key <keyHash>` for provisioning and verification. The worker logs only public request outcomes. Requests pay the exact current `fee()` in native rBTC (default 2e13 wei). Fulfillment credits the bound key’s Payee, who claims it with `withdrawFees()`. Anyone may call `timeoutRefund(requestId)` after the frozen Deadline; the Escrow returns to the Requester.

It reads each queued request and its frozen drand config at `latest`, waits for confirmations and the Target Round, creates the noble proof, simulates `fulfill` as the Fulfiller EOA, and sends the simulated transaction only if simulation succeeds. Refunded requests and Pending requests past their hard Deadline leave the queue without a beacon fetch or a fulfillment send. Failed relay calls and simulations remain queued for the next poll (10 seconds).

This tracer holds its cursor and pending IDs in memory. Run one instance per coordinator and choose `FROM_BLOCK` explicitly on restart. Durable cursors, reorg handling, replacement transactions and relay failover are tracked in #35.

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

The test spawns a loopback-only Go relay signing arbitrary rounds with the **public test drand key** from `coordinator-vectors.json`; no live beacon, credentials, AWS, or network relay is needed. It deploys implementation and proxy, funds separate Requester and Fulfiller EOAs from rskj's public genesis key, registers a noble Proving Key, and fulfills through the worker. It checks that a future round is retained; a wrong-round signature fails real `eth_call` without changing the Fulfiller nonce; retry fulfills; and onchain Beta and `deriveRandom` match the independent pinned Go prover. It also checks Payee settlement and withdrawal, mines past the frozen Deadline, refunds after a fee change, and verifies that the worker drops both Refunded and expired requests without sending. Further cases check that the worker holds every Active and Draining key at startup, follows `KeyStateChanged` (evicting a Revoked key, loading a new Active one), and reports a missing secret as not held and a load failure with its message.

The same regtest flow populates custom Admin parameters, a second drand config, a pending ownership transfer, and a Pending request. It mines a rejected non-Admin upgrade, upgrades the proxy as the Admin, checks that state, earned fees and prior Beta survive, and fulfills the pre-upgrade request with an independently cross-checked Beta. The upgrade target is a test-only `VRFCoordinatorV2` contract.

The committed golden traces bind chain 31, fixed addresses and timestamps. They cannot be used verbatim on a dynamic chain-33 deployment. Worker unit tests reproduce their Alpha, proof bytes and Beta exactly; a Go regression test binds the fake relay's expected-value endpoint to the same golden trace. The live test asks that independent Go endpoint to bind the actual chain, addresses, request ID and round. Worker time is injected only to exercise future-round waiting immediately; the coordinator still verifies the real BLS signature and noble proof on rskj.
