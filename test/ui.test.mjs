import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUi } from '../src/ui.mjs';

const ANSI = /\x1b\[/;
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const tty = (env = {}) => makeUi({ tty: true, cols: 80, env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8', ...env } });
const off = (env = {}) => makeUi({ tty: false, cols: 80, env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8', ...env } });

// ui.term means the output is a terminal that takes escapes; ui.on means colour is allowed there.
test('ui.term is a terminal; ui.on is term plus colour allowed', () => {
  assert.deepEqual([tty().term, tty().on], [true, true]);
  for (const env of [{ NO_COLOR: '1' }, { CLICOLOR: '0' }]) assert.deepEqual([tty(env).term, tty(env).on], [true, false], JSON.stringify(env));
  assert.deepEqual([tty({ TERM: 'dumb' }).term, tty({ TERM: 'dumb' }).on], [false, false]);
  assert.deepEqual([off().term, off().on], [false, false]);
  assert.equal(off({ NO_COLOR: '1' }).term, false);
});

// The palette uses the terminal's own 16 colours and text attributes: every theme picks shades
// that read on its background, which no fixed colour can do on both light and dark. So the test
// asserts the kind of code, not a computed contrast.
test('palette: only basic 16-colour codes and attributes, never a fixed colour', () => {
  const allowed = new Set([1, 2, ...Array.from({ length: 8 }, (_, i) => 30 + i), ...Array.from({ length: 8 }, (_, i) => 90 + i)]);
  for (const [name, seq] of Object.entries(tty().col)) {
    if (seq === '') continue; // default text adapts too
    assert.ok(/^\x1b\[([0-9;]+)m$/.test(seq), `${name}: not an SGR sequence: ${JSON.stringify(seq)}`);
    const p = seq.slice(2, -1).split(';').map(Number);
    for (const n of p) assert.ok(allowed.has(n), `${name} ${JSON.stringify(seq)}: code ${n} is not a basic colour or attribute`);
    assert.ok(!p.includes(38) && !p.includes(48), `${name}: fixed colour`);
  }
});

test('the accent is bold blue, so the Next line is the strongest line', () => {
  assert.equal(tty().col.acc, '\x1b[1;34m');
  assert.ok(tty().next('x').startsWith('  \x1b[1;34m'));
});

// With colour off on a terminal the helpers keep the terminal layout (indent, marks, arrow), minus the escapes.
test('colour off on a terminal: same layout as colour on, no escapes', () => {
  const helpers = [
    ['ok', (u) => u.ok('Done', 'detail')],
    ['err', (u) => u.err('Broke', 'why')],
    ['warn', (u) => u.warn('Careful')],
    ['hint', (u) => u.hint('Run x')],
    ['next', (u) => u.next('cloudy-cloud x')],
    ['table', (u) => u.table(['A', 'B'], [['x', 'y']])],
    ['block', (u) => u.block('T', [['label', 'value', 'detail']])],
  ];
  for (const env of [{ NO_COLOR: '1' }, { CLICOLOR: '0' }]) {
    for (const [name, fn] of helpers) {
      assert.doesNotMatch(fn(tty(env)), ANSI, `${name} ${JSON.stringify(env)}`);
      assert.equal(fn(tty(env)), plain(fn(tty())), `${name} ${JSON.stringify(env)}`);
    }
  }
});

test('ui.next: bold arrow on a colour terminal, bare arrow with colour off, script format when piped', () => {
  assert.equal(plain(tty().next('x')), '  → Next: x');
  assert.equal(tty({ NO_COLOR: '1' }).next('x'), '  → Next: x');
  assert.equal(plain(tty({ LANG: 'C' }).next('x')), '  -> Next: x');
  assert.equal(off().next('x'), 'Next: x');
  assert.equal(off({ NO_COLOR: '1' }).next('x'), 'Next: x');
});

test('marks still say what colour used to: ok/warn/err/hint differ by glyph', () => {
  const u = tty({ NO_COLOR: '1' });
  assert.match(u.ok('x'), /✔/);
  assert.match(u.warn('x'), /▲/);
  assert.match(u.err('x'), /✖/);
  assert.match(u.hint('x'), /›/);
});
