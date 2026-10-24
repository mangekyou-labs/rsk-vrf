// A @noble/curves port of Chainlink's secp256k1 ECVRF prover (vrfkey's
// GenerateProofWithNonce) plus the witnesses VRF.sol's verifier needs
// (core/services/vrf/proof/solidity_proof.go's SolidityPrecalculations).
//
// Every hash and encoding mirrors VRF.sol, so a Proof from here verifies
// on-chain and matches the Go vectors in tools/vrf-vectors-go byte for byte.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes } from '@noble/hashes/utils.js';

import type { Hex, KeyHash } from '../types.ts';
import { bytesToHex, toBigInt, word } from './bytes.ts';
import { N, P } from './curve.ts';
import { nonce } from './nonce.ts';

const { Point } = secp256k1;
type Point = typeof Point.BASE;

// Domain-separation prefixes, as in VRF.sol.
const HASH_TO_CURVE_PREFIX = word(1n);
const SCALAR_FROM_CURVE_POINTS_PREFIX = word(2n);
const VRF_RANDOM_OUTPUT_PREFIX = word(3n);

export type Pair = readonly [bigint, bigint];

/** Proof is VRF.sol's Proof struct, field for field. */
export interface Proof {
  readonly pk: Pair;
  readonly gamma: Pair;
  readonly c: bigint;
  readonly s: bigint;
  /** The Alpha the proof is over; VRF.sol calls it seed. */
  readonly seed: bigint;
  /** The Ethereum address of c·pk + s·G, as a 0x-prefixed lowercase hex string. */
  readonly uWitness: Hex;
  readonly cGammaWitness: Pair;
  readonly sHashWitness: Pair;
  readonly zInv: bigint;
}

const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;

const keccak = (...parts: Uint8Array[]) => keccak_256(concatBytes(...parts));

function affine(p: Point): Pair {
  const { x, y } = p.toAffine();
  return [x, y];
}

const pointBytes = (p: Point) => {
  const [x, y] = affine(p);
  return concatBytes(word(x), word(y));
};

/** mul is s·p for any scalar, reduced mod n; 0 gives the point at infinity. */
function mul(p: Point, s: bigint): Point {
  const r = mod(s, N);
  return r === 0n ? Point.ZERO : p.multiply(r);
}

/** fieldHash hashes into the base field by re-hashing until the value is < p. */
function fieldHash(msg: Uint8Array): bigint {
  let x = toBigInt(keccak(msg));
  while (x >= P) x = toBigInt(keccak(word(x)));
  return x;
}

const ySquared = (x: bigint) => mod(x * x * x + 7n, P);
const isSquare = (a: bigint) => Point.Fp.pow(a, (P - 1n) / 2n) === 1n;

/** hashToCurve is VRF.sol's hashToCurve(pk, input): try-and-increment, even y. */
function hashToCurve(pk: Point, alpha: bigint): Point {
  let x = fieldHash(concatBytes(HASH_TO_CURVE_PREFIX, pointBytes(pk), word(alpha)));
  while (!isSquare(ySquared(x))) x = fieldHash(word(x));
  const y = Point.Fp.pow(ySquared(x), (P + 1n) / 4n);
  return Point.fromAffine({ x, y: y % 2n === 0n ? y : P - y });
}

function ethAddress(p: Point): Uint8Array {
  return keccak(pointBytes(p)).slice(12);
}

/**
 * projectiveECAddZ is the z denominator VRF.sol's _projectiveECAdd computes
 * for p + q, whose inverse is the proof's zInv.
 */
export function projectiveECAddZ(p: Point, q: Point): bigint {
  const [px] = affine(p);
  const [qx] = affine(q);
  const lz = mod(qx - px, P);
  const dx = mod(lz * lz, P);
  const dy = mod(dx * lz, P);
  // This follows VRF.sol: z = dx when dx == dy, else dx·dy. It does not follow
  // Go's ProjectiveECAdd (used by SolidityPrecalculations), whose `dx != dy`
  // compares *big.Int pointers and so always gives dx·dy. VRF.sol is the
  // reference because zInv is valid only if it inverts the z the contract
  // computes. The two agree on every input: dx == dy only when lz is 0 or 1,
  // and then dx is 0 or 1, so dx·dy == dx.
  return dx !== dy ? mod(dx * dy, P) : dx;
}

export interface Proven {
  readonly proof: Proof;
  readonly beta: bigint;
}

export function publicKeyOf(secret: bigint): Point {
  return Point.BASE.multiply(secret);
}

/**
 * prove returns the proof of secret's VRF output over alpha, and that output
 * (Beta). The caller must pass a valid secret in [1, n-1].
 */
export function prove(secret: bigint, alpha: bigint): Proven {
  if (alpha < 0n || alpha >= 1n << 256n) throw new RangeError('Alpha must be a 256-bit word');
  const pk = publicKeyOf(secret);
  const h = hashToCurve(pk, alpha);
  const gamma = h.multiply(secret);
  for (let candidate = 0; ; candidate++) {
    const k = nonce(secret, alpha, candidate);
    const uWitness = ethAddress(Point.BASE.multiply(k));
    const v = h.multiply(k);
    const c = toBigInt(
      keccak(SCALAR_FROM_CURVE_POINTS_PREFIX, pointBytes(h), pointBytes(pk), pointBytes(gamma), pointBytes(v), uWitness),
    );
    const s = mod(k - c * secret, N);
    const cGamma = mul(gamma, c);
    const sHash = mul(h, s);
    // VRF.sol rejects this case; like vrfkey, move on to the next k.
    if (cGamma.equals(sHash)) continue;

    const beta = toBigInt(keccak(VRF_RANDOM_OUTPUT_PREFIX, pointBytes(gamma)));
    return {
      proof: {
        pk: affine(pk),
        gamma: affine(gamma),
        c,
        s,
        seed: alpha,
        uWitness: bytesToHex(uWitness),
        cGammaWitness: affine(cGamma),
        sHashWitness: affine(sHash),
        zInv: Point.Fp.inv(projectiveECAddZ(cGamma, sHash)),
      },
      beta,
    };
  }
}

/** keyHashOf is keccak256(abi.encode(uint256[2] pk)), the key's id on-chain. */
export function keyHashOf(pk: Point): KeyHash {
  return bytesToHex(keccak(pointBytes(pk))) as KeyHash;
}

/** encodeProof is abi.encode(VRF.Proof): the 416 bytes fulfill takes. */
export function encodeProof(p: Proof): Uint8Array {
  return concatBytes(
    ...[
      ...p.pk,
      ...p.gamma,
      p.c,
      p.s,
      p.seed,
      BigInt(p.uWitness),
      ...p.cGammaWitness,
      ...p.sHashWitness,
      p.zInv,
    ].map(word),
  );
}
