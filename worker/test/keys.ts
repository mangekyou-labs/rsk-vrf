// Test Proving Keys taken from the Go vectors, shared by the test files.
import { ProvingKey } from '../src/proving-key.ts';
import { vectors } from './vectors.ts';

/** SECRET_HEX is the secret of the first vector's Proving Key. */
export const SECRET_HEX = vectors[0]!.secretKey;
/** OTHER_SECRET_HEX is the secret of a different vector key. */
export const OTHER_SECRET_HEX = vectors.find((v) => v.secretKey !== SECRET_HEX)!.secretKey;
/** KEY_HASH is SECRET_HEX's keyHash. */
export const KEY_HASH = ProvingKey.fromHex(SECRET_HEX).keyHash;
