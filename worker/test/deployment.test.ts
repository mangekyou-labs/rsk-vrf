import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { coordinatorFromDeployment } from '../src/deployment.ts';

const proxy = `0x${'ab'.repeat(20)}`;
const record = (chainId: unknown, address: unknown = proxy) => JSON.stringify({
  chainId,
  commit: 'deadbeef',
  contracts: { implementation: { address: `0x${'cd'.repeat(20)}` }, proxy: { address, block: 7 } },
});

describe('coordinatorFromDeployment', () => {
  it('reads the proxy address of a record for the connected chain, checksummed', () => {
    assert.equal(coordinatorFromDeployment(record(31), 31), '0xABaBaBaBABabABabAbAbABAbABabababaBaBABaB');
  });

  it('refuses a record for another chain', () => {
    assert.throws(() => coordinatorFromDeployment(record(31), 33), { message: 'Invalid deployment' });
  });

  it('refuses malformed records', () => {
    for (const text of ['not json', '[]', record('31'), record(31, 'nope'), record(31, null), JSON.stringify({ chainId: 31 })]) {
      assert.throws(() => coordinatorFromDeployment(text, 31), { message: 'Invalid deployment' }, text);
    }
  });
});
