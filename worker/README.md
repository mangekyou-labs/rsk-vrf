# Worker tracer

Node 24+, `npm ci`, `npm run typecheck`, `npm test`.

`npm start` runs the polling tracer. Configure:

- `RSK_RPC_URL`: Rootstock JSON-RPC endpoint.
- `COORDINATOR_ADDRESS`: deployed coordinator proxy.
- `DRAND_RELAY_URL`: drand relay base URL exposing `/public/<round>` (the beacon must match the coordinator's frozen config).
- `FROM_BLOCK`: first block to scan, inclusive. Use the deployment block for a new process.
- `FULFILLER_PRIVATE_KEY`: funded Fulfiller EOA's 0x-prefixed key, supplied through the process environment. It is removed from `process.env` after loading. Production signing custody is a later ticket.
- `PROVING_KEY_HASH` (optional): serve this registered key, including a Draining Key. Defaults to the Active Key at startup.

The Proving Key loads into memory from AWS Secrets Manager at `rsk-vrf/proving-key/<keyHash>`, using the AWS credential provider chain. Use `worker keygen` and `worker check-key <keyHash>` for provisioning and verification. The worker logs only public request outcomes. It reads each queued request and its frozen drand config at `latest`, waits for confirmations and the Target Round, creates the noble proof, simulates `fulfill` as the Fulfiller EOA, and sends the simulated transaction only if simulation succeeds. Failed relay calls and simulations remain queued for the next poll (10 seconds).

This tracer holds its cursor and pending IDs in memory. Run one instance per key and choose `FROM_BLOCK` explicitly on restart. Durable cursors, reorg handling, replacement transactions and relay failover are tracked in #35.

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

The test spawns a loopback-only Go relay signing arbitrary rounds with the **public test drand key** from `coordinator-vectors.json`; no live beacon, credentials, AWS, or network relay is needed. It deploys implementation and proxy, funds separate Requester and Fulfiller EOAs from rskj's public genesis key, registers a noble Proving Key, and fulfills through the worker. It checks that a future round is retained; a wrong-round signature fails real `eth_call` without changing the Fulfiller nonce; retry fulfills; and onchain Beta and `deriveRandom` match the independent pinned Go prover.

The committed golden traces bind chain 31, fixed addresses and timestamps. They cannot be used verbatim on a dynamic chain-33 deployment. Worker unit tests reproduce their Alpha, proof bytes and Beta exactly; a Go regression test binds the fake relay's expected-value endpoint to the same golden trace. The live test asks that independent Go endpoint to bind the actual chain, addresses, request ID and round. Worker time is injected only to exercise future-round waiting immediately; the coordinator still verifies the real BLS signature and noble proof on rskj.
