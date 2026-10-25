# SVDW hash-to-point review

Internal self-review of vendored `hashToPoint`, `expandMsgTo96`, and `mapToPoint` in `contracts/src/vendor/bls-bn254/BLS.sol` (with `inverse` in `ModExp.sol`), as called by `DrandEvmnet`. Checked against RFC 9380 (`expand_message_xmd` §5.3.1, `hash_to_field` §5.2, SVDW §6.6.1 and Appendix F.1, `find_z_svdw` Appendix H.1, `sgn0` §4.1, cofactor §7) and against `tools/bn254-svdw/ref.py`. This note does not cover the coordinator, `VRFDerivation`, runbooks, or the README security table.

`DrandEvmnet.randomness` is sha256 of the 64-byte drand signature. Beta is the VRF output. This note is about the hash of the round into G1, not about Beta.

Compared `expand_message_xmd` (ell = 3, Keccak-256, block size 136, `len_in_bytes` = 96) and the SVDW map with the Solidity. No mismatch on the construction, and none on any input BN254 G1 can produce. Untested branches are listed separately. Vendor code was not changed.

## What was checked

- `expandMsgTo96` (BLS.sol ~254): 136 zero bytes, then the message, `I2OSP(96, 2)` as `uint8(0), uint8(96)`, a zero counter byte, then `DST || I2OSP(len(DST), 1)`. `b0 = keccak256` of that. `b1 = keccak256(b0 || 0x01 || DST_prime)`. The loop stores `b1` and `b2` and sets `b3 = keccak256(b0 XOR previous || I2OSP(i, 1) || DST_prime)` for i = 2, 3. Output is `b1 || b2 || b3` (96 bytes). DST longer than 255 bytes reverts `InvalidDSTLength`. `ell` and the length are fixed, so the RFC aborts for `ell > 255` and `len_in_bytes > 65535` do not arise.
- `hashToField` (~225): two 48-byte chunks, each `OS2IP` reduced mod `N` via `addmod(mulmod(hi, 2^192, N), lo, N)`. `MASK24` clears the high 8 bytes of each overlapping `mload` (the bytes length prefix, and the 8 data bytes that overlap the next window). It does not clear the top 8 bits of the 48-byte element. Those bits stay in the integer and are reduced mod `N`. That matches RFC `hash_to_field` for L = 48 (`ceil((254 + 128) / 8)`). A note that said the top 8 bits are masked is wrong.
- `mapToPoint` (~309): rejects `u >= N`. Computes `x1`, `x2`, `x3` as in §6.6.1, takes the first whose `g(x) = x^3 + 3` has Legendre symbol 1, sets `y = sqrt(g(x))`, and replaces `y` with `N - y` when `sgn0(u) != sgn0(y)`. `sgn0` is `x % 2` (`sgn0` for m = 1). Legendre is precompile 5 (MODEXP) with exponent `C5 = (N - 1) / 2`. `inverse` is `ModexpInverse.run`, an addchain of `mulmod`s for `a^(N-2)`. `mulmod` of zero stays zero, so `inverse(0) = 0`, which is `inv0`.
- `hashToPoint` maps both field elements and adds them with precompile 6. No `clear_cofactor`. G1 cofactor is 1, so RFC §7 requires no cofactor step. `isOnCurveG1` (`y^2 == x^3 + 3`) is the subgroup check. `isValidSignature` rejects a coordinate `>= N` before that check. `DrandEvmnet.verify` uses both; `hashToPoint` itself does not.
- `python3 tools/bn254-svdw/ref.py` was re-run for this note. `find_z()` (Appendix H.1) printed `Z = 1` and `c1..c4` equal to `BLS.sol` lines 35–47, including `sgn0(C3) == 0`. `C2 == C5` because `Z = 1` makes `-Z/2 = (N-1)/2`. That is the formula, not a duplicated constant by mistake.
- Rounds 1, 2, 1000, and 10000000 from that run match the x/y decimals `DrandHashToG1.test_hashToPoint_matchesGnarkAndPython` loads from `tools/bn254-svdw/vectors.json` (gnark-crypto v0.22.0 commit `550a513d798df79d8324697332e085498285bb63`, `bn254.MapToCurve1`). The message is `keccak256` of the uint64 big-endian round. The same test and `DrandNegative.test_WrongDstDoesNotVerify` pin the DST.

`H` is Ethereum `keccak256` (rate 136, padding `0x01 … 0x80`), which the DST names. `ref.py` asserts `keccak256("") = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`. RFC 9380 does not print 136 and its examples use SHA-256 / SHA-512. The suite string is not in the RFC suite tables. The expand steps still match §5.3.1 for this hash. Not a step mismatch.

## Findings

1. **DST.** `DrandEvmnet` pins `BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_` (43 bytes). Upstream bls-bn254 tests sometimes use `BLS_SIG_BN254G1_XMD:KECCAK-256_SSWU_RO_NUL_`. A wrong DST does not revert; `hashToPoint` returns a different point and `verify` of a real signature against it is false. Not a vendor defect. Already pinned by `test_dst`, the SSWU differ check inside `test_hashToPoint_matchesGnarkAndPython`, and `test_WrongDstDoesNotVerify`. No change.

2. **Constants.** Re-derived `Z` and `c1`–`c4` in `ref.py` match `BLS.sol`. `sgn0(C3) == 0`. No change: vendor matches Appendix H.1 and the §6.6.1 constant definitions.

3. **Field reduction.** Full 48-byte `OS2IP` mod `N`. The top 8 bits of each chunk are not masked. No change: vendor matches §5.2. The "top 8 bits" description is corrected here only.

4. **`expand_message_xmd`.** Z_pad, length encoding, DST prime, and `b0`…`b3` match §5.3.1 for ell = 3 and `len_in_bytes` = 96. No change.

5. **Map algebra.** `c1 = g(Z)`, `c2 = -Z/2`, `c3`, `c4`, the three x candidates, `inv0`, and the sign of y match §6.6.1. Solidity uses that section's early return, not the Appendix F.1 CMOV. The chosen x is the same whenever `g(x) != 0`. No change.

6. **`inverse(0)`.** Returns 0. Matches `inv0`. It does not revert. No change.

7. **Cofactor, `sgn0`, Legendre.** Cofactor 1, so the curve check is the subgroup check. `sgn0` is `x % 2`. Legendre is precompile 5 with exponent `(N-1)/2`. Matches §4.1, §4 (`x^((q-1)/2)`), and §7. No change.

8. **Constant time.** RFC 9380 §4 and §10.3 say these functions SHOULD be constant time for every use, and MUST be when the input is secret. `mapToPoint` returns on the first square candidate. `DrandEvmnet` hashes `keccak256` of the round, which is public, so the MUST case does not apply. Left as a recorded gap. No vendor change. The pinned points still match the straight-line Python port.

9. **Four pinned rounds.** They match gnark-crypto and the Python port. They do not exercise `u = 0`, `tv1 = 0`, `g(x) = 0`, or the `x3` candidate. Recorded coverage gap. Not a disagreement found in those rounds. No new tests in this pass.

10. **`g(x) = 0` predicates.** RFC `is_square` is true when the Euler power is 0 or 1. Solidity requires `legendre(g(x)) == 1`, so a zero `g(x)` would be skipped. RFC sets `y = -y`; Solidity sets `p[1] = N - p[1]`, which is `N` rather than 0 when `y = 0` and `u` is odd. `g(x) = x^3 + 3 = 0` has no solution in this field (`-3` is not a cube, and the group order is prime, so there is no rational 2-torsion). Both differences are unreachable. Not an observed output mismatch. No vendor change. The four rounds cannot hit this case.

11. **`x3` failure path.** If `g(x1)` and `g(x2)` are nonsquares and `g(x3)` is also a nonsquare, `mapToPoint` reverts `MapToPointFailed`. Appendix H.1 is written so that one candidate is always a square when `inv0` is used. The revert is defensive and untested. Not observed. No vendor change.

## Untested branches

These are not evidence that the map is fully exercised:

- `u = 0`. Not an exceptional input here: `(1 + u^2 C1)(1 - u^2 C1) = 1`. The formulas cover it. No pinned round uses it.
- `tv1 = 0` after `tv1 = 1 - u^2 C1`, i.e. `u^2 C1 = 1`. `C1 = g(Z) = 4`. The two field elements are `u = 2^{-1}` and `u = -2^{-1}`:
  - `10944121435919637611123202872628637544348155578648911831344518947322613104292`
  - `10944121435919637611123202872628637544348155578648911831344518947322613104291`
  `inverse` of the zero product returns 0 and the map continues. `u^2 C1 = -1` cannot occur (`-1` is a nonsquare, Legendre symbol `N - 1`). None of the four rounds hit either `u`.
- The `x3` candidate, and `MapToPointFailed` if `g(x3)` has no square root.
- `g(x) = 0`. Unreachable for every field `x`, not merely absent from the four rounds.

`ModexpSqrt`'s addchain was not compared line by line with `(N+1)/4`. On the four rounds, y matches `ref.py`, which takes that square root and then applies `sgn0`.
