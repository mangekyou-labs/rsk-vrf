// secp256k1 constants.
import { secp256k1 } from '@noble/curves/secp256k1.js';

/** P is the order of the base field. */
export const P = secp256k1.Point.Fp.ORDER;
/** N is the order of the group: secrets and nonces are in [1, N-1]. */
export const N = secp256k1.Point.Fn.ORDER;
