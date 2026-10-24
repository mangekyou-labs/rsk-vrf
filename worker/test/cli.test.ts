import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type CliDeps, runCli } from '../src/cli.ts';
import { ProvingKey } from '../src/proving-key.ts';
import { type SecretSource, secretName } from '../src/secrets.ts';
import { hexWord } from '../src/vrf/bytes.ts';
import { KEY_HASH, OTHER_SECRET_HEX, SECRET_HEX } from './keys.ts';
import { assertNoSecret } from './secret.ts';

class FakeSecrets implements SecretSource {
  readonly loaded: string[] = [];
  readonly store: Record<string, string>;
  constructor(store: Record<string, string>) {
    this.store = store;
  }
  async load(name: string): Promise<string> {
    this.loaded.push(name);
    const v = this.store[name];
    if (v === undefined) throw new Error(`secret ${name} not found`);
    return v;
  }
}

async function run(argv: string[], opts: { tty?: boolean; secrets?: SecretSource } = {}) {
  let stdout = '';
  let stderr = '';
  const deps: CliDeps = {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    stdoutIsTTY: opts.tty ?? false,
    secrets: () => opts.secrets ?? new FakeSecrets({}),
  };
  const code = await runCli(argv, deps);
  return { code, stdout, stderr };
}

describe('worker keygen', () => {
  it('prints only the new secret on stdout and the public key and keyHash on stderr', async () => {
    const { code, stdout, stderr } = await run(['keygen']);
    assert.equal(code, 0);
    assert.match(stdout, /^0x[0-9a-f]{64}\n$/);
    const key = ProvingKey.fromHex(stdout);
    assert.ok(stderr.includes(`keyHash: ${key.keyHash}`), stderr);
    const [x, y] = key.publicKey.map(hexWord);
    assert.ok(stderr.includes(`publicKey: [${x}, ${y}]`), stderr);
    assertNoSecret(stderr, stdout.trim(), 'stderr');
  });

  it('makes a different key every run', async () => {
    const a = await run(['keygen']);
    const b = await run(['keygen']);
    assert.notEqual(a.stdout, b.stdout);
  });

  it('refuses to print the secret to a terminal', async () => {
    const { code, stdout, stderr } = await run(['keygen'], { tty: true });
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /terminal/);
  });

  it('takes no arguments', async () => {
    const { code, stdout } = await run(['keygen', 'extra']);
    assert.equal(code, 2);
    assert.equal(stdout, '');
  });
});

describe('worker check-key', () => {
  it('loads the secret for keyHash from rsk-vrf/proving-key/<keyHash> and confirms it', async () => {
    const secrets = new FakeSecrets({ [`rsk-vrf/proving-key/${KEY_HASH}`]: `${SECRET_HEX}\n` });
    const { code, stdout, stderr } = await run(['check-key', KEY_HASH], { secrets });
    assert.equal(code, 0, stderr);
    assert.deepEqual(secrets.loaded, [secretName(KEY_HASH)]);
    assert.equal(secretName(KEY_HASH), `rsk-vrf/proving-key/${KEY_HASH}`);
    assert.ok(stdout.includes(KEY_HASH));
    assertNoSecret(stdout + stderr, SECRET_HEX, 'output');
  });

  it('accepts an upper-case keyHash', async () => {
    const secrets = new FakeSecrets({ [`rsk-vrf/proving-key/${KEY_HASH}`]: SECRET_HEX });
    const { code } = await run(['check-key', '0x' + KEY_HASH.slice(2).toUpperCase()], { secrets });
    assert.equal(code, 0);
  });

  it('fails when the secret is for another key, without printing either secret', async () => {
    const secrets = new FakeSecrets({ [`rsk-vrf/proving-key/${KEY_HASH}`]: OTHER_SECRET_HEX });
    const { code, stdout, stderr } = await run(['check-key', KEY_HASH], { secrets });
    assert.equal(code, 1);
    assert.ok(stderr.includes(ProvingKey.fromHex(OTHER_SECRET_HEX).keyHash), stderr);
    assertNoSecret(stdout + stderr, OTHER_SECRET_HEX, 'output');
  });

  it('fails when the secret is malformed, without printing it', async () => {
    const malformed = SECRET_HEX.slice(0, -1) + 'z';
    const secrets = new FakeSecrets({ [`rsk-vrf/proving-key/${KEY_HASH}`]: malformed });
    const { code, stdout, stderr } = await run(['check-key', KEY_HASH], { secrets });
    assert.equal(code, 1);
    assert.ok(!(stdout + stderr).includes(malformed.slice(2, 20)), stderr);
  });

  it('fails when the secret is missing', async () => {
    const { code, stderr } = await run(['check-key', KEY_HASH], { secrets: new FakeSecrets({}) });
    assert.equal(code, 1);
    assert.match(stderr, /not found/);
  });

  it('rejects a malformed keyHash before loading anything', async () => {
    const secrets = new FakeSecrets({});
    for (const argv of [['check-key'], ['check-key', 'abc'], ['check-key', KEY_HASH, KEY_HASH]]) {
      const { code } = await run(argv, { secrets });
      assert.equal(code, 2, argv.join(' '));
    }
    assert.deepEqual(secrets.loaded, []);
  });
});

describe('worker', () => {
  it('prints usage for an unknown command', async () => {
    const { code, stderr } = await run(['bogus']);
    assert.equal(code, 2);
    assert.match(stderr, /usage/i);
  });
});
