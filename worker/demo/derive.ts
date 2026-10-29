// The demo scripts' own Alpha, Beta and keyHash derivation, as the coordinator does it,
// without the worker's code. Testnet pilot, not externally audited; do not use for value.
import { concat, encodeAbiParameters, keccak256, pad, sha256, stringToHex, toHex, type Address, type Hex } from 'viem';

/** A drand BLS signature on BN254, as fulfill takes it. */
export type Signature = readonly [bigint, bigint];

/** A uint256 as one 32-byte ABI word. */
export const word = (n: bigint) => pad(toHex(n), { size: 32 });

const DOMAIN_ALPHA = keccak256(stringToHex('rsk-vrf/v1/alpha'));
const DOMAIN_BETA = keccak256(stringToHex('rsk-vrf/v1/beta'));

/**
 * Alpha as the coordinator builds it: keccak256(abi.encode("rsk-vrf/v1/alpha" domain,
 * chainId, coordinator, requester, requestId, targetRound, sha256(drand signature))).
 */
export function alphaOf(input: { chainId: number; coordinator: Address; requester: Address; requestId: Hex; targetRound: bigint; signature: Signature }): Hex {
  const randomness = sha256(concat([word(input.signature[0]), word(input.signature[1])]));
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint64' }, { type: 'bytes32' }],
    [DOMAIN_ALPHA, BigInt(input.chainId), input.coordinator, input.requester, input.requestId, input.targetRound, randomness],
  ));
}

/** Beta from the ECVRF output: keccak256(abi.encode("rsk-vrf/v1/beta" domain, output)). */
export function betaOf(output: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [DOMAIN_BETA, output]));
}

/** The keyHash the coordinator registers for a Proving Key's public key. */
export function keyHashOf(pk: readonly [bigint, bigint]): Hex {
  return keccak256(concat([word(pk[0]), word(pk[1])]));
}
