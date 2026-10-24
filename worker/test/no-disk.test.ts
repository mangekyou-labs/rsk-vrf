// The Proving Key never reaches disk: run the real CLI in a child process
// whose fs write paths are trapped, with HOME, TMPDIR and cwd pointed at empty
// directories, and check nothing was written or attempted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { KEY_HASH, SECRET_HEX } from './keys.ts';
import { assertNoSecret } from './secret.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const TRAP = here('./fixtures/trap-disk-writes.ts');
const MAIN = here('../src/main.ts');
const CHECK_KEY = here('./fixtures/check-key-main.ts');
const MARK = 'DISK-WRITE-ATTEMPT';

const sandboxes: string[] = [];
after(() => sandboxes.forEach((d) => rmSync(d, { recursive: true, force: true })));

function runTrapped(entry: string, argv: string[], env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'worker-no-disk-'));
  sandboxes.push(root);
  const [home, tmp, cwd] = ['home', 'tmp', 'cwd'].map((name) => join(root, name)) as [string, string, string];
  for (const d of [home, tmp, cwd]) mkdirSync(d);
  const result = spawnSync(process.execPath, ['--import', TRAP, entry, ...argv], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: tmp, ...env },
    encoding: 'utf8',
  });
  const written = [home, tmp, cwd].flatMap((d) => readdirSync(d).map((n) => join(d, n)));
  return { ...result, written };
}

describe('the Proving Key never reaches disk', () => {
  it('the trap catches a write (control)', () => {
    const r = runTrapped(here('./fixtures/writes-a-file.ts'), []);
    assert.ok(r.stderr.includes(MARK), r.stderr);
    assert.deepEqual(r.written, []);
  });

  it('keygen writes nothing to disk', () => {
    const r = runTrapped(MAIN, ['keygen']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stderr.includes(MARK), r.stderr);
    assert.deepEqual(r.written, []);
    const secret = r.stdout.trim();
    assert.match(secret, /^0x[0-9a-f]{64}$/);
    assertNoSecret(r.stderr, secret, 'stderr');
  });

  it('check-key writes nothing to disk and prints no secret', () => {
    const r = runTrapped(CHECK_KEY, ['check-key', KEY_HASH], { TEST_PROVING_KEY: SECRET_HEX });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stderr.includes(MARK), r.stderr);
    assert.deepEqual(r.written, []);
    assertNoSecret(r.stdout + r.stderr, SECRET_HEX, 'output');
  });
});
