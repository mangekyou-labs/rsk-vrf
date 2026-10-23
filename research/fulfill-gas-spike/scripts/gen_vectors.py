"""Generate proof vectors for the rsk-vrf proof probe and emit src/Vectors.sol.

Run from anywhere with:  python3 -I scripts/gen_vectors.py <probe_root> <drand_round_json> <drand_info_json>

Keys and nonces here are TEST-ONLY and deterministic (derived from public strings); they are
not RFC 6979 nonces and must never be used for a real oracle.

Vectors:
  * Chainlink-style VRF (chainlink-evm VRF.sol, identical code in mangekyou-labs/vrf-server
    crosschain-prover/contracts/src/VRF.sol): pk, gamma, c, s, seed, uWitness, cGammaWitness,
    sHashWitness, zInv - replicating VRF.sol's hashToCurve / scalarFromCurvePoints /
    projectiveECAdd exactly.
  * RFC 9381-structured ECVRF over secp256k1 with try-and-increment and SHA-256
    (suite byte 0xFE, non-standard: RFC 9381 defines no secp256k1 suite), verified on-chain
    with the RSKIP516 secp256k1 ADD/MUL precompiles.
  * drand evmnet round (bls-bn254-unchained-on-g1): signature, H(m), group public key.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vrflib as L  # noqa: E402

N, P, G = L.N, L.P, L.G


def test_scalar(label: bytes) -> int:
    return int.from_bytes(L.sha256(b"rsk-vrf-probe TEST ONLY " + label), "big") % N


# ---------------------------------------------------------------- Chainlink VRF.sol
def cl_field_hash(b: bytes) -> int:
    x = int.from_bytes(L.keccak256(b), "big")
    while x >= P:
        x = int.from_bytes(L.keccak256(L.u256(x)), "big")
    return x


def cl_candidate(b: bytes):
    x = cl_field_hash(b)
    y = pow((x ** 3 + 7) % P, (P + 1) // 4, P)
    if y % 2 == 1:
        y = P - y
    return (x, y)


def cl_hash_to_curve(pk, seed: int):
    rv = cl_candidate(L.u256(1) + L.u256(pk[0]) + L.u256(pk[1]) + L.u256(seed))
    while not L.on_curve(rv):
        rv = cl_candidate(L.u256(rv[0]))
    return rv


def cl_projective_ec_add(px, py, qx, qy):
    F = P
    def psub(x1, z1, x2, z2):
        return ((z2 * x1 + (F - x2) * z1) % F, z1 * z2 % F)
    def pmul(x1, z1, x2, z2):
        return (x1 * x2 % F, z1 * z2 % F)
    z1 = z2 = 1
    lx = (qy + F - py) % F
    lz = (qx + F - px) % F
    sx, dx = pmul(lx, lz, lx, lz)
    sx, dx = psub(sx, dx, px, z1)
    sx, dx = psub(sx, dx, qx, z2)
    sy, dy = psub(px, z1, sx, dx)
    sy, dy = pmul(sy, dy, lx, lz)
    sy, dy = psub(sy, dy, py, z1)
    if dx != dy:
        sx = sx * dy % F
        sy = sy * dx % F
        sz = dx * dy % F
    else:
        sz = dx
    return sx, sy, sz


def cl_prove(sk: int, seed: int):
    pk = L.ec_mul(sk, G)
    h = cl_hash_to_curve(pk, seed)
    gamma = L.ec_mul(sk, h)
    k = int.from_bytes(L.sha256(b"cl-nonce TEST ONLY" + L.u256(sk) + L.u256(seed)), "big") % N
    u = L.ec_mul(k, G)
    v = L.ec_mul(k, h)
    u_addr = L.addr(u)
    c = int.from_bytes(L.keccak256(L.u256(2) + b"".join(L.u256(t) for t in (*h, *pk, *gamma, *v)) + u_addr), "big")
    s = (k - c * sk) % N
    # verifier identities
    assert L.ec_add(L.ec_mul(c, pk), L.ec_mul(s, G)) == u
    cg = L.ec_mul(c, gamma)
    sh = L.ec_mul(s, h)
    assert L.ec_add(cg, sh) == v
    x, y, z = cl_projective_ec_add(cg[0], cg[1], sh[0], sh[1])
    zinv = pow(z, -1, P)
    assert (x * zinv % P, y * zinv % P) == v
    out = int.from_bytes(L.keccak256(L.u256(3) + L.u256(gamma[0]) + L.u256(gamma[1])), "big")
    return dict(pk=pk, gamma=gamma, c=c, s=s, seed=seed, uWitness=u_addr, cGammaWitness=cg,
                sHashWitness=sh, zInv=zinv, output=out)


# ---------------------------------------------------------------- RFC 9381-style secp256k1 TAI
SUITE = b"\xfe"


def pt_str(A):
    return L.compress(A)


def tai_encode_to_curve(Y, alpha: bytes):
    for ctr in range(256):
        hs = L.sha256(SUITE + b"\x01" + pt_str(Y) + alpha + bytes([ctr]) + b"\x00")
        H = L.decompress(b"\x02" + hs)
        if H is not None:
            return H, ctr
    raise ValueError("no point")


def challenge(*pts):
    return int.from_bytes(L.sha256(SUITE + b"\x02" + b"".join(pt_str(p) for p in pts) + b"\x00")[:16], "big")


def ecvrf_prove(x: int, alpha: bytes):
    Y = L.ec_mul(x, G)
    H, ctr = tai_encode_to_curve(Y, alpha)
    gamma = L.ec_mul(x, H)
    k = int.from_bytes(L.sha256(b"ecvrf-nonce TEST ONLY" + L.u256(x) + pt_str(H)), "big") % N
    c = challenge(Y, H, gamma, L.ec_mul(k, G), L.ec_mul(k, H))
    s = (k + c * x) % N
    beta = L.sha256(SUITE + b"\x03" + pt_str(gamma) + b"\x00")
    return dict(Y=Y, H=H, ctr=ctr, gamma=gamma, c=c, s=s, beta=beta)


def ecvrf_verify(Y, alpha, gamma, c, s):
    if not (L.on_curve(Y) and L.on_curve(gamma) and s < N):
        return None
    H, _ = tai_encode_to_curve(Y, alpha)
    U = L.ec_add(L.ec_mul(s, G), L.ec_mul(N - c, Y))
    V = L.ec_add(L.ec_mul(s, H), L.ec_mul(N - c, gamma))
    if U is None or V is None or challenge(Y, H, gamma, U, V) != c:
        return None
    return L.sha256(SUITE + b"\x03" + pt_str(gamma) + b"\x00")


# ---------------------------------------------------------------- emit
def h(x):
    return "0x%064x" % x


def main():
    root, round_json, info_json = sys.argv[1], sys.argv[2], sys.argv[3]
    lines = ["// SPDX-License-Identifier: MIT", "// GENERATED by scripts/gen_vectors.py - TEST-ONLY keys/nonces.",
             "pragma solidity ^0.8.20;", "", "library Vectors {"]

    # Chainlink
    sk1 = test_scalar(b"chainlink-oracle")
    seed = int.from_bytes(L.keccak256(b"rsk-vrf probe seed"), "big")
    cl = cl_prove(sk1, seed)
    for k in ("pk", "gamma", "cGammaWitness", "sHashWitness"):
        lines.append(f"    uint256 internal constant CL_{k.upper()}_X = {h(cl[k][0])};")
        lines.append(f"    uint256 internal constant CL_{k.upper()}_Y = {h(cl[k][1])};")
    for k in ("c", "s", "seed", "zInv", "output"):
        lines.append(f"    uint256 internal constant CL_{k.upper()} = {h(cl[k])};")
    lines.append(f"    address internal constant CL_UWITNESS = address(uint160(uint256(0x{cl['uWitness'].hex().rjust(64, '0')})));")

    # RFC 9381-style
    sk2 = test_scalar(b"ecvrf-secp256k1-tai-oracle")
    alpha = L.keccak256(b"rsk-vrf probe alpha")
    v = ecvrf_prove(sk2, alpha)
    assert ecvrf_verify(v["Y"], alpha, v["gamma"], v["c"], v["s"]) == v["beta"]
    assert ecvrf_verify(v["Y"], alpha, v["gamma"], v["c"], (v["s"] + 1) % N) is None
    assert ecvrf_verify(v["Y"], alpha + b"x", v["gamma"], v["c"], v["s"]) is None
    lines += [f"    uint256 internal constant EC_PK_X = {h(v['Y'][0])};",
              f"    uint256 internal constant EC_PK_Y = {h(v['Y'][1])};",
              f"    uint256 internal constant EC_GAMMA_X = {h(v['gamma'][0])};",
              f"    uint256 internal constant EC_GAMMA_Y = {h(v['gamma'][1])};",
              f"    uint256 internal constant EC_C = {h(v['c'])};",
              f"    uint256 internal constant EC_S = {h(v['s'])};",
              f"    bytes32 internal constant EC_ALPHA = 0x{alpha.hex()};",
              f"    bytes32 internal constant EC_BETA = 0x{v['beta'].hex()};",
              f"    uint256 internal constant EC_TAI_CTR = {v['ctr']};"]

    # drand evmnet
    with open(round_json) as f:
        rj = json.load(f)
    with open(info_json) as f:
        info = json.load(f)
    assert info["scheme"] == "bls-bn254-unchained-on-g1", info["scheme"]
    rnd = int(rj["round"])
    sig = bytes.fromhex(rj["signature"])
    assert len(sig) == 64
    sx, sy = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    assert (sy * sy - sx ** 3 - 3) % L.BP == 0, "sig not on G1"
    Hm, msg, _ = drand_h = L.drand_hash_to_g1(rnd)
    rand = L.sha256(sig)
    assert rand.hex() == rj["randomness"], (rand.hex(), rj["randomness"])
    pkb = bytes.fromhex(info["public_key"])
    assert len(pkb) == 128
    pkw = [int.from_bytes(pkb[i:i + 32], "big") for i in range(0, 128, 32)]
    lines += [f"    uint64 internal constant DR_ROUND = {rnd};",
              f"    uint256 internal constant DR_SIG_X = {h(sx)};",
              f"    uint256 internal constant DR_SIG_Y = {h(sy)};",
              f"    uint256 internal constant DR_HM_X = {h(Hm[0])};",
              f"    uint256 internal constant DR_HM_Y = {h(Hm[1])};",
              f"    bytes32 internal constant DR_MSG = 0x{msg.hex()};",
              f"    bytes32 internal constant DR_RANDOMNESS = 0x{rand.hex()};"]
    for i, w in enumerate(pkw):
        lines.append(f"    uint256 internal constant DR_PK_{i} = {h(w)};")
    lines.append("}")
    out = os.path.join(root, "src", "Vectors.sol")
    with open(out, "w") as f:
        f.write("\n".join(lines) + "\n")
    print("wrote", out)
    print("chainlink output", h(cl["output"]))
    print("ecvrf beta", v["beta"].hex(), "tai ctr", v["ctr"])
    print("drand round", rnd, "randomness matches api:", True)


if __name__ == "__main__":
    main()
