// Where Proving Keys are stored: AWS Secrets Manager, one secret per key.
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { ProvingKey } from './proving-key.ts';
import { parseKeyHash, type Hex, type KeyHash } from './types.ts';

/** SecretSource loads a secret's text by name. */
export interface SecretSource {
  load(name: string): Promise<string>;
}

/** secretName is where the Proving Key with this keyHash is stored. */
export function secretName(keyHash: KeyHash): string {
  return `rsk-vrf/proving-key/${keyHash}`;
}

/** SecretsManagerSender is the part of SecretsManagerClient this module uses. */
export interface SecretsManagerSender {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

/** AwsSecretSource reads SecretString from Secrets Manager. */
export class AwsSecretSource implements SecretSource {
  readonly #client: SecretsManagerSender;

  constructor(client: SecretsManagerSender = new SecretsManagerClient({})) {
    this.#client = client;
  }

  async load(name: string): Promise<string> {
    const out = await this.#client.send(new GetSecretValueCommand({ SecretId: name }));
    if (out.SecretString === undefined) throw new Error(`secret ${name} has no SecretString`);
    return out.SecretString;
  }
}

/**
 * provingKeyLoader loads the Proving Key for keyHash from source. It resolves
 * undefined when the store has no such secret, so the worker reports the key
 * as not held, and rejects on any other failure.
 */
export function provingKeyLoader(source: SecretSource): (keyHash: Hex) => Promise<ProvingKey | undefined> {
  return async keyHash => {
    const parsed = parseKeyHash(keyHash);
    if (!parsed) throw new Error('Invalid key hash');
    let secret: string;
    try {
      secret = await source.load(secretName(parsed));
    } catch (error) {
      if (error instanceof Error && error.name === 'ResourceNotFoundException') return undefined;
      throw error;
    }
    return ProvingKey.fromHex(secret);
  };
}
