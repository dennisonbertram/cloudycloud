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

test('parseSize reads NxM, rejects other forms, and ignores an empty value', async () => {
  const { parseSize, sizeLabel, SIZE_PRICE, planFor } = await import('../src/machine.mjs');
  assert.deepEqual(parseSize('8x16'), { vcpus: 8, memMiB: 16384, label: '8x16' });
  assert.deepEqual(parseSize(' 2X4 '), { vcpus: 2, memMiB: 4096, label: '2x4' });
  assert.equal(parseSize(undefined), undefined);
  assert.equal(parseSize(''), undefined);
  for (const s of ['8/16', '8x', 'big', 'x8', '0x4', '4x0', '4x8x1', '-4x8', '4.5x8']) assert.match(parseSize(s).error, /VCPUSxGIB|4x8/, s);
  assert.equal(sizeLabel({ vcpus: 2, memMiB: 4096 }), '2x4');
  assert.equal(sizeLabel({ vcpus: 8, memMiB: 16384 }), '8x16');
  assert.equal(SIZE_PRICE(8, 16), '8x16 costs about $0.068 an hour while running (vCPU $0.004/h, memory $0.00225/GiB-h).');
  assert.match(SIZE_PRICE(2, 4), /\$0\.017 an hour/);
  assert.deepEqual([planFor(8), planFor(16), planFor(32), planFor(64)], ['pro', 'builder', 'team', undefined]);
});

test('#128 planFor needs both the vCPUs and the memory to fit; planFee gives the monthly fee', async () => {
  const { planFor, planFee } = await import('../src/machine.mjs');
  assert.equal(planFor(8, 16384), 'pro');
  assert.equal(planFor(8, 32768), 'builder');
  assert.equal(planFor(16, 65536), 'team');
  assert.equal(planFor(64, 131072), undefined);
  assert.deepEqual(['pro', 'builder', 'team', 'x'].map(planFee), [20, 100, 500, undefined]);
});

test('#135 offeredBy lists only exact plan sizes; sizeCostLine adds the default for comparison', async () => {
  const { offeredBy, sizeCostLine } = await import('../src/machine.mjs');
  assert.deepEqual(['2x4', '8x16', '16x32', '32x64', '3x5', '8x32'].map(offeredBy), ['pro', 'pro', 'builder', 'team', undefined, undefined]);
  assert.match(sizeCostLine(8, 16), /\$0\.068 an hour[^]*default 4x8 costs about \$0\.034 an hour/);
  assert.doesNotMatch(sizeCostLine(4, 8), /default/);
});

test('#139 usageLine: under, over, no allowance, rounding, and null without readable usage', async () => {
  const { usageLine } = await import('../src/machine.mjs');
  const L = (usage) => usageLine({ usage });
  assert.equal(L({ costUSD: 12.4, allowanceUSD: 20, overageUSD: 0 }), 'Instabox this month: $12.40 of $20.00 included used');
  assert.equal(L({ costUSD: 12.4, allowanceUSD: 20 }), 'Instabox this month: $12.40 of $20.00 included used');
  assert.equal(L({ costUSD: 66.03, allowanceUSD: 16.61, overageUSD: 49.42 }), 'Instabox this month: $66.03 used, $16.61 included, $49.42 beyond it (pay as you go)');
  assert.equal(L({ costUSD: 3.1, allowanceUSD: 0 }), 'Instabox this month: $3.10 used (pay as you go)');
  assert.equal(L({ costUSD: 0.005, allowanceUSD: 16.666 }), 'Instabox this month: $0.01 of $16.67 included used');
  for (const p of [null, undefined, {}, { usage: {} }, { usage: { costUSD: '3' } }, { usage: { costUSD: NaN } }]) assert.equal(usageLine(p), null);
});
