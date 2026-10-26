import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GetSecretValueCommand, ResourceNotFoundException } from '@aws-sdk/client-secrets-manager';

import { ProvingKey } from '../src/proving-key.ts';
import { AwsSecretSource, provingKeyLoader } from '../src/secrets.ts';
import { SECRET_HEX } from './keys.ts';
import { assertNoSecret, errorText } from './secret.ts';

const key = ProvingKey.fromHex(SECRET_HEX);

function fakeSecretsManager(answer: (secretId: string) => { SecretString?: string } | Error) {
  const asked: string[] = [];
  return {
    asked,
    async send(command: GetSecretValueCommand) {
      assert.ok(command instanceof GetSecretValueCommand);
      asked.push(command.input.SecretId!);
      const out = answer(command.input.SecretId!);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

describe('Proving Keys from Secrets Manager', () => {
  it('loads the key from rsk-vrf/proving-key/<keyHash>', async () => {
    const sm = fakeSecretsManager(() => ({ SecretString: `${SECRET_HEX}\n` }));
    const loaded = await provingKeyLoader(new AwsSecretSource(sm))(key.keyHash);
    assert.equal(loaded?.keyHash, key.keyHash);
    assert.deepEqual(sm.asked, [`rsk-vrf/proving-key/${key.keyHash}`]);
  });

  it('treats a missing secret as a key this deployment does not hold', async () => {
    const sm = fakeSecretsManager(() => new ResourceNotFoundException({ message: 'no such secret', $metadata: {} }));
    assert.equal(await provingKeyLoader(new AwsSecretSource(sm))(key.keyHash), undefined);
  });

  it('fails on any other error', async () => {
    const sm = fakeSecretsManager(() => Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    await assert.rejects(provingKeyLoader(new AwsSecretSource(sm))(key.keyHash), /denied/);
  });

  it('fails on a binary secret', async () => {
    const sm = fakeSecretsManager(() => ({}));
    await assert.rejects(provingKeyLoader(new AwsSecretSource(sm))(key.keyHash), /no SecretString/);
  });

  it('refuses a malformed keyHash before asking', async () => {
    const sm = fakeSecretsManager(() => ({ SecretString: SECRET_HEX }));
    await assert.rejects(provingKeyLoader(new AwsSecretSource(sm))('0x1234'), /key hash/);
    assert.deepEqual(sm.asked, []);
  });

  it('rejects a malformed secret without quoting it', async () => {
    const malformed = `${SECRET_HEX}00`;
    const sm = fakeSecretsManager(() => ({ SecretString: malformed }));
    const error = await provingKeyLoader(new AwsSecretSource(sm))(key.keyHash).then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof Error);
    assertNoSecret(errorText(error), SECRET_HEX, 'error');
  });
});
