import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/mcp-cli.mjs';

function setup(claude, { project } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mcpcli-'));
  const env = { HOME: home, CLOUDY_CLOUD_MCP: join(home, '.config/cloudy-cloud/mcp.json'), CLOUDY_CLOUD_CLAUDE_JSON: join(home, '.claude.json') };
  writeFileSync(env.CLOUDY_CLOUD_CLAUDE_JSON, JSON.stringify(claude));
  if (project) writeFileSync(join(home, '.mcp.json'), JSON.stringify(project));
  return { home, env };
}
async function run(argv, env, home, extra = {}) {
  const out = [], err = [];
  const code = await main(argv, { env, cwd: home, isTTY: true, out: (s) => out.push(s), err: (s) => err.push(s), ...extra });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const TOKEN = 'ntn_abcdefghijklmnop9f3a';
const notion = { type: 'http', url: 'https://mcp.notion.com/mcp', headers: { Authorization: `Bearer ${TOKEN}` } };

test('add: user-scope http server with a Bearer header is stored as a reference', async () => {
  const { home, env } = setup({ mcpServers: { notion } });
  const r = await run(['add', 'notion'], env, home);
  assert.equal(r.code, 0);
  assert.equal(r.out, [
    'Found notion in ~/.claude.json (user scope):',
    '  type     http',
    '  url      https://mcp.notion.com/mcp',
    '  headers  Authorization: Bearer ntn_…9f3a',
    'This server sends a secret. Cloud machines run Claude with permission checks off, so the value is not copied.',
    'It is written as ${MCP_NOTION_TOKEN}; Instabox adds the real value to requests to mcp.notion.com only.',
    '  Store it once:  printf %s "$TOKEN" | npx --yes instabox@latest secrets set MCP_NOTION_TOKEN --host mcp.notion.com',
    'Added notion to ~/.config/cloudy-cloud/mcp.json. Every cloud subagent you start from now on gets it.',
  ].join('\n'));
  const text = readFileSync(env.CLOUDY_CLOUD_MCP, 'utf8');
  assert.match(text, /Bearer \$\{MCP_NOTION_TOKEN\}/);
  assert.ok(!text.includes(TOKEN) && !r.out.includes(TOKEN) && !r.err.includes(TOKEN));
  assert.equal(statSync(env.CLOUDY_CLOUD_MCP).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, '.config/cloudy-cloud')).mode & 0o777, 0o700);
});

test('add: local scope wins over user scope', async () => {
  const { home, env } = setup({ mcpServers: { x: { type: 'http', url: 'https://user.example.com/mcp' } } });
  const claude = { mcpServers: { x: { type: 'http', url: 'https://user.example.com/mcp' } }, projects: { [home]: { mcpServers: { x: { type: 'http', url: 'https://local.example.com/mcp' } } } } };
  writeFileSync(env.CLOUDY_CLOUD_CLAUDE_JSON, JSON.stringify(claude));
  const r = await run(['add', 'x'], env, home);
  assert.match(r.out, /\(local scope\)/);
  assert.match(readFileSync(env.CLOUDY_CLOUD_MCP, 'utf8'), /local\.example\.com/);
});

test('add: project .mcp.json is used when there is no local entry', async () => {
  const { home, env } = setup({}, { project: { mcpServers: { p: { type: 'http', url: 'https://p.example.com/mcp' } } } });
  const r = await run(['add', 'p'], env, home);
  assert.match(r.out, /Found p in .*\.mcp\.json \(project scope\)/);
});

test('add: stdio server with an env secret asks for hosts and prints --host', async () => {
  const { home, env } = setup({ mcpServers: { 'my-srv': { command: 'npx', args: ['-y', '@x/mcp'], env: { NOTION_API_KEY: 'ntn_secretsecret1234' } } } });
  let asked;
  const r = await run(['add', 'my-srv'], env, home, { ask: async (q) => { asked = q; return 'api.notion.com, b.example.com'; } });
  assert.equal(r.code, 0);
  assert.match(asked, /Which HTTPS hosts does this server send the token to\? \(comma-separated, exact hostnames, required\)/);
  assert.match(r.out, /NOTION_API_KEY=ntn_…1234/);
  assert.match(r.out, /secrets set MCP_MY_SRV_TOKEN --host api\.notion\.com --host b\.example\.com/);
  const text = readFileSync(env.CLOUDY_CLOUD_MCP, 'utf8');
  assert.match(text, /\$\{MCP_MY_SRV_TOKEN\}/);
  assert.ok(!text.includes('secretsecret'));
});

test('add: two secrets get distinct names', async () => {
  const { home, env } = setup({ mcpServers: { s: { type: 'http', url: 'https://a.example.com', headers: { Authorization: 'Bearer abcdefghijklmnop', 'X-Api-Key': 'zzzzzzzzzz' } } } });
  const r = await run(['add', 's'], env, home);
  assert.match(r.out, /secrets set MCP_S_TOKEN --host a\.example\.com/);
  assert.match(r.out, /secrets set MCP_S_2_TOKEN --host a\.example\.com/);
});

test('add: stdio secret with an empty host answer or no terminal writes nothing', async () => {
  const { home, env } = setup({ mcpServers: { s: { command: 'npx', args: ['x'], env: { API_TOKEN: 'abcdefghijkl' } } } });
  const a = await run(['add', 's'], env, home, { ask: async () => '  ' });
  assert.equal(a.code, 1);
  assert.equal(a.err, 'Not added: a secret without a host list would be sent to any host the subagent reaches.');
  const b = await run(['add', 's'], env, home, { isTTY: false });
  assert.equal(b.code, 1);
  assert.match(b.err, /Run this in a terminal\./);
  const c = await run(['add', 's'], env, home, { ask: async () => 'not a host!' });
  assert.equal(c.code, 1);
  assert.ok(!existsSync(env.CLOUDY_CLOUD_MCP));
});

test('add: rejections from the core check print the reason and write nothing', async () => {
  const { home, env } = setup({ mcpServers: { bad: { command: '/usr/local/bin/x' }, oa: { type: 'http', url: 'https://o.example.com', oauth: {} } } });
  const a = await run(['add', 'bad'], env, home);
  assert.equal(a.code, 1);
  assert.equal(a.err, 'Not added: the command is /usr/local/bin/x; only npx and uvx servers can run on a cloud machine');
  const b = await run(['add', 'oa'], env, home);
  assert.equal(b.err, 'Not added: uses OAuth sign-in, which a headless subagent cannot complete');
  assert.ok(!existsSync(env.CLOUDY_CLOUD_MCP));
});

test('add: unknown name exits 1', async () => {
  const { home, env } = setup({});
  const r = await run(['add', 'nope'], env, home);
  assert.equal(r.code, 1);
  assert.equal(r.err, 'No MCP server named nope in your Claude Code config. See: claude mcp list');
});

test('ls, replace and rm', async () => {
  const { home, env } = setup({ mcpServers: { notion, c7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } } });
  assert.equal((await run(['ls'], env, home)).out, 'No MCP servers are shared with cloud subagents. Add one with: cloudy-cloud mcp add <name>');
  await run(['add', 'notion'], env, home);
  await run(['add', 'c7'], env, home);
  assert.equal((await run(['add', 'c7'], env, home)).out.split('\n')[0], 'Found c7 in ~/.claude.json (user scope):');
  assert.match((await run(['add', 'c7'], env, home)).out, /Replacing the existing c7 entry\./);
  assert.equal((await run(['ls'], env, home)).out, 'notion  http  mcp.notion.com  needs MCP_NOTION_TOKEN\nc7  stdio  npx @upstash/context7-mcp');
  const rm = await run(['rm', 'notion'], env, home);
  assert.equal(rm.out, 'Removed notion from ~/.config/cloudy-cloud/mcp.json.');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(env.CLOUDY_CLOUD_MCP, 'utf8')).mcpServers), ['c7']);
  const again = await run(['rm', 'notion'], env, home);
  assert.equal(again.code, 1);
  assert.equal(again.err, 'No server named notion in ~/.config/cloudy-cloud/mcp.json.');
});

// The real src/mcpsync.mjs decides; these cases leaked a literal value before the CLI and the loader shared one rule.
const FAKE = 'FAKEFAKEFAKE5678';
const noLeak = (home, env, r) => {
  assert.ok(!r.out.includes(FAKE) && !r.err.includes(FAKE), r.out + r.err);
  assert.ok(!existsSync(env.CLOUDY_CLOUD_MCP) || !readFileSync(env.CLOUDY_CLOUD_MCP, 'utf8').includes(FAKE));
};

test('add: a Basic Authorization header is masked and stored as a reference', async () => {
  const { home, env } = setup({ mcpServers: { basic: { type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: `Basic dXNl${FAKE}` } } } });
  const r = await run(['add', 'basic'], env, home);
  assert.equal(r.code, 0, r.err);
  assert.match(readFileSync(env.CLOUDY_CLOUD_MCP, 'utf8'), /"Authorization": "\$\{MCP_BASIC_TOKEN\}"/);
  assert.match(r.out, /secrets set MCP_BASIC_TOKEN --host api\.example\.com/);
  noLeak(home, env, r);
});

test('add: a key in the url or in an argument is never printed and not added', async () => {
  const { home, env } = setup({ mcpServers: {
    u: { type: 'http', url: `https://mcp.exa.ai/mcp?exaApiKey=${FAKE}` },
    a: { command: 'npx', args: ['-y', 'x-mcp', `--api-key=sk-${FAKE}`] },
  } });
  const u = await run(['add', 'u'], env, home);
  assert.equal(u.code, 1);
  assert.match(u.err, /^Not added: url carries a secret value/);
  noLeak(home, env, u);
  const a = await run(['add', 'a'], env, home);
  assert.equal(a.code, 1);
  assert.match(a.err, /^Not added: an argument carries a secret value/);
  noLeak(home, env, a);
});

test('add: two servers whose names map to the same secret name are refused', async () => {
  const h = (n) => ({ type: 'http', url: `https://${n}.example.com`, headers: { Authorization: 'Bearer abcdefghijklmnop' } });
  const { home, env } = setup({ mcpServers: { 'my-srv': h('a'), my_srv: h('b') } });
  assert.equal((await run(['add', 'my-srv'], env, home)).code, 0);
  const r = await run(['add', 'my_srv'], env, home);
  assert.equal(r.code, 1);
  assert.equal(r.err, 'Not added: my-srv already uses MCP_MY_SRV_TOKEN. Rename one of the two servers in Claude Code first.');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(env.CLOUDY_CLOUD_MCP, 'utf8')).mcpServers), ['my-srv']);
});

test('add: local scope is found under the current folder inside a git repo', async () => {
  const { home, env } = setup({});
  execFileSync('git', ['init', '-q'], { cwd: home });
  const sub = join(home, 'sub');
  mkdirSync(sub);
  writeFileSync(env.CLOUDY_CLOUD_CLAUDE_JSON, JSON.stringify({ projects: { [sub]: { mcpServers: { x: { type: 'http', url: 'https://x.example.com' } } } } }));
  const out = [], err = [];
  const code = await main(['add', 'x'], { env, cwd: sub, isTTY: true, out: (s) => out.push(s), err: (s) => err.push(s) });
  assert.equal(code, 0, err.join('\n'));
  assert.match(out[0], /\(local scope\)/);
});
