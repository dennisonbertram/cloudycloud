import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDifferentRunTurn } from '../src/run.mjs';

test('resume rejects a fetched result that crossed into a newer turn', () => {
  assert.equal(isDifferentRunTurn({ turn_id: 'turn-original' }, 'turn-original'), false);
  assert.equal(isDifferentRunTurn({ turn_id: 'turn-newer' }, 'turn-original'), true);
  assert.equal(isDifferentRunTurn({ status: 'idle' }, 'turn-original'), false);
});
