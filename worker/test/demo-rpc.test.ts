import assert from 'node:assert/strict';
import { it } from 'node:test';

import { HttpRequestError } from 'viem';

import { redactUrls, retrying } from '../demo/rpc.ts';

const keyed = 'https://rpc.example/v1/s3cr3tk3y';
const noPause = async () => {};

it('redacts every URL in a viem error message', () => {
  const message = new HttpRequestError({ url: keyed, details: 'fetch failed' }).message;
  assert.match(message, /s3cr3tk3y/);
  const redacted = redactUrls(message);
  assert.doesNotMatch(redacted, /s3cr3tk3y/);
  assert.match(redacted, /URL: <redacted-url>/);
  assert.equal(redactUrls(`a "${keyed}" b http://x/y`), 'a "<redacted-url>" b <redacted-url>');
});

it('retries an empty read until it returns a value', async () => {
  let calls = 0;
  const value = await retrying(async () => (++calls < 3 ? undefined : '0xabc'), noPause, 5, 'No Fulfilled event');
  assert.equal(value, '0xabc');
  assert.equal(calls, 3);
});

it('gives up on an empty read after the given number of tries', async () => {
  let calls = 0;
  await assert.rejects(retrying(async () => { calls++; return undefined; }, noPause, 4, 'No Fulfilled event for 0x01'),
    { message: 'No Fulfilled event for 0x01 after 4 tries' });
  assert.equal(calls, 4);
});

it('retries a transient RPC error', async () => {
  let calls = 0;
  const value = await retrying(async () => {
    if (++calls === 1) throw new HttpRequestError({ url: keyed, details: 'fetch failed' });
    if (calls === 2) throw new TypeError('fetch failed');
    return 7n;
  }, noPause, 5, 'getRequest');
  assert.equal(value, 7n);
  assert.equal(calls, 3);
});

it('rethrows the last transient error once the tries run out', async () => {
  await assert.rejects(retrying(async () => { throw new TypeError('fetch failed'); }, noPause, 2, 'getRequest'), { message: 'fetch failed' });
});

it('does not retry an error that is not transient', async () => {
  let calls = 0;
  await assert.rejects(retrying(async () => { calls++; throw new Error('execution reverted'); }, noPause, 5, 'getRequest'),
    { message: 'execution reverted' });
  assert.equal(calls, 1);
});

it('pauses between tries', async () => {
  const events: string[] = [];
  let tries = 0;
  await retrying(async () => { events.push('try'); return ++tries < 3 ? undefined : 1; }, async () => { events.push('pause'); }, 5, 'x');
  assert.deepEqual(events, ['try', 'pause', 'try', 'pause', 'try']);
});
