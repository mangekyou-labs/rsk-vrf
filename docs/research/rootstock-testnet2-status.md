# Rootstock testnet2 status

Ticket: [#15](https://github.com/mangekyou-labs/rsk-vrf/issues/15). Map: [#1](https://github.com/mangekyou-labs/rsk-vrf/issues/1). Researched 2026-10-23, primary sources only.

## Verdict

Testnet2 (chain ID 34, BTC testnet4 peg) exists in rskj `master` as of 2026-10-16, but it is **not publicly live** and nothing says it replaces or deprecates testnet chain 31. The map's release target (chain 31) stands. Re-check before demo time.

## Sub-questions

### 1. Is testnet2 live? Launch date

- rskj PR [#3660 "Testnet2 integration"](https://github.com/rsksmart/rskj/pull/3660) was opened 2026-07-27 and merged into `master` 2026-10-16T06:28:49Z. It adds `testnet2.conf`, the genesis `rsk-testnet2.json`, `BridgeTestNet2Constants`, `FederationTestNet2Constants` and BTC testnet4 checkpoints. This is code integration, not a launch announcement.
- The latest rskj release is [VETIVER-9.0.4](https://github.com/rsksmart/rskj/releases/tag/VETIVER-9.0.4) (2026-08-06), which predates the merge. No release notes mention testnet2 or testnet4 (scanned all releases via the GitHub API). So no released binary contains testnet2; running it needs a build from `master`.
- [`testnet2.conf`](https://github.com/rsksmart/rskj/blob/master/rskj-core/src/main/resources/config/testnet2.conf) has `peer.discovery.enabled = false`, `ip.list = []` and the comment "TODO: add testnet2 bootnodes before a shared/public launch." That is the clearest primary statement: no public launch yet, no bootnodes.
- Identifiers: chain ID `TESTNET2_CHAIN_ID = (byte) 34` ([`Constants.java`](https://github.com/rsksmart/rskj/blob/master/rskj-core/src/main/java/org/ethereum/config/Constants.java)); p2p `networkId = 9100` (chain 31 uses 8100), port 50509, hello phrase `TestNet2`.
- Related merged work: rskj [#3765](https://github.com/rsksmart/rskj/pull/3765) (2026-10-09, block index and bitcoinj-thin `0.14.4-rsk-19`), rsk-powhsm [#526/#529](https://github.com/rsksmart/rsk-powhsm/pull/526) "Testnet 2 support", powpeg-node [#654](https://github.com/rsksmart/powpeg-node/pull/654) (testnet4-aware bitcoinj). This shows the peg infrastructure is being prepared too.
- Fresh chain: all released hardforks active at genesis (height 0); `arrowhead631` and `cardamom1000` stay `-1`. Genesis `gasLimit` is `0x4c4b40` (5,000,000) with `minimumGasPrice` 0.

### 2. Deprecation of chain 31

No primary source says chain 31 is replaced or deprecated.
- Not in the PR text, `testnet.conf`, rskj release notes, the [dev docs `llms.txt`](https://dev.rootstock.io/llms.txt), the [public nodes page](https://dev.rootstock.io/node-operators/public-nodes.md), the [contract addresses page](https://dev.rootstock.io/developers/smart-contracts/contract-addresses.md), or the [Rootstock roadmap](https://rootstock.io/roadmap/) (the roadmap mentions only Union testnet / Union Testnet V2 in Q4 2026).
- `Constants.java` keeps `TESTNET_CHAIN_ID` and handles both (`isTestnetOrTestnet2`), and `testnet.conf` is unchanged in design: both networks coexist in code.
- Chain 31 is live now: `https://public-node.testnet.rsk.co` returned `eth_chainId = 0x1f` and block `0x7d512f` (8,212,783) on 2026-10-23.
- Absence of an announcement is not proof of no plan; see unknowns.

### 3. Public RPC, faucet, explorer

- None found. The dev docs list only the chain-31 endpoint `https://public-node.testnet.rsk.co` (HTTP only, no WebSocket). No docs page mentions testnet2, chain 34 or testnet4.
- Probed guessed hosts (`public-node.testnet2.rsk.co`, `testnet2.rsk.co`, `*.testnet2.rootstock.io` for public-node, explorer, faucet): none resolve. These are guesses, not evidence of a real hostname, so treat as "no known endpoint".
- With no bootnodes and discovery off, a public network cannot be joined at the moment.

### 4. Precompiles and gas cap vs chain 31

Source-level reading only (no live node to call):
- PR #3660 changes only config, genesis, Bridge/Federation/Peg constants, tests and `Constants`/`SystemProperties`. It touches no precompile or VM code, so `ecrecover`, `ecmul`, `ecadd` (used by `VRF.sol`) and BN254 `ecPairing` (existing precompiles) are the same code as on chain 31.
- RSKIP516 (secp256k1 add/mul precompiles) is mapped to `reed800` and RSKIP536 (extra BlockHeader methods) to `reed810` in [`reference.conf`](https://github.com/rsksmart/rskj/blob/master/rskj-core/src/main/resources/reference.conf); testnet2 sets both `reed800 = 0` and `reed810 = 0`, so both are active from genesis. Chain 31 activated them at its own heights (`reed800 = 6835700`, `reed810 = 7139600`).
- Gas cap: `Constants.testnet2()` uses `MIN_SEQUENTIAL_SET_GAS_LIMIT = 10_000_000`, the same value as mainnet and testnet (regtest uses 6.8M). `callGasCap = 10000000` in `reference.conf`. Caveat: the genesis block gas limit is 5M and the miner adjusts it; I did not verify how the 10M figure interacts with the live block gas limit on testnet2 (on a fresh chain the block limit may start well below chain 31's).
- Also differs: RSKIP144 (parallel tx execution), RSKIP351 and RSKIP535 are active at height 1 or genesis on testnet2 (`testnet2.conf`). Header layout rules start at height 1 (commit "Activate header layout rules at height 1"). These do not affect the contracts we use but affect block header parsing.
- Gas numbers measured on chain 31 (49,086 for `VRF.sol` verify) were not re-measured on testnet2.

### 5. Does a testnet4 peg make the Bridge BTC header entropy option viable?

Not clearly; it does not change the decision for chain 31.
- The Bridge on testnet2 pegs to BTC testnet4 (`btcParamsString = NetworkParameters.ID_TESTNET4` in [`BridgeTestNet2Constants`](https://github.com/rsksmart/rskj/blob/master/rskj-core/src/main/java/co/rsk/peg/constants/BridgeTestNet2Constants.java)); the store starts at testnet4 checkpoint height 143,136.
- [BIP-94](https://github.com/bitcoin/bips/blob/master/bip-0094.mediawiki) keeps the 20-minute min-difficulty exception (blocks more than 20 min after the previous one may use `nBits = 0x1d00ffff`) and adds a block-storm fix and time-warp rule. So difficulty-1 headers are still valid on testnet4, and it is "meant to make CPU-only attacks impractical" rather than make headers costly. The grindability concern that rejected testnet3 in [#3](https://github.com/mangekyou-labs/rsk-vrf/issues/3) is reduced for sustained difficulty but not removed for individual headers.
- Moot for now: testnet2 is not public, and the actual testnet4 difficulty and who mines it were not measured.

## Implications for the map

- Release target chain 31 stands.
- Keep contracts chain-ID parametric (alpha already binds `chainid`), so a later testnet2 deployment is a config change.
- Chain 31's low-difficulty miners and the BlockHeader fallback remain as decided in #3.

## Unknowns

- Whether and when testnet2 gets bootnodes, a public RPC, faucet and explorer; no announcement found.
- Whether chain 31 will be sunset (no statement either way).
- Live behavior on testnet2: block gas limit trajectory, effective per-tx cap, precompile gas, anything requiring a running node.
- Real testnet4 difficulty and miner distribution for Bridge header entropy.
- I could not search Rootstock Discord, Telegram or blog posts beyond what the web search surfaced; a private or social announcement could exist.
