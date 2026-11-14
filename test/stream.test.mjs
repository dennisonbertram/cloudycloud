import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalise } from '../src/stream.mjs';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const kinds = (ev) => ev.map((e) => e.kind);

test('claude stream-json: kinds in order, redacted input, result totals', () => {
  const raw = fx('stream-json-sample.jsonl');
  const secret = raw.replace('ls -la', 'echo sk-abcdefghijkl1234');
  const ev = normalise(secret, { harness: 'claude', turn: 1 });
  assert.deepEqual(kinds(ev), ['tool_use', 'tool_use', 'tool_result', 'tool_result', 'text', 'result']);
  assert.deepEqual(ev.map((e) => e.seq), [0, 1, 2, 3, 4, 5]);
  assert.ok(ev.every((e) => e.turn === 1));
  const bash = ev[0];
  assert.equal(bash.name, 'Bash');
  assert.match(bash.input, /echo \[redacted\]/);
  assert.ok(!bash.input.includes('sk-abc'));
  assert.equal(bash.truncated, false);
  assert.ok(bash.inputBytes > 0);
  assert.equal(ev[2].id, ev[1].id); // the Read result comes first and pairs with the Read call
  assert.ok(ev[2].summary.length <= 400);
  const j = JSON.parse(raw.trim().split('\n').pop());
  const r = ev.at(-1);
  assert.equal(r.costUsd, j.total_cost_usd);
  assert.equal(r.usage.output, j.usage.output_tokens);
  assert.equal(r.usage.input, j.usage.input_tokens);
  assert.equal(r.sessionId, j.session_id);
  assert.equal(r.isError, false);
  assert.equal(r.durationMs, j.duration_ms);
  // off is the byte offset of the source line
  assert.equal(ev[0].off, 0);
  assert.equal(ev.at(-1).off, Buffer.byteLength(secret.trimEnd().slice(0, secret.trimEnd().lastIndexOf("\n") + 1)));
});

test('claude: off lets a second call resume at the same list', () => {
  const raw = fx('stream-json-sample.jsonl');
  const all = normalise(raw, { harness: 'claude', turn: 2 });
  const first = normalise(raw.slice(0, raw.indexOf('\n', 2000) + 1), { harness: 'claude', turn: 2 });
  assert.ok(first.length > 0 && first.length < all.length);
  const rest = Buffer.from(raw).subarray(first.next).toString();
  const second = normalise(rest, { harness: 'claude', turn: 2, from: first.next, seq: first.length });
  assert.deepEqual([...first, ...second], [...all]);
});

test('claude: init, thinking marker, retry, error, partial last line, unknown lines', () => {
  const lines = [
    { type: 'system', subtype: 'init', model: 'm1', session_id: 's', tools: ['Bash', 'Read'], mcp_servers: [{ name: 'notion', status: 'connected', secret: 'x' }] },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'my secret plan sk-abcdefghijkl1234' }, { type: 'text', text: 'hi' }] } },
    { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, retry_delay_ms: 1000, error_status: 529, error: 'overloaded' },
    { type: 'permission_denied', tool_name: 'Bash' },
    { type: 'rate_limit_event' },
  ].map((o) => JSON.stringify(o));
  const raw = `${lines.join('\n')}\nnot json\n{"type":"assis`;
  const ev = normalise(raw, { harness: 'claude', turn: 1 });
  assert.deepEqual(kinds(ev), ['init', 'thinking', 'text', 'retry', 'error']);
  assert.equal(ev[0].model, 'm1');
  assert.deepEqual(ev[0].mcp, [{ name: 'notion', status: 'connected' }]);
  assert.equal(ev[1].length, 'my secret plan sk-abcdefghijkl1234'.length);
  assert.equal(ev[1].text, undefined);
  assert.equal(ev[3].attempt, 2);
  assert.equal(ev.skipped, 2); // rate_limit_event and "not json"; the cut-off last line is left for the next call
  assert.equal(ev.next, Buffer.byteLength(`${lines.join('\n')}\nnot json\n`));
  const on = normalise(raw, { harness: 'claude', thinking: true });
  assert.equal(on[1].text, 'my secret plan [redacted]');
});

test('long tool input is truncated at 4 KB with the real size', () => {
  const big = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Write', input: { content: 'x'.repeat(10000) } }] } });
  const [e] = normalise(big, { harness: 'claude' });
  assert.equal(e.truncated, true);
  assert.ok(e.inputBytes > 10000);
  assert.ok(e.input.length <= 4096 + 20);
});

test('pi and omp fixtures', () => {
  const pi = normalise(fx('pi-json-sample.jsonl'), { harness: 'pi', turn: 1 });
  assert.deepEqual(kinds(pi), ['init', 'tool_use', 'tool_result', 'text', 'result']);
  assert.equal(pi[1].name, 'bash');
  assert.match(pi[1].input, /ls/);
  assert.equal(pi.at(-1).text, 'hello from pi');
  assert.equal(pi.at(-1).isError, false);
  assert.equal(pi.at(-1).usage.input, 350); // 100+50 + 200, cache counts as input like progress-pi
  const omp = normalise(fx('omp-json-sample.jsonl'), { harness: 'omp', turn: 1 });
  assert.deepEqual(kinds(omp), ['init', 'tool_use', 'tool_result', 'text', 'result']);
  const err = normalise(fx('omp-json-error.jsonl'), { harness: 'omp' });
  assert.equal(err.at(-1).kind, 'result');
  assert.equal(err.at(-1).isError, true);
  assert.match(err.at(-1).text, /401/);
  const piErr = normalise(fx('pi-json-error.jsonl'), { harness: 'pi' });
  assert.equal(piErr.at(-1).isError, true);
});

test('prune removes files older than 30 days, then the oldest until under the size limit; dashboard --prune runs it', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pruneStreams } = await import('../src/stream.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cc-prune-'));
  const put = (agent, name, bytes, ageDays) => {
    mkdirSync(join(dir, agent), { recursive: true });
    const f = join(dir, agent, name);
    writeFileSync(f, 'x'.repeat(bytes));
    const t = (Date.now() - ageDays * 86_400_000) / 1000;
    utimesSync(f, t, t);
  };
  put('a', 't1.jsonl', 10, 40); // too old
  put('b', 't1.jsonl', 600, 3); // oldest of the recent two
  put('c', 't1.jsonl', 600, 1);
  const r = pruneStreams(dir, { maxBytes: 1000 });
  assert.equal(r.removed, 2);
  assert.ok(!existsSync(join(dir, 'a')) && !existsSync(join(dir, 'b', 't1.jsonl')));
  assert.ok(existsSync(join(dir, 'c', 't1.jsonl')));
  put('d', 't1.jsonl', 5, 31);
  const { main } = await import('../src/dashboard.mjs');
  process.env.CLOUDY_CLOUD_STREAMS = dir;
  const logs = [];
  const log = console.log;
  console.log = (m) => logs.push(m);
  try { await main(['--prune']); } finally { console.log = log; }
  assert.match(logs[0], /removed 1 file/);
  assert.ok(!existsSync(join(dir, 'd')));
});
