# Research: Future Entropy Source and Binding Rule

Ticket: [mangekyou-labs/rsk-vrf#3](https://github.com/mangekyou-labs/rsk-vrf/issues/3). Map: [#1](https://github.com/mangekyou-labs/rsk-vrf/issues/1).
Date: 2026-10-21. Release target: Rootstock public testnet, chain ID 31. Mainnet is out of scope; mainnet facts appear only as contrast.

This note depends on ticket #2, "Rootstock Proof Feasibility". Every candidate below is public once it is produced. So the entropy source only provides the destination's first property: the request binds a future input that nobody can yet know or control. The second property, keeping the output hidden after the source is published until fulfillment, has to come from the proof construction (an oracle-keyed unique proof over `alpha`). The third property, that the oracle cannot choose among outputs, also comes from the proof construction.

Prior art (the clarity-vrf research note and map) was read as context only. Nothing here is inherited from it.

## TL;DR

- **Recommendation for chain 31: drand `evmnet` (BLS on BN254, unchained, 3 s period), verified on-chain with the `alt_bn128` precompiles.** The commitment is a fixed future round derived on-chain from the request block's timestamp. This is conditional on #2 (see "Conditionality on #2").
- **Fallback, if #2 rejects the extra BN254 verification gas or complexity: a future Rootstock block hash**, read through the BlockHeader precompile (window of 4000 blocks), not through `BLOCKHASH` (window of 256). Use it with an explicit caveat about miner influence.
- **The future BTC header through the Bridge is rejected for chain 31.** RSKIP220 designed it for exactly this use, but testnet RSK pegs to BTC testnet3. Testnet3 is currently mined mostly at difficulty 1 under the 20-minute rule, so its headers are cheap to grind and to replace. On mainnet this would be the strongest no-third-party candidate.
- **Binding:**
  ```
  alpha = keccak256(abi.encode(DOMAIN, block.chainid, address(this), consumer, requestId, SOURCE_ID, round, entropy))
  ```
  Here `entropy` is the verified source value. The committed coordinate (`round`, or the block number for the fallback) is stored at request time and is never switched. Recovery means retrying the same coordinate or timing out with a refund.
- **Timing (chain 31):**
  - drand round = `roundAt(block.timestamp) + 40`, about 120 s ahead.
  - The worker fulfills after the round exists and the request has 12 confirmations.
  - Timeout is 1,200 RSK blocks, about 8 h.
  - Fallback blockhash: target `requestBlock + 1`, require 12 confirmations, same timeout. This stays far inside the 4000-block precompile window.

## Sources

Primary sources only. Third-party code was read as data in isolated directories and never built or executed.

- Rootstock docs, linked from [`llms.txt`](https://dev.rootstock.io/llms.txt):
  - [merged mining](https://dev.rootstock.io/concepts/foundations/merged-mining.md)
  - [PowPeg](https://dev.rootstock.io/concepts/foundations/powpeg.md) and the [PowPeg security model](https://dev.rootstock.io/concepts/foundations/powpeg/security-model.md)
  - [REMASC](https://dev.rootstock.io/node-operators/merged-mining/remasc.md)
  - [merged mining reference](https://dev.rootstock.io/node-operators/merged-mining/reference.md)
  - [precompiled ABIs](https://dev.rootstock.io/developers/libraries/rsk-precompiled-abis.md)
  - [architecture](https://dev.rootstock.io/developers/blockchain-essentials/rootstock-essentials/rootstock-architecture.md)
- [rsksmart/rskj](https://github.com/rsksmart/rskj) at commit `1e95a3b` (2026-10-16). Files are cited by path below as `rskj:<path>`.
- RSKIPs:
  - [RSKIP119](https://github.com/rsksmart/RSKIPs/blob/master/IPs/RSKIP119.md) (BlockHeader precompile)
  - [RSKIP200](https://github.com/rsksmart/RSKIPs/blob/master/IPs/RSKIP200.md) (public `receiveHeader`)
  - [RSKIP220](https://github.com/rsksmart/RSKIPs/blob/master/IPs/RSKIP220.md) (Bridge BTC header getters)
- [drand/drand](https://github.com/drand/drand) at commit `e8dd607` (`crypto/schemes.go`), and the live drand HTTP API (`https://api.drand.sh`).
- Live JSON-RPC checks against `https://public-node.testnet.rsk.co`. The node reported `RskJ/9.0.3/Linux/Java17/VETIVER-c19cf12` and chain ID 31. Checks ran 2026-10-21, roughly 05:00 to 05:30 UTC. Mainnet contrast data came from `https://public-node.rsk.co`. No transactions were sent and no funds were spent. Gas figures are `eth_estimateGas`, which includes the 21,000 intrinsic cost.
- `mempool.space/testnet` API, used to cross-check BTC testnet3 tips and headers.

## Live facts gathered (chain 31)

| Fact | Value | Source |
|---|---|---|
| RSK block time, last 2,000 blocks | mean 24.3 s, median 22 s, p90 41 s, p99 69 s, max 101 s | live RPC |
| Uncles referenced in those 2,000 blocks | 1,286 | live RPC |
| Distinct block miners (coinbase) in those 2,000 blocks | 3 (679 / 678 / 644 blocks) | live RPC |
| RSK block difficulty | about 1.15e9 (`0x4453a3d4`) | live RPC |
| Mainnet contrast, last 1,000 blocks | mean 30.7 s, median 28 s, p90 53 s, 1,144 uncles, 5+ pool coinbases | live RPC |
| `BLOCKHASH` in an `eth_call` at block N | `blockhash(N-1)` and `blockhash(N-256)` equal the RPC block hashes; `blockhash(N-257)` and `blockhash(N)` are zero | live RPC; `rskj:.../vm/program/Program.java` `getBlockHash` |
| BlockHeader precompile `0x…01000010` `getBlockHash(depth)` | depth 3999 returns a hash, depth 4000 returns empty; depth 0 is the parent; total about 25.3k gas | live RPC; `rskj:.../pcc/blockheader/BlockHeaderContract.java` (`MAX_DEPTH = 4000`) |
| Bridge BTC best height vs BTC testnet3 tip | 5,195,931 vs 5,195,931 (no lag at sample time) | live RPC + mempool.space |
| `getBtcBlockchainBlockHeaderByHeight(tip)` | 80-byte header; its sha256d matched mempool.space; bits `0x1d00ffff` (difficulty 1); timestamp about 1 h 47 m in the future | live RPC |
| `getBtcBlockchainBlockHeaderByHeight(tip+1)` | `0x` (empty, does not revert); about 26.3k gas | live RPC; `rskj:.../peg/Bridge.java` |
| BTC testnet3 recent blocks | mostly difficulty 1, consecutive timestamps 1,201 s apart (20-minute rule), periodic real-difficulty blocks | live RPC header decode |
| `alt_bn128` pairing `0x08`, 2 pairs (G1,G2)·(−G1,G2) | returns 1; `eth_estimateGas` 138,980 (113,000 precompile = 45,000 + 2 × 34,000) | live RPC; `rskj:.../pcc/altBN128/BN128Pairing.java` |
| `alt_bn128` with an off-curve point | returned `0x` (empty output, no revert) through `eth_call` | live RPC |
| `modexp` `0x05`, 256-bit square root mod BN254 p | correct; `eth_estimateGas` 35,435 (about 13k precompile, EIP-198 pricing, `GQUAD_DIVISOR = 20`) | live RPC; `rskj:.../vm/PrecompiledContracts.java` |
| `ecAdd` / `ecMul` | 150 / 6,000 gas | `rskj:.../pcc/altBN128/BN128Addition.java`, `BN128Multiplication.java` |
| drand `evmnet` | chain hash `04f1e906…6ec8c3`, period 3 s, genesis 1727521075, scheme `bls-bn254-unchained-on-g1`; latest round matched the time-derived expectation within 1 round | `api.drand.sh` evmnet info and latest-round endpoints |

Timestamp rules relevant to the drand round mapping, from `rskj:.../validators/BlockTimeStampValidationRule.java` (master) and `rskj:.../config/Constants.java`:

- A block's timestamp must be greater than its parent's.
- It may be at most `NEW_BLOCK_MAX_SECONDS_IN_THE_FUTURE` ahead of the validating node's clock. That is 540 s on testnet and 60 s on mainnet.
- After RSKIP179, it must be within `maxTimestampsDiff` of the merged-mining BTC header's timestamp. That is 120 min on testnet (RSKIP297) and 5 min otherwise.
- There is no lower bound relative to wall-clock time other than monotonicity.

## Is `BLOCKHASH` reliable on Rootstock?

The opcode is mechanically reliable, but it is a poor entropy source on chain 31.

**Mechanics.** `Program.getBlockHash` returns the hash only for `index < number && index >= max(0, number-256)`. Otherwise it returns 32 zero bytes. It does not revert. The live probe confirmed:

- the window is exactly 256 blocks;
- the values equal the hashes returned by the RPC;
- the current block reads as zero.

At the 24.3 s mean, 256 blocks is only about 1.7 h. A fulfillment outage longer than that permanently loses the coordinate, which would force a forbidden switch. So a blockhash design must read through the BlockHeader precompile instead (RSKIP119):

- window of 4,000 blocks, about 27 h;
- returns empty bytes past the window, so the caller must check the length;
- static-callable, not local-only;
- about 4k gas net.

**RSK-specific behaviour:**

- *Merged mining.* A block is valid when its merged-mining BTC header meets the RSK difficulty. Every share above RSK difficulty yields a different valid RSK block hash for the same height. So a miner can discard unwanted hashes at the cost of the forgone reward. REMASC pays rewards only after maturity, and fees are low, as the merged-mining doc notes. On chain 31 the difficulty is about 1.15e9 hashes, which an ASIC produces in well under a second, so grinding is essentially free.
- *Concentration.* On chain 31, three coinbases produced every block in the sample. In practice this is an operator-run testnet, so "miner influence" means influence by those operators.
- *Uncles and forks.* Uncles are frequent (1,286 references in 2,000 blocks), so one-block forks are routine. RSK picks the canonical chain by cumulative work including uncles. A target block hash is therefore not final until it has some depth. Uncle depth measurements are in "Confirmation depth".

## Candidates

### (a) Future Rootstock block hash

- **Commitment.** At request time, store `targetBlock = block.number + 1`. The current block's own hash is unavailable to the EVM and is known to its miner before inclusion.
- **Fulfillment validity.**
  - Require `block.number >= targetBlock + CONF`.
  - Read the hash through the BlockHeader precompile with `depth = block.number - 1 - targetBlock`. Require a 32-byte, non-zero result and `depth < 4000`.
  - Never accept an oracle-supplied hash. The contract reads it itself.
- **Binding.** `alpha = keccak256(abi.encode(DOMAIN, block.chainid, address(this), consumer, requestId, SOURCE_RSK_BLOCKHASH, targetBlock, hash))`.
- **Influence.**
  - Requester: none over the hash, but can time submissions.
  - Oracle: none, unless the oracle mines or colludes with a miner.
  - Miner of `targetBlock`: can withhold or re-grind. This is free on chain 31 and costs the block reward on mainnet.
  - A colluding miner and oracle can learn the final output for each candidate hash, because the oracle holds the key, and publish the block they prefer. This breaks the "not controllable" requirement.
- **Predictability.** Unknown to everyone except the producing miner until the block propagates.
- **Reorgs.** The hash can change until `targetBlock` is buried. The commitment is the block number, so after a reorg the same number simply gets a new hash. The fulfillment check reads the hash at execution time, so a fulfillment mined on the losing branch is rolled back with it.
- **Availability and delay.** About 1 block plus `CONF`. With CONF = 12 that is about 5 min at the mean. The window is about 27 h through the precompile.
- **Recovery.** Retry the same `targetBlock` while `depth < 4000`. After that, time out and refund. Never move to a newer block.
- **Gas.** About 4k for the precompile call, plus calldata decoding.

### (b) Future BTC header through the Bridge (RSKIP220)

- **Commitment.**
  - Store `btcHeight = Bridge.getBtcBlockchainBestChainHeight() + 1`. This method is public after RSKIP220, about 19k gas.
  - Do not use `getBtcBlockchainBlockHashAtDepth`. It is `fixedPermission(true)` in `rskj:.../peg/BridgeMethods.java`, meaning local calls only, so contracts cannot call it in a transaction.
- **Fulfillment validity.**
  - Require `bestChainHeight >= btcHeight + BTC_CONF`.
  - Call `getBtcBlockchainBlockHeaderByHeight(btcHeight)`, about 5k gas. Require exactly 80 bytes. The Bridge returns empty bytes on any exception (`rskj:.../peg/Bridge.java`).
  - Compute `sha256(sha256(header))` with the `0x02` precompile.
  - Optionally check that `bits` meets a minimum difficulty. On testnet3 that check would reject most blocks.
- **Binding.** Same `abi.encode` tuple, with `SOURCE_BTC_HEADER`, `btcHeight`, and the header hash.
- **Influence.**
  - BTC miners can withhold or grind. On testnet3, difficulty-1 blocks under the 20-minute rule are cheap to mine and to replace.
  - Anyone can feed headers through the public `receiveHeader` (RSKIP200, 10.6k gas, at most one call per 5 min on testnet, headers no more than 25 blocks below the best). The PowPeg nodes also feed headers.
  - The Bridge validates proof of work but "does not check that the chain is valid" (PowPeg docs). It picks the heaviest chain it has been shown.
- **Predictability.** Unknown until mined.
- **Reorgs.** `getStoredBlockAtMainChainHeight` returns the header on the Bridge's *current* main chain. If the Bridge's BTC view reorgs, the value at a given height changes. This affects testnet3 reorgs (timestamp and min-difficulty games) and any party who feeds a heavier fork.
- **Availability and delay.**
  - BTC testnet3 timing is erratic: 20-minute min-difficulty blocks with bursts in between.
  - The Bridge can lag the tip if nobody feeds headers. No lag was observed at sample time.
  - Heights at or above `btcHeightWhenBlockIndexActivates = 2,039,594` stay readable (RSKIP199 indexing), so the read window is effectively unlimited.
- **Recovery.** Retry the same `btcHeight`. Time out with a refund if the Bridge stalls.
- **Gas.** About 5k (header) plus 19k (best height) plus two `sha256` calls. Roughly 30k in total.
- **Chain 31 verdict.** Rejected. The source is strong only where BTC proof of work is expensive, and testnet3 does not meet that condition.
  - rskj recently added `BridgeTestNet2Constants` for a new RSK testnet2 (chain 34) pegged to BTC testnet4. This suggests chain 31 and testnet3 may be retired eventually.
  - On mainnet, with 100-confirmation peg-in semantics and real BTC proof of work, this would be the preferred no-third-party source.

### (c) drand `evmnet` verified on-chain (recommended)

- **Scheme facts** (`drand:crypto/schemes.go`, `bls-bn254-unchained-on-g1`):
  - signature on G1, public key on G2;
  - DST `BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_`;
  - message `keccak256(uint64_be(round))`;
  - randomness `sha256(signature)`.
  - "Unchained" means each round's message depends only on the round number, so any round can be verified on its own.
- **Commitment.** At request time, store
  ```
  round = ((block.timestamp - GENESIS) / PERIOD) + 1 + DELAY_ROUNDS
  ```
  This is `roundAt(t)` plus `DELAY_ROUNDS`, with GENESIS = 1727521075, PERIOD = 3 and DELAY_ROUNDS = 40. The beacon's chain hash and public key are immutable constants of the coordinator.
- **Fulfillment validity.**
  - The oracle submits `sigma` (a G1 point).
  - The contract hashes the message to G1 with SVDW and verifies `e(sigma, -g2) · e(H(m), pk) == 1` through `0x08`.
  - It must require `success && returndata.length == 32 && result == 1`. The live probe showed an off-curve input returns empty output rather than reverting, so a bare `staticcall` success check is unsafe.
  - The contract derives `entropy = sha256(sigma)`.
  - BLS signatures are unique for a fixed key and message, so neither the oracle nor anyone else can pick among values.
- **Binding.** `alpha = keccak256(abi.encode(DOMAIN, block.chainid, address(this), consumer, requestId, SOURCE_DRAND_EVMNET, round, entropy))`. `SOURCE_DRAND_EVMNET` may itself be the drand chain hash.
- **Influence.**
  - Requester: none.
  - Oracle: none over the value, because it is verified on-chain.
  - RSK miners: they control `block.timestamp` only within the rules above. The only lever that matters is lag. If a miner can include the request in a block whose timestamp lags real time by more than `DELAY_ROUNDS × 3 s`, the committed round is already public when the request lands. A miner who colludes with the oracle could then selectively censor requests. With honest parent timestamps, lag is bounded by the inter-block gap (observed max 101 s, p99 69 s), and 120 s covers that.
  - A forward timestamp skew of up to 540 s only pushes the round later, which is safe and adds delay.
  - drand network: the threshold of League of Entropy members could jointly compute any round early. This is the trust assumption.
- **Predictability.** A round's signature does not exist before a threshold of drand nodes signs it at the round time.
- **Reorgs.** The commitment lives in contract state. A reorg that drops the request drops the stored round with it. A re-included request gets a fresh, later round, because timestamps increase. Fulfillments on losing branches roll back. Request depth is a liveness and UX matter, not a soundness matter.
- **Availability and delay.**
  - About 120 s plus drand propagation (seconds) plus fulfillment inclusion (about 24 s). Roughly 2.5 min before confirmations.
  - Old rounds stay fetchable from drand relays, and the verification is window-free.
  - A drand outage delays rounds. The committed round is still produced when the network resumes (drand catch-up), only later. This was not tested here.
- **Recovery.** Retry the same `round` indefinitely until the timeout. Never re-derive a round.
- **Gas.**
  - Pairing: 113,000 (measured, 2 pairs).
  - Hash-to-curve SVDW: not measured. Each square root or Legendre exponentiation through `modexp` costs about 13k (EIP-198 pricing on RSK, measured). SVDW needs several of these, or an equivalent in pure Solidity.
  - Plus calldata for the 64-byte G1 point.
  - A plausible total is roughly 150k to 200k gas. #2 must measure it.

### (d) Other options considered

- **`DIFFICULTY` / `PREVRANDAO`.** RSK has no beacon-chain RANDAO. The opcode returns the PoW difficulty, which is predictable. Rejected.
- **Requester or oracle commit/reveal.** It does not satisfy "not controllable", because the last revealer can abort. The map keeps it only as the non-VRF fallback if #2 fails.
- **Combining sources, e.g. `H(drand ‖ blockhash)`.** It is unpredictable if either part is. But it inherits the availability failure modes of both, and the party who learns last can still grind (for example, the miner of the block after the round is published). It adds gas and complexity without a clear gain. Rejected.
- **Other drand networks (`quicknet`, `default`).** They use BLS12-381. RSK has no BLS12-381 precompile in `rskj:.../vm/PrecompiledContracts.java`, so on-chain verification is impractical. `evmnet` exists for this reason.
- **The merged-mining BTC header of a future RSK block** (`BlockHeader.getBitcoinHeader`). This is the same miner-influence model as (a), so it adds nothing.

## Comparison (chain 31)

| | (a) RSK blockhash | (b) Bridge BTC header | (c) drand evmnet |
|---|---|---|---|
| Who can influence | RSK miners (3 operators, near-free grinding) | BTC testnet3 miners (difficulty 1), header feeders on forks | drand threshold only |
| Oracle influence | only by colluding with or being a miner | only by colluding with BTC miners | none |
| Predictable before | until the target block propagates | until the BTC block is mined | until the round time |
| Reorg exposure | target hash changes until buried | Bridge main-chain view can change | none for the value |
| Delay to fulfillable | about 5 min (1 + 12 blocks) | 10 to 20+ min, erratic | about 2 to 2.5 min |
| Read window | 4,000 blocks via precompile (256 via `BLOCKHASH`) | effectively unlimited | unlimited |
| External dependency | none | Bridge feeding | drand relays (oracle fetches) |
| Verification gas (approx.) | about 4k | about 30k | about 113k + SVDW (unmeasured) |
| Verdict | fallback | rejected on 31 (mainnet candidate) | **recommended** |

## Recommendation and binding rule

**Recommended source: drand `evmnet`, round committed from the request block's timestamp, signature verified on-chain.**

### Explicit assumptions

1. Fewer than the threshold of `evmnet` drand nodes collude. The threshold and membership numbers were not verified here (open question). The drand network keeps operating `evmnet` and does not rotate its key during the demonstration. A key or chain-hash change would require a coordinator upgrade, not a silent switch.
2. Parent block timestamps on chain 31 track wall-clock time within the observed inter-block gap. The `DELAY_ROUNDS` margin of 120 s covers the observed maximum gap of 101 s.
3. The output is hidden by the proof (#2), not by the source. The oracle's key must be fixed before any request whose round is unknown. The coordinator binds the key, or its hash, as an immutable value or a registered value that cannot be changed per request.
4. The oracle cannot learn round `r` before the drand network publishes it.

### Binding rule

```solidity
bytes32 constant DOMAIN = keccak256("rsk-vrf/v1/alpha");
// stored at request: consumer, requestId, round (uint64), oracleKeyHash, timeoutBlock
bytes32 entropy = sha256(abi.encodePacked(sigmaX, sigmaY)); // drand randomness = sha256(sig bytes)
bytes32 alpha = keccak256(abi.encode(
    DOMAIN, block.chainid, address(this), consumer, requestId,
    DRAND_EVMNET_CHAIN_HASH, round, entropy
));
```

- `requestId` should itself be derived inside the coordinator, for example `keccak256(abi.encode(block.chainid, address(this), consumer, nonce))`. The requester must not choose it freely.
- Use `abi.encode`, not `abi.encodePacked`, for the tuple, to avoid ambiguity.
- The exact serialization of `sigma` to compute drand's `sha256(sig)` must match drand's encoding (64-byte uncompressed G1, big-endian x‖y). Confirm this against a live round in the build ticket.
- The proof from #2 is checked over `alpha`. Its output is the consumer's randomness.

### Timing parameters (chain 31)

| Parameter | Value | Rationale |
|---|---|---|
| `GENESIS`, `PERIOD` | 1727521075, 3 s | evmnet info |
| `DELAY_ROUNDS` | 40 (120 s) | greater than the observed max inter-block gap (101 s); bounds timestamp-lag pre-knowledge |
| Worker request confirmations | 12 RSK blocks (about 5 min) | see below; liveness and UX only |
| Consumer finality on fulfillment | 12 RSK blocks | same |
| Timeout | 1,200 RSK blocks (about 8 h at the mean) | survives multi-hour oracle or drand outages; then the requester may cancel and get a refund; the oracle may fulfill until cancelled |
| Recovery | same `round` only | never re-derive or switch |

Fallback (a) parameters: `targetBlock = requestBlock + 1`, `CONF = 12`, timeout 1,200 blocks. Fulfillment must happen while `block.number - 1 - targetBlock < 4000`. A timeout of 1,200 leaves a margin of about 2,800 blocks. Never rely on the 256-block `BLOCKHASH` window.

### Confirmation depth under merged mining

Rootstock's docs give BTC-confirmation rules for the peg (100 BTC blocks on mainnet, 10 on testnet, `btc2RskMinimumAcceptableConfirmations`; peg-outs after 4,000 RSK blocks). I found no general RSK block-confirmation recommendation in `llms.txt` or the linked pages. Prior-art research (ticket #4) reports that API3 QRNG on RSK used 3 confirmations on mainnet and 1 on testnet.

Measured facts:

- 1,286 uncle references in 2,000 testnet blocks, so one-block forks are routine.
- In the last 300 testnet blocks (to 8,206,415), 203 uncles were included. By distance from the including block they were 78 at 1, 114 at 2, 10 at 3 and 1 at 4. So competing blocks routinely appear up to 2 or 3 heights back, and occasionally 4.
- Deeper reorgs cannot be seen from uncle data and were not observed directly.

Recommendation: **12 RSK blocks on chain 31** (about 5 min at a 24.3 s mean, about 8 min at p90 gaps).

- This is well above observed fork depth and well inside every window.
- For the recommended drand design, depth protects only against wasted fulfillment gas and consumer callbacks on orphaned branches. Soundness does not depend on it.
- For fallback (a), depth is what makes the target hash final. 12 blocks are cheap on a 3-operator testnet, but they do not stop an operator who wants to rewrite the target.

## Conditionality on #2 (Rootstock Proof Feasibility)

- **If #2 accepts an oracle-keyed unique proof** (for example ECVRF on secp256k1, or BLS on BN254) with measured on-chain verification on RSK: use (c), and budget roughly 150k to 200k extra gas for drand verification.
  - If #2 itself picks BLS on BN254, the hash-to-curve and pairing code is shared, so the marginal cost is about one more pairing pair and one more hash-to-curve.
- **If #2's gas or complexity budget cannot absorb an SVDW hash-to-curve plus a 2-pair pairing:** use fallback (a). Document plainly that chain 31 miners (3 operators) can influence the input, so the "not controllable" property holds only against requesters and non-mining oracles.
- **If #2 finds no construction that passes the gate,** none of these sources makes the output hidden by itself, because all of them are public. The non-VRF commit/reveal fallback from the map applies.
- In every case, an oracle-only HMAC or signature over a public seed is not enough unless #2 proves uniqueness.

## Limits

- Hash-to-curve (SVDW, keccak XMD) gas on RSK was not measured. Only the pairing (113k) and one `modexp` square root (about 13k) were measured. No Solidity was deployed.
- The drand `evmnet` threshold, membership and long-term support commitment were not verified from a primary drand source in this ticket.
- The off-curve `alt_bn128` behaviour (empty output, no revert) was observed through `eth_call` on one public node. Treat it as "must check output length", not as a specified behaviour.
- The block-time, miner and uncle statistics are snapshots from a single morning (UTC).
- BTC testnet3 behaviour is volatile, and chain 31 may be superseded by chain 34 (testnet4).

## Open questions (for tickets or fog)

1. Is RSK testnet2 (chain 34, BTC testnet4; `BridgeTestNet2Constants`, rskj PR #3660) live or scheduled? Should the demonstration target it if chain 31 is deprecated? This could also change the verdict on (b).
2. #2: what is the measured gas of SVDW hash-to-curve for BN254 on RSK under EIP-198 `modexp` pricing? Is there an audited Solidity implementation that matches drand's DST?
3. What are drand `evmnet`'s threshold, group size, operators and support horizon? What is the key-rotation policy?
4. Worker: which drand relay or relays should the worker use, and what are the monitoring and alerting rules for missing rounds?
5. Contract: should the timeout be block-based (as proposed) or round-based? Who may fulfill after the timeout but before cancellation?
6. Should the coordinator also store the request block's `block.timestamp`, to make the round derivation auditable?
