import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { N } from '../src/vrf/curve.ts';
import { nonce } from '../src/vrf/nonce.ts';
import { vectors } from './vectors.ts';

const sha256 = (msg: string) => BigInt('0x' + createHash('sha256').update(msg).digest('hex'));

describe('nonce', () => {
  // The widely used secp256k1 / HMAC-SHA256 RFC 6979 vectors, h1 = SHA-256(message).
  const known = [
    { sk: 1n, msg: 'Satoshi Nakamoto', k: 0x8f8a276c19f4149656b280621e358cce24f5f52542772691ee69063b74f15d15n },
    {
      sk: 1n,
      msg: 'All those moments will be lost in time, like tears in rain. Time to die...',
      k: 0x38aa22d72376b4dbc472e06c3ba403ee0a394da63fc58d88686c611aba98d6b3n,
    },
    { sk: N - 1n, msg: 'Satoshi Nakamoto', k: 0x33a19b60e25fb6f4435af53a3d42d493644827367e6453928554f43e49aa6f90n },
  ];
  for (const { sk, msg, k } of known) {
    it(`is RFC 6979 for sk=${sk === 1n ? '1' : 'n-1'}, "${msg.slice(0, 16)}..."`, () => {
      assert.equal(nonce(sk, sha256(msg)), k);
    });
  }

  it('matches the k of every Go vector', () => {
    for (const v of vectors) {
      assert.equal(nonce(BigInt(v.secretKey), BigInt(v.proof.seed)), BigInt(v.k), v.name);
    }
  });

  it('never gives two distinct Alphas the same k, for any of several keys', () => {
    const keys = [...new Set([1n, 2n, N - 1n, ...vectors.map((v) => BigInt(v.secretKey))])];
    const max = (1n << 256n) - 1n;
    const alphas = [0n, 1n, 2n, N - 1n, N, N + 1n, max - 1n, max];
    // Alphas that differ by n stay distinct: Alpha is not reduced mod n.
    for (let i = 0n; i < 64n; i++) alphas.push(i * 0x9e3779b97f4a7c15f39cc0605cedc834n, i + N);
    for (let i = 0; i < 200; i++) {
      alphas.push(BigInt('0x' + createHash('sha256').update(`alpha-${i}`).digest('hex')));
    }
    const distinct = [...new Set(alphas)];
    // No k repeats across any (key, Alpha) pair either.
    const ks = new Set(keys.flatMap((sk) => distinct.map((alpha) => nonce(sk, alpha))));
    assert.equal(ks.size, keys.length * distinct.length);
  });

  it('is always a valid scalar', () => {
    for (const v of vectors) {
      const k = nonce(BigInt(v.secretKey), BigInt(v.proof.seed));
      assert.ok(k > 0n && k < N, v.name);
    }
  });
});
