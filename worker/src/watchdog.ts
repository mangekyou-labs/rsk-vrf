import type { Address } from 'viem';

export interface WatchdogConfig {
  /** Full private ntfy topic URL. */
  pageUrl: string;
  pageToken?: string;
  warningUrl: string;
  workerId: string;
  /** Warn below this many maximum-cap fulfillments; default 100. */
  topUpFulfillments?: bigint;
  /** Include both the primary and Backup Worker's Fulfillers. */
  allowedFulfillers?: readonly Address[];
}

export function jsonLine(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
}

/** Delivers independently in each process. Failed delivery remains retryable. */
export function createWatchdog(config: WatchdogConfig | undefined, report: (line: string) => void) {
  const delivered = new Set<string>();
  const logged = new Set<string>();
  return {
    clear(id: string) { delivered.delete(id); logged.delete(id); },
    async alert(level: 'page' | 'warn', event: string, fields: Record<string, unknown> = {}, id = event): Promise<boolean> {
      const alert = { level, event, workerId: config?.workerId ?? 'worker', ...fields };
      const line = jsonLine(alert);
      if (!logged.has(id)) { report(line); logged.add(id); }
      if (!config || delivered.has(id)) return true;
      try {
        const headers: Record<string, string> = level === 'page'
          ? { 'Content-Type': 'text/plain', Title: `VRF ${event}`, Priority: 'urgent' }
          : { 'Content-Type': 'application/json' };
        if (level === 'page' && config.pageToken) headers.Authorization = `Bearer ${config.pageToken}`;
        const response = await fetch(level === 'page' ? config.pageUrl : config.warningUrl, {
          method: 'POST', headers, body: level === 'page' ? line : JSON.stringify({ text: line }),
          signal: AbortSignal.timeout(5_000), redirect: 'error',
        });
        if (!response.ok) throw new Error('Alert delivery failed');
        delivered.add(id);
        return true;
      } catch {
        report(jsonLine({ level: 'warn', event: 'alert_delivery_failed', workerId: config.workerId, alert: event }));
        return false;
      }
    },
  };
}
