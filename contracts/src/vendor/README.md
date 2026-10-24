# Vendored verifiers

> **Unaudited testnet pilot; do not use for value.**

These files are copied byte for byte from upstream and must never be edited. [`PINS`](PINS) records each file's upstream git blob hash; CI runs [`check-vendor-pins.sh`](../../script/check-vendor-pins.sh) on every PR and fails if a file differs. Wrap or extend them in our own code instead. See [Verifier Source and License](https://github.com/mangekyou-labs/rsk-vrf/issues/13) and [Verifier Review Expectation](https://github.com/mangekyou-labs/rsk-vrf/issues/12).

| Local path | Upstream | License |
|---|---|---|
| `chainlink/VRF.sol` | [`smartcontractkit/chainlink-evm@23aa976`](https://github.com/smartcontractkit/chainlink-evm/blob/23aa97639f630240f34b79b98d6b38baa094ccc5/contracts/src/v0.8/vrf/VRF.sol) `contracts/src/v0.8/vrf/VRF.sol`, blob `0aa7ffe` | MIT, [`chainlink/LICENSE`](chainlink/LICENSE) (Copyright (c) 2018 SmartContract ChainLink Limited SEZC) |
| `bls-bn254/BLS.sol` | [`kevincharm/bls-bn254@9f70fb4`](https://github.com/kevincharm/bls-bn254/blob/9f70fb4dff2cd0921dc2144929dc0aff6f21a9b9/contracts/BLS.sol) `contracts/BLS.sol`, blob `dd2332b` | MIT, [`bls-bn254/LICENSE`](bls-bn254/LICENSE) (Copyright (c) Kevin Charm) |
| `bls-bn254/ModExp.sol` | [`kevincharm/bls-bn254@9f70fb4`](https://github.com/kevincharm/bls-bn254/blob/9f70fb4dff2cd0921dc2144929dc0aff6f21a9b9/contracts/ModExp.sol) `contracts/ModExp.sol`, blob `d1ff429` | MIT, [`bls-bn254/LICENSE`](bls-bn254/LICENSE) |

## Third-party notice

- The Chainlink repository `LICENSE` is multi-license. Its only non-MIT carve-out, `pkg/bindings/abigen` (LGPL-3.0), is Go code outside `contracts/`; `VRF.sol` is MIT.
- `bls-bn254` states that much of its code comes from [`thehubbleproject/hubble-contracts`](https://github.com/thehubbleproject/hubble-contracts), [`ChihChengLiang/bls_solidity_python`](https://github.com/ChihChengLiang/bls_solidity_python), [`kilic/evmbls`](https://github.com/kilic/evmbls) and [`kevincharm/draft-irtf-cfrg-hash-to-curve`](https://github.com/kevincharm/draft-irtf-cfrg-hash-to-curve). `ModExp.sol` is generated with [`kobigurk/addchain`](https://github.com/kobigurk/addchain). We haven't checked those licenses ourselves.
- Neither upstream ships an audit report for these files. The BN254 hash-to-curve has no known audit.

## Updating a pin

Copy the new upstream file unmodified, then set its line in `PINS` to the new commit and the output of `git hash-object <file>`. Run `script/check-vendor-pins.sh --upstream` to confirm the pin matches GitHub.
