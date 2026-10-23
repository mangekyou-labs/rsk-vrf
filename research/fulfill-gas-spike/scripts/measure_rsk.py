"""Measure the fulfill-gas spike on Rootstock over JSON-RPC, read-only.

Harness (src/Harness.sol) runs a whole scenario inside its constructor: deploy coordinator + proxy +
consumers, request, then one measured action chosen by `mode`. We send the contract-creation transaction
via eth_call / eth_estimateGas, which execute it against the latest state without mining, signing or
spending anything. `from` is a fixed unfunded address so every CREATE address (and so every Alpha) is
stable between the two passes: pass 1 reads the Alphas, Python proves them, pass 2 measures.

Usage: python3 -I scripts/measure_rsk.py <spike_root> [testnet|mainnet ...]
Reads only this project's own forge artifacts under <spike_root>/out.
"""
import http.client
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prove  # noqa: E402

RPC = {"testnet": "https://public-node.testnet.rsk.co", "mainnet": "https://public-node.rsk.co"}
FROM = "0x1111111111111111111111111111111111111111"
VALUE = 10 ** 15  # covers the six request fees; eth_call does not check the sender's balance on RSKj
TX_CAP = 10_000_000
CAP = 200_000
SELECTORS = {}  # filled from the artifact ABI: 4-byte selector -> error name


def rpc(url, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(url, body, {"Content-Type": "application/json", "User-Agent": "rsk-vrf-gas-spike"})
    for attempt in range(5):  # the public nodes occasionally drop a connection
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except (OSError, http.client.HTTPException):
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)


def calldata_gas(b: bytes) -> int:
    # RSKj GasCost: TX_ZERO_DATA 4, TX_NO_ZERO_DATA 16 (RSKIP400)
    return sum(4 if x == 0 else 16 for x in b)


def word(x: int) -> bytes:
    return x.to_bytes(32, "big")


class Net:
    def __init__(self, root, name):
        self.url = RPC[name]
        self.name = name
        with open(os.path.join(root, "out", "Harness.sol", "Harness.json")) as f:
            self.code = bytes.fromhex(json.load(f)["bytecode"]["object"][2:])
        with open(os.path.join(root, "out", "VRFCoordinator.sol", "VRFCoordinator.json")) as f:
            for item in json.load(f)["abi"]:
                if item["type"] == "error":
                    sig = item["name"] + "(" + ",".join(i["type"] for i in item["inputs"]) + ")"
                    SELECTORS[int.from_bytes(prove.V.L.keccak256(sig.encode())[:4], "big")] = item["name"]
        blk = rpc(self.url, "eth_getBlockByNumber", ["latest", False])["result"]
        self.block = int(blk["number"], 16)
        self.bgl = int(blk["gasLimit"], 16)
        self.chainid = int(rpc(self.url, "eth_chainId", [])["result"], 16)
        self.price = int(rpc(self.url, "eth_gasPrice", [])["result"], 16)
        self.min_price = int(blk.get("minimumGasPrice", "0x0"), 16)
        self.proofs = [[0] * 13 for _ in range(4)]

    def tx(self, mode, g=0, reserve=0):
        args = word(mode) + word(g) + word(reserve) + b"".join(word(w) for p in self.proofs for w in p)
        return {"from": FROM, "data": "0x" + (self.code + args).hex(), "value": hex(VALUE), "gas": hex(self.bgl)}

    def call(self, mode, g=0, reserve=0):
        r = rpc(self.url, "eth_call", [self.tx(mode, g, reserve), "latest"])
        if "result" not in r or len(r["result"]) != 2 + 512:
            raise RuntimeError(f"mode {mode} g {g}: {json.dumps(r)[:300]}")
        b = bytes.fromhex(r["result"][2:])
        return [int.from_bytes(b[i:i + 32], "big") for i in range(0, 256, 32)]

    def estimate(self, mode):
        r = rpc(self.url, "eth_estimateGas", [self.tx(mode)])
        if "result" not in r:
            raise RuntimeError(f"estimate mode {mode}: {json.dumps(r)[:300]}")
        return int(r["result"], 16)

    def min_limit(self, mode, g=0, lo=5_000_000):
        """Smallest whole-tx gas limit at which eth_call succeeds, to 1 gas: the search eth_estimateGas runs."""
        def ok(gas):
            t = self.tx(mode, g)
            t["gas"] = hex(gas)
            r = rpc(self.url, "eth_call", [t, "latest"])
            return len(r.get("result", "0x")) == 2 + 512
        hi = self.bgl
        assert ok(hi) and not ok(lo)
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if ok(mid):
                hi = mid
            else:
                lo = mid
        return hi

    def min_gas(self, mode, reserve, lo=300_000, hi=2_000_000):
        """Smallest g for which fulfill{gas: g} succeeds (binary search; success is monotone in g)."""
        assert self.call(mode, hi, reserve)[4] == 1, "hi must succeed"
        below = self.call(mode, lo, reserve)
        assert below[4] == 0
        while hi - lo > 1:
            mid = (lo + hi) // 2
            r = self.call(mode, mid, reserve)
            if r[4] == 1:
                hi = mid
            else:
                lo, below = mid, r
        return hi, SELECTORS.get(below[5], hex(below[5]))


def fulfill_calldata(proof_words):
    # fulfill(bytes32,Proof,uint256[2]); requestId and drand sig taken as all-nonzero bytes (worst case)
    sel = prove.V.L.keccak256(
        b"fulfill(bytes32,(uint256[2],uint256[2],uint256,uint256,uint256,address,uint256[2],uint256[2],uint256),uint256[2])"
    )[:4]
    return sel + b"\xff" * 32 + b"".join(word(w) for w in proof_words) + b"\xff" * 64


def main():
    root = sys.argv[1]
    for name in sys.argv[2:] or ["testnet"]:
        n = Net(root, name)
        print(f"== {name} chainId {n.chainid} block {n.block} gasLimit {n.bgl} gasPrice {n.price} minimumGasPrice {n.min_price}")

        alphas = n.call(0)[:4]
        n.proofs = [prove.prove_words(a)[0] for a in alphas]
        its = [prove.h2c_iterations(a) for a in alphas]
        print("  pass 1 alphas:", ", ".join(f"{hex(a)[:12]}.. ({k} h2c iter)" for a, k in zip(alphas, its)))

        labels = {1: "fulfill success consumer", 2: "fulfill burner consumer", 3: "fulfill requester has no code",
                  4: "fulfill plain request (cap 0)"}
        res = {}
        for m in (1, 2, 3, 4):
            o = n.call(m)
            res[m] = o[4]
            print(f"  {labels[m]:34s} exec={o[4]:>7}  status={o[5]} betaNonzero={o[6] != 0} payeeBalance={o[7]}")
        o = n.call(1)
        print(f"  request, consumer->requestWithCallback  first={o[0]}  steady={o[1]}  (incl. consumer frame + value CALL)")
        print(f"  request, plain from harness             first={o[2]}  steady={o[3]}")
        o = n.call(5)
        print(f"  timeoutRefund -> consumer={o[4]}  -> nonexistent account={o[5]}  (nonexistent got {o[6]} wei)")
        o = n.call(6)
        print(f"  withdrawFees (after a fulfill) exec={o[5]}  balanceAfter={o[6]}")
        o = n.call(7)
        print(f"  segment VRF.sol verify={o[4]}  drand BN254 verify={o[6]}  drandRandomnessOk={o[7] == 0x4da14d73e62d0c909d143e61a2adce866f6be3e7a9d58b1e32a95c87e780569c or hex(o[7])}")

        # The public nodes cap eth_estimateGas at 6.8M and return the cap (no error) for anything above it; the
        # harness setup alone needs ~7M, so run the same gas-limit search with eth_call at the block gas limit.
        print(f"  eth_estimateGas(harness baseline) = {n.estimate(8)}  (node estimation cap, see min-limit search)")
        base = n.min_limit(8)
        l11, l12 = n.min_limit(11), n.min_limit(12)
        print(f"  min tx gas limit: baseline={base} +fulfillSuccess={l11} (delta {l11 - base})"
              f" +fulfillBurner={l12} (delta {l12 - base})")

        # VRF.sol verify cost against hash-to-curve iterations: Alphas chosen offline with 1, 2, 4, 8 iterations
        saved = n.proofs
        h2c = [4, 1, 16, 7]
        n.proofs = [prove.prove_words(a)[0] for a in h2c]
        o = n.call(13)
        k = [prove.h2c_iterations(a) for a in h2c]
        print("  VRF.sol verify by h2c iterations: " + ", ".join(f"{ki} -> {o[i]}" for i, ki in enumerate(k)))
        print(f"    per extra iteration ~ {(o[3] - o[0]) / (k[3] - k[0]):.0f} gas")
        n.proofs = saved

        cd = fulfill_calldata(n.proofs[1])
        cdg = calldata_gas(cd)
        worst = max(res[1], res[2], res[3])
        total = 21_000 + cdg + worst
        print(f"  fulfill calldata {len(cd)}B -> {cdg} gas; worst tx = 21000 + {cdg} + {worst} = {total}  (< {TX_CAP}: {total < TX_CAP})")

        big = 60_000
        g0, why0 = n.min_gas(9, 0)
        gb, whyb = n.min_gas(9, big)
        need = big - (gb - g0)
        print(f"  burner fulfill min gas: R=0 -> {g0} (below: {why0});  R={big} -> {gb} (below: {whyb})")
        print(f"  => gasleft at the reserve check must be >= cap + {need} for the burner fulfill to complete")
        gs, whys = n.min_gas(10, 0)
        print(f"  success fulfill min gas with R=0: {gs} (below: {whys})")
        for r in (need - 1, need, need + 5_000):
            g, why = n.min_gas(9, r)
            print(f"    check R={r}: min gas {g}, just below reverts with {why}")
        c0, whyc0 = n.min_gas(14, 0, lo=150_000)
        cb, whycb = n.min_gas(14, big, lo=150_000)
        needc = big - (cb - c0)
        print(f"  no-account requester, cap 1: min gas R=0 -> {c0} (below: {whyc0});  R={big} -> {cb} (below: {whycb})")
        print(f"  => gasleft at the reserve check must be >= cap + {needc} when the requester has no account")
        for r in (needc - 1, needc):
            g, why = n.min_gas(14, r, lo=150_000)
            print(f"    check R={r}: min gas {g}, just below reverts with {why}")
        for r in (0, 10_000):
            g, why = n.min_gas(15, r, lo=150_000)
            print(f"  no-account requester, cap {CAP}, R={r}: min gas {g}, just below reverts with {why}")


if __name__ == "__main__":
    main()
