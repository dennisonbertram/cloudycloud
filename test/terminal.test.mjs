import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminal, coordinatorTable, formatError } from '../src/terminal.mjs';
import { rootHelp, coordinatorHelp } from '../src/cli-help.mjs';

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

test('errors keep recovery guidance while removing terminal controls and token-shaped secrets', () => {
  const output = formatError(new Error('HTTP 401\x1b[2J\r\x07 ibk_FAKEKEY123 sk-ant-test123\nRun: claude-cloud coordinator --help'), plain(80));
  assert.match(output, /error  claude-cloud[\s\S]*HTTP 401[\s\S]*Run: claude-cloud coordinator --help/);
  assert.doesNotMatch(output, /[\x1b\r\x07]|ibk_FAKEKEY|sk-ant-test/);
});

test('styling honors TTY, NO_COLOR (including empty), and TERM=dumb', () => {
  assert.match(rootHelp(terminal({ isTTY: true, env: { TERM: 'xterm' } })), /\x1b\[/);
  for (const options of [ { isTTY: false, env: {} }, { isTTY: true, env: { NO_COLOR: '' } }, { isTTY: true, env: { TERM: 'dumb' } } ]) {
    assert.doesNotMatch(rootHelp(terminal(options)), /\x1b/);
  }
});

test('help is readable at 48 and 80 columns; commands retain copyable logical lines', () => {
  for (const width of [48, 80]) {
    for (const output of [rootHelp(plain(width)), coordinatorHelp(undefined, plain(width))]) {
      assert.ok(output.split('\n').every((line) => line.length <= width), output);
    }
  }
  const command = 'claude-cloud coordinator start NAME --repo https://github.com/OWNER/REPO';
  assert.equal(plain(48).command(command), `  ${command}`);
});

test('long external fields wrap without truncation and controls cannot forge rows', () => {
  const name = 'a'.repeat(120);
  const output = coordinatorTable([{ ...rows[0], name, state: '\x1b[2Jrunning\nforged\trow', startedAt: 'bad-date' }], plain(48));
  assert.ok(output.split('\n').every((line) => line.length <= 48));
  assert.ok(output.replace(/\s/g, '').includes(name));
  assert.match(output, /unknown/);
  assert.doesNotMatch(output, /\x1b|\t|\nforged/);
  assert.match(output, /running forged row/);
  assert.equal(plain(24).text('界'.repeat(30)).split('\n').length, 3);
});
