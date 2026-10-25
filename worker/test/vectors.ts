// The proof vectors tools/vrf-vectors-go generates with Chainlink's vrfkey.
import { readFileSync } from 'node:fs';

type Hex = `0x${string}`;

export interface Vector {
  name: string;
  secretKey: Hex;
  k: Hex;
  hashToCurveTries: number;
  hash: [Hex, Hex];
  proof: {
    pk: [Hex, Hex];
    gamma: [Hex, Hex];
    c: Hex;
    s: Hex;
    seed: Hex;
    uWitness: Hex;
    cGammaWitness: [Hex, Hex];
    sHashWitness: [Hex, Hex];
    zInv: Hex;
  };
  proofBytes: Hex;
  output: Hex;
}

const file = new URL('../../tools/vrf-vectors-go/vrf-proofs.json', import.meta.url);

export const vectors: Vector[] = JSON.parse(readFileSync(file, 'utf8')).vectors;
