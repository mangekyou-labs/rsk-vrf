// Types shared across the worker.

/** Hex is a 0x-prefixed hex string. */
export type Hex = `0x${string}`;

/**
 * KeyHash is keccak256(abi.encode(publicKey)), a Proving Key's id in the Key
 * Registry, as 0x and 64 lowercase hex digits. Make one with parseKeyHash or
 * keyHashOf; the brand keeps any other Hex from passing for it.
 */
export type KeyHash = Hex & { readonly __brand: 'KeyHash' };

const KEY_HASH = /^0x[0-9a-fA-F]{64}$/;

/** parseKeyHash reads 0x and 64 hex digits, in either case, as a KeyHash. */
export function parseKeyHash(text: string): KeyHash | undefined {
  return KEY_HASH.test(text) ? (text.toLowerCase() as KeyHash) : undefined;
}
