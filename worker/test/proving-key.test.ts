import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { format, inspect } from 'node:util';

import { ProvingKey } from '../src/proving-key.ts';
import { hexWord } from '../src/vrf/bytes.ts';
import { N } from '../src/vrf/curve.ts';
import { SECRET_HEX } from './keys.ts';
import { assertNoSecret, errorText } from './secret.ts';

describe('ProvingKey secrecy', () => {
  const key = ProvingKey.fromHex(SECRET_HEX);

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
      assertNoSecret(text, SECRET_HEX, name);
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
    assertNoSecret(lines.join('\n'), SECRET_HEX, 'console');
  });
});

describe('ProvingKey.fromHex', () => {
  it('accepts 0x and 64 hex digits, with surrounding whitespace', () => {
    assert.equal(ProvingKey.fromHex(`  ${SECRET_HEX}\n`).keyHash, ProvingKey.fromHex(SECRET_HEX).keyHash);
    assert.equal(ProvingKey.fromHex(SECRET_HEX.toUpperCase().replace('0X', '0x')).keyHash, ProvingKey.fromHex(SECRET_HEX).keyHash);
  });

  const bad: Record<string, string> = {
    'no 0x prefix': SECRET_HEX.slice(2),
    'too short': SECRET_HEX.slice(0, -1),
    'too long': SECRET_HEX + '0',
    'non-hex digit': SECRET_HEX.slice(0, -1) + 'g',
    decimal: BigInt(SECRET_HEX).toString(10),
    zero: hexWord(0n),
    'group order': hexWord(N),
    'above group order': hexWord(N + 1n),
    'two keys': `${SECRET_HEX} ${SECRET_HEX}`,
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
      assertNoSecret(leaked, SECRET_HEX, 'error');
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
