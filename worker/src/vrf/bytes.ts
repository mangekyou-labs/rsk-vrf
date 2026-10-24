// Big-endian 256-bit words, the encoding VRF.sol hashes and abi-encodes.

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

/** toBigInt reads bytes as a big-endian unsigned integer. */
export function toBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
