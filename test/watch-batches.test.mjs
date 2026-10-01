import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitBatch, prBatches } from '../lib/watch-batches.mjs';

test('prBatches sorts and caps each request at ten numbers', () => {
  assert.deepEqual(prBatches([]), []);
  assert.deepEqual(prBatches([3]), [[3]]);
  assert.deepEqual(prBatches([2, 2, 1]), [[1, 2]]);
  assert.equal(prBatches(Array.from({ length: 10 }, (_, i) => i + 1)).length, 1);
  const eleven = prBatches([11, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(eleven, [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [11]]);
  assert.equal(prBatches(Array.from({ length: 21 }, (_, i) => 21 - i)).length, 3);
  assert.throws(() => prBatches([0]), /positive/);
});

test('admitBatch requires remaining quota to cover the batches still needed', () => {
  assert.equal(admitBatch({ remaining: 103, floor: 100, batchesStillNeeded: 3 }), true);
  assert.equal(admitBatch({ remaining: 102, floor: 100, batchesStillNeeded: 3 }), false);
  assert.equal(admitBatch({ remaining: 50, floor: 100, batchesStillNeeded: 1 }), false);
  assert.equal(admitBatch({ remaining: 100, floor: 100, batchesStillNeeded: 0 }), true);
});
