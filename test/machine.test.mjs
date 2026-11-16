import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMachine, KINDS, EXPENSIVE, PRICE } from '../src/machine.mjs';

test('parseMachine accepts the eight forms and normalises them', () => {
  const ok = (s, want) => assert.deepEqual(parseMachine(s), want, String(s));
  ok(undefined, { name: 'linux', label: 'linux' });
  ok('', { name: 'linux', label: 'linux' });
  ok('linux', { name: 'linux', label: 'linux' });
  ok('android', { name: 'android', label: 'android' });
  ok('omarchy', { name: 'omarchy', label: 'omarchy' });
  ok('gpu', { name: 'gpu', label: 'gpu' });
  ok('gpu:L4', { name: 'gpu', gpu: 'l4', label: 'gpu:l4' });
  ok('GPU:l4:2', { name: 'gpu', gpu: 'l4:2', label: 'gpu:l4:2' });
  ok('macos', { name: 'macos', label: 'macos' });
  ok('macos:M4-Pro', { name: 'macos', model: 'm4-pro', label: 'macos:m4-pro' });
});

test('parseMachine rejects bad strings and lists the accepted forms', () => {
  for (const s of ['gpu:l4:9', 'gpu:l4:0', 'gpu:l4:x', 'gpu:l4:2:1', 'macos:M4 Pro', 'macos:m4:1', 'windows', 'linux;rm', 'linux:x', 'android:x', ':', 'gpu:']) {
    const r = parseMachine(s);
    assert.ok(r.error && !r.name, s);
    assert.match(r.error, /gpu\[:TYPE\[:COUNT\]\]/, s);
  }
});

test('KINDS, EXPENSIVE and PRICE agree', () => {
  assert.deepEqual(KINDS, ['linux', 'android', 'omarchy', 'gpu', 'macos']);
  assert.deepEqual(EXPENSIVE, ['gpu', 'macos']);
  for (const k of EXPENSIVE) assert.match(PRICE[k], /\$/);
});
