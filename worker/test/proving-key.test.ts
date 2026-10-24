import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { format, inspect } from 'node:util';

import { ProvingKey } from '../src/proving-key.ts';
import { assertNoSecret, errorText } from './secret.ts';
import { vectors } from './vectors.ts';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const hex64 = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

const secretHex = vectors[0]!.secretKey;

describe('ProvingKey secrecy', () => {
  const key = ProvingKey.fromHex(secretHex);

  const renderings: Record<string, () => string> = {
    String: () => String(key),
    template: () => `${key}`,
    'JSON.stringify': () => JSON.stringify(key),
    'JSON.stringify in an object': () => JSON.stringify({ key }),
    inspect: () => inspect(key, { showHidden: true, depth: Infinity, getters: true }),
    'console format %o': () => format('%o', key),
    'console format %O / %j / %s': () => format('%O %j %s', key, key, key),
    'Object.entries': () => JSON.stringify(Object.entries(key), (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    structuredClone: () => inspect(structuredClone(key), { showHidden: true, depth: Infinity }),
  };
  for (const [name, render] of Object.entries(renderings)) {
    it(`never renders the secret via ${name}`, () => {
      const text = render();
      assertNoSecret(text, secretHex, name);
    });
  }

  it('renders as its keyHash', () => {
    assert.ok(String(key).includes(key.keyHash));
    assert.ok(inspect(key).includes(key.keyHash));
  });

  it('never puts the secret in the console output', (t) => {
    const lines: string[] = [];
    for (const method of ['log', 'error', 'warn', 'info', 'debug', 'dir'] as const) {
      t.mock.method(console, method, (...args: unknown[]) => lines.push(format(...args)));
      console[method](key);
    }
    assert.equal(lines.length, 6);
    assertNoSecret(lines.join('\n'), secretHex, 'console');
  });
});

describe('ProvingKey.fromHex', () => {
  it('accepts 0x and 64 hex digits, with surrounding whitespace', () => {
    assert.equal(ProvingKey.fromHex(`  ${secretHex}\n`).keyHash, ProvingKey.fromHex(secretHex).keyHash);
    assert.equal(ProvingKey.fromHex(secretHex.toUpperCase().replace('0X', '0x')).keyHash, ProvingKey.fromHex(secretHex).keyHash);
  });

  const bad: Record<string, string> = {
    'no 0x prefix': secretHex.slice(2),
    'too short': secretHex.slice(0, -1),
    'too long': secretHex + '0',
    'non-hex digit': secretHex.slice(0, -1) + 'g',
    decimal: BigInt(secretHex).toString(10),
    zero: hex64(0n),
    'group order': hex64(N),
    'above group order': hex64(N + 1n),
    'two keys': `${secretHex} ${secretHex}`,
  };
  for (const [name, text] of Object.entries(bad)) {
    it(`rejects ${name} without echoing the input`, () => {
      let caught: unknown;
      try {
        ProvingKey.fromHex(text);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof Error, 'expected an error');
      const leaked = errorText(caught);
      assertNoSecret(leaked, secretHex, 'error');
      if (/[0-9a-f]{8}/i.test(text)) assert.ok(!leaked.includes(text.trim().slice(2, 18)), 'error echoes the input');
    });
  }
});

describe('ProvingKey.generate', () => {
  it('makes a fresh valid key each time, recoverable from its secret', () => {
    const a = ProvingKey.generate();
    const b = ProvingKey.generate();
    assert.notEqual(a.keyHash, b.keyHash);
    const secret = a.revealSecretHex();
    assert.match(secret, /^0x[0-9a-f]{64}$/);
    assert.equal(ProvingKey.fromHex(secret).keyHash, a.keyHash);
  });
});
