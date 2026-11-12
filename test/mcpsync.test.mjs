import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcp, checkServer, mcpFile, mcpConfigText, SECRET_REF, isLiteralSecret, forHarness } from '../src/mcpsync.mjs';
import { redact } from '../src/events.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'mcp-'));
const withFile = (text) => { const f = join(tmp(), 'mcp.json'); writeFileSync(f, typeof text === 'string' ? text : JSON.stringify(text)); return { CLOUDY_CLOUD_MCP: f }; };
const reason = (name, entry) => { const r = checkServer(name, entry); assert.equal(r.ok, false, JSON.stringify(entry)); return r.reason; };
const ok = (entry, name = 'srv') => { const r = checkServer(name, entry); assert.equal(r.ok, true, r.reason); return r; };

test('mcpFile honours CLOUDY_CLOUD_MCP and defaults under ~/.config', () => {
  assert.equal(mcpFile({ CLOUDY_CLOUD_MCP: '/x/y.json' }), '/x/y.json');
  assert.match(mcpFile({}), /\.config\/cloudy-cloud\/mcp\.json$/);
});

test('missing file means the feature is off', () => {
  assert.deepEqual(loadMcp({ CLOUDY_CLOUD_MCP: join(tmp(), 'none.json') }), { servers: {}, skipped: [], secrets: [] });
});

test('invalid JSON and a bad top level throw with the path', () => {
  const e1 = withFile('{nope');
  assert.throws(() => loadMcp(e1), (e) => e.message.startsWith(`Could not read ${e1.CLOUDY_CLOUD_MCP}: `));
  for (const bad of [[], { servers: {} }, { mcpServers: [] }, { mcpServers: null }, 'x']) {
    const e = withFile(bad);
    assert.throws(() => loadMcp(e), (err) => err.message.startsWith(`Could not read ${e.CLOUDY_CLOUD_MCP}: `));
  }
});

test('accepts https http/sse servers and keeps the entry unchanged', () => {
  const entry = { type: 'http', url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer ${MCP_NOTION_TOKEN}', 'X-Plain': 'yes' } };
  const r = ok(entry);
  assert.deepEqual(r.entry, entry);
  assert.deepEqual(r.secrets, ['MCP_NOTION_TOKEN']);
  ok({ type: 'sse', url: 'https://example.com/sse' });
  assert.deepEqual(ok({ type: 'http', url: 'https://example.com/x' }).secrets, []);
});

test('accepts npx and uvx stdio servers, with or without type', () => {
  ok({ command: 'npx', args: ['-y', '@upstash/context7-mcp'] });
  ok({ type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], env: { MCP_X: '1', FOO_TOKEN: '${MCP_FOO_TOKEN}' } });
  ok({ command: 'npx' });
});

test('rejects bad names', () => {
  assert.match(reason('bad name', { command: 'npx' }), /name/);
  assert.match(reason('a.b', { command: 'npx' }), /name/);
});

test('rejects other commands', () => {
  assert.equal(reason('s', { command: '/Users/me/bin/x' }), 'the command is not npx or uvx; only npx and uvx servers can run on a cloud machine');
  assert.match(reason('s', { command: 'node', args: [] }), /the command is not npx or uvx/);
  assert.match(reason('s', {}), /only npx and uvx/);
});

test('rejects unsafe args', () => {
  for (const args of [['/etc/passwd'], ['~/x'], ['a/../b'], ['..'], ['--dir=~/x'], [1]]) assert.match(reason('s', { command: 'npx', args }), /arg/);
  assert.match(reason('s', { command: 'npx', args: 'x' }), /arg/);
});

test('rejects headersHelper, oauth and unsupported types', () => {
  assert.match(reason('s', { type: 'http', url: 'https://a.com', headersHelper: 'x' }), /uses headersHelper, a local script the machine does not have/);
  assert.match(reason('s', { type: 'http', url: 'https://a.com', oauth: {} }), /uses OAuth sign-in, which a headless subagent cannot complete/);
  for (const t of ['ws', 'sdk', 'weird']) assert.equal(reason('s', { type: t, url: 'https://a.com' }), 'this server type is not supported on a cloud machine');
});

test('rejects http and private hosts', () => {
  assert.match(reason('s', { type: 'http', url: 'http://example.com' }), /url must be https/);
  for (const h of ['localhost', 'foo.local', '127.0.0.1', '127.9.9.9', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '0.0.0.0', '[::1]']) {
    assert.match(reason('s', { type: 'http', url: `https://${h}:8080/mcp` }), /url points at localhost, which does not exist on the machine/, h);
  }
  ok({ type: 'http', url: 'https://172.32.0.1/x' });
  assert.match(reason('s', { type: 'http', url: 'not a url' }), /url/);
  assert.match(reason('s', { type: 'http' }), /url/);
});

test('rejects literal secrets in env and headers', () => {
  const msg = /contains a secret value; run cloudy-cloud mcp add to store it as an Instabox secret instead/;
  assert.match(reason('s', { command: 'npx', env: { GITHUB_TOKEN: 'abc' } }), msg);
  assert.match(reason('s', { command: 'npx', env: { MY_PASSWORD: 'abc' } }), msg);
  assert.match(reason('s', { command: 'npx', env: { OTHER: 'ghp_abcdefghijklmnop' } }), msg);
  assert.match(reason('s', { type: 'http', url: 'https://a.com', headers: { 'X-Api-Key': 'abc' } }), msg);
  assert.match(reason('s', { type: 'http', url: 'https://a.com', headers: { Authorization: 'Bearer abc' } }), msg);
  assert.match(reason('s', { type: 'http', url: 'https://a.com', headers: { Authorization: 'Basic dXNlcjpwYXNz' } }), msg);
  assert.match(reason('s', { type: 'http', url: 'https://a.com', headers: { 'X-Custom': 'Bearer abcdefghijklmnop' } }), msg);
  // a reference in a credential slot is fine
  ok({ command: 'npx', env: { GITHUB_TOKEN: '${MCP_GH_TOKEN}' } });
});

test('rejects a secret in the url query, an argument, or a map on the wrong server type', () => {
  assert.match(reason('s', { type: 'http', url: 'https://mcp.exa.ai/mcp?exaApiKey=abcdefgh1234' }), /url carries a secret/);
  assert.match(reason('s', { type: 'http', url: 'https://a.com/mcp?x=ghp_abcdefghijklmnop' }), /url carries a secret/);
  ok({ type: 'http', url: 'https://a.com/mcp?region=eu' });
  assert.match(reason('s', { command: 'npx', args: ['x', '--api-key=sk-abcdefghijkl'] }), /argument \d+ carries a secret/);
  // env on an http entry and headers on a stdio entry are still copied to the machine, so they are checked too
  assert.match(reason('s', { type: 'http', url: 'https://a.com', env: { X_TOKEN: 'literal' } }), /contains a secret value/);
  assert.match(reason('s', { command: 'npx', headers: { Authorization: 'Bearer abcdefghijklmnop' } }), /contains a secret value/);
});

test('isLiteralSecret is the one rule the CLI shares', () => {
  assert.equal(isLiteralSecret('Authorization', 'Basic dXNlcjpwYXNz', true), true);
  assert.equal(isLiteralSecret('Authorization', 'Bearer ${MCP_X_TOKEN}', true), false);
  assert.equal(isLiteralSecret('LINEAR_API_KEY', 'lin_api_abc', false), true);
  assert.equal(isLiteralSecret('REGION', 'eu', false), false);
  assert.equal(isLiteralSecret('OTHER', 'ghp_abcdefghijklmnop', false), true);
});

test('rejects references that are not MCP_*_TOKEN', () => {
  assert.equal(reason('s', { command: 'npx', env: { A: '${HOME}' } }), 'references a variable; cloud machines only expand MCP_<NAME>_TOKEN secrets');
  assert.match(reason('s', { type: 'http', url: 'https://a.com', headers: { 'X-A': '${MCP_x_TOKEN}' } }), /references a variable/);
  assert.match(reason('s', { command: 'npx', args: ['${FOO}'] }), /references a variable/);
  assert.match(reason('s', { type: 'http', url: 'https://a.com/${FOO}' }), /references a variable/);
});

test('SECRET_REF matches only the exact form', () => {
  assert.ok(SECRET_REF.test('${MCP_NOTION_TOKEN}'));
  for (const v of ['${GH_TOKEN}', '${MCP_X}', 'x${MCP_X_TOKEN}', '$MCP_X_TOKEN']) assert.ok(!SECRET_REF.test(v), v);
});

test('loadMcp splits servers and skipped, dedupes and sorts secrets', () => {
  const env = withFile({ mcpServers: {
    zed: { type: 'http', url: 'https://z.com', headers: { Authorization: 'Bearer ${MCP_Z_TOKEN}' } },
    alpha: { command: 'npx', env: { A_TOKEN: '${MCP_A_TOKEN}', B_TOKEN: '${MCP_Z_TOKEN}' } },
    bad: { command: 'bash' },
    'bad name': { command: 'npx' },
    nul: null,
  } });
  const r = loadMcp(env);
  assert.deepEqual(Object.keys(r.servers).sort(), ['alpha', 'zed']);
  assert.deepEqual(r.secrets, ['MCP_A_TOKEN', 'MCP_Z_TOKEN']);
  assert.deepEqual(r.skipped.map((s) => s.name).sort(), ['bad', 'bad name', 'nul']);
  assert.ok(r.skipped.every((s) => typeof s.reason === 'string' && !s.reason.includes('\n')));
});

test('secrets of skipped servers are not reported', () => {
  const r = loadMcp(withFile({ mcpServers: { s: { command: 'bash', env: { A_TOKEN: '${MCP_A_TOKEN}' } } } }));
  assert.deepEqual(r.secrets, []);
});

test('mcpConfigText round-trips and never contains a redactable value', () => {
  const r = loadMcp(withFile({ mcpServers: {
    leak: { type: 'http', url: 'https://a.com', headers: { 'X-Foo': 'ghp_abcdefghijklmnopqrstuv' } },
    good: { type: 'http', url: 'https://b.com', headers: { Authorization: 'Bearer ${MCP_GOOD_TOKEN}' } },
  } }));
  assert.deepEqual(r.skipped.map((s) => s.name), ['leak']);
  const text = mcpConfigText(r.servers);
  assert.deepEqual(JSON.parse(text), { mcpServers: r.servers });
  assert.ok(!text.includes('ghp_'));
  assert.equal(redact(text), text);
});

test('only the fields of the entry type are kept: an http entry drops args, a stdio entry drops url', () => {
  const r = ok({ type: 'http', url: 'https://a.com/mcp', args: ['ghp_abcdefghijklmnopqrst'], command: 'node', extra: 'ghp_abcdefghijklmnopqrst' });
  assert.deepEqual(r.entry, { type: 'http', url: 'https://a.com/mcp' });
  const s = ok({ command: 'npx', args: ['-y', 'srv'], url: 'https://x:y@a.com/ghp_abcdefghijklmnopqrst', headers: { A: 'b' }, other: ['ghp_abcdefghijklmnopqrst'] });
  assert.deepEqual(s.entry, { command: 'npx', args: ['-y', 'srv'] });
});

test('credential-looking arguments and URL userinfo are secrets', () => {
  assert.match(reason('s', { command: 'npx', args: ['server', '--password=hunter2'] }), /argument 2 carries a secret value/);
  assert.match(reason('s', { command: 'npx', args: ['server', '--api-key', 'abc12345'] }), /argument 3 carries a secret value/);
  assert.match(reason('s', { type: 'http', url: 'https://alice:secretpass@example.com/mcp' }), /url carries a secret value/);
  assert.match(reason('s', { type: 'http', url: 'https://tokenonly@example.com/mcp' }), /url carries a secret value/);
  ok({ command: 'npx', args: ['server', '--token=${MCP_S_TOKEN}', '--port=8080'] });
  assert.equal(isLiteralSecret(undefined, 'https://alice:pw@example.com/'), true);
});

test('rejection reasons never repeat a value from the entry', () => {
  const t = 'ghp_abcdefghijklmnopqrst';
  for (const entry of [
    { command: 'npx', args: [`/tmp/${t}`] }, { command: 'npx', args: [`--password=${t}x`] }, { command: `${t}x` },
    { type: `${t}x` }, { type: 'http', url: `https://a.com/${t}?${t}` }, { type: 'http', url: `http://${t}.localhost/x` },
    { command: 'npx', env: { A: `\${${t}}` } }, { command: 'npx', env: { A: 'hunter2hunter2', [`${t}_TOKEN`]: 'x' } },
  ]) assert.ok(!reason('s', entry).includes(t.slice(0, 12)) && !JSON.stringify(reason('s', entry)).includes('hunter2'), JSON.stringify(entry));
});

test('a url host that is not a plain hostname is rejected by the loader too', () => {
  const r = checkServer('inj', { type: 'http', url: 'https://example.com;id/mcp' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /plain hostname/);
});

test('forHarness moves sse servers to skipped for pi and leaves claude alone', () => {
  const mcp = { servers: { a: { type: 'sse', url: 'https://a.example.com/s' }, b: { type: 'http', url: 'https://b.example.com' } }, skipped: [{ name: 'z', reason: 'r' }], secrets: ['MCP_B_TOKEN'] };
  const pi = forHarness(mcp, 'pi');
  assert.deepEqual(Object.keys(pi.servers), ['b']);
  assert.deepEqual(pi.skipped, [{ name: 'z', reason: 'r' }, { name: 'a', reason: 'pi does not support the SSE transport' }]);
  assert.equal(Object.keys(mcp.servers).length, 2, 'input is not mutated');
  assert.equal(forHarness(mcp, 'claude'), mcp);
  assert.equal(forHarness(mcp, undefined), mcp);
});

test('forHarness for pi drops the proxy secret and the allowed-literal name of a skipped sse server', () => {
  const mcp = { servers: { a: { type: 'sse', url: 'https://a.example.com/s', headers: { Authorization: 'Bearer ${MCP_A_TOKEN}' } }, b: { type: 'http', url: 'https://b.example.com', headers: { X: '${MCP_B_TOKEN}' } }, c: { type: 'sse', url: 'https://c.example.com/s', headers: { X: 'lit-value-123' } } }, skipped: [], secrets: ['MCP_A_TOKEN', 'MCP_B_TOKEN'], literal: ['c'], values: new Set(['lit-value-123']) };
  const pi = forHarness(mcp, 'pi');
  assert.deepEqual(pi.secrets, ['MCP_B_TOKEN']);
  assert.deepEqual(pi.literal, []);
});

test('forHarness for omp skips values omp would run or resolve as a variable name, and keeps our references', () => {
  const ok = { type: 'http', url: 'https://ok.example.com', headers: { Authorization: 'Bearer ${MCP_OK_TOKEN}', 'X-Key': '${MCP_OK_TOKEN}', 'X-Flag': 'true-ish value' } };
  const mcp = { servers: { ok, name: { type: 'http', url: 'https://a.example.com', headers: { 'X-Credential': 'PARTICLE_API_KEY' } }, cmd: { type: 'http', url: 'https://b.example.com', headers: { A: '!cat /etc/passwd' } }, env: { type: 'stdio', command: 'npx', args: ['x'], env: { T: 'OPENROUTER_API_KEY' } } }, skipped: [], secrets: ['MCP_OK_TOKEN'] };
  const r = forHarness(mcp, 'omp');
  assert.deepEqual(Object.keys(r.servers), ['ok']);
  assert.deepEqual(r.skipped.map((x) => x.name).sort(), ['cmd', 'env', 'name']);
  assert.match(r.skipped[0].reason, /MCP_<NAME>_TOKEN/);
  assert.deepEqual(r.secrets, ['MCP_OK_TOKEN']);
  assert.equal(Object.keys(forHarness(mcp, 'claude').servers).length, 4);
});
