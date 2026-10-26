import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertNoSecret } from './secret.ts';

const startup = '{"level":"error","event":"startup_failed","message":"Check configuration, RPC and Secrets Manager access"}\n';
const pinWord = `0x${'ab'.repeat(32)}`;
const fulfillerKey = `0x${'22'.repeat(32)}`;

function runWorker(env: Record<string, string | undefined>) {
  const child = spawn(process.execPath, ['src/run.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { PATH: process.env.PATH, WORKER_ID: 'test', ALERT_PAGE_URL: 'http://127.0.0.1:1/page', ALERT_WARNING_URL: 'http://127.0.0.1:1/warn', HEALTHCHECKS_PING_URL: 'http://127.0.0.1:1/heartbeat', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  return once(child, 'exit').then(([code]) => ({ code, stdout, stderr }));
}

describe('worker run', () => {
  it('refuses to start without a drand pin and does not print configuration', async () => {
    const { code, stdout, stderr } = await runWorker({
      RSK_RPC_URL: 'http://127.0.0.1:1',
      COORDINATOR_ADDRESS: `0x${'11'.repeat(20)}`,
      FULFILLER_PRIVATE_KEY: fulfillerKey,
    });
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.equal(stderr, startup);
    assertNoSecret(stderr + stdout, fulfillerKey, 'startup');
  });

  it('a bad pin or a dead RPC still prints only the generic startup line', async () => {
    const pinned = await runWorker({
      RSK_RPC_URL: 'http://127.0.0.1:1',
      COORDINATOR_ADDRESS: `0x${'11'.repeat(20)}`,
      FULFILLER_PRIVATE_KEY: fulfillerKey,
      DRAND_PIN_PUBLIC_KEY: [pinWord, pinWord, pinWord, pinWord].join(','),
      DRAND_PIN_GENESIS: '1727521075',
      DRAND_PIN_PERIOD: '3',
    });
    assert.equal(pinned.code, 1);
    assert.equal(pinned.stdout, '');
    assert.equal(pinned.stderr, startup);
    assertNoSecret(pinned.stderr + pinned.stdout, pinWord, 'startup');
    assertNoSecret(pinned.stderr + pinned.stdout, fulfillerKey, 'startup');

    const zeroPeriod = await runWorker({
      DRAND_PIN_PUBLIC_KEY: [pinWord, pinWord, pinWord, pinWord].join(','),
      DRAND_PIN_GENESIS: '1727521075',
      DRAND_PIN_PERIOD: '0',
      FULFILLER_PRIVATE_KEY: fulfillerKey,
    });
    assert.equal(zeroPeriod.code, 1);
    assert.equal(zeroPeriod.stderr, startup);
    assertNoSecret(zeroPeriod.stderr, pinWord, 'startup');
  });

  it('refuses a non-numeric grace and does not print configuration', async () => {
    const { code, stdout, stderr } = await runWorker({
      RSK_RPC_URL: 'http://127.0.0.1:1',
      COORDINATOR_ADDRESS: `0x${'11'.repeat(20)}`,
      FULFILLER_PRIVATE_KEY: fulfillerKey,
      DRAND_PIN_PUBLIC_KEY: [pinWord, pinWord, pinWord, pinWord].join(','),
      DRAND_PIN_GENESIS: '1727521075',
      DRAND_PIN_PERIOD: '3',
      GRACE_BLOCKS: '100 blocks',
    });
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.equal(stderr, startup);
    assertNoSecret(stderr + stdout, fulfillerKey, 'startup');
    assertNoSecret(stderr + stdout, pinWord, 'startup');
  });
});
