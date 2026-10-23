# Rootstock RPC and Reorg Behaviour for the Worker

Research for [issue #18](https://github.com/mangekyou-labs/rsk-vrf/issues/18) (map: [#1](https://github.com/mangekyou-labs/rsk-vrf/issues/1)).
Date of probes: 2026-10-23. Target: Rootstock testnet, chain ID 31.

Method: Rootstock developer docs; rskj source at tag `VETIVER-9.0.4` (commit `731b9d8aaa3d266f9fb90687a53c6e507db08ae6`, the latest release; the public testnet node reports `RskJ/9.0.3/Linux/Java17/VETIVER-c19cf12`); live JSON-RPC probes of `https://public-node.testnet.rsk.co`; the viem (2.57.10) and ethers (6.17.0) source and live runs of both against that node. "Probe" below means a live call made while writing this note.

## Summary

- The public testnet node is **HTTP only and has `eth_getLogs`, all filter methods and `eth_subscribe` disabled**. A log-polling or event-subscription worker cannot run on it. The worker needs its own rskj node (where `eth_getLogs` works and is capped at 5,000 blocks / 20,000 logs by default) or the RootstockRPC API (limits not documented beyond 25,000 requests per day per user; log support untested, see Unknowns).
- **`safe` and `finalized` block tags do not work** on Rootstock (rskj parses them as tags, then fails with `invalid blocknumber safe`). There is no node-provided finality signal; confirmations must be counted by the worker against block hashes.
- Only **legacy (type 0) transactions** exist. No EIP-2930, no EIP-1559, no `eth_feeHistory`, no `eth_maxPriorityFeePerGas`. Stuck-tx replacement needs a same-nonce legacy tx with gas price at least 40% higher (rskj default).
- **12 confirmations** matches Rootstock's own minimum recommendation and is fine against accidental reorgs. It is **not** a defence against a deliberate reorg on chain 31 (cheap, thin hash power), which the map already treats as a known weakness of block-hash-based entropy.
- **Judgement: viem** is the better client, narrowly. Both handle legacy transactions on a chain with no `baseFeePerGas` automatically. viem supports EIP-1191 checksums (`checksumAddress(addr, chainId)`, `isAddress(addr, {strict:false})`) and has a built-in chain definition; ethers v6 **throws on any mixed-case address carrying an EIP-1191 checksum**. Neither client works around the missing `safe`/`finalized` or `eth_getLogs` on the public node.

## 1. Reorg depth under merged mining; is 12 confirmations well-founded?

### What the sources say

| Claim | Source |
| --- | --- |
| "A minimum of 12 confirmations is recommended, corresponding to an average delay of 6 minutes." Average block time "every 30 seconds"; miners can reduce it to about 15 s. | [Rootstock FAQ](https://dev.rootstock.io/resources/faqs/) |
| Reorganizations are frequent but not quantified by depth. "We detected 371 reorganizations out of 3,717 blocks" in a roughly 24 h mainnet sample taken before Foundry joined (published 2025-02-13). The article's own derived ratio is inconsistent (371/3717 is about 0.10 per block, not the 1-in-7.3 it states). No depth distribution is given. | [Rootstock blog, "Leveraging Bitcoin's Security: Exploring the Dynamics of Merged Mining"](https://rootstock.io/blog/leveraging-bitcoins-security-exploring-the-dynamics-of-merged-mining/) |
| Uncles are "valid blocks that didn't make it into the main chain"; the article gives no reorg depth or frequency numbers and says future simulations will model reorgs to assess finality. Block-time target discussed: 14 s now, 20 s proposed (conflicts with the FAQ's 30 s). | [Rootstock blog, "Rootstock Blocks Getting Faster"](https://rootstock.io/blog/rootstock-blocks-getting-faster-redefining-difficulty-adjustment/) |
| "rogue merge-miners could theoretically revert Rootstock blockchain at a low cost". Proven selfish forks put nodes into a "safe mode where no transaction is advertised as confirmed". Resolution is by accumulated PoW. | [Merged mining reference](https://dev.rootstock.io/node-operators/merged-mining/reference/) |
| Peg-in waits 100 Bitcoin blocks (about 2000 RSK blocks); peg-out requires 4000 RSK blocks. "Rootstock consensus does not attempt to recover from an attack that manages to revert the blockchain deep enough"; PowPeg halts peg-outs after a huge reversal. | [PowPeg architecture](https://dev.rootstock.io/rsk/architecture/powpeg) |
| Fork choice is highest total difficulty. On equal total difficulty: take the block with paid fees more than `PAID_FEES_MULTIPLIER_CRITERIA` times higher, else the lower hash (given fees are not below half of the current block's). Equal-difficulty sibling blocks are therefore routine and resolved deterministically, which makes depth-1 reorgs a normal event. | rskj [`SelectionRule.shouldWeAddThisBlock`](https://github.com/rsksmart/rskj/blob/VETIVER-9.0.4/rskj-core/src/main/java/co/rsk/core/bc/SelectionRule.java), called from [`BlockChainImpl.tryToConnect`](https://github.com/rsksmart/rskj/blob/VETIVER-9.0.4/rskj-core/src/main/java/co/rsk/core/bc/BlockChainImpl.java) |

### Observed (chain 31)

- Probe: 40 polls at 3 s (about 2 min) of `latest`: block numbers 0x7d5133 to 0x7d513a advanced monotonically with no hash change at a given height, so **no reorg was observed in that window**. This is far too short to say anything about frequency.
- Observed testnet block intervals in that window: 24, 15, 17, 25, 16, 10 s (about 18 s average). 12 confirmations is therefore roughly 3 to 4 minutes on testnet, not the FAQ's 6 minutes (mainnet figure).
- Testnet difficulty at the probe was `0x49827808` (about 1.2e9 per block), i.e. thin hash power. Testnet merge-mining difficulty adjustments are special-cased (RSKIP290 "Testnet difficulty should drop to a higher difficulty", RSKIP297, in rskj `ConsensusRule`). This is consistent with the map's note that chain 31 is miner-grindable.

### Is 12 well-founded?

- **For accidental reorgs: yes, adequate and sourced.** 12 is exactly Rootstock's published minimum. Reorgs are common but the available evidence (no depth data published) is that they are shallow; 12 gives a large margin over depth-1/2 events. The actual depth distribution is **not published** (unknown).
- **For adversarial reorgs: no, and the docs say so** ("revert ... at a low cost"). There is no quantitative cost model for chain 31 anywhere in the primary sources. 12 confirmations on testnet should be justified as "pilot-grade", not as a security bound. This lines up with decisions already in the map (future-entropy fallback is miner-grindable on chain 31; the pilot is explicitly unaudited).
- **What the worker must do regardless:**
  1. Track confirmations by **block hash**, not just number: record the hash of the block containing the `Requested` event, and at depth 12 re-fetch that block number and confirm the hash and tx receipt are unchanged before proving. (There is no `safe`/`finalized`, so this is the only canonicality check.)
  2. Keep a rolling window of recent block hashes (a window of at least 2x the confirmation depth is cheap) and detect parent-hash mismatches to roll back any queued, not-yet-submitted work.
  3. After submitting `fulfill`, treat inclusion as provisional until 12 confirmations too; a reorg can drop the fulfilment tx or its request. Because the coordinator enforces the confirmation depth on-chain (Request and Callback Semantics), a fulfilment sent against a request that was reorged out simply reverts.
  4. Do not rely on RSK `timestamp` regularity; block spacing varies (10 to 25 s observed).

## 2. `safe` / `finalized` block tags

- **Not supported.** Probe on the public node: `eth_getBlockByNumber("safe", false)` returns `{"code":-32602,"message":"invalid blocknumber safe"}`; same for `finalized`. `latest`, `earliest` work; `pending` is unsupported for block fetches (rskj `Web3Impl.getBlockByNumberOrStr` throws "The method don't support 'pending' as a parameter yet"; docs list `eth_getBlockByNumber` as partially supported for this reason).
- Source: rskj has the tags in the `BlockTag` enum (`PENDING, LATEST, EARLIEST, FINALIZED, SAFE`) so the parameter validator accepts them, but `Web3InformationRetriever` then parses the identifier as a hex number and throws `invalid blocknumber %s`. No code maps `safe`/`finalized` to a block (checked `BlockTag` usages at VETIVER-9.0.4: `ExecutionBlockRetriever` handles only earliest/latest/pending).
- Consequence: `getBlock({blockTag:'finalized'})` (viem) and `getBlock('finalized')` (ethers) both fail on this node (verified live, section 7). The worker defines finality itself: `head - 12`.

## 3. `eth_getLogs` limits and `eth_subscribe` availability

### Public node (`https://public-node.testnet.rsk.co`)

- Docs: the public nodes "do not expose WebSockets, they are `HTTP` only"; they are "for testing purposes" and production use should be an own node or provider ([Public nodes](https://dev.rootstock.io/node-operators/public-nodes.md), [Transport protocols](https://dev.rootstock.io/node-operators/json-rpc/transport-protocols.md)).
- Probes (the methods docs list all of these as supported, but the public node has disabled them):
  - `eth_getLogs` (even a 42-block range) returns `-32601 the method eth_getLogs does not exist/is not available`.
  - `eth_newFilter` returns the same error.
  - `eth_subscribe` returns `-32601 method not found` (HTTP has no subscriptions anyway).
  - `eth_feeHistory`, `eth_maxPriorityFeePerGas`, `eth_getBlockReceipts`: `-32601 method not found`. `eth_pendingTransactions`: not available.
  - Work: `eth_blockNumber`, `eth_getBlockByNumber`/`ByHash`, `eth_getTransactionReceipt`, `eth_call`, `eth_estimateGas`, `eth_gasPrice`, `eth_sendRawTransaction`, `eth_syncing`, `txpool_content`.
- Effect: on the public node the only way to learn about requests is per-block scanning (`eth_getBlockByNumber(n, true)` plus `eth_getTransactionReceipt` per coordinator-touching tx) or polling coordinator state with `eth_call`. Both are workable but not what viem/ethers log helpers do by default.
- Note viem's built-in `rootstockTestnet` chain points at this node, so `getLogs`/`watchEvent` fail out of the box (verified live).

### Own rskj node

- `eth_getLogs` is enabled by default. Limits are configurable in `rpc.logs` (config keys `maxBlocksToQuery`, `maxLogsToReturn`); defaults in rskj `reference.conf` at VETIVER-9.0.4: **`maxBlocksToQuery = 5000`, `maxLogsToReturn = 20000`**, `0` disables. The docs page [Configuration of Limits](https://dev.rootstock.io/node-operators/json-rpc/configuration-limits.md) says "by default, this value is disabled", which **contradicts** the shipped `reference.conf` (5000 / 20000); the source is authoritative for 9.0.x. `maxResponseSize` defaults to 0 (unlimited). Exceeding a limit aborts the query with an error.
- WebSocket is **off by default** (`rpc.providers.web.ws.enabled = false`, port 4445, route `/websocket`, max frame 64 kb). `eth_subscribe`/`eth_unsubscribe` exist in rskj only as the WS-handled methods (`RskJsonRpcMethod`, `EthSubscribeRequest`), so they require the WS provider enabled. rskj's `LogFilter` has a TODO and does not implement OR-of-addresses semantics beyond the arrays it supports and does not support `pending` in filters.
- Log filter quirk to know: a nested topic list is OR-ed per position, but there is a `// TODO list of topics as topic with OR logic` marker in `LogFilter.java`; keep queries to one address and one `topic0`.

### RootstockRPC API (`https://rpc.testnet.rootstock.io/<apikey>`)

- Documented: free account, up to 4 API keys, **25,000 requests per day per user** ([setup](https://dev.rootstock.io/developers/rpc-api/rootstock/setup.md), [overview](https://dev.rootstock.io/developers/rpc-api/rootstock.md)). Endpoint without a key returns HTTP 400 (probe).
- The docs I could retrieve do not state WebSocket support, `eth_getLogs` support, block-range limits, or the method list (methods page was an empty list in the fetched markdown). See Unknowns.
- 25,000/day is about 0.29 requests per second. A worker polling `eth_blockNumber` at 3 s already uses about 28,800/day, which exceeds the cap alone. Design implication: poll no faster than about every 10 s and batch (JSON-RPC batch counting is also undocumented), or run an own node.

## 4. Transaction types

- **Legacy only.** rskj's `Transaction` constructor decodes a 9-element RLP list (`nonce, gasPrice, gasLimit, to, value, data, v, r, s`) with no type-prefix handling anywhere in `org.ethereum.core` (no `0x01`/`0x02` envelope; grep for EIP-1559/2930/typed finds nothing). `ConsensusRule` at VETIVER-9.0.4 contains no RSKIP for typed transactions.
- Probe: blocks have no `baseFeePerGas`; `eth_feeHistory` and `eth_maxPriorityFeePerGas` do not exist. `eth_getBlockByNumber` returns `minimumGasPrice` and `paidFees` instead.
- Replay protection: EIP-155 `v` with chainId 31 (rskj `Transaction` encodes `chainId` in `v` for signing).
- `BASEFEE` opcode exists (RSKIP412 from EIP-3198) but is not backed by a market.

## 5. `minimumGasPrice`, stuck transactions, replacement

- **Minimum gas price is a block-header field, adjusted by miners** (`BlockHeader.getMinimumGasPrice`, `MinimumGasPriceCalculator`). Probe on testnet: `minimumGasPrice = 0x596e08` = 5,860,872 wei (about 0.0059 gwei) at block 0x7d5131. `eth_gasPrice` returned 6,431,712 to 6,448,863 wei across probes, i.e. roughly 1.1x min. rskj logic (`EthereumImpl.getGasPrice`): the `GasPriceTracker` fee-market estimate if it is "working", else `bestBlock.minimumGasPrice * rpc.minGasPriceMultiplier`.
- **Admission checks** in the tx pool: gasPrice must be at least the best block's `minimumGasPrice` (`TxValidatorMinimuGasPriceValidator`: `"transaction's gas price lower than block's minimum"`), and, once RSKIP252 is active, at most **80x** it (`TxGasPriceCap.FOR_TRANSACTION = 80`; blocks cap at 100x): `"transaction's gas price exceeds cap"`. Because `minimumGasPrice` moves between blocks, a tx priced exactly at `eth_gasPrice` can fall below the minimum after an upward adjustment and be dropped or rejected; price with headroom (viem's legacy estimate, 1.2x gasPrice, gave 7.74M wei and is a reasonable default).
- **Replacement rule** (`TransactionPoolImpl.isBumpingGasPriceForSameNonceTx`): a same-sender, same-nonce tx replaces the pending one only if its gas price is strictly higher **and** at least `old * (100 + transaction.gasPriceBump) / 100`. Default **`transaction.gasPriceBump = 40`** (+40%), far larger than Ethereum's usual 10%. Otherwise the error is `"gas price not enough to bump transaction"`. The public node's real value is not observable; assume the default (unknown if overridden).
- Other pool settings (`reference.conf`): `transaction.outdated.threshold = 10` blocks and `transaction.outdated.timeout = 650` s before a pending tx is dropped from the pool (so a stuck tx may silently disappear, leaving a nonce gap in the node's view); `transaction.accountSlots = 16` pending slots guaranteed per account; `transaction.accountTxRateLimit.enabled = true` (per-account quota on txs consuming large resources).
- Worker design implications:
  1. Set explicit `gasPrice` (about 1.2x to 1.5x of `eth_gasPrice`), never rely on defaults; re-read `minimumGasPrice` from the head block when retrying.
  2. Keep a local nonce manager (`eth_getTransactionCount` with `latest` and `pending` handling: `pending` as a block parameter is documented as unsupported for block lookups; verify `eth_getTransactionCount(addr,'pending')` before relying on it, see Unknowns).
  3. Bump a stuck `fulfill` by at least 1.4x per attempt; with the 80x cap the bump chain is bounded (from 1.2x, only a handful of bumps fit). Re-broadcast the same raw tx if the pool dropped it after the outdated timeout.
  4. At most 16 in-flight txs per sending account; this does not bind a worker that fulfils sequentially.

## 6. EIP-1191 checksum quirks

- Rootstock "implements EIP-1191": checksum hashes `chainId + "0x" + lowercase address`, chain IDs 30 (mainnet) and 31 (testnet). An address without a chain ID "is assumed to be on Rootstock mainnet" in the docs' framing ([Account-based addresses](https://dev.rootstock.io/concepts/account-based-addresses.md)).
- Practical effect: the same 20 bytes have three different mixed-case spellings (EIP-55, chain 30, chain 31). Verified with a sample address:
  - EIP-55: `0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed`
  - chain 31: `0x5aAeb6053F3e94c9b9A09F33669435E7EF1BEaEd`
  - chain 30: `0x5aaEB6053f3e94c9b9a09f33669435E7ef1bEAeD`
- Probe results (viem 2.57.10, ethers 6.17.0):
  - ethers `getAddress()` **throws `bad address checksum`** for the chain 30 and chain 31 forms (it only knows EIP-55; it accepts all-lowercase).
  - viem `isAddress(a)` (strict by default) returns **false** for those forms; `isAddress(a, {strict:false})` returns true; `getAddress(a)` from viem normalises without throwing.
  - viem has `checksumAddress(address, chainId)` and documents the EIP-1191 incompatibility warning in source.
- Rules for the worker and the contracts' off-chain interfaces: never validate or compare addresses via checksum; store and compare **lowercase** (or `bytes20`); accept user/config addresses mixed-case but lowercase them before `getAddress` (ethers) or use `strict:false` (viem). On-chain this is irrelevant (addresses are 20 bytes); the Solidity side and `eth_*` JSON responses use lowercase hex (probe: `miner` field is lowercase).

## 7. Which TypeScript client handles these cleanly? (viem vs ethers v6)

Live runs against the public testnet node (scripts not committed; results below):

| Concern | viem 2.57.10 | ethers 6.17.0 |
| --- | --- | --- |
| Chain definition | `rootstockTestnet` (id 31) built in; default RPC is the public node | None built in; pass `new JsonRpcProvider(url, 31, {staticNetwork:true})` |
| Legacy tx on a chain without `baseFeePerGas` | `prepareTransactionRequest` chose `type: legacy`, set `gasPrice` 7,738,635 (1.2x `eth_gasPrice`), signed `0xf864...` correctly with chainId 31. `estimateFeesPerGas()` default throws "Chain does not support EIP-1559 fees"; `estimateFeesPerGas({type:'legacy'})` works | `populateTransaction` chose `type 0`, `gasPrice` 6,446,959, `maxFeePerGas` undefined; `getFeeData()` returns `maxFeePerGas: null` |
| `safe`/`finalized` | Fails (`Invalid parameters were provided to the RPC method`) | Fails (`server response 400 Bad Request`) |
| `getLogs` on public node | Fails with the node's `-32601` message passed through clearly | Fails with `unsupported operation` wrapping the node's `-32601` |
| `watchEvent` / filters | Uses `eth_newFilter`, which the public node disables; falls back to `getLogs`, also disabled | Same problem (`provider.on(filter)` polls via `getLogs`) |
| EIP-1191 | `checksumAddress(addr, chainId)`; `isAddress(a,{strict:false})`; `getAddress` tolerant | `getAddress()` throws on EIP-1191 mixed case; must lowercase first |
| Polling control | `pollingInterval`, `watchBlockNumber`, `getBlock` by hash, per-call `blockNumber` | `pollingInterval`, `getBlock`; polling provider option |
| Retries, batching | `http` transport `retryCount`, `batch` option | `JsonRpcProvider` batching built in (`batchMaxCount`), retry via `FetchRequest` |

**Judgement: viem**, for these reasons:

1. EIP-1191 is the one place where the clients differ materially, and only viem exposes it (`checksumAddress(…, chainId)`, non-strict validation). ethers hard-fails on a valid Rootstock-checksummed address, a real footgun when operators paste addresses from the Rootstock Explorer.
2. Built-in Rootstock chain definitions (id, native currency, explorer) and a `defineChain` path for the private RPC.
3. Equivalent legacy-tx handling and both let you set `gasPrice` explicitly, so this does not favour either.
4. Neither supports `safe`/`finalized`, and neither can use logs on the public node; this is an infrastructure constraint, not a client one, and shapes the design equally.

Caveat: ethers v6 has slightly better built-in JSON-RPC request batching and is lighter on dependencies in a minimal worker. If the team already has ethers code, the cost of the checksum footgun is mitigated by lowercasing addresses at the config boundary. This is a close call; choose viem unless an ethers reason exists.

## 8. Design constraints for the worker

1. **Infrastructure**: run an own rskj node (VETIVER 9.x, `rpc.logs` limits kept at defaults, WS optional) for event discovery. Fall back to the RootstockRPC API only after confirming `eth_getLogs` works there. The public node is dev-only; design a block-scan fallback (`eth_getBlockByNumber(n,true)` + receipts) that works on the public node.
2. **Polling**: poll head every 10 s or longer on the capped API (25k/day), or 3 to 5 s on an own node; page `eth_getLogs` in at most 5,000-block (use 1,000 as a safety margin) ranges with at most 20,000 logs.
3. **Confirmations**: count by block hash against `head`; require 12 plus a hash recheck at depth; keep a rolling hash window and roll back on parent mismatch. No reliance on `safe`/`finalized`.
4. **Transactions**: legacy type only, explicit `gasPrice` with headroom above head `minimumGasPrice`; replacement bumps of at least +40%; hard ceiling at 80x `minimumGasPrice`; own nonce manager; re-broadcast after the 650 s pool timeout.
5. **Addresses**: lowercase everywhere in storage and comparisons; viem `isAddress(…,{strict:false})` at input boundaries.

## Unknowns

- Reorg **depth distribution** on chain 30 or 31 (no primary source publishes it; the 371/3,717 figure is mainnet, pre-Foundry, and internally inconsistent). A multi-day head-hash recorder against the node would settle chain 31 empirically.
- Cost or probability of a deliberate reorg on chain 31; no source quantifies it.
- RootstockRPC API: whether `eth_getLogs`, filters and WebSocket are enabled, any block-range and result caps, whether batches count as one request. Needs an API key to probe.
- Whether `eth_getTransactionCount(addr, "pending")` returns pool-aware nonces on the public node (not probed with a funded sender).
- The public node's actual `transaction.gasPriceBump` and `rpc.logs` limits (it has logs disabled, so the latter is moot); I read the shipped defaults only.
- The docs' "Configuration of Limits" page says the log limits are disabled by default, whereas rskj `reference.conf` at 9.0.4 ships 5,000 and 20,000; behaviour on older node versions not checked.
- Docs say block time is about 30 s (FAQ) or 14 s target (blog); observed testnet average was about 18 s over a 2-minute sample.
- Which RSKIP, if any, will introduce typed (EIP-2718) transactions; none present at VETIVER-9.0.4.
