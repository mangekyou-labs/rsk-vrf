# Research: Existing VRF services on Rootstock

- Ticket: [#4](https://github.com/mangekyou-labs/rsk-vrf/issues/4) (parent map [#1](https://github.com/mangekyou-labs/rsk-vrf/issues/1))
- Date: 2026-10-21
- Method: primary sources (Rootstock dev portal, each provider's official docs or deployment registries in its own repo), then read-only `eth_getCode` against `https://public-node.rsk.co` (chain 30, `eth_chainId` = `0x1e`) and `https://public-node.testnet.rsk.co` (chain 31, `0x1f`). The public nodes reject `eth_getLogs` (`-32601`), so transaction history came from the Blockscout v2 API (`rootstock.blockscout.com`, `rootstock-testnet.blockscout.com`). No state-changing calls were made and no funds were spent. Third-party code was downloaded into isolated empty directories and only read. None of it was built or executed.
- RPC sanity check: RIF token on mainnet `0x2acc95758f8b5f583470ba265eb685a8f45fc9d5` returns 16400 bytes of code. tRIF on testnet `0x19f64674d8a5b4e652319f5e239efd3bc969a1fe` returns 5607 bytes. A result of "0 bytes" therefore means no contract is deployed at that address.

## Destination test

Map #1 sets the bar: **true VRF + on-chain proof verification + output hidden until fulfillment + live on Rootstock testnet (31)**. Its security acceptance criteria are:

1. The request binds a future input that cannot be known or controlled in advance.
2. The output stays hidden from requesters and observers until fulfillment.
3. The proof stops the oracle from choosing among outputs (uniqueness).

## Conclusion

**No production VRF/randomness service that meets the destination is live on Rootstock mainnet or testnet. The destination should not be reopened.**

- Rootstock's own docs say so directly:
  - "Chainlink VRF is not currently deployed on Rootstock" ([security patterns guide](https://dev.rootstock.io/resources/guides/defi-developer-guide/security-patterns.md)).
  - "Chainlink Price Feeds and VRF are not officially supported on Rootstock mainnet at this time – only CCIP is confirmed" ([Chainlink mock guide](https://dev.rootstock.io/use-cases/interoperability/oracle-chainlink-mock.md)).
  - The [Oracles page](https://dev.rootstock.io/dev-tools/oracles.md) lists only RedStone and APRO, both price-data products.
- API3 QRNG is the only randomness service ever deployed on Rootstock. It fails the destination on every count:
  - It has no cryptographic proof. The output is a signed API response from a first-party oracle.
  - It has been dormant since 2022 on mainnet and since 2023 on testnet.
  - API3 sunset QRNG on 2025-01-01.
- Every other provider checked has no Rootstock deployment. Their known addresses have no code on Rootstock either.

## Findings by provider

| Provider | Chain 30 (mainnet) | Chain 31 (testnet) | Addresses checked (`eth_getCode`) | Construction / trust model | Fee asset | Status |
|---|---|---|---|---|---|---|
| **Chainlink VRF v2.5 / v2** | No | No | n/a (none published for RSK) | secp256k1 VRF (Chainlink's own non-RFC scheme), proof verified on-chain; DON key holder | LINK or native | Not on RSK. The [supported networks](https://docs.chain.link/vrf/v2-5/supported-networks.md) page has 0 mentions of Rootstock and lists Arbitrum, Avalanche, BASE, BNB, Ethereum, OP, Polygon, Ronin and Soneium. Rootstock docs confirm the gap (links above). |
| **Witnet Randomness** | No | No | WitRandomness `0xC0FFEE98AD1434aCbDB894BbB752e138c1006fAB`, WitOracle `0x77703aE126B971c9946d562F41Dd47071dA00777`, V3 `0xC0FFEE6912244068F3151F55AeF20fDe504B6E3a`, PriceFeeds `0x1111AbA2164AcdC6D291b08DfB374280035E1111`: **0 bytes** on both chains | Commit/reveal randomness among Witnet witnesses, relayed by a bridge. Not an EVM-verified VRF. | Native gas plus Witnet fees | Never deployed. Rootstock is absent from the [supported chains doc](https://github.com/witnet/documentation/blob/gitbook/smart-contracts/supported-chains.md) and from `migrations/addresses.json` in [witnet-solidity-bridge](https://github.com/witnet/witnet-solidity-bridge) (master, plus tags 0.5.7, 0.6.1 and 2.0.18). |
| **Pyth Entropy** | No | No | n/a | Commit/reveal between the provider's hash chain and user randomness. Not a VRF. | Native | Not on RSK. `contract_manager/src/store/contracts/EvmEntropyContracts.json` in [pyth-crosschain](https://github.com/pyth-network/pyth-crosschain) has 43 entries and no rsk/rootstock. `EvmChains.json` doesn't list RSK at all. |
| **API3 QRNG** | Yes (historic) | Yes (historic) | AirnodeRrpV0 `0xa0AD79D995DdeeB18a14eAef56A549A04e3Aa1Bd`: **10061 bytes** on both chains, verified as `AirnodeRrpV0` on Blockscout | First-party Airnode signs an API response (ANU quantum RNG; on testnet, Nodary PRNG). **No proof.** The trust is entirely in the API provider and Airnode operator. | Sponsor wallet pays gas in RBTC | **Dormant and sunset.** Addresses come from the [old API3 docs chain table](https://old-docs.api3.org/qrng/reference/chains.html), which shows minConfirmations 3 on 30 and 1 on 31. On Blockscout the last fulfillment was on 2022-11-30 (mainnet) and 2023-03-23 (testnet). API3 ended QRNG support on 2025-01-01 ([announcement](https://x.com/API3DAO/status/1852863278407651539)). Airnodes: ANU `0x9d3C147cA16DB954873A498e0af5852AB39139f2` (mainnets), Nodary `0x6238772544f029ecaBfDED4300f13A3c4FE84E1D` (testnets), Quintessence `0x224e030f03Cd3440D88BD78C9BF5Ed36458A1A25`. |
| **Gelato VRF** | No | No | n/a | Gelato Web3 Functions relay the drand beacon. drand rounds are public on release, so this **fails the hidden-output requirement**. The relayer is trusted. | Gelato 1Balance | No RSK deployment found. The Rootstock dev portal's Gelato card is commented out and its page returns 404. Gelato's VRF docs pages return 404, the `gelatodigital/vrf-contracts` repo returns 404, and the how-to repo's deployments list only "blueberry". Secondary sources report that Web3 Functions/Automate reached end of life on 2026-03-31; I couldn't confirm this from a first-party source. |
| **Supra dVRF** | No | No | n/a | Threshold BLS signature, verified on-chain | Supra deposit (native) | Not among the roughly 60 networks on the [networks page](https://docs.supra.com/dvrf/learn-supra-dvrf/networks). |
| **APRO VRF** | No | No | BSC Coordinator V2 `0xA7dE2D68627604b9306Ea8d862b59511Ce338b2E` and BlockHashStore `0xbD5dE803a825f63e1Cc4B7ca734D8B0dAa04842f`: **0 bytes** on both RSK chains | BLS threshold with timelock encryption, Chainlink-style coordinator | "Valueless_Test" token `0x6539e82D19A1D67696aCE0A0eBd919Cc50F8798C` | BSC only, per the [integration guide](https://docs.apro.com/en/apro-vrf/vrf/integration-guide.md). APRO's only Rootstock product is price push. |
| **ARPA Randcast** | No | No | n/a | BLS threshold signatures (BLS-TSS network), verified on-chain | ETH/native plus ARPA | Not listed on the [supported networks page](https://docs.arpanetwork.io/randcast/supported-networks-and-parameters.md). Its mainnets are Ethereum, BSC, ARPA Chain, OP, TON, Base, Redstone and Taiko. Its testnets are Hoodi, Sepolia, OP Sepolia and Taiko Hoodi. |
| **ORAO zkVRF (EVM)** | No | No | n/a | zk-proved VRF | n/a | EVM support is limited to Polygon Amoy and Zircuit testnet ([orao.network/zkvrf](https://orao.network/zkvrf)). |
| **DIA xRandom** | No | No | n/a | Relays drand, which is public before the relay, so it **fails the hidden-output requirement** | n/a | Rootstock doesn't appear in DIA's llms.txt or in its chain-guides overview. |
| **RedStone** | n/a | n/a | n/a | No VRF product | n/a | Listed on the Rootstock Oracles page for price data only. The old `redstone-finance/redstone-vrf-oracle-node` is archived (MIT, last push 2022-05-19). |
| **Randamu dcipher** | No | No | n/a | BLS threshold | n/a | Ran on Filecoin, Polygon, Base/Arb/OP Sepolia, Avalanche testnet and Sei testnet, never RSK. Randamu shut down in February 2026 and its repos are archived. |
| **Orakl** | No | No | n/a | Chainlink VRF fork | n/a | Kaia only. Not examined further. |
| **Umbrella** | n/a | n/a | n/a | Price feeds only | n/a | Rootstock `llms-full.txt` mentions it for price feeds and says it is often unavailable on testnet. |

## Reusable open-source EVM VRF code

| Code | Licence (SPDX checked in file headers) | Scheme | Audit | Maintenance | Notes for RSK |
|---|---|---|---|---|---|
| Chainlink [`smartcontractkit/chainlink-evm`](https://github.com/smartcontractkit/chainlink-evm): `VRF.sol`, `VRFCoordinatorV2_5.sol`, `BlockhashStore.sol`, `SubscriptionAPI.sol` | **MIT** in every file header. The repo LICENSE is MIT, plus LGPL-3.0 for `./pkg/bindings/abigen` only. No BUSL found. | secp256k1, Chainlink's own construction (not RFC 9381). It uses the `ecrecover` trick for scalar multiplication and modexp precompile `0x05` for square roots. | No public VRF v2.5 audit report found. Etherscan shows "No Contract Security Audit Submitted". The contracts README warns that `dev/` contracts "are likely unaudited". | Active (pushed 2026-10-21) | `VRF.sol` uses `^0.8.0` and the coordinator uses `0.8.19`, so both work with Foundry as-is. Modexp `0x05` works on both RSK chains (eth_call `3^2 mod 5` returns `4`). Battle-tested on many chains. |
| [`witnet/vrf-solidity`](https://github.com/witnet/vrf-solidity) and [`witnet/elliptic-curve-solidity`](https://github.com/witnet/elliptic-curve-solidity) | **MIT** | ECVRF draft-irtf-cfrg-vrf-04, SECP256K1_SHA256_TAI (suite `0xFE`) | None. The README says it is "experimental software. Use it at your own risk". | vrf-solidity last pushed 2022-05-17; elliptic-curve-solidity 2026-04-14 | Pragma `>=0.5.3 <0.7.0`, so it needs porting to 0.8. Gas: `verify` about 1.64M; `fastVerify` about 150k on average (range 106k to 353k) with `computeFastVerifyParams` run off-chain. The suite follows an old draft and has not been updated to final RFC 9381. |
| **Org prior art**: [`mangekyou-labs/vrf-server`](https://github.com/mangekyou-labs/vrf-server) `crosschain-prover/contracts/src/{VRF,VRFCoordinator,BlockHashStore}.sol` and Go `crosschain-prover/operator` | Repo LICENSE is Apache-2.0. The Solidity files carry **SPDX MIT** headers. | `VRF.sol` is the secp256k1 Chainlink-style verifier: it has the same `GROUP_ORDER`/`FIELD_SIZE` constants and the same `bigModExp` via `0x05` | None known | Last push 2026-05-12 | Already an EVM coordinator, verifier and operator in-house, and could be the fastest starting point. The separate `ecvrf-cli`/Solana path uses `curve25519-dalek` (32-byte keys, 80-byte proofs, Ristretto-style), which is **not** compatible with the EVM secp256k1 verifier. |
| ARPA [`BLS-TSS-Network`](https://github.com/ARPA-Network/BLS-TSS-Network) | Apache-2.0 | BLS threshold on BN254 | Unknown | Pushed 2025-10-26 | Needs bn128 pairing (`0x08`). Add (`0x06`) is confirmed on RSK testnet; pairing was not checked here. `Randcast` (MIT, 2022) is stale, and `Randcast-User-Contract` has no licence. |
| Randamu `randomness-solidity`, `bls-solidity` | MIT | BLS threshold | Unknown | **Archived** (2026) | Usable as reference only. |

## Newly surfaced questions

1. **Suite choice.** Should we use Chainlink-style secp256k1 (cheap via `ecrecover`, MIT, battle-tested, but non-standard) or an RFC 9381 / draft-04 ECVRF (Witnet, which is standard-ish but needs an 0.8 port and is about 150k gas with off-chain helpers)? The org's `vrf-server` already contains a Chainlink-style EVM VRF.sol plus a Go operator. Does that make it the intended starting point?
2. **Prover compatibility.** The org's Rust `ecvrf` prover (curve25519/Ristretto) can't feed a secp256k1 EVM verifier. Either the oracle worker uses the Go operator or a secp256k1 prover, or we pay for an on-chain Ristretto/ed25519 verifier, which would be very expensive without precompiles.
3. **Precompiles.** Modexp (`0x05`) is confirmed on both chains and bn128 add (`0x06`) on testnet. bn128 pairing (`0x08`) and blake2f (`0x09`) were not tested, and BLS-based designs would need them.
4. **Future-input binding.** Rootstock uses merged mining with Bitcoin, so its reorg and confirmation profile differs from Ethereum's. API3 used 3 confirmations on mainnet and 1 on testnet. What blockhash and confirmation depth should requests bind to, and is `BLOCKHASH` reliable within 256 blocks on RSK?
5. **Audits.** No candidate verifier has a public audit (Chainlink VRF v2.5 has no published report; Witnet's is explicitly experimental). Does the testnet scope need any review gate?
