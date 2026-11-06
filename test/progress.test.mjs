import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProgress, parseStream, statusLine, totalLine, fmtTokens, fmtElapsed } from '../src/progress.mjs';

// Real `claude -p --model haiku --output-format stream-json --verbose` output (assistant, user and result events only).
const sample = readFileSync(new URL('./fixtures/stream-json-sample.jsonl', import.meta.url), 'utf8');

test('fixture: counts tools, tokens, last step and the final result', () => {
  const p = parseStream(sample);
  assert.equal(p.tools, 2);
  assert.equal(p.step, 'Read /home/user/repo/a.txt');
  assert.equal(p.final.is_error, false);
  assert.match(p.final.result, /done/);
  assert.deepEqual(p.totals(), { tools: 2, in: 4 + 35410 + 57692, out: 327, cost: p.final.total_cost_usd });
  assert.match(totalLine(p), /^Total: 2 tool uses, 93\.1k in \/ 327 out tokens, \$0\.0078, \d+s$/);
});

test('fixture fed in odd chunks gives the same live status line; step disappears once the result is in', () => {
  let t = 1000;
  const p = createProgress(() => t);
  const cut = sample.indexOf('"Read"') + 5; // inside the Read tool_use line
  p.feed(sample.slice(0, cut));
  t += 190_000;
  assert.equal(p.tools, 1);
  assert.match(statusLine(p), /^1 tool use · [\d.]+k? tokens · 3m10s · Bash ls -la$/);
  p.feed(sample.slice(cut));
  p.end();
  assert.equal(p.tools, 2);
  assert.equal(statusLine(p), '2 tool uses · 93.4k tokens · 3m10s');
});

test('live token estimate counts each message once, using its largest usage', () => {
  const p = createProgress();
  const ev = (out) => JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [], usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: out } } });
  p.feed(`${ev(4)}\n${ev(50)}\n${ev(20)}\n`);
  assert.deepEqual(p.totals(), { tools: 0, in: 100, out: 50 });
});

test('non-JSON lines are ignored; long arguments are truncated and token-like text is removed', () => {
  const p = createProgress();
  const tool = (id, input) => JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id, name: 'Bash', input }] } });
  p.feed(`warning: something\n${tool('a', { command: `curl -H "x: ghp_abc123DEF" ${'x'.repeat(200)}` })}\n{broken\n`);
  assert.equal(p.tools, 1);
  assert.ok(p.step.length <= 'Bash '.length + 60);
  assert.doesNotMatch(p.step, /ghp_/);
  assert.match(p.step, /\[redacted\]/);
});

test('formatting', () => {
  assert.equal(fmtTokens(950), '950');
  assert.equal(fmtTokens(48_200), '48.2k');
  assert.equal(fmtTokens(250_000), '250k');
  assert.equal(fmtElapsed(5_000), '5s');
  assert.equal(fmtElapsed(190_000), '3m10s');
  assert.equal(fmtElapsed(3_900_000), '1h05m');
});

test('totalLine leaves out the cost when asked: Claude Code prices other providers at Anthropic rates', () => {
  const p = parseStream(sample);
  assert.doesNotMatch(totalLine(p, { cost: false }), /\$/);
  assert.match(totalLine(p), /\$0\.0078/);
});
