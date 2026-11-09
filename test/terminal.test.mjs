import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminal, coordinatorTable } from '../src/terminal.mjs';

const rows = [{ metadata: { name: 'review-api' }, state: 'running', startedAt: '2026-01-02T03:04:05Z', name: 'coord-review-api' }];
const plain = (columns) => terminal({ columns, isTTY: true, env: { NO_COLOR: '1' } });

test('coordinator list fits wide columns and stacks full values on narrow terminals', () => {
  const wide = coordinatorTable(rows, plain(100));
  assert.match(wide, /NAME +STATE +CREATED +MACHINE/);
  const narrow = coordinatorTable(rows, plain(48));
  for (const value of ['review-api', 'running', '2026-01-02T03:04:05.000Z', 'coord-review-api']) assert.ok(narrow.includes(value));
  assert.match(narrow, /Machine: coord-review-api/);
  assert.ok(narrow.split('\n').every((line) => line.length <= 48));
});
