import { setTimeout } from 'node:timers/promises';

/** Delay between polls when POLL_INTERVAL_MS is unset: ten seconds. */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

/**
 * Parses POLL_INTERVAL_MS: unset or empty keeps the default, anything else
 * must be a positive whole number of milliseconds.
 */
export function parsePollIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_POLL_INTERVAL_MS;
  if (!/^\d+$/.test(raw)) throw new Error('Invalid poll interval');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid poll interval');
  return value;
}

export interface WorkerLoop {
  pollOnce(): Promise<readonly unknown[]>;
  heartbeat(): Promise<void>;
  signal: AbortSignal;
  report(line: string): void;
  nowMilliseconds?: () => number;
  /** Delay between polls. Defaults to DEFAULT_POLL_INTERVAL_MS. */
  pollIntervalMs?: number;
  sleep?: (intervalMs: number) => Promise<void>;
}

/** A heartbeat certifies progress through the poll, never just a running timer. */
export async function runWorkerLoop(config: WorkerLoop): Promise<void> {
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('Invalid poll interval');
  const now = config.nowMilliseconds ?? Date.now;
  const sleep = config.sleep ?? ((intervalMs: number) => setTimeout(intervalMs, undefined, { signal: config.signal }));
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
      try { await sleep(pollIntervalMs); } catch { /* shutdown */ }
    }
  }
}
