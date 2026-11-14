// RPC hygiene for the demo scripts: keyed RPC URLs stay out of their output, and a long
// wait outlasts a flaky RPC. Testnet pilot, not externally audited.

/** Replaces each URL in text. A keyed RPC URL is a secret, and viem errors quote the URL. */
export function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/g, '<redacted-url>');
}

const TRANSIENT_ERRORS = new Set(['HttpRequestError', 'TimeoutError', 'LimitExceededRpcError']);

/** An error the next poll may not repeat: the RPC was unreachable, timed out or rate-limited it. */
function transient(error: unknown): boolean {
  for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
    if (TRANSIENT_ERRORS.has((cause as { name?: string }).name ?? '')) return true;
    if (/fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test((cause as { message?: string }).message ?? '')) return true;
  }
  return false;
}

/**
 * Calls `attempt` up to `tries` times, with `pause` between calls, until it returns a value.
 * A transient RPC error or an undefined result (a read the node has not caught up on yet)
 * costs a try; any other error is thrown at once. When the tries run out it throws the last
 * transient error, or `<what> after <tries> tries`.
 */
export async function retrying<T>(attempt: () => Promise<T | undefined>, pause: () => Promise<unknown>, tries: number, what: string): Promise<T> {
  for (let n = 1; ; n++) {
    let value: T | undefined;
    try {
      value = await attempt();
    } catch (error) {
      if (!transient(error) || n >= tries) throw error;
    }
    if (value !== undefined) return value;
    if (n >= tries) throw new Error(`${what} after ${tries} tries`);
    await pause();
  }
}
