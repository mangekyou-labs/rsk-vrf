import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deadlineMiss } from '../src/worker.ts';

// Ordinals of the coordinator's RequestStatus and RefundReason enums (src/VRFCoordinator.sol).
const PENDING = 1, FULFILLED = 2, REFUNDED = 3;
const DEADLINE = 0, KEY_REVOKED = 1;

describe('deadlineMiss', () => {
  it('a request still Pending after its Deadline block is a miss', () => {
    assert.equal(deadlineMiss({ status: PENDING, deadline: 100 }, undefined, 101n), 'Pending');
  });

  it('a request Pending at its Deadline block is not a miss yet', () => {
    assert.equal(deadlineMiss({ status: PENDING, deadline: 100 }, undefined, 100n), undefined);
  });

  it('a request refunded on the Deadline branch is a miss', () => {
    assert.equal(deadlineMiss({ status: REFUNDED, deadline: 100 }, DEADLINE, 200n), 'Refunded');
  });

  it('a Revocation Refund is not a miss', () => {
    assert.equal(deadlineMiss({ status: REFUNDED, deadline: 100 }, KEY_REVOKED, 200n), undefined);
  });

  it('a fulfilled request is not a miss, even after its Deadline', () => {
    assert.equal(deadlineMiss({ status: FULFILLED, deadline: 100 }, undefined, 200n), undefined);
  });
});
