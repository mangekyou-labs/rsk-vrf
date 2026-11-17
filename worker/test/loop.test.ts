import assert from 'node:assert/strict';
import { it } from 'node:test';
import { DEFAULT_POLL_INTERVAL_MS, parsePollIntervalMs, runWorkerLoop } from '../src/loop.ts';

it('heartbeats follow completed polls and stop while a poll is stalled', async () => {
  const stop = new AbortController();
  let clock = 0;
  let polls = 0;
  const pings: number[] = [];
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  const running = runWorkerLoop({
    pollOnce: async () => { polls++; if (polls === 3) await stalled; return []; },
    heartbeat: async () => { pings.push(clock); },
    signal: stop.signal,
    nowMilliseconds: () => clock,
    sleep: async () => { clock += 60_000; },
    report: () => {},
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(polls, 3);
  assert.deepEqual(pings, [0, 60_000]);
  clock += 300_000;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pings, [0, 60_000]);
  stop.abort();
  release();
  await running;
  assert.deepEqual(pings, [0, 60_000]);
});

it('parses the poll interval, defaulting to ten seconds', () => {
  assert.equal(DEFAULT_POLL_INTERVAL_MS, 10_000);
  assert.equal(parsePollIntervalMs(undefined), 10_000);
  assert.equal(parsePollIntervalMs(''), 10_000);
  assert.equal(parsePollIntervalMs('60000'), 60_000);
  assert.equal(parsePollIntervalMs('250'), 250);
  for (const raw of ['0', '-1000', '1.5', '10 seconds', ' 1000', '1000 ']) {
    assert.throws(() => parsePollIntervalMs(raw), /Invalid poll interval/, raw);
  }
});

it('sleeps for the configured poll interval between polls', async () => {
  const stop = new AbortController();
  const sleeps: number[] = [];
  let polls = 0;
  await runWorkerLoop({
    pollOnce: async () => { polls++; if (polls === 3) stop.abort(); return []; },
    heartbeat: async () => {},
    signal: stop.signal,
    pollIntervalMs: 60_000,
    sleep: async ms => { sleeps.push(ms); },
    report: () => {},
  });
  assert.deepEqual(sleeps, [60_000, 60_000]);
});

it('sleeps for the default poll interval when none is configured', async () => {
  const stop = new AbortController();
  const sleeps: number[] = [];
  let polls = 0;
  await runWorkerLoop({
    pollOnce: async () => { polls++; if (polls === 2) stop.abort(); return []; },
    heartbeat: async () => {},
    signal: stop.signal,
    sleep: async ms => { sleeps.push(ms); },
    report: () => {},
  });
  assert.deepEqual(sleeps, [10_000]);
});

it('does not heartbeat after a failed poll', async () => {
  const stop = new AbortController();
  let pings = 0;
  await runWorkerLoop({
    pollOnce: async () => { stop.abort(); throw new Error('RPC unavailable'); },
    heartbeat: async () => { pings++; }, signal: stop.signal, report: () => {},
  });
  assert.equal(pings, 0);
});
