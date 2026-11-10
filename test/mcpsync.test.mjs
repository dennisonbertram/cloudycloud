import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcp, checkServer, mcpFile, mcpConfigText, SECRET_REF } from '../src/mcpsync.mjs';
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
  assert.equal(reason('s', { command: '/Users/me/bin/x' }), 'the command is /Users/me/bin/x; only npx and uvx servers can run on a cloud machine');
  assert.match(reason('s', { command: 'node', args: [] }), /the command is node; only npx and uvx/);
  assert.match(reason('s', {}), /only npx and uvx/);
});

test('rejects unsafe args', () => {
  for (const args of [['/etc/passwd'], ['~/x'], ['a/../b'], ['..'], ['--dir=~/x'], [1]]) assert.match(reason('s', { command: 'npx', args }), /arg/);
  assert.match(reason('s', { command: 'npx', args: 'x' }), /arg/);
});

test('rejects headersHelper, oauth and unsupported types', () => {
  assert.match(reason('s', { type: 'http', url: 'https://a.com', headersHelper: 'x' }), /uses headersHelper, a local script the machine does not have/);
  assert.match(reason('s', { type: 'http', url: 'https://a.com', oauth: {} }), /uses OAuth sign-in, which a headless subagent cannot complete/);
  for (const t of ['ws', 'sdk', 'weird']) assert.equal(reason('s', { type: t, url: 'https://a.com' }), `type ${t} is not supported on a cloud machine`);
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

test('rejects references that are not MCP_*_TOKEN', () => {
  assert.equal(reason('s', { command: 'npx', env: { A: '${HOME}' } }), 'references ${HOME}; cloud machines only expand MCP_<NAME>_TOKEN secrets');
  assert.match(reason('s', { type: 'http', url: 'https://a.com', headers: { 'X-A': '${MCP_x_TOKEN}' } }), /references \$\{MCP_x_TOKEN\}/);
  assert.match(reason('s', { command: 'npx', args: ['${FOO}'] }), /references \$\{FOO\}/);
  assert.match(reason('s', { type: 'http', url: 'https://a.com/${FOO}' }), /references \$\{FOO\}/);
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
