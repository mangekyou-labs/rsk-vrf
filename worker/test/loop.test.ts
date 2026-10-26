import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runWorkerLoop } from '../src/loop.ts';

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

it('does not heartbeat after a failed poll', async () => {
  const stop = new AbortController();
  let pings = 0;
  await runWorkerLoop({
    pollOnce: async () => { stop.abort(); throw new Error('RPC unavailable'); },
    heartbeat: async () => { pings++; }, signal: stop.signal, report: () => {},
  });
  assert.equal(pings, 0);
});
