// The Proving Key: the oracle's secp256k1 VRF secret, held only in memory.
import { type Hex, type Pair, type Proven, keyHashOf, prove, publicKeyOf } from './vrf/prover.ts';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

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

  /** fromHex parses a secret written as 0x and 64 hex digits. */
  static fromHex(text: string): ProvingKey {
    const secret = BigInt(text);
    if (secret < 1n || secret >= N) throw new Error('invalid Proving Key');
    return new ProvingKey(secret);
  }

  /** prove returns the proof over alpha and its Beta. */
  prove(alpha: bigint): Proven {
    return prove(this.#secret, alpha);
  }
}
