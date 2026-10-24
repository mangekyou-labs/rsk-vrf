// The prover's deterministic nonce: RFC 6979 section 3.2 with HMAC-SHA256 over
// the Proving Key's secret and Alpha.
//
// One deliberate departure from RFC 6979: Alpha goes in as its raw 32 bytes,
// not reduced mod n (bits2octets). Reducing would give Alpha and Alpha + n the
// same k, and VRF.sol accepts any 256-bit Alpha; two proofs with one k and
// different c reveal the Proving Key. Unreduced, distinct Alphas always seed
// the DRBG differently. This matches decred's NonceRFC6979, which the Go
// vectors use.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';

import { toBigInt, word } from './bytes.ts';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * nonce returns the candidate-th valid k (counting from 0) of the RFC 6979
 * HMAC-SHA256 DRBG seeded with secret ‖ alpha. The prover only moves past
 * candidate 0 if c·gamma = s·hash, which never happens in practice.
 */
export function nonce(secret: bigint, alpha: bigint, candidate = 0): bigint {
  const x = word(secret);
  const h = word(alpha);
  let v = new Uint8Array(32).fill(1);
  let k = new Uint8Array(32);
  try {
    k = hmac(sha256, k, concatBytes(v, Uint8Array.of(0), x, h));
    v = hmac(sha256, k, v);
    k = hmac(sha256, k, concatBytes(v, Uint8Array.of(1), x, h));
    v = hmac(sha256, k, v);
    for (let found = 0; ; ) {
      v = hmac(sha256, k, v);
      const t = toBigInt(v);
      if (t >= 1n && t < N) {
        if (found === candidate) return t;
        found++;
      }
      k = hmac(sha256, k, concatBytes(v, Uint8Array.of(0)));
      v = hmac(sha256, k, v);
    }
  } finally {
    x.fill(0);
    k.fill(0);
  }
}
