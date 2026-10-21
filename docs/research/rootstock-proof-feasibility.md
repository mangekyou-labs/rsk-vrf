# Research: Rootstock proof feasibility

- Ticket: [#2](https://github.com/mangekyou-labs/rsk-vrf/issues/2) (parent map [#1](https://github.com/mangekyou-labs/rsk-vrf/issues/1))
- Date: 2026-10-21
- Method:
  - Rootstock facts come from the RSKj source at tag/commit `c19cf12` ("VETIVER", the exact build the public nodes report through `web3_clientVersion`: `RskJ/9.0.3/Linux/Java17/VETIVER-c19cf12`) and from read-only JSON-RPC against `https://public-node.testnet.rsk.co` (chain 31) and `https://public-node.rsk.co` (chain 30).
  - Gas was measured with a Foundry probe project, committed here under [`research/proof-probe/`](../../research/proof-probe/). Each probe contract's constructor runs one verifier between two `gasleft()` reads and returns `abi.encode(ok, verifyGas, output)` as its runtime code.
  - The contract-creation transaction (no `to`) was sent to Rootstock with `eth_call` and `eth_estimateGas` only. Nothing was signed, broadcast or deployed, and no funds were used.
  - Third-party code was downloaded into isolated directories and only read. The specific verifier files needed were copied into the probe, with their headers kept.

## Conclusion

**VRF established: a secp256k1 ECVRF.** The primary pick is the Chainlink `VRF.sol` construction, which the org already carries as `crosschain-prover/contracts/src/VRF.sol`. The alternative is an RFC 9381-structured ECVRF verified with Rootstock's RSKIP516 secp256k1 precompiles. This holds on one condition: the coordinator binds the complete VRF input at request time. The org's current coordinator does not, as shown in [Grinding](#grinding-and-input-binding).

| | Chainlink `VRF.sol` (org copy) | RFC 9381-style ECVRF via RSKIP516 |
|---|---|---|
| Verify gas, Rootstock testnet and mainnet (identical) | **49,086** (vector needs 1 extra hash-to-curve round) | **43,071** (TAI ctr = 0); **105,650** at ctr = 4, so about 15,645 per extra round |
| Whole creation tx (`eth_estimateGas`) | 184,985 | 161,616 |
| Headroom: verify / testnet block (12,000,000) | 0.41 % | 0.36 % (ctr 0) |
| Headroom: whole probe tx / per-tx cap (10,000,000 on both nets) | 1.85 % | 1.62 % |
| Uniqueness incl. key validation | pk, Gamma and both witnesses must be on-curve; cofactor 1. Chainlink's claim, proofs in eprint 2017/099 App. B | pk and Gamma must be on-curve, c < 2^128, s < n, U and V not infinity; cofactor 1 |
| Maturity | Production code on many EVM chains; code-identical to upstream | My own research code, unaudited; non-standard suite byte; depends on a Rootstock-only precompile activated in 2025-26 |

Why Chainlink is the primary pick:

- It is the same cost class as the alternative: 49k against 43k at ctr 0, or about 59k at the expected ctr ≈ 1. That figure is derived from the measured per-round cost, not measured directly.
- It needs only `ecrecover` and modexp, both present on every EVM chain.
- It is upstream production code, and the org already has a byte-for-byte equivalent.

RSKIP516 ECVRF is worth keeping as the alternative if the org wants an RFC 9381-structured proof (compressed points, 81-byte proof, suite-separated hashing) rather than Chainlink's keccak/address-truncated variant.

Rejected:

- **mangekyou Ristretto ECVRF:** output computable from the public key alone. It is not a VRF.
- **witnet `vrf-solidity`:** 1.61M gas for the full verify. The cheap `fastVerify` drops to 160-bit address checks. No curve-membership checks, solc < 0.7, draft-04.
- **drand-as-prover:** a sound, unique beacon, but the output is public as soon as drand publishes the round, before fulfillment.
- **BN254 BLS unique signatures:** viable and measured at 179,315 gas, but about 4x the cost of an ECVRF, with roughly 100-bit security and a G2 key-validation obligation. Nothing it offers is needed.

### What the measurement does not cover

- **Not a fulfill transaction.** The probe embeds the proof as constants in init code, so the calldata cost (62,572 gas for the Chainlink probe) is init-code cost.
  - A real `fulfillRandomWords` adds request-storage reads and deletes, the block-hash-store lookup, ABI-decoding of a calldata proof, the consumer callback (bounded by `callbackGasLimit`), and 21,000 instead of 53,000 base gas.
  - The verify-only column is the number to carry forward. The whole-tx column is an upper bound on the overhead of this harness, not of a fulfill.
- **Hash-to-curve variance.** Cost grows by about 15.6k gas per extra round for both secp256k1 constructions. Each extra round is a failed square-root attempt at 13,056 gas via modexp (EIP-198 pricing, see below), plus hashing.
  - Round counts are geometric with p ≈ 1/2. Over 2,000 random inputs the observed maximum TAI counter was 13, about 246k gas, still 2.5 % of the 10M cap.
  - Chainlink's own comment (`VRF.sol` lines 109-120) quotes 15,555 gas per round and puts a 2M-gas input at 2^-128 probability.
- **Single point in time.** One block per network (testnet 8,206,446; mainnet 9,343,225), measured through the public node's `eth_call`/`eth_estimateGas`, not a mined receipt and not a local node. A future repricing fork would change the numbers.
- **Proof generation, oracle key management and off-chain latency** are out of scope here.
- **RSKIP516 on a local regtest node** is active from block 0 (`regtest.conf`: `reed800 = 0`). It was not exercised there.

## Rootstock facts

### Block and transaction gas limits

| | Testnet (31) | Mainnet (30) |
|---|---|---|
| `latest.gasLimit` (RPC, 2026-10-21) | **12,000,000** (block 8,206,446) | **10,000,000** (block 9,343,225) |
| RSKIP144 (parallel tx execution, `reed810`) | active from 7,139,600 (`testnet.conf` line 19) | **not scheduled**: `reed810 = -1` (`main.conf` line 19) |
| Effective per-tx cap | 10,000,000 | 10,000,000 (block limit) |

- On testnet the per-tx cap comes from the RSKIP144 sequential sublist: `Constants.MIN_SEQUENTIAL_SET_GAS_LIMIT = 10_000_000` (`Constants.java` line 64), and the sublist gas limit is used when RSKIP144/351 are active (`TransactionExecutor`).
- The Rootstock dev portal still says "The transaction gas limit per block is 6,800,000 units" (`concepts/rbtc/gas`). That is stale for both networks. 6.8M survives only as `MIN_SEQUENTIAL_SET_GAS_LIMIT_SPLIT_FOR_PTE` for regtest (`Constants.java` line 65).
- **Intrinsic gas** (RSKj `GasCost.java`, `Transaction.java` line 230): TRANSACTION 21,000; TRANSACTION_CREATE_CONTRACT 53,000; zero byte 4; non-zero byte 16 after RSKIP400 (68 before; `rskip400 = arrowhead600`).

### Precompiles

Addresses are from `PrecompiledContracts.java` lines 78-93, activation rules from lines 140-151 and `reference.conf`, and activation heights from `config/{main,testnet}.conf`. Every row was confirmed live on 2026-10-21 with `eth_call` against both public nodes, using known-answer inputs.

| Address | Function | Activation | Live check (testnet and mainnet) |
|---|---|---|---|
| 0x01 | ecrecover | genesis | used by Chainlink and witnet probes |
| 0x02 / 0x03 / 0x04 | sha256 / ripemd160 / identity | genesis | sha256 used by every probe |
| 0x05 | modexp, **EIP-198 pricing** (`GQUAD_DIVISOR = 20`, `PrecompiledContracts.java` line 462; no EIP-2565 repricing) | RSKIP?? (genesis-era) | used by every probe; 32-byte sqrt = 13,056 gas |
| 0x06 / 0x07 | alt_bn128 add / mul | RSKIP137 (`papyrus200`) | mul(G1, 2) returned the correct 2G |
| 0x08 | alt_bn128 pairing: 45,000 + 34,000 per pair (EIP-1108 values, `BN128Pairing.java` `getGasForData`) | RSKIP137 | empty input returned 1; drand probe verifies a real round; off-curve G1 input makes the call fail (see [invalid-input behaviour](#pairing-precompile-invalid-input-behaviour)) |
| 0x09 | blake2f | RSKIP153 (`iris300`) | EIP-152 test vector 5 returned the expected `ba80a53f...4009923` |
| 0x01000016 | secp256k1 ADD, 150 gas (`Secp256k1Addition.java` line 27) | **RSKIP516** (`reed800`) | used by ECVRF probe |
| 0x01000017 | secp256k1 MUL, 3,000 gas (`Secp256k1Multiplication.java` line 27) | **RSKIP516** (`reed800`) | G·2 returned the correct 2G (`c6047f94...`) on both nets |
| 0x01000006 / 08 / 09 / 10 / 11 | Bridge / Remasc / HDWalletUtils / BlockHeader / Environment | Rootstock native | not relevant here |

- `reed800` activates at 6,835,700 on testnet and 8,052,200 on mainnet, so RSKIP516 is live on both.
- No BLS12-381 (EIP-2537), Curve25519/Ristretto, or P-256 precompile exists in this build.
- For G2 points in the pairing input, the Java implementation enforces subgroup membership (`BN128G2.create`, `isGroupMember`). Public Linux nodes use the native `GoAltBN128` (`AbstractAltBN128.java` line 29), whose checks were not separately read.

## Candidates

All gas figures are `verifyGas` from `eth_call` on Rootstock and were identical on testnet and mainnet. Full output is in [`research/proof-probe/measurements-2026-10-21.txt`](../../research/proof-probe/measurements-2026-10-21.txt). Forge (revm, Ethereum schedule) figures are given only for comparison.

### 1. Chainlink `VRF.sol`, the org's `crosschain-prover` copy

- **Source.** `mangekyou-labs/vrf-server@71fdd87` (2026-05-12) `crosschain-prover/contracts/src/VRF.sol`.
  - After normalising whitespace and the leading underscore on identifiers, it is code-identical to `smartcontractkit/chainlink-evm@23aa976` `contracts/src/v0.8/vrf/VRF.sol`.
  - Only two other differences: `randomValueFromVRFProof` takes `Proof memory` instead of `calldata`, and a `Request` struct is added.
  - The file header is `SPDX-License-Identifier: MIT`, but the vrf-server repository `LICENSE` is Apache-2.0. That mismatch is worth resolving before reuse.
- **Construction** (from the file's design notes, lines 39-104).
  - Based on draft-irtf-cfrg-vrf-05 on secp256k1, with keccak in place of SHA-256 and recursive-rehash hash-to-curve.
  - The challenge covers `u`'s Ethereum address rather than `u`, so that `ecrecover` can verify `c·pk + s·G` up to its address.
  - Multiplications on H and Gamma are checked with `ecrecover`, and their sum is computed projectively with a caller-supplied `zInv`.
- **Uniqueness and key validation.**
  - `verifyVRFProof` requires pk, Gamma, cGammaWitness and sHashWitness on curve (lines 507-510).
  - secp256k1 has cofactor 1, and the affine encoding cannot denote infinity, so on-curve is the full key validation (lines 98-103).
  - Full uniqueness, collision resistance and pseudorandomness are claimed, with proofs cited to eprint 2017/099 App. B (lines 88-97). I did not re-derive those proofs.
- **Measured.** Valid proof: **49,086 gas** verify, estimateGas 184,985. A tampered `s` reverts with `addr(c*pk+s*g)!=_uWitness`. A tampered seed reverts with `Second mul check failed`. Forge: 22,878. The gap is Rootstock's EIP-198 modexp pricing.
- **Hiding.** Output = keccak(3 ‖ Gamma), and Gamma = sk·H(pk, seed). It is pseudorandom to everyone but the oracle until the proof is published.

### 2. RFC 9381-style ECVRF over secp256k1

There are two implementations.

**(a) witnet/vrf-solidity@653dc85** (2020-12-01, `VRF.sol` with `EllipticCurve.sol` 0.2.4). MIT licensed, though the README's license link points at `vrf-rs`. It follows **draft-04**, not RFC 9381 (README line 62), uses `pragma >=0.5.3 <0.7.0`, and has no audit referenced in the repo.

- `verify` performs **no on-curve check on pk or Gamma and no `s < n` check** (lines 86-121). Only `uint128(derivedC) == c` is checked.
  - Off-curve Gamma values are therefore not excluded. Because beta = hash(Gamma), that leaves uniqueness unsupported. I did not construct an exploit.
- `fastVerify` uses `ecrecover` and states that this is "decreasing the security from 32 to 20 bytes" (line 123).
- Measured with witnet's own `test/data.json` vector:
  - `verify`: **1,611,554**, estimate 1,782,021.
  - `fastVerify`: **82,597**, estimate 253,003.
  - Tampered `s` returns false: 1,608,738 for `verify`, 40,583 for `fastVerify`.
- Rejected on cost (`verify`), on security margin (`fastVerify`), and on the missing curve checks.

**(b) `EcvrfSecp256k1Rskip516`**, my own verifier in the probe.

- Structure:
  - RFC 9381 §5.3 verify, with `encode_to_curve_try_and_increment` (§5.4.1.1).
  - Salt = compressed pk, `cLen = 16`, `ptLen = 33`.
  - Challenge per §5.4.3; `proof_to_hash` per §5.2.
- Suite byte 0xFE is **non-standard**, because RFC 9381 defines no secp256k1 suite. It is the same byte witnet uses.
- Scalar multiplications go through RSKIP516 MUL/ADD. Square roots go through modexp.
- Checks: pk and Gamma on curve, `c < 2^128`, `s < n`, and U, V ≠ infinity.
- Measured:
  - Valid: **43,071** (ctr 0), estimate 161,616.
  - Tampered `s` returns false at 41,040. Tampered alpha returns false at 105,650 (its TAI ctr is 4). An off-curve pk returns false at 360.
- Vectors come from an independent Python prover (`scripts/gen_vectors.py`), which also self-checks the negative cases.
- RSKIP516 is the only option that is not portable to other EVM chains, which is why it is the alternative rather than the primary pick.

### 3. The org's Ristretto ECVRF (`mangekyou`, `kamui_vrf.rs`)

**Not a VRF.** In `vrf-server@71fdd87` `mangekyou/src/kamui_vrf.rs` lines 142-153, `ecvrf_encode_to_curve_solana` computes `h = SHA512(DST ‖ HASH_POINTS_DST ‖ Y ‖ alpha) mod L` and returns **H = h·B**.

- Then Gamma = x·H = h·(x·B) = **h·Y**, which anyone can compute from the public key, and so can beta = `to_hash(Gamma)`.
- `research/proof-probe/scripts/mangekyou_gamma_from_pk.py` ports `prove`, `verify` and `to_hash` to Python. It shows a proof that verifies, and a beta recomputed without the secret key that matches.
- The output is neither hidden nor pseudorandom, so it fails the map's criterion 2 outright.
- The crate's `tests/vrf_tests.rs` vectors target a module (`crate::vrf::ecvrf`) that no longer exists and is not compiled.

**It cannot feed a secp256k1 verifier.** Ristretto255 (RFC 9496, over Curve25519) and secp256k1 are different prime-order groups.

- A Ristretto key, Gamma, and 32-byte point encodings mean nothing to `VRF.sol` or `EcvrfSecp256k1Rskip516`. Neither can a SHA-512 challenge scalar mod L.
- An oracle would need a separate secp256k1 key and prover.
- An on-chain Ristretto verifier would need pure-EVM arithmetic mod 2^255−19. Rootstock has no Curve25519 precompile (table above).
- **Not measured.** By analogy with witnet's pure-EVM `verify` at 1.6M, expect the same order of magnitude or worse. That is an inference, and it is moot given the flaw.

### 4. BN254 BLS unique signatures (oracle-owned key)

- **Precompiles exist** (0x06-0x08).
- **Cost.** The verify is the same code path as candidate 5 with a different pk: hash-to-G1 (SVDW) plus a 2-pair pairing.
  - Measured **179,315** gas. Of that, 63,521 is hash-to-G1 (measured on its own, see [below](#bn254-hash-to-curve-on-rootstock)), 113,000 is the pairing (45,000 + 2·34,000), and about 2.8k is sha256, memory and call overhead.
- **Uniqueness.** BLS signatures are unique for a fixed message and a valid key: G1 has cofactor 1, so on-curve suffices for the signature.
  - The oracle's G2 public key must be validated for subgroup membership at registration. RSKj's Java pairing enforces this; the Go path was not read.
- **Security level.** BN254 provides roughly 100-bit security after the exTNFS improvements (Barbulescu & Duquesne, "Updating Key Size Estimations for Pairings", J. Cryptology 2019).
- **Verdict.** Viable, but about 4x the ECVRF cost at a lower security level, with an extra key-validation obligation. Not selected.

### 5. drand-as-prover (evmnet)

- **Pinned beacon** (`https://api.drand.sh/v2/beacons/evmnet/info`, fetched 2026-10-21):
  - chain hash `04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3`
  - scheme `bls-bn254-unchained-on-g1`
  - period 3 s
  - genesis 1727521075
  - G2 public key as in `DrandEvmnetVerifier.sol` (PK0-PK3)
- **Verification** (`src/drand/DrandEvmnetVerifier.sol`): checks `e(sig, G2) == e(H(m), pk)`.
  - m = keccak256(uint64be(round)).
  - H is expand_message_xmd(keccak256) plus SVDW with DST `BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_`, ported from `drand/kyber` `pairing/bn254` and `drand/drand` `crypto/schemes.go`.
  - Randomness = sha256(sig).
- **Measured.** Round 1,000,000 verifies at **179,315** gas (estimate 303,482). Its randomness equals the API's `4da14d73...780569c`. A wrong round and a negated signature both return false (177,930). An off-curve signature returns false (177,916) without burning the forwarded gas. Forge: 128,870.
- **Uniqueness.** Yes. One valid BLS signature exists per round under the pinned key.
- **Grinding.** If the fulfiller chooses the round, it can choose among every published round, and grinding is trivial. The round must be fixed by the contract at request time, for example `round = ceil((block.timestamp − genesis)/3) + k` for a future offset. Then no one, including the fulfiller, chooses the output.
- **Trust shift.** Correctness and unpredictability rest on drand's threshold network (League of Entropy) rather than on a single oracle key. Liveness rests on drand plus anyone relaying the signature.
- **Output hiding fails.** The signature for round r is published by drand's HTTP and gossip relays at genesis + (r−1)·3 s, to everyone, before any Rootstock fulfill transaction can land.
  - So the output is hidden only until the round time, not until fulfillment. Requesters and observers see it in the gap.
  - It is safe only where nothing actionable depends on the output between round time and fulfillment, for example a request that is irrevocable and whose consequences are fixed at request time.
  - This fails the map's criterion 2 as stated.
- **Boundary with #3.** Here drand is evaluated as the *proof* of the output. In #3, drand is a candidate *input* to bind, for example as an alpha/seed component of an ECVRF request.
  - Mixing a future drand round into the ECVRF alpha keeps the ECVRF's hiding, because only the oracle can compute Gamma.
  - It also removes the oracle's knowledge of the output before the round time.
  - The 179k gas figure applies if #3 decides to verify that round on-chain. The hash-to-curve cost, the implementation question and the evmnet trust parameters raised from #3 are answered in the next three subsections.

### BN254 hash-to-curve on Rootstock

This answers a question raised from #3 (`docs/research/future-entropy-source.md` on branch `research/future-entropy-source`), which had estimated the drand verify at 150k-200k gas without measuring hash-to-curve.

- **Measured, not estimated.** Probe mode 3 runs `DrandEvmnetVerifier.hashToG1` on its own and checks the result against drand's H(m) for round 1,000,000. The output matched.
  - Cost on Rootstock, identical on testnet (block 8,206,630) and mainnet (block 9,343,377): **63,521 gas**. Forge (Ethereum schedule): 14,287.
  - The work is expand_message_xmd with keccak256 to 96 bytes, two SVDW `map_to_curve` calls (RFC 9380 §6.6.1, Z = 1) and one G1 add (0x06).
  - Nearly all of the cost is modexp. Each `map_to_curve` makes one field inversion (exponent P−2) and one to three square roots (exponent (P+1)/4). Each is a 32-byte modexp at about 13k gas under Rootstock's EIP-198 pricing. That gives 4 to 8 modexp calls per hash, depending on the input.
  - The 4.4x gap against forge comes from that pricing: Rootstock has not adopted EIP-2565.
- **Cheaper variant, not measured.** Passing square roots and inverses as calldata hints and checking them with `mulmod` would remove almost all of the modexp cost. On that basis I would expect a full verify of roughly 120k-130k. That figure is an inference, not a measurement, and this probe does not do it.
- **Full verify** is 179,315 gas (measured above). That is 1.8 % of the 10M per-tx cap on both networks and confirms #3's 150k-200k range.
- **Audited Solidity implementations: none found for the hash-to-curve itself.** Every on-chain implementation I found with evmnet's DST (`BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_`) derives from one unaudited library:
  - `kevincharm/bls-bn254@9f70fb4` (MIT). Its README gives no audit and says the code is largely taken from hubble-contracts, bls_solidity_python, evmbls and draft-irtf-cfrg-hash-to-curve. The DST is supplied by the caller.
  - `randa-mu/bls-solidity@11af179` (MIT). Its README describes its BN254 `BLS.sol` as "based on Kevin Charm's bls-bn254 library" and states "**Experimental, unaudited cryptographic code. Use at your own risk.**" It ships an `EvmnetRegistry.sol` demo.
  - `frogworksio/anyrand@4b17b49` `contracts/beacon/DrandBeacon.sol` hard-codes the evmnet DST and imports `@kevincharm/bls-bn254`. Its 0xGuard audit (October 2024, `audits/2024-10-14_Anyrand_final-audit-report_*.pdf`) lists `DrandBeacon.sol` as checked, but says: "The audit scope excludes external libraries, including the @kevincharm/bls-bn254 cryptographic library."
  - `GOATNetwork/goat-vrf-contracts@1f1e42a` `src/BN254DrandBeacon.sol` inlines a copy with the same DST. Its 0xGuard audit (March 2025) says: "The audit scope excludes BN254DrandBeacon and BLS12381DrandBeacon contracts."
  - So the wrappers around the hash-to-curve have been audited, but not the hash-to-curve itself. The probe's own verifier is unaudited too. It is validated only against drand's real round 1,000,000 signature and its H(m).
  - My search was GitHub code search for the DST string, so an audit published elsewhere would have been missed.

### Pairing precompile invalid-input behaviour

#3 reported that an invalid point gives empty output instead of a revert. On the current RSKj build, the source says something more specific:

- `BN128PrecompiledContract.execute` (RSKj `c19cf12`) has two paths, depending on RSKIP197:
  - Before RSKIP197 (`safeExecute`), an invalid result returns `EMPTY_BYTE_ARRAY`, so the call *succeeds with empty output*.
  - After RSKIP197 (`unsafeExecute`), it throws `VMException`.
- `Program.executePrecompiledAndHandleError` turns that exception into a *failed* call: it pushes 0, sets the return data to null, and refunds the forwarded gas minus the precompile price (in the `finally` block). On Ethereum, by contrast, the call fails and **all** forwarded gas is consumed.
- RSKIP197 activates at `iris300` (`reference.conf` line 54), so it is active on both networks today.
- Measured: an off-curve signature (mode 4) returns false at 177,916 gas on both networks, so nothing was burned. The same input in forge consumed the whole forwarded gas (test gas about 1.04e9).
- To cover both behaviours and the native Go path (whose return code was not read), the verifier now requires `success && returndatasize() == 32 && output == 1`. Code that relies on a revert, or that reads output from zero-initialised memory without checking its length, is fragile on Rootstock.

### evmnet threshold, membership and key rotation

**I could not confirm evmnet's threshold, node membership or rotation policy from a primary source.**

- **Not published per beacon.**
  - The public chain info (`/v2/beacons/evmnet/info` and `/{chain_hash}/info`) contains only `public_key`, `period`, `genesis_time`, `genesis_seed`/`groupHash`, `chain_hash`, `scheme` and `beacon_id`. There is no threshold and no node list.
  - The drand specification says the group configuration holds `Nodes` and `Threshold` (`drand-docs@333c0c8` `docs/concepts/03-Specification.md` lines 112-125). That configuration lives on the nodes, and I found no public HTTP endpoint or repository for evmnet's copy.
  - The League of Entropy page (https://www.drand.love/loe) lists mainnet and testnet member organisations, but does not say which of them run evmnet or with what threshold.
- **What the primary sources do establish, for drand networks in general:**
  - The threshold "must be superior to 50% of the number of nodes" (Specification lines 117-119).
  - Rotation happens by **resharing**: the shares change but "the distributed public key doesn't change" (`docs/concepts/02-Security_Model.md` lines 132-138), and "even after a resharing is performed, the chain information is constant" (Specification lines 696-697).
  - So a contract that pins evmnet's G2 key and chain hash survives membership changes. Only a fresh DKG creates a new chain and key, which needs a contract update.
  - The security model notes that anyone who collects a threshold of shares "can generate all future chain beacons" (Security Model lines 125-127). It does not say whether shares from before a resharing stop being usable. I therefore cannot rule out that a past threshold coalition, colluding or compromised, remains a risk after rotation.
- **Lifecycle.** drand calls BN254 the "legacy option" and says evmnet's fate is for the League of Entropy to "collectively decide", with "no plan to wind it down as long as there is interest" (`blog/2025-08-26-verifying-bls12-on-ethereum.md` lines 25 and 37). So there is no formal deprecation commitment.
- **Consequence:** the trust shift for drand, whether as a proof or as an input, cannot be quantified in t-of-n terms from public data. It should be confirmed directly with the drand team or the League of Entropy before relying on it.

## Grinding and input binding

A unique proof stops grinding only if the verifier fixes the input. In `crosschain-prover/contracts/src/VRFCoordinator.sol`:

- `requestRandomWords` derives `seed = keccak256(abi.encode(callbackAddress, nonce))` (line 67). It stores a commitment over requestId, sender, nonce, oracleId, nbWords, requestConfirmations, callbackGasLimit, callbackAddress and callbackSelector (lines 69-80). **It does not store `blockNumber`.**
- `fulfillRandomWords` takes `_request.blockNumber` from the fulfiller and computes `actualSeed = keccak256(seed ‖ blockHashStore.getBlockHash(_request.blockNumber))` (lines 132-133).
  - Any stored hash is accepted.
  - `BlockHashStore.storeBlockHashesViaOpCode` is callable by anyone for the last 256 blocks (`BlockHashStore.sol` lines 20-26).
  - **So the fulfiller can pick among hundreds of seeds, each with a different unique output.** That is grinding.
  - `requestConfirmations` is not enforced at fulfill time either, and there is no caller restriction.

The fix is to commit the request block number and have the fulfill check the block number and confirmation depth. Choosing which Rootstock entropy to bind is #3's question.

## Reproducing

```
cd research/proof-probe
git clone https://github.com/foundry-rs/forge-std lib/forge-std   # tested at b013eff
forge test -vv                                                     # forge 1.5.1; solc 0.8.36 + 0.5.16
python3 -I scripts/measure_rsk.py . testnet mainnet                # read-only eth_call / eth_estimateGas
```

- `forge test` runs 9 tests: valid and negative cases for every probe, plus drand hash-to-G1 on its own.
- The RSKIP516 probe uses a test-only Solidity mock of the precompiles via `vm.etch`, so its forge gas is meaningless.
- `scripts/gen_vectors.py` regenerates `src/Vectors.sol`. Its keys and nonces are deterministic **test-only** values derived from public strings.

## Sources

- RSKj `c19cf12`:
  - `rskj-core/src/main/java/org/ethereum/vm/PrecompiledContracts.java`
  - `org/ethereum/vm/GasCost.java`
  - `org/ethereum/core/Transaction.java`
  - `org/ethereum/config/Constants.java`
  - `co/rsk/pcc/secp256k1/*.java`
  - `co/rsk/pcc/altBN128/BN128Pairing.java`
  - `co/rsk/crypto/altbn128java/BN128G2.java`
  - `rskj-core/src/main/resources/{reference,config/main,config/testnet,config/regtest}.conf`
- Rootstock public nodes (JSON-RPC, 2026-10-21): `web3_clientVersion`, `eth_getBlockByNumber`, `eth_call`, `eth_estimateGas`.
- Rootstock dev portal, gas page (stale 6.8M figure): https://dev.rootstock.io/concepts/rbtc/gas/
- RSKIP516 (secp256k1 ADD/MUL precompiles): https://github.com/rsksmart/RSKIPs
- `mangekyou-labs/vrf-server@71fdd87`:
  - `crosschain-prover/contracts/src/{VRF,VRFCoordinator,BlockHashStore}.sol`
  - `mangekyou/src/kamui_vrf.rs`
  - `LICENSE`
- `smartcontractkit/chainlink-evm@23aa976` `contracts/src/v0.8/vrf/VRF.sol`
- `witnet/vrf-solidity@653dc85` `contracts/VRF.sol`, `README.md`, `package.json`, `test/data.json`. `witnet/elliptic-curve-solidity` 0.2.4 `contracts/EllipticCurve.sol`.
- Specifications:
  - RFC 9381 (ECVRF)
  - RFC 9380 (hash to curve, SVDW §6.6.1)
  - RFC 9496 (ristretto255)
  - EIP-152, EIP-196, EIP-197, EIP-198, EIP-1108, EIP-2565
  - draft-irtf-cfrg-vrf-04 and -05
  - Papadopoulos et al., eprint 2017/099
- drand:
  - `https://api.drand.sh/v2/beacons/evmnet/info`
  - `https://api.drand.sh/04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3/public/1000000`
  - `drand/drand` `crypto/schemes.go`
  - `drand/kyber` `pairing/bn254`
- Barbulescu & Duquesne, "Updating Key Size Estimations for Pairings", Journal of Cryptology 32 (2019).

## Newly surfaced questions

1. **Coordinator grinding.** The fulfiller chooses `blockNumber`, which is not in the commitment, and `requestConfirmations` is not enforced. Fix this in whatever coordinator rsk-vrf ships.
2. **mangekyou `kamui_vrf.rs` output is computable from the public key.** Any deployment using it (Solana or other) has predictable randomness. Its `vrf_tests.rs` vectors are stale.
3. **Committed secret key material in vrf-server.** `vrf-keypair.json` and `oracle-keypair.json` sit at the repo root.
4. **License mismatch.** vrf-server's `LICENSE` is Apache-2.0, while `crosschain-prover/contracts/src/VRF.sol` is MIT. Settle provenance before copying.
5. **Network divergence.** Mainnet has a 10M block gas limit and no RSKIP144 (`reed810 = -1`), while testnet has 12M and RSKIP144. Size budgets against 10M, and track whether reed810 is scheduled for mainnet.
6. **Stale docs.** The Rootstock docs' 6.8M gas-limit statement is stale.
7. **Primary choice.** Chainlink `VRF.sol` (portable, upstream) or RSKIP516 ECVRF (RFC-structured, Rootstock-only, unaudited). If RSKIP516, it needs an audit and a standard-looking suite definition.
8. **drand boundary with #3.** Whether to mix a future drand round into alpha, and whether to verify it on-chain (179,315 gas, of which hash-to-G1 is 63,521).
9. **Selective abort.** No proof construction stops an oracle that sees the output first from withholding it. That is a liveness and economic question for the coordinator design.
10. **No audited BN254 SVDW hash-to-curve with evmnet's DST** was found. Every candidate traces to `kevincharm/bls-bn254`, which the two existing audits exclude. On-chain drand verification needs its own audit, or a review of that library.
11. **evmnet t-of-n and membership are not public.** Confirm them with drand or the League of Entropy, and ask whether a fresh DKG (which would change the key) is ever planned.
