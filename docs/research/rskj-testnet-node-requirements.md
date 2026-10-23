# rskj testnet node requirements

Research for [issue #22](https://github.com/mangekyou-labs/rsk-vrf/issues/22) (consumer: [#21](https://github.com/mangekyou-labs/rsk-vrf/issues/21), Oracle Worker Design, one rskj node per worker host).

Date of probes: 2026-10-23. Target: Rootstock testnet, chain ID 31.

Method: primary sources only. rskj source and config at tag `VETIVER-9.0.4` (commit 731b9d8aaa3d266f9fb90687a53c6e507db08ae6, shallow clone, files read directly), the GitHub releases API, Docker Hub tag list, dev.rootstock.io node-operator docs, and live HTTP probes of the testnet import-sync indexes. Source base: `https://github.com/rsksmart/rskj/blob/VETIVER-9.0.4/` (written `SRC/` below). Provider claims come from marketing pages and are marked SECONDARY. Where nothing is published the text says "not published". No numbers are estimated.

## Summary

- **Release.** Current rskj is `VETIVER-9.0.4` (published 2026-08-06). Install by Docker (`rsksmart/rskj:VETIVER-9.0.4`) or by running the fat jar with Java 17. Select testnet with `--testnet`.
- **Hardware.** The docs give one figure for mainnet and testnet: 2 cores, 8 GB RAM, 128 GB storage. No separate testnet figure and no growth rate is published.
- **Sync.** Full-sync time from genesis is not published. A supported fast path exists: Import Sync (needs 9.0.4+). A testnet archive is live now (landing height 8,208,000, 1.85 GB download, 2.36 GB extracted). Snapshot Sync exists but is experimental and off by default.
- **Pruning.** Not described in the dev docs. The source has an off-by-default state garbage collector (`blockchain.gc`). Treat it as unverified operationally.
- **eth_getLogs.** The shipped defaults are already `rpc.logs.maxBlocksToQuery = 5000` and `rpc.logs.maxLogsToReturn = 20000`. HTTP JSON-RPC is on by default but bound to localhost. The docs page that says these limits are "disabled" is stale against the source.
- **Correction to the prior note.** `rpc.maxResponseSize` defaults to 10485760 (10 MiB) in `reference.conf`, not 0.
- **eth_sendRawTransaction.** Same-nonce replacement needs `new >= old*(100+40)/100` (`transaction.gasPriceBump = 40`) and only compares against the pending set. Nonce gaps go to a queued pool.
- **minGasPriceMultiplier.** `rpc.minGasPriceMultiplier` is not in `reference.conf`. It defaults to 1.1 in code and is distinct from `rpc.gasPriceMultiplier`.
- **Managed hosting.** No provider publishes an rskj testnet node with `eth_getLogs` confirmed. Self-hosting is the only verified path.

## 1. Release and install

| Claim | Source |
|---|---|
| Latest release is `VETIVER-9.0.4`, published 2026-08-06. Prior: 9.0.3 (2026-06-18), 9.0.2 (2026-06-12), 9.0.1 (2026-04-08), 9.0.0 (2026-04-02). | GitHub releases API, `https://api.github.com/repos/rsksmart/rskj/releases` |
| 9.0.4 notes: fixes Import Sync (#3669), `eth_estimateGas` (#3520), IpUtils port handling (#3611); adds federation-change logs (#3364). Not mandatory, recommended. | `https://github.com/rsksmart/rskj/releases/tag/VETIVER-9.0.4` |
| Jar asset `rskj-core-9.0.4-VETIVER-all.jar`, 94,550,330 bytes, SHA256 `79c2ea69c91092d6804dea75012d03e40057b11b1894783cd4923fd401f7c064`, plus `SHA256SUMS.asc`. | Same release page / API |
| Jar install: Java 17 JDK required (minimum since 6.4.0). Run `java -cp <jar> co.rsk.Start`, network flag `--testnet`. The default RPC port is 4444. The page's example output (`RSKj/6.6.0`) is stale. | `https://dev.rootstock.io/node-operators/setup/installation/java.md` |
| Docker image `rsksmart/rskj`. Tags `latest`, `VETIVER-9`, `VETIVER-9.0.4` (about 285 MB compressed, updated 2026-08-05), plus `master`/`edge`. | Docker Hub tag list `https://hub.docker.com/r/rsksmart/rskj/tags`; docs `https://dev.rootstock.io/node-operators/setup/installation/docker.md` |
| Image internals: base `eclipse-temurin:17-jre`, non-root user `rsk`, workdir `/var/lib/rsk`, `DEFAULT_JVM_OPTS="-Xms4G"`. `RSKJ_SYS_PROPS` sets `-Drpc.providers.web.http.bind_address=0.0.0.0` and `hosts.0..2` to localhost, 127.0.0.1, ::1. `RSKJ_LOG_PROPS="-Dlogging.stdout=INFO"`. Entrypoint is `exec java $DEFAULT_JVM_OPTS $RSKJ_SYS_PROPS $RSKJ_LOG_PROPS -cp rsk.jar $RSKJ_CLASS $RSKJ_OPTS "${@}"`, so args after the image name (such as `--testnet`) are passed to `co.rsk.Start`. | `SRC/Dockerfile` |
| Docker Hub README example (SECONDARY, stale: it documents image `IRIS-3.3.0`): `docker run -p 50505:50505 rsksmart/rskj:<tag> --testnet`; data dir mount `/var/lib/rsk/.rsk`; custom config mount `/etc/rsk/node.conf`; publish `127.0.0.1:4444:4444` for RPC. Check these paths against the 9.0.4 image before relying on them. | `https://hub.docker.com/v2/repositories/rsksmart/rskj/` (full_description) |

Observed: the public testnet node reports 9.0.3 (prior note), so running 9.0.4 is ahead of it. Whether `--testnet` selects chain 31 was taken from the docs, not re-derived from `Start`/`RskContext` source (see Unknowns). `SRC/rskj-core/src/main/resources/config/testnet.conf` sets `networkId=8100` (the P2P network id, not the EVM chain id 31), peer port 50505, bootstrap hosts `bootstrap01..08.testnet.rsk.co:50505`, and `database.dir=${user.home}/.rsk/testnet/database`. Vetiver 9.0.0 activates at height 7,604,200 on testnet.

## 2. CPU, RAM, disk, growth

| Claim | Source |
|---|---|
| Minimum 2 cores, 8 GB RAM, 128 GB storage, x64 OS; one set of numbers stated for both mainnet and testnet. | `https://dev.rootstock.io/node-operators/setup/requirements.md` |
| Growth rate of the on-disk database: not published. On-disk size after sync: not published, and not measured here. | (absence in the above page and in the docs set) |
| JVM heap: the image starts with `-Xms4G`; Import Sync is documented with `-Xmx4G`. No recommended maximum heap is published. | `SRC/Dockerfile`; `https://dev.rootstock.io/node-operators/setup/import-sync.md` |
| Default key-value store is RocksDB (`keyvalue.datasource=rocksdb`; LevelDB deprecated). `flushNumberOfBlocks=1000`. | `SRC/rskj-core/src/main/resources/reference.conf` |

Observed (chain 31, import indexes, see section 3): the export file for the newest snapshot is 2.36 GB uncompressed. This is an export size, not the RocksDB footprint, so it is a floor-ish indicator only. Block cadence from index dates: 4,752,000 (2024-11-13) to 8,208,000 (2026-10-21) is 3.456M blocks in about 706 days, roughly 4,900 blocks/day; over the last 45 days about 3,600 blocks/day. Export size growth is lumpy (0.94 GB in Nov 2024, 2.32 GB at 8,046,000 on 2026-09-05, 2.36 GB at 8,208,000), so no clean growth rate can be derived.

## 3. Initial sync and fast options

| Claim | Source |
|---|---|
| Full sync time from genesis: not published in docs or source. | (absence) |
| Import Sync: run `java -Xmx4G -cp <jar> co.rsk.Start --import` once, then restart without the flag. Requires 9.0.4 or later. It deletes the database directory on every run while enabled; never leave `database.import.enabled=true` in a config. Needs temp space for the archive plus extracted file. A majority (min 2) of 3 trusted signing keys must agree and all signer indexes must be reachable. It lands at the newest height with agreement, then syncs the remainder from peers. | `https://dev.rootstock.io/node-operators/setup/import-sync.md` |
| Testnet import URL `https://import.testnet.rskcomputing.net/dbs/testnet/`; three trusted keys `0437e3ab...`, `04b39e3c...`, `04c64c11...` (full values in file). | `SRC/rskj-core/src/main/resources/config/testnet.conf` |
| Snapshot Sync: EXPERIMENTAL, introduced in LOVELL-7.1.0, off by default for client and server. Client keys: `enabled`, `checkHistoricalHeaders`, `parallel`, `chunkSize=50`, `limit=10000`, `snapBootNodes`. Peer discovery is disabled and `peer.active` is used. | `https://dev.rootstock.io/node-operators/setup/experimental-features.md`; `SRC/.../reference.conf` (`sync.snapshot.*`, about lines 395-415) |
| Testnet snap boot nodes (port 50505): `snapshot-sync-euw1-1.testnet.rskcomputing.net` (node id `137eb432...49fac7a8...` as published), `snapshot-sync-usw2-1.testnet.rskcomputing.net`. The docs' testnet YAML example reuses the MAINNET hosts and node ids; that is a docs inconsistency, so copy the testnet hostnames, not the YAML. | experimental-features.md (same page) |
| Docker and Ubuntu-package Import Sync procedures differ from the jar one. | Not read; see Unknowns. |

Observed (probe 2026-10-23, all three index URLs HTTP 200):

- Landing height by the doc's agreement rule: 8,208,000, 3 of 3 signers agreeing, dated 2026-10-21 21:10.
- The index for key `0437e3ab...` has 91 entries, 3,735,000 (2023-04-09) to 8,208,000. It is sparse, with a gap between 4,770,000 (2024-11-13) and 8,028,000 (2026-09-01).
- Each archive `output.zip` holds one entry, `bootstrap-data.bin`; sizes read from the zip central directory by HTTP range request:

| Height | Date | Zip | Uncompressed |
|---|---|---|---|
| 3,735,000 | 2023-04-09 | 0.55 GB | 0.81 GB |
| 4,752,000 | 2024-11-13 | 0.65 GB | 0.94 GB |
| 8,046,000 | 2026-09-05 | 1.82 GB | 2.32 GB |
| 8,208,000 | 2026-10-21 | 1.85 GB (1,852,525,999 bytes) | 2.36 GB |

Consequence: Import Sync is the sane bootstrap for a worker host. Disk needed during import is at least archive plus extracted file (about 4.2 GB at the current height) plus the final DB, whose size is not published. The import itself was not executed here, so import duration is not published/measured.

## 4. Pruning

| Claim | Source |
|---|---|
| The dev docs do not describe pruning (searched preferences, troubleshooting and reference pages). | `https://dev.rootstock.io/node-operators/` (absence) |
| Source has `blockchain.gc` with `enabled=false`, `epochs=3`, `blocksPerEpoch=20000`. | `SRC/rskj-core/src/main/resources/reference.conf` (about lines 109-113) |
| `GarbageCollector` removes state tries older than `blocksPerEpoch * epochs - 1` blocks (59,999 with defaults) and runs every `blocksPerEpoch` blocks over a `MultiTrieStore`. Wired in `RskContext` (about lines 1063 and 1603; line 1618 handles a database where gc was previously enabled). | `SRC/rskj-core/src/main/java/co/rsk/core/bc/GarbageCollector.java`; `SRC/rskj-core/src/main/java/co/rsk/RskContext.java` |

Inference, not verified: because it prunes old state, historical state queries (`eth_call` at old blocks) would be affected; this class does not obviously touch blocks, receipts or logs. For a worker that only reads recent logs and sends transactions this is irrelevant, so the recommendation is to leave it off. Enabling it needs a database built with a multi-trie store and was not tested.

## 5. HTTP JSON-RPC and eth_getLogs caps

| Claim | Source |
|---|---|
| HTTP is enabled by default: `rpc.providers.web.http.enabled=true`, `bind_address=localhost`, `port=4444`, `hosts=["*"]`, `cors="localhost"`, `max_batch_requests_size=50`, `max_aggregated_frame_size=5242880`. WebSocket is `ws.enabled=false` (port 4445). | `SRC/.../reference.conf` (about lines 420-470) |
| Modules on: `eth`, `net`, `rpc`, `web3`, `evm`, `txpool`, `personal`, `rsk`. Off: `debug`, `trace`, `sco`. | same |
| `rpc.timeout=5000` ms, `rpc.callGasCap=10000000`, `rpc.gasEstimationCap=6800000`. | same |
| `rpc.maxResponseSize = 10485760` (10 MiB). Corrects the prior note (it said 0 / unlimited). | same; the docs page `https://dev.rootstock.io/node-operators/json-rpc/configuration-limits.md` also says 0 and is stale |
| `rpc.logs.maxBlocksToQuery = 5000`, `rpc.logs.maxLogsToReturn = 20000` (comment: about 10 MB for 20k logs; 0 means unlimited). Defaults are therefore already the 5,000 / 20,000 caps; no config is needed to get them. The same docs page says "disabled / 0", contradicting the source. The source is authoritative. | `SRC/.../reference.conf` (about lines 538-547); read in `SRC/rskj-core/src/main/java/co/rsk/config/RskSystemProperties.java` lines 63-64, 532-538 |
| Block-range check: `totalToQuery = to - from`; error "Cannot query more than N blocks at once" only if `totalToQuery > maxBlocksToQuery`. So `to - from = 5000` passes, which is 5,001 inclusive blocks. | `SRC/rskj-core/src/main/java/org/ethereum/rpc/LogFilter.java` (about lines 342-351) |
| Log-count error: "Filter returned more than N logs." at LogFilter about lines 105-106; code `MAX_ETH_GET_LOGS_LIMIT = -32012`. | `SRC/.../LogFilter.java`; `SRC/rskj-core/src/main/java/co/rsk/jsonrpc/JsonRpcError.java:33` |
| `eth_getLogs` is implemented as newFilter, getFilterLogs, uninstall. | `SRC/rskj-core/src/main/java/org/ethereum/rpc/Web3Impl.java` (about line 1080) |

Minimal worker overlay: the defaults suffice for a same-host client (`localhost:4444`). Only if the worker runs in a different container or host must `bind_address` change; the official Docker image already sets it to `0.0.0.0` with a localhost/127.0.0.1/::1 hosts allowlist, so a client reaching it via a published port needs the `Host` header to match an allowed entry (the `hosts` allowlist behaviour is from the Dockerfile; its exact Host matching was not re-read). Keep port 4444 off public interfaces.

Observed (prior note): the public testnet node `https://public-node.testnet.rsk.co` has `eth_getLogs` disabled, which is the reason a self-hosted node is needed.

## 6. eth_sendRawTransaction, pool, gas price

| Claim | Source |
|---|---|
| Flow: decode, reject missing gasPrice/gas/value, check chain id via `acceptTransactionSignature`, `transactionGateway.receiveTransaction(tx)`, return hash, or throw with the pool's error message. | `SRC/rskj-core/src/main/java/co/rsk/rpc/modules/eth/EthModuleTransactionBase.java` lines 98-124 |
| Duplicate hash errors: "pending transaction with same hash already exists" / "queued transaction with same hash already exists". Nonce above current goes to the QUEUED pool. | `SRC/rskj-core/src/main/java/co/rsk/core/bc/TransactionPoolImpl.java` (`internalAddTransaction`, about line 235) |
| Replacement: if a pending tx has the same sender and nonce, the new tx must bump or the error is "gas price not enough to bump transaction". Only the pending set is checked. | same, line 254 |
| Bump rule `isBumpingGasPriceForSameNonceTx` (lines 306-312): `old < new` AND `new >= old*(100+gasPriceBump)/100` (integer division). `transaction.gasPriceBump = 40`. | same; `SRC/.../reference.conf:306`; getter `RskSystemProperties.java:460` |
| Other pool settings: `transaction.outdated.threshold = 10` blocks, `transaction.outdated.timeout = 650` s, `transaction.accountSlots = 16`; per-account rate limiter error "account exceeds quota" when `transaction.accountTxRateLimit.enabled`. | `SRC/.../reference.conf`; TransactionPoolImpl |
| Validators: "transaction nonce too low"; "transaction nonce too high" if `stateNonce + accountSlots <= nonce`; "transaction's gas price lower than block's minimum"; "transaction's gas price exceeds cap". | `SRC/rskj-core/src/main/java/co/rsk/net/handler/txvalidator/` (nonce range, min gas price, max gas price validators) |
| `rpc.minGasPriceMultiplier` is NOT in `reference.conf` or `expected.conf`. It is read in `SystemProperties.java` (const line 103; `getMinGasPriceMultiplier()` about lines 815-821) and defaults to 1.1 when absent. | `SRC/rskj-core/src/main/java/org/ethereum/config/SystemProperties.java` |
| Use: `EthereumImpl.getGasPrice()` returns the tracker price if the fee market is working, otherwise `bestBlock.minimumGasPrice * minGasPriceMultiplier`. | `SRC/rskj-core/src/main/java/org/ethereum/facade/EthereumImpl.java` (about lines 87-93) |
| Separate setting `rpc.gasPriceMultiplier = 1.1` (`reference.conf:429`, read at `RskSystemProperties.java:67`, `:209`). `GasPriceTracker.getGasPrice` returns `max(percentile price, bestBlockPrice * gasPriceMultiplier)`. | `SRC/rskj-core/src/main/java/org/ethereum/listener/GasPriceTracker.java` (about lines 120-136) |

Design constraints for the worker (derived from the above):

- Replacing a stuck tx needs at least +40% gas price against the pending tx with the same nonce; a smaller bump is rejected by the pool, not by the chain. A tx that sits in the queued pool (nonce gap) is not replaceable by this check.
- `rpc.minGasPriceMultiplier` only affects the fallback price returned by `eth_gasPrice`/`getGasPrice` when the fee market is not working; do not confuse it with `rpc.gasPriceMultiplier`. Set it only via an explicit config or `-D` property, since it has no entry in `reference.conf` to override.
- The prior note's 80x gas price cap (`TxGasPriceCap`) was carried over and not re-verified in this session.

## 7. Managed hosting

None of the below is primary evidence of `eth_getLogs` on testnet. All entries are SECONDARY (vendor pages, no live key-based probe).

| Provider | What the page says | Source |
|---|---|---|
| Rootstock RPC API (official) | Free, 25,000 requests/day/user, up to 4 keys, testnet endpoint `https://rpc.testnet.rootstock.io/<apikey>`. `eth_getLogs` support and limits are not documented. | `https://dev.rootstock.io/node-operators/` and the RPC API docs (method list not present in the fetched markdown) |
| Alchemy | Testnet endpoint `https://rootstock-testnet.g.alchemy.com/v2/API_KEY`; WebSockets "Not currently supported". No Rootstock `eth_getLogs` statement. Generic `eth_getLogs` range table exists (Free tier 10 blocks; Pay As You Go 10,000 on "All Other Chains") but names no Rootstock range. `alchemy.com/docs/chains/rootstock` returned 404. | `https://www.alchemy.com/rpc/rootstock-testnet` |
| GetBlock | RSK nodes "available for mainnet and testnets". Free plan 40,000 requests/day. Dedicated nodes from $1000/month with archive data. `eth_getLogs` only mentioned as a heavy, costlier method. | `https://getblock.io/nodes/rsk/` |
| NOWNodes | Page lists mainnet only; testnet not confirmed. START plan up to 100,000 requests/month. | NOWNodes Rootstock page |
| dRPC | A Rootstock testnet chainlist page exists. A search snippet said it was "temporarily unavailable due to no active nodes". Unverified. | dRPC chainlist (via search) |
| Chainstack, QuickNode, Ankr | No evidence of Rootstock testnet support found. | (absence) |

Conclusion: no provider publishes an rskj testnet node with logs confirmed. Any provider claim needs a live key-based `eth_getLogs` probe with a 5,001-block range, which was not done.

## Unknowns

- Full-sync time from genesis: not published.
- On-disk database size after Import Sync and its growth rate: not published, not measured. CPU and RAM beyond the 2 core / 8 GB docs minimum are not published; actual RSS was not measured.
- Import Sync duration: not published, not run.
- Import Sync procedure inside the Docker image and the Ubuntu package: not read.
- Pruning (`blockchain.gc`): undocumented in dev docs, untested, and its effect on logs and receipts is an inference.
- Whether the 9.0.4 Docker image defaults to mainnet and the exact data and config mount paths; the Docker Hub README found is for the old `IRIS-3.3.0` image. The `--testnet` flag mapping was taken from docs, not from `Start`/`RskContext` source.
- Whether any managed provider enables `eth_getLogs` on Rootstock testnet, and with what range.
- Whether the Docker `hosts` allowlist rejects requests whose `Host` header is a container name; not tested.
- The 80x gas price cap: carried over from the prior note.
- Docs-versus-source contradictions found (source treated as authoritative): log limits and `maxResponseSize` shown as disabled/0 in `configuration-limits.md`; testnet Snapshot Sync YAML uses mainnet hosts; Java install page shows 6.6.0 / 7.0.0 examples; `rpc.minGasPriceMultiplier` undocumented in `reference.conf`.
