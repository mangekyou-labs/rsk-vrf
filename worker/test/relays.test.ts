import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_RELAYS, EVMNET_CHAIN_HASH } from '../src/relays.ts';

describe('default relays', () => {
  it('read rounds of the evmnet chain, not of the relay host\'s default chain', () => {
    assert.equal(DEFAULT_RELAYS.length, 3);
    for (const relay of DEFAULT_RELAYS) {
      // The worker fetches `${relay}/public/<round>`.
      const url = new URL(`${relay}/public/21905320`);
      assert.match(url.hostname, /^api[23]?\.drand\.sh$/);
      assert.equal(url.pathname, `/${EVMNET_CHAIN_HASH}/public/21905320`);
    }
  });
});
