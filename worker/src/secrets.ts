// Where Proving Keys are stored: AWS Secrets Manager, one secret per key.
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import type { KeyHash } from './types.ts';

/** SecretSource loads a secret's text by name. */
export interface SecretSource {
  load(name: string): Promise<string>;
}

/** secretName is where the Proving Key with this keyHash is stored. */
export function secretName(keyHash: KeyHash): string {
  return `rsk-vrf/proving-key/${keyHash}`;
}

/** AwsSecretSource reads SecretString from Secrets Manager. */
export class AwsSecretSource implements SecretSource {
  readonly #client = new SecretsManagerClient({});

  async load(name: string): Promise<string> {
    const out = await this.#client.send(new GetSecretValueCommand({ SecretId: name }));
    if (out.SecretString === undefined) throw new Error(`secret ${name} has no SecretString`);
    return out.SecretString;
  }
}
