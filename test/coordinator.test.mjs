import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from '../src/coordinator.mjs';

const IBK = 'ibk_REALKEY_0123456789';
const TOK = 'sk-ant-oat01-REALTOKEN0123';
const PROV = 'sk-or-PROVIDERKEY0123';
const applied = { proxy: { revision: 2, appliedRevision: 2 }, guest: { revision: 2, appliedRevision: 2 } };

function fixture({ machines = [], snapshot = 'sn_1' } = {}) {
  const log = { create: [], cmds: [], writes: [], killed: [], snapshots: [], fetches: [], out: [] };
  const dir = mkdtempSync(join(tmpdir(), 'cc-coord-'));
  const configFile = join(dir, 'env');
  const mk = (id, name, metadata) => ({ sandboxId: id, name, metadata, state: 'running', startedAt: new Date('2026-01-02T03:04:05Z') });
  const sandbox = (id, name) => ({
    sandboxId: id,
    getInfo: async () => ({ name }),
    files: { write: async (p, d) => { log.writes.push({ p, d }); } },
    commands: { run: async (cmd, o) => { log.cmds.push(cmd); return { stdout: '/data/home', stderr: '', exitCode: 0 }; } },
    createSnapshot: async (o) => { log.snapshots.push(o); return { id: 'sn_new', status: 'pending' }; },
    kill: async () => { log.killed.push(id); return true; },
  });
  const sdk = { Sandbox: {
    async create(template, opts) { log.create.push({ template, opts }); return sandbox('m_new', opts.name ?? 'sbx-abc'); },
    async list({ metadata }) { return machines.filter((m) => Object.entries(metadata).every(([k, v]) => m.metadata[k] === v)); },
    async connect(id) { return sandbox(id, 'img-1'); },
    async getSnapshot(id) { return { id, status: 'ready' }; },
    async kill(id) { log.killed.push(id); return true; },
  } };
  const fetchFn = async (url, init) => { log.fetches.push({ url, ...init }); return init.method === 'PATCH' ? new Response('{}') : Response.json(applied); };
  const env = { INSTABOX_API_KEY: IBK, CLAUDE_CODE_OAUTH_TOKEN: TOK, OPENROUTER_API_KEY: PROV, CLAUDE_CLOUD_CONFIG: configFile, ...(snapshot && { CLAUDE_CLOUD_COORDINATOR_SNAPSHOT: snapshot }), PATH: '/x' };
  const deps = { sdk, fetchFn, env, root: resolve('.'), sleep: async () => {}, out: (s) => log.out.push(s) };
  return { log, deps, configFile, mk };
}

test('image creates a labelled machine, installs claude-cloud and prints the login steps', async () => {
  const f = fixture();
  await main(['image'], f.deps);
  assert.equal(f.log.create[0].opts.metadata.role, 'coordinator-image');
  assert.ok(f.log.cmds.some((c) => /npm install/.test(c)));
  assert.ok(f.log.fetches.some((x) => x.method === 'PATCH' && /secrets/.test(x.url)));
  const text = f.log.out.join('\n');
  assert.match(text, /npx --yes instabox@latest ssh sbx-abc/);
  assert.match(text, /claude auth login/);
  assert.match(text, /coordinator image --save/);
});

test('image --save records the snapshot id and deletes the image machine', async () => {
  const f = fixture({ snapshot: '' });
  f.deps.sdk.Sandbox.list = async () => [f.mk('m_img', 'img-1', { role: 'coordinator-image' })];
  await main(['image', '--save'], f.deps);
  assert.equal(f.log.snapshots.length, 1);
  assert.match(readFileSync(f.configFile, 'utf8'), /^CLAUDE_CLOUD_COORDINATOR_SNAPSHOT=sn_new$/m);
  assert.equal(statSync(f.configFile).mode & 0o777, 0o600);
  assert.deepEqual(f.log.killed, ['m_img']);
});

test('start without a snapshot fails and points to coordinator image', async () => {
  const f = fixture({ snapshot: '' });
  await assert.rejects(main(['start', 'boss', '--repo', 'https://github.com/o/r'], f.deps), /coordinator image/);
  assert.equal(f.log.create.length, 0);
});

test('start creates from the snapshot, attaches GH_TOKEN, writes keys by file and starts tmux', async () => {
  const f = fixture();
  await main(['start', 'boss', '--repo', 'https://github.com/o/r', '--branch', 'main'], f.deps);
  const { template, opts } = f.log.create[0];
  assert.equal(template, 'sn_1');
  assert.equal(opts.autoSuspendMs, 0);
  assert.deepEqual(opts.metadata, { purpose: 'claude-cloud', role: 'coordinator', name: 'boss' });
  assert.ok(f.log.fetches.some((x) => x.method === 'PATCH' && x.body.includes('GH_TOKEN')));
  const w = f.log.writes.find((x) => x.p === '/data/home/.config/claude-cloud/env');
  assert.ok(w.d.includes(`INSTABOX_API_KEY=${IBK}`) && w.d.includes(`CLAUDE_CODE_OAUTH_TOKEN=${TOK}`) && w.d.includes(`OPENROUTER_API_KEY=${PROV}`));
  assert.ok(!w.d.includes('PATH='));
  for (const c of f.log.cmds) for (const secret of [IBK, TOK, PROV]) assert.ok(!c.includes(secret), `secret in command: ${c}`);
  assert.ok(f.log.cmds.some((c) => /chmod 600/.test(c)));
  assert.ok(f.log.cmds.some((c) => /git clone -q -b 'main' 'https:\/\/github.com\/o\/r'/.test(c)));
  assert.ok(f.log.cmds.some((c) => /tmux new-session -d -s claude/.test(c) && /claude-cloud --remote-control .*boss/.test(c)));
  const text = f.log.out.join('\n');
  assert.match(text, /"boss"/);
  assert.match(text, /coordinator attach boss/);
});

test('start rejects bad repo urls and duplicate names', async () => {
  const f = fixture({ machines: [{ sandboxId: 'm1', name: 'coord-boss', metadata: { role: 'coordinator', name: 'boss' } }] });
  await assert.rejects(main(['start', 'x', '--repo', 'git@github.com:o/r.git'], f.deps), /--repo/);
  await assert.rejects(main(['start', 'boss', '--repo', 'https://github.com/o/r'], f.deps), /already exists/);
});

test('ls lists only coordinators', async () => {
  const f = fixture({ machines: [
    { sandboxId: 'm1', name: 'coord-boss', state: 'running', startedAt: new Date('2026-01-02T03:04:05Z'), metadata: { role: 'coordinator', name: 'boss' } },
    { sandboxId: 'm2', name: 'worker-1', state: 'running', startedAt: new Date(), metadata: { purpose: 'claude-cloud', owner: 'x' } },
    { sandboxId: 'm3', name: 'img', state: 'running', startedAt: new Date(), metadata: { role: 'coordinator-image' } },
  ] });
  await main(['ls'], f.deps);
  const text = f.log.out.join('\n');
  assert.match(text, /boss\trunning\t2026-01-02T03:04:05.000Z\tcoord-boss/);
  assert.ok(!/worker-1|img/.test(text));
});

test('stop deletes only the named coordinator', async () => {
  const f = fixture({ machines: [
    { sandboxId: 'm1', name: 'coord-a', metadata: { role: 'coordinator', name: 'a' } },
    { sandboxId: 'm2', name: 'coord-b', metadata: { role: 'coordinator', name: 'b' } },
  ] });
  await main(['stop', 'b'], f.deps);
  assert.deepEqual(f.log.killed, ['m2']);
  assert.match(f.log.out.join('\n'), /cleanup process/);
  await assert.rejects(main(['stop', 'zzz'], f.deps), /No coordinator named zzz/);
});

test('attach prints the ssh command', async () => {
  const f = fixture({ machines: [{ sandboxId: 'm1', name: 'coord-a', metadata: { role: 'coordinator', name: 'a' } }] });
  await main(['attach', 'a'], f.deps);
  assert.equal(f.log.out[0], 'npx --yes instabox@latest ssh coord-a -- tmux attach -t claude');
});

test('launcher: coordinator goes to the script; plain claude-cloud still starts claude', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-coord-l-'));
  const stub = join(dir, 'claude');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\n`);
  chmodSync(stub, 0o755);
  const cfg = join(dir, 'env');
  writeFileSync(cfg, `INSTABOX_API_KEY=${IBK}\nCLAUDE_CODE_OAUTH_TOKEN=${TOK}\n`);
  const env = { PATH: `${dir}:${process.env.PATH}`, HOME: dir, CLAUDE_CLOUD_CONFIG: cfg };
  const sh = (args, extra = {}) => spawnSync('/bin/sh', [resolve('bin/claude-cloud'), ...args], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' });
  const r = sh(['coordinator']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: claude-cloud coordinator/);
  assert.ok(!existsSync(join(dir, 'argv')));
  assert.equal(sh([]).status, 0);
  const plain = readFileSync(join(dir, 'argv'), 'utf8');
  assert.ok(!/cloud coordinator/.test(plain));
  sh(['--remote-control', 'boss'], { CLAUDE_CLOUD_COORDINATOR: '1' });
  const coord = readFileSync(join(dir, 'argv'), 'utf8');
  assert.match(coord, /Never print, share, commit or send these keys/);
  assert.match(coord, /--remote-control\nboss/);
});

test('tmux is installed after refreshing package lists (Instabox images ship without them)', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/coordinator.mjs', import.meta.url), 'utf8');
  assert.match(src, /apt-get update[^\n]*&&[^\n]*apt-get install -y[^\n]*tmux/);
});

test('git is set up to use the GitHub token before claude-cloud is cloned', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/coordinator.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function installTool'), src.indexOf('async function image'));
  assert.ok(body.indexOf('gh auth setup-git') > -1 && body.indexOf('gh auth setup-git') < body.indexOf('git clone'));
});
