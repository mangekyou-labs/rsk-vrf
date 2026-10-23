"""Pure-Python primitives for the rsk-vrf proof probe (no third-party deps).

keccak256 (legacy Keccak, as EVM), secp256k1 affine arithmetic, and BN254 G1 hash-to-curve
(RFC 9380 expand_message_xmd with Keccak-256 + Shallue-van de Woestijne map, as in
drand/kyber pairing/bn254/point.go for scheme bls-bn254-unchained-on-g1).
"""
import hashlib

# ---------------- Keccak-256 (pre-NIST padding 0x01) ----------------
_RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
       0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
       0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
       0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
       0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
       0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_M = (1 << 64) - 1
def _rol(x, n): return ((x << n) | (x >> (64 - n))) & _M if n else x
def _f(A):
    for rc in _RC:
        C = [A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4] for x in range(5)]
        D = [C[(x - 1) % 5] ^ _rol(C[(x + 1) % 5], 1) for x in range(5)]
        A = [[A[x][y] ^ D[x] for y in range(5)] for x in range(5)]
        B = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                B[y][(2 * x + 3 * y) % 5] = _rol(A[x][y], _ROT[x][y])
        A = [[B[x][y] ^ ((~B[(x + 1) % 5][y]) & B[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        A[0][0] ^= rc
    return A
def keccak256(data: bytes) -> bytes:
    rate = 136
    m = bytearray(data) + b"\x01"
    m += b"\x00" * ((-len(m)) % rate)
    m[-1] |= 0x80
    A = [[0] * 5 for _ in range(5)]
    for off in range(0, len(m), rate):
        blk = m[off:off + rate]
        for i in range(rate // 8):
            x, y = i % 5, i // 5
            A[x][y] ^= int.from_bytes(blk[8 * i:8 * i + 8], "little")
        A = _f(A)
    out = b""
    for i in range(4):
        out += A[i % 5][i // 5].to_bytes(8, "little")
    return out
assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"

def sha256(b): return hashlib.sha256(b).digest()
def u256(x): return x.to_bytes(32, "big")

# ---------------- secp256k1 ----------------
P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)
def on_curve(Pt): return Pt is not None and (Pt[1] * Pt[1] - Pt[0] ** 3 - 7) % P == 0
def ec_add(A, B):
    if A is None: return B
    if B is None: return A
    if A[0] == B[0]:
        if (A[1] + B[1]) % P == 0: return None
        l = 3 * A[0] * A[0] * pow(2 * A[1], -1, P) % P
    else:
        l = (B[1] - A[1]) * pow(B[0] - A[0], -1, P) % P
    x = (l * l - A[0] - B[0]) % P
    return (x, (l * (A[0] - x) - A[1]) % P)
def ec_mul(k, A):
    R = None
    k %= N
    while k:
        if k & 1: R = ec_add(R, A)
        A = ec_add(A, A); k >>= 1
    return R
def ec_neg(A): return (A[0], (-A[1]) % P)
def sqrt_p(a):
    r = pow(a, (P + 1) // 4, P)
    return r if r * r % P == a % P else None
def compress(A): return bytes([2 + (A[1] & 1)]) + u256(A[0])
def decompress(b):
    assert len(b) == 33 and b[0] in (2, 3)
    x = int.from_bytes(b[1:], "big")
    if x >= P: return None
    y = sqrt_p((x ** 3 + 7) % P)
    if y is None: return None
    if (y & 1) != (b[0] & 1): y = P - y
    return (x, y)
def addr(A): return keccak256(u256(A[0]) + u256(A[1]))[12:]

# ---------------- BN254 G1 hash-to-curve (drand evmnet) ----------------
BP = 21888242871839275222246405745257275088696311157297823662689037894645226208583
BR = 21888242871839275222246405745257275088548364400416034343698204186575808495617
DRAND_DST = b"BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_"
def expand_xmd_keccak(msg, dst, out_len):
    ell = (out_len + 31) // 32
    dst_p = dst + bytes([len(dst)])
    b0 = keccak256(b"\x00" * 136 + msg + out_len.to_bytes(2, "big") + b"\x00" + dst_p)
    bs = [keccak256(b0 + b"\x01" + dst_p)]
    for i in range(2, ell + 1):
        bs.append(keccak256(bytes(a ^ c for a, c in zip(b0, bs[-1])) + bytes([i]) + dst_p))
    return b"".join(bs)[:out_len]
def _g(x): return (x ** 3 + 3) % BP
def _sqrt_bp(a):
    r = pow(a, (BP + 1) // 4, BP)
    return r if r * r % BP == a % BP else None
def _sgn0(x): return x & 1
Z = 1
C1 = _g(Z)
C2 = (-Z * pow(2, -1, BP)) % BP
_c3 = _sqrt_bp((-_g(Z) * (3 * Z * Z)) % BP)
C3 = _c3 if _sgn0(_c3) == 0 else BP - _c3
C4 = (-4 * _g(Z) * pow(3 * Z * Z, -1, BP)) % BP
def svdw(u):
    tv1 = u * u % BP * C1 % BP
    tv2 = (1 + tv1) % BP
    tv1 = (1 - tv1) % BP
    tv3 = pow(tv1 * tv2 % BP, BP - 2, BP)
    tv5 = u * tv1 % BP * tv3 % BP * C3 % BP
    x1 = (C2 - tv5) % BP
    x2 = (C2 + tv5) % BP
    x3 = (Z + C4 * pow(tv2 * tv2 % BP * tv3 % BP, 2, BP)) % BP
    for x in (x1, x2, x3):
        y = _sqrt_bp(_g(x))
        if y is not None:
            break
    if _sgn0(u) != _sgn0(y): y = BP - y
    return (x, y)
def bn_add(A, B):
    if A is None: return B
    if B is None: return A
    if A[0] == B[0]:
        if (A[1] + B[1]) % BP == 0: return None
        l = 3 * A[0] * A[0] * pow(2 * A[1], -1, BP) % BP
    else:
        l = (B[1] - A[1]) * pow(B[0] - A[0], -1, BP) % BP
    x = (l * l - A[0] - B[0]) % BP
    return (x, (l * (A[0] - x) - A[1]) % BP)
def drand_hash_to_g1(round_no):
    msg = keccak256(round_no.to_bytes(8, "big"))
    uni = expand_xmd_keccak(msg, DRAND_DST, 96)
    u0 = int.from_bytes(uni[:48], "big") % BP
    u1 = int.from_bytes(uni[48:], "big") % BP
    return bn_add(svdw(u0), svdw(u1)), msg, (u0, u1)
