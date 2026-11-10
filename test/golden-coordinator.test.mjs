import './tmp-cleanup.mjs';
// Golden: what `coordinator image`, `image --save`, `start`, `ls`, `attach`, `stop` and `finish` send to Instabox
// (SDK calls, HTTP requests, commands and files on the machine) and print. Must not change in the provider refactor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from '../src/coordinator.mjs';
import { golden, envNames } from './golden-util.mjs';

const KEY = 'GOLDEN_API_KEY_0123456789';
const TOK = 'GOLDEN_OAUTH_TOKEN_0123';
const applied = { proxy: { revision: 2, appliedRevision: 2 }, guest: { revision: 2, appliedRevision: 2 } };
const started = new Date('2026-01-02T03:04:05Z');

// A stand-in for the cloudy-cloud checkout: coordinator start reads the git identity and origin from it and bundles it.
function toolRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gold-tool-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a]);
  cpSync(resolve('skills/cloud-fleet'), join(dir, 'skills/cloud-fleet'), { recursive: true }); // uploaded to the machine
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Gold Tester');
  git('config', 'user.email', 'gold@example.com');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('remote', 'add', 'origin', 'https://github.com/gold/tool.git');
  return dir;
}
const root = toolRepo();

// The coordinator fixture of test/coordinator.test.mjs, recording every call in order.
function fixture({ machines = [], snapshot = 'sn_1' } = {}) {
  const calls = [];
  const dir = mkdtempSync(join(tmpdir(), 'gold-coord-'));
  const sandbox = (id, name) => ({
    sandboxId: id,
    getInfo: async () => ({ name }),
    files: { write: async (p, d) => { calls.push({ sdk: 'files.write', path: p, ...(/\/env$/.test(p) ? { envNames: envNames(d) } : /task\.md$/.test(p) ? { text: String(d) } : {}) }); } },
    commands: { run: async (cmd, o = {}) => { calls.push({ sdk: 'commands.run', cmd, cwd: o.cwd, timeoutMs: o.timeoutMs }); return { stdout: '/data/home', stderr: '', exitCode: 0 }; } },
    createSnapshot: async (o) => { calls.push({ sdk: 'createSnapshot', ...o }); return { id: 'sn_new', status: 'pending' }; },
    kill: async () => { calls.push({ sdk: 'sandbox.kill', id }); return true; },
  });
  const sdk = { Sandbox: {
    async create(template, { fetch: f, ...opts }) {
      await f('https://api.instabox.sh/v1/machines', { method: 'POST', body: '{"name":"x"}' }); // as the real SDK does
      calls.push({ sdk: 'Sandbox.create', template, opts });
      return sandbox('m_new', opts.name ?? 'sbx-abc');
    },
    async list(o) {
      calls.push({ sdk: 'Sandbox.list', ...o });
      return machines.filter((m) => Object.entries(o.metadata).every(([k, v]) => m.metadata[k] === v));
    },
    async connect(id, o) { calls.push({ sdk: 'Sandbox.connect', id, ...o }); return sandbox(id, 'img-1'); },
    async getSnapshot(id, o) { calls.push({ sdk: 'Sandbox.getSnapshot', id, ...o }); return { id, status: 'ready' }; },
    async kill(id, o) { calls.push({ sdk: 'Sandbox.kill', id, ...o }); return true; },
  } };
  const fetchFn = async (url, init = {}) => {
    calls.push({ http: init.method ?? 'GET', url: String(url), headers: init.headers, body: init.body });
    if (init.method === 'POST') return Response.json({});
    if (init.method === 'PATCH') return new Response('{}');
    if (init.method === 'DELETE') return new Response('{}');
    if (/\/secrets$/.test(url)) return Response.json(applied);
    return Response.json({ machines: machines.map((m) => ({ id: m.sandboxId, name: m.name, state: m.state, metadata: m.metadata })) });
  };
  const out = [];
  const env = { INSTABOX_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: TOK, CLOUDY_CLOUD_CONFIG: join(dir, 'env'), ...(snapshot && { CLOUDY_CLOUD_COORDINATOR_SNAPSHOT: snapshot }), PATH: '/x' };
  return { calls, out, deps: { sdk, fetchFn, env, root, sleep: async () => {}, out: (s) => out.push(s), ownerFile: join(dir, 'owner') } };
}

const coord = (id, name, cname) => ({ sandboxId: id, name, state: 'running', startedAt: started, metadata: { role: 'coordinator', name: cname } });
const normalise = (v) => JSON.parse(JSON.stringify(v)
  .replaceAll(KEY, '<API_KEY>').replaceAll(TOK, '<OAUTH_TOKEN>')
  .replace(/\b[0-9a-f]{40}\b/g, '<SHA>').replace(/cc-keep\/tool-[0-9a-f]+/g, 'cc-keep/tool-<RAND>')
  .replace(/(?:\/[\w.-]+)+\/gold-coord-\w+\/env/g, '<CONFIG_FILE>')
  .replace(/coordinator-\d{14}/g, 'coordinator-<STAMP>')
  .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, (s) => (s === started.toISOString() ? s : '<TIME>'))
  .replace(/"Idempotency-Key":"[0-9a-f-]{36}"/g, '"Idempotency-Key":"<UUID>"'));

test('coordinator calls are unchanged', async () => {
  const record = {};
  const run = async (label, args, opts, extra = {}) => {
    const f = fixture(opts);
    Object.assign(f.deps, extra);
    await main(args, f.deps);
    record[label] = { args, calls: f.calls, out: f.out };
  };
  await run('image', ['image']);
  await run('image --save', ['image', '--save'], { snapshot: '', machines: [{ sandboxId: 'm_img', name: 'img-1', metadata: { role: 'coordinator-image' } }] });
  await run('start', ['start', 'boss', '--repo', 'https://github.com/o/r', '--branch', 'main', '--task', 'do it', '--max-hours', '3']);
  await run('start --json', ['start', 'boss', '--repo', 'https://github.com/o/r', '--json']);
  await run('ls', ['ls'], { machines: [coord('m1', 'coord-boss', 'boss')] });
  await run('attach', ['attach', 'boss'], { machines: [coord('m1', 'coord-boss', 'boss')] });
  await run('stop', ['stop', 'boss'], { machines: [coord('m1', 'coord-boss', 'boss'), coord('m2', 'coord-b', 'b')] });
  await run('finish --force', ['finish', '--force'], { machines: [coord('m1', 'coord-boss', 'boss')] }, { hostname: 'instabox-coord-boss' });
  assert.equal(Object.keys(record).length, 8);
  golden('coordinator-commands', normalise(record));
});
