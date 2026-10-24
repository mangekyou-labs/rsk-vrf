// Big-endian 256-bit words, the encoding VRF.sol hashes and abi-encodes.
import type { Hex } from '../types.ts';

/** HEX_WORD matches a word written as 0x and 64 hex digits, in either case. */
export const HEX_WORD = /^0x[0-9a-fA-F]{64}$/;

/** word is n as a 32-byte big-endian word. */
export function word(n: bigint): Uint8Array {
  if (n < 0n || n >= 1n << 256n) throw new RangeError('value does not fit in a 256-bit word');
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** hexWord is n as a word written as 0x and 64 lowercase hex digits. */
export function hexWord(n: bigint): Hex {
  if (n < 0n || n >= 1n << 256n) throw new RangeError('value does not fit in a 256-bit word');
  return `0x${n.toString(16).padStart(64, '0')}`;
}

/** bytesToHex is bytes as 0x and lowercase hex digits. */
export function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

/** toBigInt reads bytes as a big-endian unsigned integer. */
export function toBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
