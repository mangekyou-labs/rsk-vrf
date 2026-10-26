import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GetParametersByPathCommand } from '@aws-sdk/client-ssm';

import { applyParameters, loadParameters } from '../src/parameters.ts';

function fakeSsm(pages: { Name: string; Value: string }[][]) {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    async send(command: GetParametersByPathCommand) {
      assert.ok(command instanceof GetParametersByPathCommand);
      calls.push({ ...command.input });
      const index = command.input.NextToken === undefined ? 0 : Number(command.input.NextToken);
      return { Parameters: pages[index], NextToken: index + 1 < pages.length ? String(index + 1) : undefined };
    },
  };
}

describe('worker configuration from SSM Parameter Store', () => {
  it('reads every page under the path, decrypted, keyed by the last name segment', async () => {
    const ssm = fakeSsm([
      [{ Name: '/rsk-vrf/primary/COORDINATOR_ADDRESS', Value: '0x11' }, { Name: '/rsk-vrf/primary/GRACE_BLOCKS', Value: '0' }],
      [{ Name: '/rsk-vrf/primary/ALERT_PAGE_TOKEN', Value: 'tk' }],
    ]);
    assert.deepEqual(await loadParameters({ ssm, path: '/rsk-vrf/primary' }), {
      COORDINATOR_ADDRESS: '0x11', GRACE_BLOCKS: '0', ALERT_PAGE_TOKEN: 'tk',
    });
    assert.equal(ssm.calls.length, 2);
    for (const call of ssm.calls) {
      assert.equal(call.Path, '/rsk-vrf/primary/');
      assert.equal(call.WithDecryption, true);
      assert.equal(call.Recursive, false);
    }
  });

  it('rejects a parameter name that is not an environment variable name', async () => {
    const ssm = fakeSsm([[{ Name: '/rsk-vrf/primary/rpc-url', Value: 'x' }]]);
    await assert.rejects(loadParameters({ ssm, path: '/rsk-vrf/primary' }), /parameter name/);
  });

  it('fills only variables the environment does not already set', () => {
    const env: Record<string, string | undefined> = { GRACE_BLOCKS: '100', EMPTY: '' };
    applyParameters(env, { GRACE_BLOCKS: '0', WORKER_ID: 'primary-eu', EMPTY: 'x' });
    assert.deepEqual(env, { GRACE_BLOCKS: '100', WORKER_ID: 'primary-eu', EMPTY: 'x' });
  });
});
