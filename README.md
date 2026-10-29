# rsk-vrf

Verifiable randomness service for Rootstock (testnet). Planning lives in the Wayfinder map issue.

## Security status

This is a testnet pilot. Do not use it for value. The components are not externally audited. An external audit of the BN254 hash-to-curve and the coordinator is a mainnet prerequisite ([Verifier Review Expectation](https://github.com/mangekyou-labs/rsk-vrf/issues/12)). Consumers must follow the [consumer guide](docs/consumer-guide.md). Each operational incident gets a public Incident Note: see the [`incident` issues](https://github.com/mangekyou-labs/rsk-vrf/issues?q=label%3Aincident).

| Component | Source and pin | Bar it passed | Tests | Reviews | External audit |
| --- | --- | --- | --- | --- | --- |
| `VRF.sol` (secp256k1 ECVRF verify) | Verbatim copy of `smartcontractkit/chainlink-evm@23aa976` `contracts/src/v0.8/vrf/VRF.sol`, blob `0aa7ffe` ([PINS](contracts/src/vendor/PINS)) | Verbatim copy with a CI blob-hash pin, our positive vectors cross-checked against Chainlink's Go implementation, and a negative suite. No line-by-line review. | [VRFVectors.t.sol](contracts/test/VRFVectors.t.sol), [VRFNegative.t.sol](contracts/test/VRFNegative.t.sol), [tools/vrf-vectors-go](tools/vrf-vectors-go) | None | Not externally audited |
| `BLS.sol` and `ModExp.sol` (drand BN254 verify) | Verbatim copy of `kevincharm/bls-bn254@9f70fb4` `contracts/BLS.sol` (blob `dd2332b`) and `contracts/ModExp.sol` (blob `d1ff429`) ([PINS](contracts/src/vendor/PINS)) | Verbatim copy with a CI blob-hash pin, real drand `evmnet` rounds, hash-to-G1 checked against gnark-crypto and a Python reference, a negative suite, and an internal review | [DrandEvmnetRounds.t.sol](contracts/test/DrandEvmnetRounds.t.sol), [DrandHashToG1.t.sol](contracts/test/DrandHashToG1.t.sol), [DrandNegative.t.sol](contracts/test/DrandNegative.t.sol), [tools/bn254-svdw](tools/bn254-svdw) | [SVDW hash-to-point](docs/reviews/svdw-hash-to-point.md) (self-review) | Not externally audited |
| `DrandEvmnet.sol` (drand `evmnet` round check) | Our code, [contracts/src/DrandEvmnet.sol](contracts/src/DrandEvmnet.sol) | Real-round and negative suites | [DrandEvmnetRounds.t.sol](contracts/test/DrandEvmnetRounds.t.sol), [DrandNegative.t.sol](contracts/test/DrandNegative.t.sol) | Covered with the drand verify in [SVDW hash-to-point](docs/reviews/svdw-hash-to-point.md) (self-review) | Not externally audited |
| `VRFCoordinator.sol` | Our code, [contracts/src/VRFCoordinator.sol](contracts/src/VRFCoordinator.sol) | A negative test for each `fulfill` rejection, golden Alpha and Beta vectors shared with the worker, storage-layout and upgrade gates, and an internal review | [VRFCoordinator.t.sol](contracts/test/VRFCoordinator.t.sol), [VRFCallbacks.t.sol](contracts/test/VRFCallbacks.t.sol), [VRFAdmin.t.sol](contracts/test/VRFAdmin.t.sol), [VRFUpgrade.t.sol](contracts/test/VRFUpgrade.t.sol), [Deploy.t.sol](contracts/test/Deploy.t.sol), [coordinator-vectors.json](tools/vrf-vectors-go/coordinator-vectors.json), [callbacks.test.ts](worker/integration/callbacks.test.ts) (RSK regtest) | [Coordinator review](docs/reviews/coordinator.md) (self-review) | Not externally audited |
| `VRFDerivation.sol` | Our code, [contracts/src/VRFDerivation.sol](contracts/src/VRFDerivation.sol) | Fixed derivation vectors and an internal review | [VRFDerivation.t.sol](contracts/test/VRFDerivation.t.sol), [coordinator-vectors.json](tools/vrf-vectors-go/coordinator-vectors.json) | [VRFDerivation review](docs/reviews/vrf-derivation.md) (self-review) | Not externally audited |
| `VRFConsumer.sol` | Our code, [contracts/src/VRFConsumer.sol](contracts/src/VRFConsumer.sol) | Coordinator-only delivery test | [VRFConsumer.t.sol](contracts/test/VRFConsumer.t.sol), [DemoConsumers.t.sol](contracts/test/DemoConsumers.t.sol) | None | Not externally audited |
| Worker prover (`worker/src/vrf`) | Our code on `@noble/curves` 2.4.0, pinned in [worker/package.json](worker/package.json) | Byte-for-byte match with Chainlink's Go prover on the shared vectors. It is not constant time; see the known gaps below. | [prover.test.ts](worker/test/prover.test.ts), [nonce.test.ts](worker/test/nonce.test.ts) | None | Not externally audited |

### Known prover gaps

These are known gaps in the worker prover (`worker/src/vrf`).

| Item | Status | Note |
| --- | --- | --- |
| Constant time | Not guaranteed | The prover uses `@noble/curves` and JavaScript bigint. Bigint operations can take more or less time for different values. Thus the time to prove a Beta from an Alpha can show data about the Proving Key. |
| Secret in memory | Cannot erase | The Proving Key secret is a bigint. JavaScript cannot write zeros over a bigint, so the secret stays in memory until the garbage collector removes it. |
| Nonce state in memory | Cannot erase fully | The nonce function writes zeros over its byte copies of the secret and the DRBG key `k`. It cannot erase the last DRBG value `v`, because it gives `v` back as the nonce. |
