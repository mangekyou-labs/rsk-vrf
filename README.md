# rsk-vrf

Verifiable randomness service for Rootstock (testnet). Planning lives in the Wayfinder map issue.

## Security status

These are known gaps in the worker prover (`worker/src/vrf`).

| Item | Status | Note |
| --- | --- | --- |
| Constant time | Not guaranteed | The prover uses `@noble/curves` and JavaScript bigint. Bigint operations can take more or less time for different values. Thus the time to prove a Beta from an Alpha can show data about the Proving Key. |
| Secret in memory | Cannot erase | The Proving Key secret is a bigint. JavaScript cannot write zeros over a bigint, so the secret stays in memory until the garbage collector removes it. |
| Nonce state in memory | Cannot erase fully | The nonce function writes zeros over its byte copies of the secret and the DRBG key `k`. It cannot erase the last DRBG value `v`, because it gives `v` back as the nonce. |
