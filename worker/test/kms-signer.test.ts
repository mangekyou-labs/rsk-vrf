import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes, recoverTransactionAddress, type Hex, type TransactionSerializedLegacy } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { kmsAccount } from '../src/kms-signer.ts';

// A known secp256k1 key standing in for the KMS key; never a real Fulfiller.
const SECRET: Hex = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const N = secp256k1.Point.CURVE().n;
// SubjectPublicKeyInfo header for an uncompressed secp256k1 point, as KMS returns it.
const SPKI_HEADER = '3056301006072a8648ce3d020106052b8104000a034200';

function derInteger(value: bigint): string {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  if (parseInt(hex.slice(0, 2), 16) >= 0x80) hex = `00${hex}`;
  return `02${(hex.length / 2).toString(16).padStart(2, '0')}${hex}`;
}

function der(r: bigint, s: bigint): Uint8Array {
  const body = derInteger(r) + derInteger(s);
  return hexToBytes(`0x30${(body.length / 2).toString(16).padStart(2, '0')}${body}`);
}

/** fakeKms answers GetPublicKey and Sign the way KMS does, optionally with high-s signatures. */
function fakeKms(opts: { highS?: boolean } = {}) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const secret = hexToBytes(SECRET);
  return {
    calls,
    async send(command: unknown) {
      if (command instanceof GetPublicKeyCommand) {
        calls.push({ name: 'GetPublicKey', input: { ...command.input } });
        const point = secp256k1.getPublicKey(secret, false);
        return { KeySpec: 'ECC_SECG_P256K1', PublicKey: hexToBytes(`0x${SPKI_HEADER}${bytesToHex(point).slice(2)}`) };
      }
      if (command instanceof SignCommand) {
        calls.push({ name: 'Sign', input: { ...command.input } });
        const sig = secp256k1.Signature.fromBytes(secp256k1.sign(command.input.Message!, secret, { prehash: false }));
        const s = opts.highS ? N - sig.s : sig.s;
        return { Signature: der(sig.r, s), SigningAlgorithm: 'ECDSA_SHA_256' };
      }
      throw new Error('unexpected command');
    },
  };
}

const tx = {
  to: '0x00000000000000000000000000000000000000aa', data: '0x1234', gas: 700_000n, gasPrice: 66_000_000n, nonce: 7, value: 0n, type: 'legacy', chainId: 31,
} as const;

describe('KMS-backed Fulfiller account', () => {
  it('has the address of its KMS public key', async () => {
    const account = await kmsAccount({ kms: fakeKms(), keyId: 'alias/rsk-vrf-fulfiller-primary' });
    assert.equal(account.address, privateKeyToAccount(SECRET).address);
  });

  it('signs a legacy chain-31 transaction exactly as the key itself would', async () => {
    const kms = fakeKms();
    const account = await kmsAccount({ kms, keyId: 'alias/rsk-vrf-fulfiller-primary' });
    const signed = await account.signTransaction(tx);
    assert.equal(signed, await privateKeyToAccount(SECRET).signTransaction(tx));
    const sign = kms.calls.find(call => call.name === 'Sign')!;
    assert.equal(sign.input.KeyId, 'alias/rsk-vrf-fulfiller-primary');
    assert.equal(sign.input.MessageType, 'DIGEST');
    assert.equal(sign.input.SigningAlgorithm, 'ECDSA_SHA_256');
  });

  it('normalises a high-s KMS signature to low s', async () => {
    const account = await kmsAccount({ kms: fakeKms({ highS: true }), keyId: 'k' });
    const signed = await account.signTransaction(tx);
    assert.equal(signed, await privateKeyToAccount(SECRET).signTransaction(tx));
    assert.equal(await recoverTransactionAddress({ serializedTransaction: signed as TransactionSerializedLegacy }), account.address);
  });

  it('recovers the right parity across many digests', async () => {
    const account = await kmsAccount({ kms: fakeKms({ highS: true }), keyId: 'k' });
    const local = privateKeyToAccount(SECRET);
    for (let nonce = 0; nonce < 16; nonce++) {
      assert.equal(await account.signTransaction({ ...tx, nonce }), await local.signTransaction({ ...tx, nonce }));
    }
  });

  it('signs messages like the key itself', async () => {
    const account = await kmsAccount({ kms: fakeKms(), keyId: 'k' });
    assert.equal(await account.signMessage({ message: 'rsk-vrf' }), await privateKeyToAccount(SECRET).signMessage({ message: 'rsk-vrf' }));
  });

  it('rejects a key that is not secp256k1', async () => {
    const kms = {
      async send() { return { KeySpec: 'ECC_NIST_P256', PublicKey: new Uint8Array(91) }; },
    };
    await assert.rejects(kmsAccount({ kms, keyId: 'k' }), /secp256k1/);
  });
});
