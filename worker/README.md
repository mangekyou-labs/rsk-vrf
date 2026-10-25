# Worker tracer

Node 24+, `npm ci`, `npm run typecheck`, `npm test`.

`npm start` runs the polling tracer. Configure:

- `RSK_RPC_URL`: Rootstock JSON-RPC endpoint.
- `COORDINATOR_ADDRESS`: deployed coordinator proxy.
- `DRAND_RELAY_URLS`: comma-separated relay base URLs tried in order. The first well-formed `/public/<round>` wins. `DRAND_RELAY_URL` sets one relay. With neither set, the process uses `https://api.drand.sh`, `https://api2.drand.sh`, and `https://api3.drand.sh`.
- `DRAND_PIN_PUBLIC_KEY`, `DRAND_PIN_GENESIS`, `DRAND_PIN_PERIOD`: required pin of the frozen beacon. A mismatch is reported once and that config is not served.
- `GRACE_BLOCKS`: blocks after the request's confirmations. Unset or empty is `0` (primary). A backup uses `100`.
- `FULFILLER_PRIVATE_KEY`: funded Fulfiller EOA's 0x-prefixed key, supplied through the process environment. It is removed from `process.env` after loading. Production signing custody is a later ticket.
- `PROVING_KEY_HASH` (optional): serve this registered key, including a Draining Key. Defaults to the Active Key at startup.

The Proving Key loads into memory from AWS Secrets Manager at `rsk-vrf/proving-key/<keyHash>`, using the AWS credential provider chain. Use `worker keygen` and `worker check-key <keyHash>` for provisioning and verification. The worker logs only public request outcomes. Requests pay the exact current `fee()` in native rBTC (default 2e13 wei). Fulfillment credits the bound key's Payee, who claims it with `withdrawFees()`. Anyone may call `timeoutRefund(requestId)` after the frozen Deadline; the Escrow returns to the Requester. This worker never calls `timeoutRefund`.

Each poll scans `latest − 2,400 − 100`, keeps an id until Fulfilled or Refunded is `confirmations` deep, and does not delete or send on deadline. It waits for confirmations, grace, and the pinned round, simulates `fulfill`, and sends a legacy transaction only when simulation succeeds. At most eight fulfills stay in flight, earliest deadline first, from 1.1× the quoted gas price up to `80 × minimumGasPrice − 1`. Below the cost of twenty fulfills it sends nothing. A missing nonce is rebroadcast or filled with a self-transfer. A beacon still down 30 seconds after the round is reported once; the id stays pending. Failed simulations wait for the next poll (10 seconds). Refunded requests and Pending requests past their Deadline leave the queue without a beacon fetch or a fulfillment send.

Pending ids live in memory and are rediscovered from the chain. Run one primary per key, and optionally the same binary as a backup with `GRACE_BLOCKS=100` and its own Fulfiller. Reorg recovery, and replacement of a transaction a mined block omits, were not shown on the pinned regtest node.

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

The test spawns a loopback-only Go relay signing arbitrary rounds with the **public test drand key** from `coordinator-vectors.json`; no live beacon, credentials, AWS, or network relay is needed. It deploys implementation and proxy, funds separate Requester and Fulfiller EOAs from rskj's public genesis key, registers a noble Proving Key, and fulfills through the worker. It checks that a future round is retained; a wrong-round signature fails real `eth_call` without changing the Fulfiller nonce; retry fulfills; and onchain Beta and `deriveRandom` match the independent pinned Go prover. It also checks Payee settlement and withdrawal, mines past the frozen Deadline, refunds after a fee change, and verifies that the worker drops both Refunded and expired requests without sending.

The same regtest flow populates custom Admin parameters, a second drand config, a pending ownership transfer, and a Pending request. It mines a rejected non-Admin upgrade, upgrades the proxy as the Admin, checks that state, earned fees and prior Beta survive, and fulfills the pre-upgrade request with an independently cross-checked Beta. The upgrade target is a test-only `VRFCoordinatorV2` contract.

The committed golden traces bind chain 31, fixed addresses and timestamps. They cannot be used verbatim on a dynamic chain-33 deployment. Worker unit tests reproduce their Alpha, proof bytes and Beta exactly; a Go regression test binds the fake relay's expected-value endpoint to the same golden trace. The live test asks that independent Go endpoint to bind the actual chain, addresses, request ID and round. Worker time is injected only to exercise future-round waiting immediately; the coordinator still verifies the real BLS signature and noble proof on rskj.
