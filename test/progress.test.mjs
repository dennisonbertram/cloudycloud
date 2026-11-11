import './tmp-cleanup.mjs';
import { parsePiStream, createPiProgress } from '../src/progress-pi.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProgress, parseStream, statusLine, totalLine, fmtTokens, fmtElapsed, mcpLine } from '../src/progress.mjs';

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
  assert.match(statusLine(p), /^claude-haiku-5-5 · 1 tool use · [\d.]+k? tokens · 3m10s · Bash ls -la$/);
  p.feed(sample.slice(cut));
  p.end();
  assert.equal(p.tools, 2);
  assert.equal(statusLine(p), 'claude-haiku-5-5 · 2 tool uses · 93.4k tokens · 3m10s');
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

// Synthetic pi events built from the documented shapes (pi.dev/docs/latest/json), not captured from a real run.
const pi = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

test('pi JSON events give tools, tokens, step, session id and the final text', () => {
  const p = parsePiStream(pi('pi-json-sample.jsonl'));
  assert.deepEqual(p.totals(), { tools: 1, in: 350, out: 30 });
  assert.equal(p.step, 'bash ls');
  assert.equal(p.final.session_id, '11111111-2222-3333-4444-555555555555');
  assert.equal(p.final.result, 'hello from pi');
  assert.equal(p.final.is_error, false);
});

test('a pi error message is reported as an error with its message', () => {
  const p = parsePiStream(pi('pi-json-error.jsonl'));
  assert.equal(p.final.is_error, true);
  assert.match(p.final.result, /401 invalid api key/);
});

test('pi progress works on chunks split anywhere, and before the run settles', () => {
  const text = pi('pi-json-sample.jsonl'), p = createPiProgress();
  const cut = text.indexOf('tool_execution_start') + 5;
  p.feed(text.slice(0, cut));
  assert.equal(p.tools, 0);
  p.feed(text.slice(cut, cut + 300));
  assert.equal(p.tools, 1);
  assert.equal(p.final, undefined);
  p.feed(text.slice(cut + 300));
  p.end();
  assert.equal(p.final.result, 'hello from pi');
});

import { modelLine } from '../src/progress.mjs';
import { profileHint } from '../src/profiles.mjs';

test('claude stream: model from init and assistant events; the alias worker is ignored', () => {
  const p = parseStream([
    { type: 'system', subtype: 'init', model: 'worker' },
    { type: 'assistant', message: { id: 'm1', model: 'worker', content: [] } },
  ].map((e) => JSON.stringify(e)).join('\n'));
  assert.equal(p.model, '');
  p.event({ type: 'assistant', message: { id: 'm2', model: 'z-ai/glm-5.3-flash', content: [] } });
  p.event({ type: 'assistant', message: { id: 'm3', model: 'worker', content: [] } });
  assert.equal(p.model, 'z-ai/glm-5.3-flash');
  assert.equal(parseStream(sample).model, 'claude-haiku-5-5');
});

test('pi stream: model comes from responseModel only; the alias is ignored', () => {
  const end = (m) => JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], provider: 'worker', model: 'z-ai/glm-5.3-flash', ...m } });
  assert.equal(parsePiStream(end({})).model, '');
  assert.equal(parsePiStream(end({ responseModel: 'worker' })).model, '');
  assert.equal(parsePiStream(end({ responseModel: 'glm-5.3-flash' })).model, 'glm-5.3-flash');
});

test('modelLine: confirmed, mismatch, not confirmed, plain claude', () => {
  const req = { model: 'z-ai/glm-5.3-flash', host: 'api.particle.ai', name: 'glm' };
  const at = (model) => modelLine({ model }, req);
  assert.equal(at('z-ai/glm-5.3-flash'), 'Model: z-ai/glm-5.3-flash via api.particle.ai (profile glm)');
  assert.equal(at('glm-5.3-flash'), 'Model: glm-5.3-flash via api.particle.ai (profile glm)');
  assert.match(at('gpt-x'), /^WARNING Model: asked for z-ai\/glm-5.3-flash, provider reported gpt-x via/);
  assert.equal(at(''), 'Model: z-ai/glm-5.3-flash requested via api.particle.ai (profile glm); not confirmed by the provider');
  assert.equal(modelLine({ model: 'claude-haiku-5-5' }), 'Model: claude-haiku-5-5');
});

test('status line starts with the short model name', () => {
  const p = createProgress();
  p.setModel('z-ai/glm-5.3-flash');
  assert.match(statusLine(p), /^glm-5\.3-flash · 0 tool uses · /);
});

test('profile hint names model, host and profile, and is safe inside single quotes', () => {
  const h = profileHint({ name: 'glm', model: 'z-ai/glm-5.3-flash', baseUrl: 'https://api.particle.ai/v1' });
  assert.match(h, /^You are running model z-ai\/glm-5\.3-flash through api\.particle\.ai \(profile glm\)\. .*alias worker/);
  assert.ok(!h.includes("'"));
});

test('modelLine: a pi reply with no responseModel says pi saw no different model', () => {
  const req = { model: 'particle-ai/particle-1', host: 'api.particle.ai', name: 'pi-particle' };
  assert.equal(modelLine({ model: '', answered: true }, req), 'Model: particle-ai/particle-1 via api.particle.ai (profile pi-particle); pi saw no different model from the provider');
  assert.match(modelLine({ model: '' }, req), /not confirmed by the provider/);
});

test('init event: progress.mcp keeps server names, status and error messages; mcpLine renders them', () => {
  const init = { type: 'system', subtype: 'init', model: 'claude-haiku-5-5', mcp_servers: [{ name: 'notion', status: 'connected' }, { name: 'context7', status: 'connected' }, { name: 'linear', status: 'failed' }], mcp_server_errors: { linear: 'connection refused' } };
  const p = parseStream(JSON.stringify(init));
  assert.deepEqual(p.mcp, { servers: init.mcp_servers, errors: { linear: 'connection refused' } });
  assert.equal(mcpLine(p), 'MCP servers: notion, context7 (failed: linear)');
  const none = parseStream(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'notion', status: 'failed' }] }));
  assert.equal(mcpLine(none), 'MCP servers: none connected (failed: notion)');
  assert.equal(mcpLine(parseStream(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'a', status: 'connected' }] }))), 'MCP servers: a');
});

test('no init event or no mcp fields: mcp stays undefined and mcpLine is empty', () => {
  const p = parseStream(sample);
  assert.equal(p.mcp, undefined);
  assert.equal(mcpLine(p), '');
  assert.equal(parseStream(JSON.stringify({ type: 'system', subtype: 'init', model: 'x' })).mcp, undefined);
  assert.equal(mcpLine(parseStream(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [] }))), '');
});

test('servers listed only in mcp_server_errors (skipped by Claude Code) count as failed', () => {
  const only = parseStream(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [], mcp_server_errors: { linear: 'invalid config' } }));
  assert.equal(mcpLine(only), 'MCP servers: none connected (failed: linear)');
  const mixed = parseStream(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'notion', status: 'connected' }], mcp_server_errors: { linear: 'invalid config' } }));
  assert.equal(mcpLine(mixed), 'MCP servers: notion (failed: linear)');
});
