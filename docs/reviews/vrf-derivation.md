# VRFDerivation review

Internal self-review of `contracts/src/VRFDerivation.sol` at commit `07dd2e6`. The reviewer is an AI coding agent that works for the author. No second person reviewed the code. This is not an external audit. The review checks the code against `docs/spec.md`, issue #12, and the golden file `tools/vrf-vectors-go/coordinator-vectors.json` that the worker and the contract share.

The severity scale is the same as in [coordinator.md](coordinator.md).

## Result

No Critical, High or Medium finding. No code changed.

## What was checked

- [x] **Domains.** `DOMAIN_DERIVE = keccak256("rsk-vrf/v1/derive")` and `DOMAIN_RANGE = keccak256("rsk-vrf/v1/range")` match the spec. They differ from each other and from the Alpha and Beta domains.
- [x] **Encoding.** All hashes use `abi.encode` of fixed-size words. Two different input lists cannot give the same bytes.
- [x] **`randomBytes` and `random`.** `randomBytes = keccak256(abi.encode(DOMAIN_DERIVE, context, beta))`. `random` is the same word as a `uint256`. The golden vectors pin both (`test_RequestFulfillDeriveMatchesGoldenVectors`, `test_FullRangeReturnsGoldenDerivedWord`).
- [x] **`randomInRange` bounds.** `min > max` reverts `InvalidRange` (`test_RangeRejectsReversedBounds`). `span = max - min + 1` wraps to 0 only for the full `uint256` range, and that case returns `random`.
- [x] **No modulo bias.** `(0 - span) % span` equals `2**256 mod span`. `lastAccepted = 2**256 - 1 - (2**256 mod span)`. So the accepted words are `0 … 2**256 - (2**256 mod span) - 1`. That count is an exact multiple of `span`, so `word % span` is uniform. When `span` divides `2**256`, every word is accepted (`test_RangeWithPowerOfTwoSpanAcceptsWithoutOverflow`).
- [x] **No overflow.** `word % span <= span - 1 = max - min`, so `min + word % span <= max`. The `unchecked` block is safe (`testFuzz_InclusiveRangeStaysInsideBounds`).
- [x] **Rejection path.** The counter starts at 0 and goes up by 1. The golden file has vectors that reject at least one word (`test_RangesMatchGoGoldenVectorsIncludingRejection`, `test_RangeRejectsUpperTailAsSpecified`).
- [x] **Only one code path.** The coordinator derive views call this library and read only a Fulfilled Beta (`test_RangeReadsOnlyFulfilledBeta`, `test_DeriveRevertsForPendingRequest`, `test_DeriveRevertsForRefundedRequest`).

## Findings

1. **Low. The rejection loop has no upper limit.** Each draw is rejected with a probability below 1/2. So more than `k` rejections has a probability below `2**-k`. The worst case is a `span` just above `2**255`. A callback that calls `randomInRange` with a tight Callback Gas Cap can run out of gas in rare cases. The fulfillment stays final, and the consumer can read the derive views later. The spec chooses uncapped rejection sampling, so the output has no bias. Handled: no code change.

2. **Info. The full range returns `random(beta, context)`.** For one Derivation Context, `randomInRange(beta, context, 0, type(uint256).max)` equals `random(beta, context)`. The NatSpec states this. Handled: no code change.

3. **Info. One Derivation Context gives one value.** A consumer that needs two independent values must use two contexts. The library cannot check this. Handled: no code change. The consumer guide explains Derivation Contexts.
