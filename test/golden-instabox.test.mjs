import './tmp-cleanup.mjs';
// Golden: every SDK call and HTTP request that today's Instabox code makes for create, secrets, sandbox calls, list,
// delete and ports. Must not change in the provider refactor. (Worker and coordinator goldens are in their own files.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstaboxSandbox } from '../src/providers/instabox.mjs';
import { createProvider } from '../src/providers/instabox.mjs';
import { reap } from '../src/reaper.mjs';
import { listMachines } from '../src/dashboard.mjs';
import { run as openRun } from '../src/open.mjs';
import { golden } from './golden-util.mjs';

const KEY = 'GOLDEN_API_KEY_0123456789';
const applied = { proxy: { revision: 2, appliedRevision: 2 }, guest: { revision: 2, appliedRevision: 2 } };
const fns = (_k, v) => (typeof v === 'function' ? '<fn>' : v);
const normalise = (v) => JSON.parse(JSON.stringify(v, fns).replaceAll(KEY, '<API_KEY>').replace(/"Idempotency-Key":"[0-9a-f-]{36}"/g, '"Idempotency-Key":"<UUID>"'));

test('Instabox requests are unchanged', async () => {
  const record = {};

  // create + secrets + sandbox calls
  const calls = [];
  const sdk = { Sandbox: { async create(template, { fetch: f, ...opts }) {
    await f('https://api.instabox.sh/v1/machines', { method: 'POST', body: '{"name":"x"}' }); // as the real SDK does
    await f('https://api.instabox.sh/v1/machines/m1/exec', { method: 'POST', body: '{}' }); // other requests pass through unchanged
    calls.push({ sdk: 'Sandbox.create', template, opts });
    return {
      sandboxId: 'm-123',
      files: { write: async (...a) => { calls.push({ sdk: 'files.write', args: a }); }, read: async (...a) => { calls.push({ sdk: 'files.read', args: a }); return new Uint8Array(); } },
      kill: async () => { calls.push({ sdk: 'kill' }); return true; },
      commands: { async run(cmd, o) {
        calls.push({ sdk: 'commands.run', cmd, opts: o });
        if (!o.background) return { stdout: 'fg', stderr: '', exitCode: 0 };
        return { kill: async () => true, wait: async (w) => { calls.push({ sdk: 'job.wait', opts: w }); return { stdout: 'bg', stderr: '', exitCode: 0 }; } };
      } },
    };
  } } };
  const fetchFn = async (url, init = {}) => {
    calls.push({ http: init.method ?? 'GET', url: String(url), headers: init.headers, body: init.body });
    return init.method === 'PATCH' || init.method === 'POST' ? new Response('{}') : Response.json(applied);
  };
  const create = createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, fetchFn, { pollMs: 1, timeoutMs: 100 }, 'owner1');
  const sbx = await create({ ANTHROPIC_API_KEY: 'x' }, { deleteAfterSeconds: 3600, secrets: ['MCP_X_TOKEN'] });
  await sbx.files.write('/data/home/a.txt', 'hello');
  await sbx.files.read('/data/home/a.txt');
  await sbx.commands.run('echo fg', { cwd: '/data/home', timeoutMs: 600000 });
  await sbx.commands.run('echo bg', { cwd: '/data/home', timeoutMs: 600001 });
  await sbx.kill();
  record.create = { sandbox: { id: sbx.id, home: sbx.home }, calls };

  // list and delete used by the reaper (raw HTTP)
  const reaperCalls = [];
  const reaperFetch = async (url, init = {}) => {
    reaperCalls.push({ http: init.method ?? 'GET', url: String(url), headers: init.headers });
    return init.method === 'DELETE' ? { ok: true, status: 200 } : { ok: true, status: 200, json: async () => ({ machines: [{ id: 'm1', metadata: { owner: 'o1' } }, { id: 'm2', metadata: { owner: 'o2' } }] }) };
  };
  await reap({ owner: 'o1', provider: createProvider({ INSTABOX_API_KEY: KEY }, { fetchFn: reaperFetch }) });
  record.reaper = reaperCalls;

  // list used by the dashboard (SDK, through the adapter's { sdk: true } list)
  const listCalls = [];
  const dashEnv = { INSTABOX_API_KEY: KEY };
  const rows = await listMachines(dashEnv, createProvider(dashEnv, { sdk: { Sandbox: { async list(o) {
    listCalls.push(o);
    return [{ sandboxId: 'm1', name: 'box', state: 'running', startedAt: '2026-01-02T03:04:05Z', archiveAt: '2026-01-03T03:04:05Z', metadata: { purpose: 'cloudy-cloud', role: 'coordinator', owner: 'o1' } }];
  } } } }));
  record.dashboardList = { calls: listCalls, rows: rows.map(({ status, labels, ...today }) => today) }; // `status` and `labels` are new (the provider's mapped state); the recorded fields are today's

  // ports (npx instabox argv)
  const argvs = [];
  const machines = [{ id: 'mach-aaa', name: 'box-aaa', state: 'running', status: 'running' }];
  const events = [{ t: 1, id: '7c1e90ab', type: 'agent', description: 'a' }, { t: 2, id: '7c1e90ab', type: 'machine', machine: 'mach-aaa' }];
  const spawn = async (argv, o) => { argvs.push({ argv, inherit: !!o.inherit, envNames: Object.keys(o.env ?? {}) }); return { code: 0, stdout: '{"url":"https://x.example/"}' }; };
  const env = { INSTABOX_API_KEY: KEY };
  const d = { env, provider: createProvider(env, { spawn }), list: async () => machines, events: () => events, alive: () => true, out: () => {}, err: () => {} };
  for (const args of [['7c1e90ab', '8080:3000'], ['7c1e90ab', '3000', '--share'], ['7c1e90ab', '3000', '--unshare']]) assert.equal(await openRun(args, d), 0);
  record.ports = argvs;

  golden('instabox-requests', normalise(record));
});
