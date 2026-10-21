"""Show that mangekyou kamui_vrf.rs ECVRF outputs are computable from the PUBLIC KEY ONLY.

Faithful pure-Python port of prove/verify/to_hash from
mangekyou-labs/vrf-server@71fdd87 mangekyou/src/kamui_vrf.rs (lines ~142-153, 198-207, 235-250,
307-337, 395-442). Generates a key, proves, verifies the proof with the ported verifier, then
recomputes Gamma and beta with no secret key.
NOTE: mangekyou/src/tests/vrf_tests.rs vectors target a module (crate::vrf::ecvrf) that no longer
exists and is not compiled (no `mod vrf_tests` in lib.rs), so they are not usable here.

mangekyou's encode_to_curve is H = h*B with h = SHA512(DST||HASH_POINTS_DST||Y||alpha) mod L,
so Gamma = x*H = h*(x*B) = h*Y. Anyone can compute Gamma and beta = proof_to_hash(Gamma).
Ristretto255 encode/decode per RFC 9496. Pure Python, no dependencies.
"""
import hashlib, sys

p = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = (-121665 * pow(121666, -1, p)) % p
SQRT_M1 = pow(2, (p - 1) // 4, p)
INVSQRT_A_MINUS_D = 54469307008909316920995813868745141605393597292927456921205312896311721017578

def neg(x): return x & 1  # IS_NEGATIVE
def ct_abs(x): return (-x) % p if neg(x) else x

def sqrt_ratio_m1(u, v):
    r = (u * pow(v, 3, p)) * pow(u * pow(v, 7, p), (p - 5) // 8, p) % p
    check = v * r * r % p
    correct = check == u % p
    flipped = check == (-u) % p
    flipped_i = check == (-u * SQRT_M1) % p
    if flipped or flipped_i:
        r = r * SQRT_M1 % p
    return (correct or flipped), ct_abs(r)

def decode(b):
    s = int.from_bytes(b, "little")
    assert s < p and not neg(s), "non-canonical"
    ss = s * s % p
    u1 = (1 - ss) % p; u2 = (1 + ss) % p
    u2s = u2 * u2 % p
    v = (-(D * u1 * u1) - u2s) % p
    ok, inv = sqrt_ratio_m1(1, v * u2s % p)
    dx = inv * u2 % p; dy = inv * dx * v % p
    x = ct_abs(2 * s * dx % p); y = u1 * dy % p; t = x * y % p
    assert ok and not neg(t) and y != 0, "invalid ristretto"
    return (x, y, 1, t)

def encode(P):
    X0, Y0, Z0, T0 = P
    u1 = (Z0 + Y0) * (Z0 - Y0) % p
    u2 = X0 * Y0 % p
    _, inv = sqrt_ratio_m1(1, u1 * u2 * u2 % p)
    den1 = inv * u1 % p; den2 = inv * u2 % p
    zinv = den1 * den2 * T0 % p
    ix0 = X0 * SQRT_M1 % p; iy0 = Y0 * SQRT_M1 % p
    ench = den1 * INVSQRT_A_MINUS_D % p
    rotate = neg(T0 * zinv % p)
    X, Y, den_inv = (iy0, ix0, ench) if rotate else (X0, Y0, den2)
    if neg(X * zinv % p):
        Y = (-Y) % p
    s = ct_abs(den_inv * (Z0 - Y) % p)
    return s.to_bytes(32, "little")

def add(P, Q):  # extended twisted Edwards, a = -1
    X1, Y1, Z1, T1 = P; X2, Y2, Z2, T2 = Q
    A = (Y1 - X1) * (Y2 - X2) % p; B = (Y1 + X1) * (Y2 + X2) % p
    C = 2 * D * T1 * T2 % p; Dd = 2 * Z1 * Z2 % p
    E = B - A; F = Dd - C; G = Dd + C; H = B + A
    return (E * F % p, G * H % p, F * G % p, E * H % p)

def mul(k, P):
    R = (0, 1, 1, 0)
    while k:
        if k & 1: R = add(R, P)
        P = add(P, P); k >>= 1
    return R

DST = b"ECVRF_ristretto255_XMD:SHA-512_R255MAP_RO_sol_vrf"
HASH_POINTS_DST = b"sol_vrf_hash_points"
SUITE = b"sol_vrf"
CHAL_DST = b"sol_vrf_challenge_generation"
NONCE_DST = b"sol_vrf_nonce_generation"
B = decode(bytes.fromhex("e2f2ae0a6abc4e71a884a961c500515f58e30b6aa582dd8db6a65945e08d2d76"))
sha = lambda *a: hashlib.sha512(b"".join(a)).digest()
wide = lambda d: int.from_bytes(d, "little") % L

def h2c(pk, alpha):
    return mul(wide(sha(DST, HASH_POINTS_DST, pk, alpha)), B)

def challenge(*pts):
    return sha(SUITE, CHAL_DST, b"\x02", *[encode(P) for P in pts], b"\x00")[:16]

def prove(x, alpha):
    pk = encode(mul(x, B)); Y = decode(pk); H = h2c(pk, alpha)
    gamma = mul(x, H)
    k = wide(sha(NONCE_DST, sha(x.to_bytes(32, "little")), encode(H)))
    c = challenge(Y, H, gamma, mul(k, B), mul(k, H))
    s = (k + int.from_bytes(c, "little") * x) % L
    return pk, encode(gamma), c, s

def verify(pk, alpha, gamma_b, c, s):
    Y = decode(pk); H = h2c(pk, alpha); G = decode(gamma_b); ci = (L - int.from_bytes(c, "little")) % L
    U = add(mul(s, B), mul(ci, Y)); V = add(mul(s, H), mul(ci, G))
    return challenge(Y, H, G, U, V) == c

to_hash = lambda g: sha(SUITE, b"\x03", g, b"\x00")

def main():
    import secrets
    x = wide(secrets.token_bytes(64)); alpha = b"Hello, world!"
    pk, gamma, c, s = prove(x, alpha)
    print("pk            =", pk.hex())
    print("proof verifies:", verify(pk, alpha, gamma, c, s))
    print("prover beta   =", to_hash(gamma).hex())
    # attacker: public key + alpha only
    h = wide(sha(DST, HASH_POINTS_DST, pk, alpha))
    g2 = encode(mul(h, decode(pk)))
    print("attacker beta =", to_hash(g2).hex())
    print("MATCH (output predictable without sk):", g2 == gamma)

if __name__ == "__main__":
    main()
