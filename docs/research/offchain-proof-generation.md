# Off-chain proof generation for the Chainlink-style secp256k1 VRF (issue #17)

Question: which off-chain prover produces proofs that the vendored `VRF.sol` (`smartcontractkit/chainlink-evm@23aa97639f630240f34b79b98d6b38baa094ccc5`, `contracts/src/v0.8/vrf/VRF.sol`) accepts, including the `uWitness`, `cGammaWitness`, `sHashWitness` and `zInv` helpers? Map: issue #1.

## What the verifier needs

`Proof = {pk, gamma, c, s, seed, uWitness, cGammaWitness, sHashWitness, zInv}` (VRF.sol, `struct Proof`).

- `H = hashToCurve(pk, seed)`: `x = fieldHash(abi.encodePacked(1, pk(64B), seed(32B)))`; while `x^3+7` is a non-residue, `x = fieldHash(x)`; `y` is the even root.
- `gamma = sk*H`; `c = keccak(abi.encodePacked(2, H, pk, gamma, v, uWitness20))` (not reduced mod n); `s = (nonce - c*sk) mod n`.
- `uWitness` = Ethereum address of `c*pk + s*G` (ecrecover trick). `cGammaWitness = c*gamma`. `sHashWitness = s*H`. `zInv` = inverse of the z coordinate computed by `_projectiveECAdd(cGammaWitness, sHashWitness)`; Solidity z is `dx*dy`, or `dx` if `dx == dy`.
- Output = `keccak256(abi.encode(3, gamma))`.

The only secret-dependent operations are `sk*H` (scalar multiply of an arbitrary point) and `nonce*G`, `nonce*H`.

## Candidates

| | Chainlink Go `vrfkey` (chainlink-common) | Org `vrf-server/crosschain-prover` | TypeScript on `@noble/curves` |
|---|---|---|---|
| Language | Go (kyber-based secp256k1) | Go, thin wrapper over an old Chainlink import path | TypeScript/JS |
| License | MIT (chainlink-common root LICENSE; BUSL only for capabilities/consensus/ocr3). kyber is MPL-2.0 | Repo root Apache-2.0; its `VRF.sol` is SPDX MIT | MIT (noble-curves v2.4.0) |
| Library use in a long-running worker | Yes: `vrfkey` has `GenerateProofWithNonce`, `MarshalForSolidityVerifier`; Chainlink's `core/services/vrf/proof` has `SolidityPrecalculations` (480 B proof) | Poor: no `go.mod`/`go.sum` under `crosschain-prover`, not buildable standalone; server is a CLI with `-p privateKey` hex flag | Yes, but the ~40-line proof layer is ours to own |
| Key handling | In-process scalar (kyber). `secp256k1/scalar.go` header: "Do not use in production until this code has been audited" and "NOT CONSTANT TIME" | Raw hex private key on the command line (visible in process list); `crypto.HexToECDSA` | In-process bigint; noble uses scalar blinding and a fixed operation sequence, but is constant-time only within JS limits |
| Reproduces Chainlink vectors | It is the reference. No static vectors found in the tests I read (proofs use random nonces); smoke test only in `proof_response_test.go` | Not verified; tests are mock-based, no vectors | Verified once on-chain, see below |

Sources are listed at the end.

## KMS finding (applies to all candidates)

AWS KMS `ECC_SECG_P256K1` is sign/verify only, and `DeriveSharedSecret` excludes secp256k1. GCP Cloud KMS offers only `EC_SIGN_SECP256K1_SHA256` (ECDSA) and no ECDH. A VRF proof needs `sk*H` for an arbitrary `H`, which an ECDSA-only KMS cannot produce. So the Proving Key cannot live inside AWS or GCP KMS as a usable VRF key. Practical options: (a) a secret manager holding the raw scalar, loaded into the worker at start, (b) KMS envelope encryption with the scalar decrypted in memory, (c) an HSM or MPC that supports arbitrary-point scalar multiply (not evaluated here).

## Spike: noble port against the vendored verifier

I wrote a small `@noble/curves` 2.4.0 prover (hashToCurve, ecrecover-style uWitness, a z computation that mirrors Solidity `_projectiveECAdd`, and `zInv`). Inputs: `sk=0x1234567890abcdef`, `seed=0xdeadbeef`, `nonce=0x3`. I ran it against the upstream `VRF.sol` at `23aa976` in Foundry (forge 1.5.1, solc 0.8.36) through a harness calling `_randomValueFromVRFProof`.

- The valid proof was accepted and the returned output equalled the prover's `0x99c364fb...f6b4`.
- The same proof with `s` incremented by 1 reverted.

This is a single vector with a small key and nonce, so it demonstrates compatibility of hashToCurve, c, s and the witnesses, not full coverage. Deterministic nonces were used for the spike only.

## Recommendation basis

- Correctness reference: the Go `vrfkey` library is authoritative, but its own header says not to use it in production until audited, and it is not constant time. Depending on it ties the worker to Go and an unaudited kyber scalar.
- The org's `crosschain-prover` is not a viable base: not buildable, key passed as a CLI flag, no vectors.
- The noble route is viable on the evidence: the spike proof verifies on the vendored contract, the library is MIT, widely audited for secp256k1 primitives, and fits a TypeScript worker. Cost: we own and must test the ~40-line VRF layer, including nonce generation.
- If the Oracle Worker Design ticket chooses Go, using chainlink-common `vrfkey` directly is the lower-risk path for proof construction; if TypeScript, noble plus a cross-check against Go-generated vectors.
- Either way, key custody is secret-manager or envelope-encrypted, not KMS-native.

## Explicit unknowns

- Whether the noble port matches Go `GenerateProofWithNonce` byte for byte for many random keys, seeds, and nonces. I tested one vector against Solidity only, not against Go, and did not run the Go library.
- Whether Chainlink publishes static VRF proof test vectors. I found none in `vrfkey` tests, `proof_response_test.go`, or crosschain-prover; `VRFTestHelper.sol` in chainlink-evm was not read.
- Nonce policy: the Go library uses random nonces; a safe deterministic (RFC 6979-style) or hedged nonce scheme for the TS port is undecided. Nonce reuse across seeds leaks the key.
- Constant-time behaviour of noble under a real worker's threat model; no side-channel testing done.
- Rare `dx == dy` divergence between Go (pointer compare) and Solidity in `zInv`; the noble port follows Solidity.
- HSM/MPC options supporting arbitrary-point scalar multiplication were not evaluated.
- Whether the vendored Solidity compiler version used by the repo matches the solc 0.8.36 I used for the spike.

## Sources

- `smartcontractkit/chainlink-evm@23aa97639f630240f34b79b98d6b38baa094ccc5`: `contracts/src/v0.8/vrf/VRF.sol`
- `smartcontractkit/chainlink-common@6812ecc7b2db3cfb4bad40392cdb7dc215d8aeb5`: `keystore/corekeys/vrfkey/{key_v2.go, proof.go, crypto.go, proof_test.go, crypto_test.go, models_test.go}`, `secp256k1/scalar.go`, `LICENSE`, `go.mod`
- `smartcontractkit/chainlink`: `core/services/vrf/proof/solidity_proof.go`, `proof_response_test.go`, `solidity_ports.go`
- `mangekyou-labs/vrf-server@71fdd87f99c34edf7fac90728bdc2c56d9792376`: `crosschain-prover/operator/{vrf/vrf.go, vrf/utils.go, server/server.go, operator.go}`, root `LICENSE`, `contracts/src/VRF.sol`
- `dedis/kyber` LICENSE (MPL-2.0)
- `paulmillr/noble-curves` v2.4.0 README and LICENSE
- https://docs.aws.amazon.com/kms/latest/developerguide/asymmetric-key-specs.html
- https://docs.cloud.google.com/kms/docs/algorithms
