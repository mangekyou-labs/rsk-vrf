# drand evmnet operational guarantees

Research for issue #16 (map: #1). Observed 2026-10-23 (UTC). Primary sources only: live endpoints, the `drand/drand`, `drand/http-relay`, `drand/drand-docs`, `drand/website` repos (shallow clones at default branch on the observation date), and the drand status page.

## Summary

- `evmnet` is a League of Entropy (LoE) mainnet beacon, period 3 s, signatures on BN254 G1, public key on G2, unchained. Genesis 2024-09-28.
- drand publishes **no** support horizon or SLA for `evmnet`. The only stated policy: the LoE collectively decides its fate, with "no plan to wind it down as long as there is interest" (Aug 2025).
- Threshold and membership of the `evmnet` group are **not published** in any primary source found. Unknown.
- The chain hash is fixed by (period, genesis time, group public key, genesis seed, beacon ID). Resharing keeps the public key and thus the chain hash. A fresh DKG makes a new chain with a new hash. So the pinned key only changes if the LoE starts a new chain, which would be announced as a new chain, not a rotation.
- No `evmnet` outage is recorded on the official status page. This is weak evidence: the status page tracks relays and "fresh randomness" components, not evmnet specifically.

## 1. Chain parameters (live `/info`)

`GET https://api.drand.sh/v2/beacons/evmnet/info` (identical from api, api2, api3):

| Field | Value |
|---|---|
| beacon_id | `evmnet` |
| scheme | `bls-bn254-unchained-on-g1` |
| period | 3 (seconds) |
| genesis_time | 1727521075 (2024-09-28 10:57:55 UTC) |
| genesis_seed | `cd7ad2f0e0cce5d8c288f2dd016ffe7bc8dc88dbb229b3da2b6ad736490dfed6` |
| chain_hash | `04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3` |
| public_key (G2, 128 bytes) | `07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b3820557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808f0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0b` |

The chain hash and the key match the chain hash published in the docs (`docs/developer/00-Getting-started-devs.md` in drand-docs). Round formula: `round = floor((now - genesis_time) / 3) + 1`. At the time of check the computed expected round (21732328) matched the relays' latest (21732331 to 21732342 across calls, all within a round or two of the clock).

Scheme details from `drand/drand` `crypto/schemes.go` (`NewPedersenBLSBN254UnchainedOnG1Scheme`):
- Signatures on G1, key group G2, threshold BLS on G1.
- Digest is `keccak256(uint64_be(round))` (unchained: only the round number is signed).
- DSTs: `BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_` (G1), `BLS_SIG_BN254G2_XMD:KECCAK-256_SVDW_RO_NUL_` (G2). Comment states it is "configured to be optimally compatible with the EVM".

Docs discrepancy: `00-Getting-started-devs.md` says evmnet has "public keys on G2" (consistent with the code) but its list of networks is otherwise terse; `drand/website` `docs/about/README.md` says "signatures on G1". Both are consistent with the code: keys G2, signatures G1.

The v2 `evmnet` response omits `randomness` (only `round`, `signature`). The v1 path `/{chainhash}/public/latest` on api.drand.sh includes `randomness`.

## 2. Threshold and membership

- Not published for `evmnet`. Searched: drand-docs (docs, blog), `drand/website` (LoE page), `drand/drand` repo, status page. The LoE page only says the LoE is "a coalition of 15 independent organizations" generally, with no per-network breakdown.
- Only per-network figures found are for the sunset `fastnet` (21 nodes/threshold 11, reduced to 14/8) in the 2023-07-03 blog, which says nothing about `evmnet`.
- The group file (nodes, threshold) is not served by the public HTTP API (`/info` has no group data). Operators of a node would have it. Ask the LoE (leagueofentropy@googlegroups.com or the drand Slack). The 2025-08-26 blog says `evmnet` was launched "discreetly" in 2024.
- Security model (drand-docs `docs/concepts/02-Security_Model.md`): threshold is the number of nodes that must be online and honest to produce each beacon; it must be strictly more than 50% of the group. Below threshold online, no beacon is produced.

## 3. Support horizon and deprecation policy

- Quote, drand-docs `blog/2025-08-26-verifying-bls12-on-ethereum.md`: "This also does not mean that support for BN254 and `evmnet` will end abruptly. While we expect BLS12-381 to be gradually adopted, many blockchain networks only support BN254 today. Regarding `evmnet`, it is the League of Entropy who collectively will decide its fate, and for now there is no plan to wind it down as long as there is interest."
- No end date, no minimum notice period, no SLA published for `evmnet`.
- Precedent for how a network is retired: `fastnet` was announced for sunset 2023-07-03, with shutdown planned for Dec 2023 / Q1 2024, with node count reduced stepwise and dates set in a 2024-09-14 post; and "the default chained network might be deprecated within 18 months, nothing set in stone" (2023-10-16 quicknet post). So expect months of notice announced on the drand blog, but this is precedent only, not a commitment for `evmnet`.
- The blog post also signals that the drand team's forward direction is BLS12-381 (EIP-2537, post-Pectra); `evmnet` is described as the "legacy option" for BN254 chains.

## 4. Can the group key or chain hash change?

- `drand/drand` `common/chain/info.go` `Info.Hash()` = sha256 over period (u32 BE), genesis time, group public key bytes, genesis seed, and beacon ID (when not the default ID). So the chain hash changes iff any of those change.
- Security model doc: "When a resharing occurs, the individual shares of each drand node change but the chain remains the same... the distributed public key doesn't change." "If the same set of nodes perform a new fresh DKG, it will create a new chain from scratch." The doc recommends resharing regularly, including between the same nodes.
- Consequence: membership changes and threshold changes via resharing do **not** change the pinned public key or chain hash. A new key means a new chain (new genesis, new hash), which would be a distinct beacon, not an in-place rotation. A fresh DKG on the same beacon ID is technically possible but the old chain would stop (the hash would differ), so the coordinator's Admin key rotation would be a planned migration, not a surprise key swap.
- Security risk noted by drand: in v2.0.0 a DKG command bug could allow a rogue operator to reduce the threshold and recover the group key; fixed in v2.1.0 (Feb 2025) per the 2025-03-21 post-mortem. The team states it was not exploited. Current drand release: v2.1.8 (2026-10-07). I did not verify which version the `evmnet` nodes run.
- Unknown: whether and when `evmnet` has been resharded (no public log). The chain hash has been stable since genesis per the docs and live check; I did not compare against historical snapshots.

## 5. Outage history

- Status page (`https://drand.statuspage.io/api/v2/incidents.json`, page `status.drand.love`) lists these incidents, none about `evmnet` specifically:
  - 2020-06-26: no new randomness in LoE (default network) for about 2 hours due to third-party node downtime.
  - 2023-11-02/04: Cloudflare relays down.
  - 2024-12-04: inconsistent `/latest` caching responses (nginx cached without Cache-Control; fixed by setting Cache-Control on v2 relays).
  - 2025-12-17: 502s on api.drand.sh (resolved the same day).
  - 2026-04-22: increased error rate on relays; `/latest` recovered, "v2 APIs still showing some issues" at last update, status stayed "monitoring" and no resolved time (still open as of check).
  - Testnet-only incidents in 2020 and 2024.
- Status-page components cover only api/api2/api3 reachability and "fresh randomness" (components named `mainnet1/2/3`), not per-beacon. `evmnet` beacon gaps cannot be ruled out from this. No per-round gap audit was done (would require walking 21.7M rounds; see unknowns).

## 6. Public relays serving evmnet

HTTP (checked live):

| Endpoint | evmnet? | Notes |
|---|---|---|
| `https://api.drand.sh` | Yes | v1 `/{hash}/...` and v2 `/v2/beacons/evmnet/...` |
| `https://api2.drand.sh` | Yes | same |
| `https://api3.drand.sh` | Yes | same |
| `https://drand.cloudflare.com` | **No** | `/chains` lists only default and quicknet; `/{evmnet hash}/info` returns "group not found" (though the docs list this endpoint among the mainnet endpoints). Its `/public/latest` is the default chain. No v2 API (404). |
| `https://api.drand.secureweb3.com:6875` | Unknown | Connection timed out from the test host (15 s). |

- Docs say only the `drand.sh` relays support the v2 API; all relays support v1 (drand-docs `docs/developer/06-HTTP-API.md`).
- `GET https://api.drand.sh/v2/chains` returns three hashes: default `8990e7a9...`, evmnet `04f1e906...`, quicknet `52db9ba7...`. `GET /v2/beacons` returns `["evmnet","quicknet","default"]`.

Gossip (libp2p gossipsub):
- Docs (drand-docs `docs/developer/04-PubSub_Network_Integration.md`): first-tier relays `/dnsaddr/api.drand.sh`, `/dnsaddr/api2.drand.sh`, `/dnsaddr/api3.drand.sh`. Topic: `/drand/pubsub/v0.0.0/<chain_hash>`, messages are `PublicRandResponse` protobufs. The doc only gives the default chain's topic as an example; the evmnet topic would be `/drand/pubsub/v0.0.0/04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3` by that rule. I did not subscribe to verify that the relays publish evmnet on gossip. That is **unverified**.
- DNS check: `_dnsaddr.api.drand.sh` (and api2/api3) TXT records resolve to libp2p multiaddrs on tcp/44544 (peer IDs recorded in the observation output; not reproduced here).

## 7. Behavior on a missed round, and detecting a stall

From `drand/http-relay` `routes_handler.go` and live responses:

- `GET /v2/beacons/evmnet/rounds/latest` returns the latest *stored* beacon, with `Cache-Control: public, must-revalidate, max-age=N` where N is time to the next expected round (observed 2 or 3). It does not error when the chain is behind; it just returns an older round. A worker must compare `round` with the expected round.
- Requesting a round in the future (beyond expected next) returns **HTTP 425** `Requested future beacon` (observed for round 99999999) with `max-age` of one period. Requesting exactly the expected next round blocks until it is produced (via `Next`), so the call can hang or error if the chain is stalled.
- Historic rounds are cached `public, max-age=604800, immutable`.
- `GET /v2/beacons/evmnet/health` returns `{"current":<latest stored round>,"expected":<expected round>}`; observed `{"current":21732294,"expected":21732294}`. Code: HTTP 200 if `latest.Round >= next-2`, else **503** (i.e. tolerance of about one missed round). Not cached (`no-cache`). The v2 `/chains/{hash}/health` is equivalent. The v1 path has no health endpoint in the paths seen.
- Chain semantics: the scheme is unchained, so each round's signature depends only on the round number (and the key). A skipped round can later be produced by catch-up (nodes sync and the handler runs in "catchup mode" if behind; `drand/drand` `internal/chain/beacon/node.go`). The round number never "skips": the beacon for round N is always the signature over N, whenever it is produced. A stall means the latest round lags the clock-computed expected round. I did not find a documented guarantee about how fast catch-up runs (`CatchupPeriod` is a group parameter; value for evmnet unknown).
- Detection recipe for a worker:
  1. Compute `expected = floor((now - 1727521075)/3) + 1` locally (needs only `/info` constants pinned).
  2. Fetch `/v2/beacons/evmnet/rounds/latest` from at least two relays; verify the BLS signature against the pinned key (do not trust relay JSON); compare `round` to `expected`.
  3. Optionally poll `/health`; treat 503 or `expected - current >= 2` as a stall. Allow one period of slack for relay caching (`max-age` up to 3 s).
  4. On 5xx or timeouts from one relay, fail over across api/api2/api3. The relays are all run from one operator (`drand.sh`; status page names them "Protocol Labs mainnet1-3"), so they share a failure mode.
- Per the coordinator design, a stall is not a refund reason; the worker should wait for catch-up of the specific round number rather than switch rounds.

## Unknowns (not answerable from primary sources found)

1. evmnet group size, threshold, and member organisations; whether it equals the mainnet default/quicknet LoE set.
2. Whether any resharing has happened on evmnet since genesis, and the process for announcing one.
3. A formal support horizon or SLA. Only the "as long as there is interest" statement exists.
4. A complete evmnet round-gap and downtime history (no per-beacon incident log; status page is relay-level).
5. Whether the gossip relays actually publish the evmnet topic.
6. Whether `api.drand.secureweb3.com:6875` serves evmnet (timed out), and whether Cloudflare will add it (currently does not, contrary to the endpoint list in the docs).
7. evmnet's `CatchupPeriod` and the actual catch-up speed after a stall.
8. Open status incident from 2026-04-22 ("Increased error rate on relays", v2 API partially degraded) has no recorded resolution in the API output.

## Sources

- Live: `https://api.drand.sh|api2.drand.sh|api3.drand.sh/v2/beacons/evmnet/{info,health,rounds/latest,rounds/1,rounds/next}`, `/v2/chains`, `/v2/beacons`, `/{hash}/info`, `/{hash}/public/latest`; `https://drand.cloudflare.com/chains`; `dig TXT _dnsaddr.api{,2,3}.drand.sh`.
- https://github.com/drand/drand-docs : `docs/developer/00-Getting-started-devs.md`, `docs/developer/04-PubSub_Network_Integration.md`, `docs/developer/06-HTTP-API.md`, `docs/concepts/02-Security_Model.md`, `blog/2025-08-26-verifying-bls12-on-ethereum.md`, `blog/2025-03-21-drand-v2-0-postmortem.md`, `blog/2023-07-03-fastnet-sunset-quicknet-new.md`, `blog/2023-10-16-quicknet-is-live.md`, `blog/2024-09-14-fastnet-sunsetting-dates-set.md`. Published at https://docs.drand.love.
- https://github.com/drand/drand : `crypto/schemes.go`, `common/chain/info.go`, `internal/chain/beacon/node.go`; releases (v2.1.8, 2026-10-07).
- https://github.com/drand/http-relay : `routes_handler.go`.
- https://github.com/drand/website : `docs/about/README.md`, `docs/loe/README.md`.
- https://drand.statuspage.io/api/v2/incidents.json and `/components.json` (status.drand.love).
