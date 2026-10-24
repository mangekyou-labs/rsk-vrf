// Helpers for asserting that a Proving Key's secret does not leak.
import assert from 'node:assert/strict';

/** forms are the ways a secret could show up in text. */
export function forms(secretHex: string): string[] {
  const n = BigInt(secretHex);
  const hex = n.toString(16).padStart(64, '0');
  return [hex, hex.toUpperCase(), n.toString(16), n.toString(10), Buffer.from(hex, 'hex').toString('base64')];
}

export function assertNoSecret(text: string, secretHex: string, what: string) {
  for (const form of forms(secretHex)) {
    assert.ok(!text.toLowerCase().includes(form.toLowerCase()), `${what} contains the secret (${form.slice(0, 6)}...)`);
  }
}

/** errorText is everything an error could print: message, stack, and cause chain. */
export function errorText(err: unknown): string {
  const parts: string[] = [];
  for (let e = err, depth = 0; e !== undefined && depth < 10; depth++) {
    if (e instanceof Error) {
      parts.push(String(e.message), String(e.stack));
      e = e.cause;
    } else {
      parts.push(String(e));
      break;
    }
  }
  return parts.join('\n');
}
