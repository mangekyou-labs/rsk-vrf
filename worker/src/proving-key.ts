// The Proving Key: the oracle's secp256k1 VRF secret, held only in memory.
//
// The secret lives in a #private field, so nothing that walks the object
// (inspect, JSON, structuredClone, a logger) can reach it, and every way of
// rendering a ProvingKey shows only its keyHash. Errors never quote the input
// they reject. The one way out is revealSecretHex, which only keygen calls.
import { secp256k1 } from '@noble/curves/secp256k1.js';

import { toBigInt } from './vrf/bytes.ts';
import { type Hex, type Pair, type Proven, keyHashOf, prove, publicKeyOf } from './vrf/prover.ts';

const N = secp256k1.Point.Fn.ORDER;
const SECRET_HEX = /^0x[0-9a-fA-F]{64}$/;

export class InvalidProvingKeyError extends Error {
  override name = 'InvalidProvingKeyError';
}

export class ProvingKey {
  readonly #secret: bigint;
  /** The registered public key, (x, y). */
  readonly publicKey: Pair;
  /** keccak256(abi.encode(publicKey)), the key's id in the Key Registry. */
  readonly keyHash: Hex;

  private constructor(secret: bigint) {
    this.#secret = secret;
    const pk = publicKeyOf(secret);
    const { x, y } = pk.toAffine();
    this.publicKey = [x, y];
    this.keyHash = keyHashOf(pk);
  }

  /** generate makes a new Proving Key from the system CSPRNG. */
  static generate(): ProvingKey {
    const bytes = secp256k1.utils.randomSecretKey();
    try {
      return new ProvingKey(toBigInt(bytes));
    } finally {
      bytes.fill(0);
    }
  }

  /**
   * fromHex parses a secret written as 0x and 64 hex digits, ignoring
   * surrounding whitespace. It must be in [1, n-1].
   */
  static fromHex(text: string): ProvingKey {
    const trimmed = text.trim();
    // The checks never pass the input to anything that might quote it.
    if (!SECRET_HEX.test(trimmed)) throw new InvalidProvingKeyError('Proving Key must be 0x and 64 hex digits');
    const secret = BigInt(trimmed);
    if (secret < 1n || secret >= N) throw new InvalidProvingKeyError('Proving Key is not a valid secp256k1 secret');
    return new ProvingKey(secret);
  }

  /** prove returns the proof over alpha and its Beta. */
  prove(alpha: bigint): Proven {
    return prove(this.#secret, alpha);
  }

  /** revealSecretHex returns the secret. Only keygen may call it. */
  revealSecretHex(): Hex {
    return `0x${this.#secret.toString(16).padStart(64, '0')}`;
  }

  toString(): string {
    return `ProvingKey(${this.keyHash})`;
  }

  toJSON(): { keyHash: Hex } {
    return { keyHash: this.keyHash };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }
}
