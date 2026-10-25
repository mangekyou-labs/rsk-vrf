// The coordinator's ABI and input composition. This is the same domain-bound
// Alpha/Beta encoding as the Go-generated coordinator vectors and Solidity.
import { createHash } from 'node:crypto';

import { encodeAbiParameters, hexToBigInt, keccak256, parseAbi, stringToHex, type Address, type Hex } from 'viem';

import type { ProvingKey } from './proving-key.ts';

export const coordinatorAbi = parseAbi([
  'struct Request { address requester; uint8 status; uint32 callbackGasCap; uint48 requestBlock; uint8 drandConfigId; uint96 fee; uint64 targetRound; uint48 deadline; uint16 confirmations; uint32 keyId; bytes32 beta; }',
  'struct Proof { uint256[2] pk; uint256[2] gamma; uint256 c; uint256 s; uint256 seed; address uWitness; uint256[2] cGammaWitness; uint256[2] sHashWitness; uint256 zInv; }',
  'struct DrandConfig { uint256[4] publicKey; uint64 genesis; uint64 period; }',
  'function getRequest(bytes32 requestId) view returns (Request)',
  'function getDrandConfig(uint8 drandConfigId) view returns (DrandConfig)',
  'function getProvingKey(uint32 keyId) view returns (bytes32 keyHash, address payee, uint8 state, uint48 drainingSince)',
  'function activeKeyId() view returns (uint32)',
  'function fulfill(bytes32 requestId, Proof proof, uint256[2] drandSignature)',
  'function request(bytes32 tag) payable returns (bytes32)',
  'function fee() view returns (uint96)',
  'function payeeBalance(address payee) view returns (uint256)',
  'function setFeeConfig(uint256 amount)',
  'function timeoutRefund(bytes32 requestId)',
  'function withdrawFees()',
  'function registerProvingKey(uint256[2] publicKey, address payee) returns (uint32)',
  'function deriveRandom(bytes32 requestId, bytes32 context) view returns (uint256)',
  'event RandomnessRequested(bytes32 indexed requestId, address indexed requester, bytes32 tag, uint32 keyId, uint64 targetRound, uint48 requestBlock, uint48 deadline, uint96 fee, uint32 callbackGasCap)',
  'event Fulfilled(bytes32 indexed requestId, bytes32 beta, address indexed fulfiller)',
  'event Refunded(bytes32 indexed requestId, uint8 reason)',
  'event FeesWithdrawn(address indexed payee, uint256 amount)',
  'event KeyStateChanged(uint32 keyId, uint8 state)',
]);

/** The coordinator's KeyState ordinals. Retired is never stored; getProvingKey derives it. */
export const KeyState = { None: 0, Active: 1, Draining: 2, Revoked: 3, Retired: 4 } as const;

/** servesKey: only Active and Draining keys may fulfill. */
export const servesKey = (state: number) => state === KeyState.Active || state === KeyState.Draining;

const DOMAIN_ALPHA = keccak256(stringToHex('rsk-vrf/v1/alpha'));
const DOMAIN_BETA = keccak256(stringToHex('rsk-vrf/v1/beta'));

export interface FulfillmentInput {
  chainId: bigint;
  coordinator: Address;
  requester: Address;
  requestId: Hex;
  targetRound: bigint;
  /** drand/kyber BN254 G1 MarshalBinary: 32-byte x followed by 32-byte y. */
  signature: Hex;
}

export function composeFulfillment(input: FulfillmentInput, key: ProvingKey) {
  if (!/^0x[0-9a-fA-F]{128}$/.test(input.signature)) throw new Error('Invalid drand signature encoding');
  const randomness = `0x${createHash('sha256').update(Buffer.from(input.signature.slice(2), 'hex')).digest('hex')}` as Hex;
  const alpha = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint64' }, { type: 'bytes32' }],
    [DOMAIN_ALPHA, input.chainId, input.coordinator, input.requester, input.requestId, input.targetRound, randomness],
  ));
  const { proof, beta: output } = key.prove(hexToBigInt(alpha));
  const beta = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [DOMAIN_BETA, output]));
  const drandSignature = [BigInt(`0x${input.signature.slice(2, 66)}`), BigInt(`0x${input.signature.slice(66)}`)] as const;
  return { alpha, proof, beta, drandSignature };
}
