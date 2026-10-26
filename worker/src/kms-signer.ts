// The Fulfiller EOA held in AWS KMS: an ECC_SECG_P256K1 key that never leaves KMS.
//
// KMS returns DER (r, s) with no recovery id and possibly a high s. The account
// normalises s to the lower half of the curve, as Rootstock and viem require,
// and finds the recovery id by recovering against the key's own public key.
import { GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  bytesToHex, hashMessage, hashTypedData, keccak256, numberToHex, serializeTransaction, type Hex, type LocalAccount, type Signature,
} from 'viem';
import { publicKeyToAddress, toAccount } from 'viem/accounts';

/** KmsSender is the part of KMSClient this module uses. */
export interface KmsSender {
  send(command: GetPublicKeyCommand | SignCommand): Promise<{ KeySpec?: string; PublicKey?: Uint8Array; Signature?: Uint8Array }>;
}

const N = secp256k1.Point.CURVE().n;
// SubjectPublicKeyInfo header of an uncompressed secp256k1 point (id-ecPublicKey, secp256k1).
const SPKI_HEADER = '3056301006072a8648ce3d020106052b8104000a034200';

/** kmsAccount returns a viem account that signs with the KMS key keyId. */
export async function kmsAccount(opts: { kms: KmsSender; keyId: string }): Promise<LocalAccount> {
  const { kms, keyId } = opts;
  const out = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
  const spki = out.PublicKey ? bytesToHex(out.PublicKey).slice(2) : '';
  if (out.KeySpec !== 'ECC_SECG_P256K1' || spki.length !== SPKI_HEADER.length + 130 || !spki.startsWith(SPKI_HEADER)) {
    throw new Error('KMS Fulfiller key is not an ECC_SECG_P256K1 (secp256k1) key');
  }
  const publicKey = `0x${spki.slice(SPKI_HEADER.length)}` as Hex;
  const address = publicKeyToAddress(publicKey);

  async function sign(hash: Hex): Promise<Signature> {
    const signed = await kms.send(new SignCommand({
      KeyId: keyId, Message: Buffer.from(hash.slice(2), 'hex'), MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256',
    }));
    if (!signed.Signature) throw new Error('KMS returned no signature');
    const parsed = secp256k1.Signature.fromBytes(signed.Signature, 'der');
    const s = parsed.s > N / 2n ? N - parsed.s : parsed.s;
    for (const recovery of [0, 1]) {
      const candidate = new secp256k1.Signature(parsed.r, s, recovery);
      const recovered = candidate.recoverPublicKey(Buffer.from(hash.slice(2), 'hex')).toBytes(false);
      if (bytesToHex(recovered) === publicKey) {
        return { r: numberToHex(parsed.r, { size: 32 }), s: numberToHex(s, { size: 32 }), v: BigInt(27 + recovery), yParity: recovery };
      }
    }
    throw new Error('KMS signature does not recover to the Fulfiller key');
  }

  const signatureHex = (sig: Signature): Hex =>
    `0x${sig.r.slice(2)}${sig.s.slice(2)}${(sig.yParity ? 28 : 27).toString(16)}` as Hex;

  return toAccount({
    address,
    async sign({ hash }) {
      return signatureHex(await sign(hash));
    },
    async signMessage({ message }) {
      return signatureHex(await sign(hashMessage(message)));
    },
    async signTypedData(typedData) {
      return signatureHex(await sign(hashTypedData(typedData)));
    },
    async signTransaction(transaction, options) {
      const serializer = options?.serializer ?? serializeTransaction;
      return serializer(transaction, await sign(keccak256(await serializer(transaction))));
    },
  });
}
