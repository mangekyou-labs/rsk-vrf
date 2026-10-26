import { setTimeout } from 'node:timers/promises';

export interface WorkerLoop {
  pollOnce(): Promise<readonly unknown[]>;
  heartbeat(): Promise<void>;
  signal: AbortSignal;
  report(line: string): void;
  nowMilliseconds?: () => number;
  sleep?: () => Promise<void>;
}

/** A heartbeat certifies progress through the poll, never just a running timer. */
export async function runWorkerLoop(config: WorkerLoop): Promise<void> {
  const now = config.nowMilliseconds ?? Date.now;
  const sleep = config.sleep ?? (() => setTimeout(10_000, undefined, { signal: config.signal }));
  let lastHeartbeat = -Infinity;
  while (!config.signal.aborted) {
    try {
      const results = await config.pollOnce();
      for (const result of results) config.report(JSON.stringify({ event: 'poll_result', result }));
      if (!config.signal.aborted && now() - lastHeartbeat >= 60_000) {
        await config.heartbeat();
        lastHeartbeat = now();
      }
    } catch {
      config.report(JSON.stringify({ level: 'warn', event: 'poll_failed' }));
    }
    if (!config.signal.aborted) {
      try { await sleep(); } catch { /* shutdown */ }
    }
  }
}
