"""Chainlink VRF.sol proof for a given Alpha with the TEST-ONLY oracle key, ABI-encoded as VRF.Proof.

Usage: python3 -I scripts/prove.py <alpha as 0x-hex uint256>  -> prints 0x<13 words> (forge ffi friendly)
The proof's own `seed` field is set to Alpha for readability; the coordinator ignores it.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen_vectors as V  # noqa: E402

SK = V.test_scalar(b"chainlink-oracle")


def prove_words(alpha: int):
    p = V.cl_prove(SK, alpha)
    return [*p["pk"], *p["gamma"], p["c"], p["s"], alpha, int.from_bytes(p["uWitness"], "big"),
            *p["cGammaWitness"], *p["sHashWitness"], p["zInv"]], p["output"]


def h2c_iterations(alpha: int) -> int:
    """How many try-and-increment candidates VRF.sol's _hashToCurve evaluates for this Alpha (1 = first hit)."""
    pk = V.L.ec_mul(SK, V.G)
    rv = V.cl_candidate(V.L.u256(1) + V.L.u256(pk[0]) + V.L.u256(pk[1]) + V.L.u256(alpha))
    n = 1
    while not V.L.on_curve(rv):
        rv = V.cl_candidate(V.L.u256(rv[0]))
        n += 1
    return n


def encode(alpha: int) -> str:
    words, _ = prove_words(alpha)
    return "0x" + "".join("%064x" % w for w in words)


if __name__ == "__main__":
    print(encode(int(sys.argv[1], 16)))
