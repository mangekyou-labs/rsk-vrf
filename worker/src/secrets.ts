// Proving Keys in AWS Secrets Manager: one secret per key, named by keyHash,
// holding the key as hex. provingKeyLoader reads and parses one, and tells a key
// this deployment does not hold apart from a secret left without a value.
import { DescribeSecretCommand, GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

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
  send(command: GetSecretValueCommand | DescribeSecretCommand): Promise<{ SecretString?: string }>;
}

/** The error for a secret that exists with no value, such as one Terraform created and nobody filled. */
export const EMPTY_SECRET_MESSAGE = 'Proving Key secret exists but has no value';

const isNotFound = (error: unknown) => error instanceof Error && error.name === 'ResourceNotFoundException';

/** AwsSecretSource reads SecretString from Secrets Manager. */
export class AwsSecretSource implements SecretSource {
  readonly #client: SecretsManagerSender;

  constructor(client: SecretsManagerSender = new SecretsManagerClient({})) {
    this.#client = client;
  }

  async load(name: string): Promise<string> {
    let out: { SecretString?: string };
    try {
      out = await this.#client.send(new GetSecretValueCommand({ SecretId: name }));
    } catch (error) {
      // GetSecretValue says ResourceNotFound both for no secret and for a secret with no value.
      if (isNotFound(error) && await this.#exists(name)) throw new Error(EMPTY_SECRET_MESSAGE);
      throw error;
    }
    if (out.SecretString === undefined) throw new Error(`secret ${name} has no SecretString`);
    return out.SecretString;
  }

  async #exists(name: string): Promise<boolean> {
    try {
      await this.#client.send(new DescribeSecretCommand({ SecretId: name }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
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
      if (isNotFound(error)) return undefined;
      throw error;
    }
    return ProvingKey.fromHex(secret);
  };
}
