# Verifier source and license

Ticket: mangekyou-labs/rsk-vrf#13 (map issue #1). Researched 2026-10-23. All files were fetched from GitHub (`gh api` contents or `git clone` into empty temp directories) and read as text only. Nothing was built or executed.

## Answer

Vendor `VRF.sol` from upstream `smartcontractkit/chainlink-evm`, not from the org copy. Both are MIT. The org copy is a hand-edited, reformatted copy of an older (2023) upstream revision. It differs from the code the feasibility note says it is identical to, and it carries no provenance or copyright notice. Upstream has no imports, so vendoring is a single file plus a copy of the upstream `LICENSE`.

## Upstream: Chainlink `VRF.sol`

- Repo: `smartcontractkit/chainlink-evm`, file `contracts/src/v0.8/vrf/VRF.sol`.
- Pinned commit: `23aa97639f630240f34b79b98d6b38baa094ccc5` (2026-10-20). The file blob is `0aa7ffeb87a5c9d72657aa992639d54a2c9bc3b8`, which is also the blob at `develop` at the time of research. The last commit that changed the file is `b6cf3a6ff90c7172e1d6090d056c0f77282450ce` (2026-08-19, "Bump Foundry and format code (#529)"). The previous changes were `c054b4e` (2025-09-03, forge fmt) and `697e469` (2024-07-08).
- SPDX header: `// SPDX-License-Identifier: MIT`, `pragma solidity ^0.8.0;`.
- Repo `LICENSE` (blob size 8944 bytes): "Copyright (c) 2018 SmartContract ChainLink Limited SEZC. Portions of this software are licensed as follows: The MIT License (MIT)". The only carve-out is `./pkg/bindings/abigen` (LGPL-3.0), which is Go code and does not touch `contracts/`. GitHub reports the license as `NOASSERTION` only because the file is multi-license. For `contracts/src/v0.8/vrf/VRF.sol` the license is MIT.
- Imports: none. `grep '^import'` finds nothing. The file is `contract VRF` with `internal` functions and struct `Proof`, so a consumer imports it and inherits (as the org coordinator does). No libraries, no OpenZeppelin.
- Notice and attribution: MIT requires the copyright notice and permission text to travel with "all copies or substantial portions". The `.sol` file itself carries only the SPDX line. The copyright line lives in the repo `LICENSE`. So when vendoring, keep the SPDX header and ship the upstream MIT text with "Copyright (c) 2018 SmartContract ChainLink Limited SEZC" (for example `contracts/vendor/chainlink/LICENSE` plus a note with the source repo and commit). The file's long docstring cites IETF draft-irtf-cfrg-vrf-05 and eprint 2017/099, which are references, not licensed content. No NOTICE file requirement exists.
- Audit: no audit report is referenced in the file or in `contracts/README.md`. That README only warns that `dev/` contracts are "likely unaudited"; `vrf/VRF.sol` is not under `dev/`. The note's "production code on many EVM chains" claim is outside the scope of this check. I did not find an audit report for the VRF v1 verifier in the repo, so treat "audited" as unverified. Security reasoning is in the file's own docstring, citing eprint 2017/099 Appendix B.

## Org copy: `mangekyou-labs/vrf-server`

- Repo: `mangekyou-labs/vrf-server` at `71fdd87f99c34edf7fac90728bdc2c56d9792376`, file `crosschain-prover/contracts/src/VRF.sol` (579 lines).
- SPDX header: `// SPDX-License-Identifier: MIT`. Repo `LICENSE` is Apache-2.0 (from commit `133d682`, 2024-04-12). No `NOTICE` file. The MIT header inside an Apache repo is not a conflict (a permissively licensed file can sit in an Apache-2.0 repo if its own license is kept), but the file has no copyright line and no mention of Chainlink.
- Git history: added by commit `9bf1033` (Kyler, 2025-11-15, "feat: add evm contracts system and operator (#21)") as `iota-vrf/contracts/src/VRF.sol`, then renamed (R100, content unchanged) to `crosschain-prover/` by `fbffdf4` (MrSufferer, 2026-01-22). The commit message does not mention Chainlink. There is no provenance in the repo beyond the file's own text, which does contain upstream's docstring.
- Related hygiene issue: the repo root tracks key files such as `oracle-keypair.json` and `vrf-keypair.json`, plus about 20 more `*keypair*.json` files under `kamui-program/`, `vrf-server/` and `iota/`. I did not open them. Copying the whole repo or subtree would import them. If the org copy were used, copy the single `.sol` file only. Whether those keys are live should be checked by the org.

## Diff: org copy vs upstream

Method: strip comments and whitespace, tokenise, and drop the leading underscore on identifiers (upstream renamed internal functions with `_` prefixes in `3f492fe`, 2023-10-16). Then diff token streams.

- Org copy vs the 2023-05-11 upstream revision (`a80d630`, before the rename): identical except for one added block, `struct Request {address sender; uint256 nonce; bytes32 oracleId; uint32 nbWords; uint16 requestConfirmations; uint32 callbackGasLimit; address callbackAddress; bytes4 callbackSelector; uint64 blockNumber;}`. This struct is not in upstream. It is used by the org coordinator `fulfillRandomWords(VRF.Proof memory, VRF.Request memory)`.
- Org copy vs current upstream (`23aa976`): the same `Request` addition, plus:
  - Upstream's explicit `return x;` statements that were added after 2023 are absent in the org copy (functions use named returns, so behaviour is identical).
  - `randomValueFromVRFProof(Proof memory proof, ...)` in the org copy against `_randomValueFromVRFProof(Proof calldata proof, ...)` upstream. This is the only semantic-looking change.
  - Comment-only: a stray `f` typo in a banner line (`*************************f***...`) in the org copy, and renamed identifiers in the docs.
  - Formatting (4-space indent vs 2-space).
- Conclusion: the Rootstock Proof Feasibility note's claim that the org copy is "code-identical" to `chainlink-evm@23aa976` is true for the verification math (every curve, hash and `ecrecover` routine), but not literally: the org copy adds `struct Request` and changes `calldata` to `memory`, and its base revision is the pre-rename 2023 one. The note's gas figures (49,086) were measured on the org copy, so re-measure if switching, though the verification body is token-identical.

## Does `Proof memory` vs `calldata` matter for a `fulfill` function?

- `calldata` is only legal for parameters of `external` functions (and internal functions called from them with a calldata value). It avoids copying the `Proof` (13 words) into memory.
- If `fulfill` is `external` and takes `Proof calldata`, upstream works directly and saves some gas on the copy. If `fulfill` takes a `memory` struct or decodes with `abi.decode(data, (Proof))`, a memory-typed function is required. A calldata parameter cannot accept a memory struct. A `memory` parameter accepts a calldata struct (implicit copy).
- ABI and decoding: the ABI encoding is identical. The org coordinator's `fulfillRandomWords(VRF.Proof memory _proof, VRF.Request memory _request) external` decodes the same bytes either way. Only gas and which call sites compile differ. The verification output (`keccak256(abi.encode(3, proof.gamma))`) is the same.
- Recommendation: use upstream's `calldata` signature for an external `fulfill`. If the coordinator receives the proof via LayerZero-style `bytes` payloads or builds it in memory, add a thin memory-typed wrapper in our code rather than editing the vendored file.

## drand side: `kevincharm/bls-bn254`

- Repo `kevincharm/bls-bn254`, default branch `master`. The HEAD commit is `9f70fb4dff2cd0921dc2144929dc0aff6f21a9b9` (2024-03-19, message "2.0.0", `package.json` version `2.0.0`). There is no `v2.0.0` tag. The newest tag is `v1.3.0` (`bef9dad5d99b3c99a17fd85e3328daea5824dac9`), so pin the SHA. The repo was last pushed 2024-09-21 and is not archived. There are 30 commits.
- License: repo `LICENSE` is "MIT License, Copyright (c) Kevin Charm". `package.json` says MIT. `contracts/BLS.sol` and `contracts/ModExp.sol` both have `// SPDX-License-Identifier: MIT` and `pragma solidity ^0.8;`.
- Dependencies: `BLS.sol` imports `{ModexpInverse, ModexpSqrt}` from `./ModExp.sol` (same repo, MIT). Vendor both files (402 + 652 lines). `BLS.sol` calls precompiles `0x05` (modexp), `0x06` (bn add) and `0x08` (pairing) via `staticcall`. The feasibility note confirmed these on Rootstock.
- Provenance and attribution: the README says much of the code was taken from `thehubbleproject/hubble-contracts`, `ChihChengLiang/bls_solidity_python`, `kilic/evmbls` and `kevincharm/draft-irtf-cfrg-hash-to-curve`. `BLS.sol` is marked "Adapted from hubble-contracts". `ModExp.sol` cites a generated addition chain (`kobigurk/addchain` commit `2c37a2a`). I did not verify those upstream licenses individually. Hubble-contracts and evmbls are, to my knowledge, MIT, but that is from memory and was not checked here. Keep the `LICENSE` and the SPDX headers when vendoring. A third-party notice listing the sources above is cheap insurance.
- Audit: none stated in the repo (README has no audit mention). The feasibility note already records that downstream audits (Anyrand by 0xGuard, Oct 2024; GOAT, Mar 2025) explicitly exclude this library or the BN254 contracts, and that `randa-mu/bls-solidity` labels its derivative "Experimental, unaudited". I did not independently re-fetch those reports in this pass, so those statements are the note's, not re-verified here.
- Scope warning: this library does BLS verification and hash-to-curve. The drand quicknet scheme (BLS12-381) is not what it verifies. The note's drand probe targets the BN254 evmnet scheme (`bls-bn254-unchained-on-g1`), where the DST is supplied by the caller.

## Recommendation

1. Take `VRF.sol` from `smartcontractkit/chainlink-evm@23aa97639f630240f34b79b98d6b38baa094ccc5` (blob `0aa7ffe`), unmodified. Do not use the org copy. It has an unattributed origin, an added `Request` struct that belongs in the coordinator, a `memory` change, and a banner typo.
2. Keep the MIT SPDX header and add the upstream `LICENSE` text (Copyright (c) 2018 SmartContract ChainLink Limited SEZC) next to the file. Record repo, path and commit in a `VENDORED.md` or header comment. Put `struct Request` in our own coordinator or interface.
3. Vendor `kevincharm/bls-bn254@9f70fb4` `BLS.sol` and `ModExp.sol` unmodified, with its `LICENSE` and a third-party notice listing its stated sources. Treat the hash-to-curve as unaudited and budget for an external review or a test-vector suite (drand real-round signatures).
4. Use `calldata` for an external `fulfill`. Use a wrapper if a memory struct is needed.
5. If the org later wants its own `crosschain-prover` copy kept, relabel it as a Chainlink-derived file with attribution. Do not copy the vrf-server tree, because of the committed keypair files.

## Caveats

- "Chainlink VRF.sol is audited" could not be confirmed from primary sources in this pass. No audit report was found in `chainlink-evm`.
- Hubble-contracts, evmbls, bls_solidity_python and addchain licenses were not checked.
- GitHub shows the `chainlink-evm` license as `NOASSERTION` because of the multi-license `LICENSE`; the MIT portion covers the contracts.
- I did not check the licenses of `randa-mu/bls-solidity` or Anyrand. Neither is proposed for vendoring.
- Solc: org `foundry.toml` pins 0.8.13; both vendored files use `^0.8`, so no conflict is expected, but compile before depending on it.
