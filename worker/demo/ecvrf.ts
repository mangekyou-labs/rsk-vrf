// An ECVRF verifier for recompute-beta, written straight from VRF.sol's
// _verifyVRFProof with @noble/curves primitives. It deliberately shares no code
// with the worker's prover, so a bug there cannot hide here.
// Unaudited testnet pilot; do not use for value.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, hexToBytes } from '@noble/hashes/utils.js';

const { Point } = secp256k1;
type Point = typeof Point.BASE;
const P = Point.Fp.ORDER;
const N = Point.Fn.ORDER;

export interface VerifiableProof {
  pk: readonly [bigint, bigint];
  gamma: readonly [bigint, bigint];
  c: bigint;
  s: bigint;
  /** The address of c·pk + s·G, as hex. */
  uWitness: string;
}

const word = (n: bigint) => hexToBytes(n.toString(16).padStart(64, '0'));
const num = (bytes: Uint8Array) => BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
const keccak = (...parts: Uint8Array[]) => num(keccak_256(concatBytes(...parts)));
const bytesOf = (p: Point) => { const { x, y } = p.toAffine(); return concatBytes(word(x), word(y)); };
const address = (p: Point) => keccak_256(bytesOf(p)).slice(12);
const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;
const times = (p: Point, k: bigint) => (mod(k, N) === 0n ? Point.ZERO : p.multiply(mod(k, N)));

function onCurve([x, y]: readonly [bigint, bigint]): Point | undefined {
  if (x >= P || y >= P) return undefined;
  try {
    const point = Point.fromAffine({ x, y });
    point.assertValidity();
    return point;
  } catch {
    return undefined;
  }
}

/** VRF.sol's hashToCurve(pk, alpha): try-and-increment on keccak, even y. */
function hashToCurve(pk: Point, alpha: bigint): Point {
  const fieldHash = (bytes: Uint8Array) => {
    let x = keccak(bytes);
    while (x >= P) x = keccak(word(x));
    return x;
  };
  let x = fieldHash(concatBytes(word(1n), bytesOf(pk), word(alpha)));
  for (;;) {
    const y = trySqrt(mod(x ** 3n + 7n, P));
    if (y !== undefined) return Point.fromAffine({ x, y: y % 2n === 0n ? y : P - y });
    x = fieldHash(word(x));
  }
}

function trySqrt(a: bigint): bigint | undefined {
  const root = Point.Fp.pow(a, (P + 1n) / 4n);
  return mod(root * root, P) === a ? root : undefined;
}

/**
 * Verifies an ECVRF proof over Alpha as VRF.sol does: Gamma and pk on the curve,
 * address(c·pk + s·G) is uWitness, and c is the hash of (H, pk, Gamma, c·Gamma + s·H,
 * uWitness), where H is hashToCurve(pk, Alpha). On success it returns the VRF output
 * keccak256(3, Gamma).
 */
export function verify(proof: VerifiableProof, alpha: bigint): { valid: true; output: bigint } | { valid: false } {
  const pk = onCurve(proof.pk);
  const gamma = onCurve(proof.gamma);
  if (!pk || !gamma) return { valid: false };
  const u = times(pk, proof.c).add(times(Point.BASE, proof.s));
  if (u.equals(Point.ZERO)) return { valid: false };
  const uWitness = hexToBytes(proof.uWitness.replace(/^0x/, '').toLowerCase().padStart(40, '0'));
  if (Buffer.compare(Buffer.from(address(u)), Buffer.from(uWitness)) !== 0) return { valid: false };
  const h = hashToCurve(pk, alpha);
  const v = times(gamma, proof.c).add(times(h, proof.s));
  if (v.equals(Point.ZERO)) return { valid: false };
  const c = keccak(word(2n), bytesOf(h), bytesOf(pk), bytesOf(gamma), bytesOf(v), uWitness);
  if (c !== proof.c) return { valid: false };
  return { valid: true, output: keccak(word(3n), bytesOf(gamma)) };
}
