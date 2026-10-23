# Fulfill Gas Budget and Fee Amount

Wayfinder task "Fulfill Gas Budget and Fee Amount" on the map "Wayfinder map: Rootstock VRF service".
Measured 2026-10-23 on Rootstock testnet (chain 31), with mainnet (chain 30) as a cross-check.
Spike code: [`research/fulfill-gas-spike/`](../../research/fulfill-gas-spike/). Raw output: [`measurements-2026-10-23.txt`](../../research/fulfill-gas-spike/measurements-2026-10-23.txt).

## Answer

| Item | Value |
|---|---|
| `fulfill` tx gas, worst consumer (callback burns its whole 200k cap), 1 hash-to-curve iteration | **≈ 507k** (21,000 intrinsic + 8,100 calldata + 477,514 execution) |
| Extra gas for each additional `VRF.sol` hash-to-curve iteration | **15,036** |
| `fulfill` gas budget used for fee sizing (10 iterations, exceeded with probability 2⁻¹⁰ ≈ 0.1 %) | **642k** |
| `request` / `requestWithCallback` | 100k–127k (see table) |
| `timeoutRefund` | 31k to an existing requester; 56k if the requester has no account |
| `withdrawFees` | 30k |
| Against the 10M per-tx cap | Every path is far below it. The cap would need ~630 hash-to-curve iterations (probability 2⁻⁶³⁰), or a Callback Gas Cap above ~9.3M; the cap's upper bound is 2.5M. |
| **`CALLBACK_RESERVE`** | **10,000** (measured need: 2,009 above the cap, or 25,853 in total when the requester has no account; see below) |
| **Flat fee** | **2 × 10¹³ wei = 0.00002 rBTC** |
| Coordinator runtime bytecode | 21,236 B, leaving 3,340 B under the 24,576 B limit. The verifiers stay in the coordinator. |

## Method

The spike coordinator (`research/fulfill-gas-spike/src/VRFCoordinator.sol`) follows the shape from "Coordinator Contract Boundaries and Fulfill Error Set":

- **Contract structure:** a single `VRFCoordinator` inheriting unmodified `VRF.sol` (`chainlink-evm@23aa976`), with an internal `DrandEvmnet` library over unmodified `BLS.sol` (`kevincharm/bls-bn254@9f70fb4`). It sits behind an `ERC1967Proxy` (UUPS), with ERC-7201 storage and `Ownable2Step`.
- **Request record:** three storage slots.
- **`fulfill` steps, in order:**
  1. the ordered checks;
  2. calldata proof decoding;
  3. drand BN254 verification;
  4. VRF verification;
  5. effects;
  6. Payee credit;
  7. the `Fulfilled` event;
  8. `gasleft() >= cap + CALLBACK_RESERVE`;
  9. a low-level `call(cap, …)` with no return-data copy;
  10. `CallbackFailed` if that call fails.

Fifteen Foundry tests cover the happy path and every revert. Those tests use a Python prover over ffi.

The public nodes have no state overrides (the request returns HTTP 400), and the spike has no funded account. So `src/Harness.sol` runs each scenario inside the constructor of a contract-creation transaction. The scenario deploys the implementation, proxy and consumers, makes the requests, and then performs one measured action. `scripts/measure_rsk.py` sends that transaction with `eth_call` against `latest`.

Pass 1 reads each request's Alpha. Python then builds the proofs, and pass 2 measures. The real evmnet round 1,000,000 signature from the vectors is used for the drand part.

A `VRFCoordinatorProbe` subclass is used only to measure. It does three things:

- **Allows contract callers:** it replaces the EOA check with the same opcodes compared against themselves, so the gas is the same.
- **Rewrites request fields:** block heights, round and requester.
- **Exposes timed segments.**

Execution figures are `gasleft()` deltas around the external call. They include the CALL into the proxy and the `delegatecall`, so they are slightly conservative.

### `eth_estimateGas`

The public nodes cap `eth_estimateGas` at 6,800,000. For transactions that need more than that, they return the cap with no error: the harness's setup alone needs 6,999,861, and an `eth_call` at 6.8M reverts.

Instead, the script runs the same binary search that `eth_estimateGas` performs: the smallest whole-transaction gas limit at which `eth_call` (with the 12M block gas limit available) succeeds. It runs this with and without the `fulfill`.

The difference is the gas limit a `fulfill` transaction needs on chain 31:

| Scenario | Smallest succeeding gas limit | Delta over setup |
|---|---|---|
| Setup only | 6,999,861 | — |
| + `fulfill`, success consumer | 7,452,737 | **452,876** |
| + `fulfill`, burner consumer | 7,475,913 | **476,052** |

For the success consumer, the needed gas limit (452,876) is well above the gas it actually uses (326,799). The `cap + CALLBACK_RESERVE` check means a fulfiller must always supply the full cap, whatever the consumer spends. **The worker should therefore size `fulfill` gas limits from the full-cap figure,** not from what a consumer happens to use. Only gas actually used is charged.

## Measurements (chain 31)

Testnet block 8,213,365 had gasPrice 6,425,290 wei and minimumGasPrice 5,841,173 wei. An earlier run at block 8,212,962 gave identical gas figures.

### `fulfill`

| Case | Execution gas | Hash-to-curve iterations in its proof |
|---|---|---|
| Success consumer (stores Beta) | 326,799 | 3 |
| Burner consumer (callback loops until out of gas → `CallbackFailed`) | **477,514** | 1 |
| Requester has no account (CALL to a nonexistent account) | 301,320 | 1 |
| Plain `request` (cap 0, no callback) | 290,337 | 2 |

In every case, `status = Fulfilled`, Beta is nonzero and the Payee is credited.

Timed segments:

- **drand BN254 verify:** 183,446. It returned the expected randomness.
- **`VRF.sol` `_randomValueFromVRFProof`,** by hash-to-curve iteration count:

| Iterations | 1 | 2 | 4 | 8 |
|---|---|---|---|---|
| Gas | 34,338 | 49,365 | 79,439 | 139,593 |

**Fulfill gas is not a single number.** `VRF.sol`'s `_hashToCurve` is try-and-increment. The number of candidates it tries is geometric with p = ½, so P(iterations > k) = 2⁻ᵏ.

- Each extra candidate costs one `_fieldHash` plus one `_squareRoot` (`bigModExp`): about **15,036 gas**.
- That accounts for the success/burner gap above.
- The 49,086 in "Rootstock Proof Feasibility" was a 2-iteration vector.
- The Alpha cannot be steered toward cheap iteration counts, because drand randomness and the requestId are bound into it.

Calldata for `fulfill` is 516 B. Counted with every non-selector byte nonzero, it costs 8,100 gas. With RSKIP400, that is 4 gas per zero byte and 16 per nonzero byte.

**Worst-consumer `fulfill` tx at k iterations** = 21,000 + 8,100 + 477,514 + (k − 1) · 15,036.

| k | tx gas | P(iterations > k) |
|---|---|---|
| 1 | 506,614 | ½ |
| 4 | 551,722 | 1/16 |
| 10 | **641,938** | 1/1,024 |
| 20 | 792,298 | ~10⁻⁶ |

A Callback Gas Cap at its 2.5M maximum adds 2.3M to every row.

### Other entry points

| Call | Execution gas |
|---|---|
| `requestWithCallback` through a consumer contract, first request from that requester | 126,537 |
| `requestWithCallback` through a consumer, steady state | 111,537 |
| plain `request`, first | 115,441 |
| plain `request`, steady state | 100,441 |
| `timeoutRefund` → consumer | 31,348 |
| `timeoutRefund` → requester with no account | 56,293 |
| `withdrawFees` | 30,163 |

The consumer rows include the consumer's own frame and the value-carrying CALL. Add 21,000 plus calldata for a transaction. The "first" rows pay one extra 20k SSTORE, for that requester's nonce slot.

## `CALLBACK_RESERVE`

The reserve must leave enough gas after the check for everything up to the end of `fulfill`, even when the callback consumes its entire cap:

- the CALL itself (700, plus 25,000 if the requester account doesn't exist; RSKj `VM.java` charges `NEW_ACCT_CALL` whenever the target account does not exist, value or not);
- memory;
- the `CallbackFailed` log;
- the return.

On RSK, the callee gets `min(remaining, cap)` and there is no 63/64 rule. So if the reserve is too small, the burner takes everything, and the whole `fulfill` reverts out of gas after the callback. That would be a starvation hole.

**Measurement:** for each reserve R, a binary search finds the smallest `g` for which `fulfill{gas: g}` succeeds:

- **Burner consumer:**
  - With R = 0, the minimum is 473,906. Just below that, the transaction reverts with no data (out of gas after the callback).
  - With R = 60,000, the minimum is 531,897, and just below it reverts with `InsufficientGasForCallback`.
  - So the gas needed after the check is cap + **2,009**.
  - Spot checks: at R = 2,008, the transaction one gas below the minimum still runs out of gas (unsafe). At R = 2,009 it reverts cleanly with `InsufficientGasForCallback`. At R = 7,009 the minimum moves up by exactly 5,000.
- **Requester with no account:**
  - With the cap forced to 1 to isolate the surcharge, the need is cap + **25,853**: the 25,000 `NEW_ACCT_CALL` charge plus the same tail. Spot checks: at R = 25,852, the transaction just below the minimum runs out of gas; at R = 25,853 it reverts cleanly.
  - The callee has no code, so it spends none of the gas it is given. The need is therefore a fixed 25,853 after the check, not cap + 25,853.
  - At the real 200k cap, the transaction just below the minimum already reverts cleanly with `InsufficientGasForCallback` at R = 0. R = 10,000 moves the minimum by exactly +10,000. This confirms that RSK hands the callee `min(remaining, cap)` after the surcharge, instead of failing the CALL.
  - Safety condition: cap + `CALLBACK_RESERVE` ≥ 25,853. The 25k minimum cap from "Callback Delivery Policy" gives at least 35,000.

**Decision: `CALLBACK_RESERVE = 10,000`.** That is about 5× the measured 2,009. Reserve that goes unspent costs nothing, because it only raises the gas limit the fulfiller must supply, not the gas charged. It also covers the no-account surcharge at every allowed cap. If the product ever drops the 25k minimum cap, it must keep cap + `CALLBACK_RESERVE` ≥ 25,853.

The product contract makes it a `constant`, and its test suite should repeat the same boundary search.

## Fee amount

Sizing rule from "Fee Escrow and Refunds": fulfill gas plus the fixed callback cap, priced at a reference gas price, plus a margin.

- **Gas:** 641,938, the worst-consumer `fulfill` transaction at 10 hash-to-curve iterations. It includes the full 200k cap.
  - Only about 0.1 % of fulfills that also hit a consumer burning its whole cap cost more.
  - A typical fulfill costs 330k–510k.
- **Reference gas price:** 10,000,000 wei (0.01 gwei). That is about 1.56× chain 31's `eth_gasPrice` (6.43M) and about 1.7× its minimumGasPrice (5.84M).
- **Margin:** ×2.5. This covers two ×1.5 replacement bumps from "Oracle Worker Design" (×2.25).
- **Result:** 641,938 × 10⁷ × 2.5 = 1.60 × 10¹³ wei, rounded up to **2 × 10¹³ wei (0.00002 rBTC).**

Mainnet is out of scope, but as a cross-check: chain 30's `eth_gasPrice` was 26,065,600 wei. 2 × 10¹³ wei covers the 642k budget up to about 31.2M wei, only about 1.2× mainnet's price. A mainnet deployment would need its own fee, roughly 5 × 10¹³ wei by the same rule.

The fee is set at the default 200k cap, so **raising the Callback Gas Cap requires re-sizing the fee in the same Admin batch**. Each extra 100k of cap adds 100k × 10⁷ × 2.5 = 2.5 × 10¹² wei. The runbook carries this rule; the contract does not enforce it.

## Bytecode size

`forge build --sizes` (solc 0.8.28, optimizer 200 runs, `paris`):

| Contract | Runtime | Margin under 24,576 |
|---|---|---|
| `VRFCoordinator` | 21,236 B | **3,340 B** |
| `VRFCoordinatorProbe` (spike-only extras) | 22,297 B | 2,279 B |

The coordinator fits with both verifiers inside it, so **the stateless-verifier split from "Coordinator Contract Boundaries and Fulfill Error Set" is not triggered.**

The margin is thin, though. The spike has the full `fulfill` path, Key Registry, fee config, refunds and UUPS. It lacks `deriveRandom*` views, Draining/Retired views and full rotation admin, and it has short revert strings in the vendored code. If the product exceeds the limit, these are the fallbacks:

1. Move `DrandEvmnet`/`BLS` into a stateless library contract called with `staticcall`.
2. Lower the optimizer `runs`.

## Caveats

- **Spike, not product:**
  - The probe's EOA-check replacement costs the same opcodes, so its numbers match the real check.
  - The harness's outer CALL adds a few hundred gas, so execution figures are slightly high.
- **Gas identity across networks:** pricing is the same on both chains. Mainnet's Alphas differ, because `block.chainid` is bound into the requestId and Alpha, so its iteration counts differ: success 1, burner 1, no-account 2, plain 3. Matching cases agree within calldata zero-byte noise: the burner costs 477,504 vs 477,514, the reserve need is 2,009 vs 2,009, and the no-account need is 25,853 vs 25,853. The request, refund and withdraw figures are identical. This matches "Rootstock Proof Feasibility".
- **drand cost:** the drand verify cost depends on the round's hash-to-G1. SVDW is constant-time apart from `ModExp`, and the four live rounds in "BN254 Hash-to-Curve Reference Vectors" verified with the same library. Here only round 1,000,000 was timed.
