# fulfill-gas-spike (throwaway)

Spike for the wayfinder ticket "Fulfill Gas Budget and Fee Amount". Findings: [`docs/research/fulfill-gas-budget.md`](../../docs/research/fulfill-gas-budget.md).
Not product code: never deployed and never merged.

- `src/VRFCoordinator.sol` is the coordinator shape from "Coordinator Contract Boundaries and Fulfill Error Set".
  `CALLBACK_RESERVE` is an immutable here only so the spike can vary it.
- `src/vendor/` is unmodified upstream code:
  - `chainlink/VRF.sol` from `smartcontractkit/chainlink-evm@23aa976` (MIT);
  - `bls-bn254/{BLS,ModExp}.sol` from `kevincharm/bls-bn254@9f70fb4` (MIT).
- `src/Harness.sol` runs a whole scenario inside one contract-creation `eth_call`. This lets Rootstock's public nodes
  measure it against real chain state without an account, funds or a broadcast.
- `scripts/measure_rsk.py` drives the harness. `scripts/prove.py` is the TEST-ONLY Chainlink-style prover; the
  tests also use it through ffi.

```sh
forge install foundry-rs/forge-std@v1.17.0 OpenZeppelin/openzeppelin-contracts@v5.7.0 \
  OpenZeppelin/openzeppelin-contracts-upgradeable@v5.7.0 --no-git
forge test
python3 -I scripts/measure_rsk.py . testnet mainnet
```
