import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractSuite } from './provider-contract.mjs';
import { createProvider } from '../src/providers/e2b.mjs';
import { loadProvider } from '../src/providers/index.mjs';

const KEY = 'e2b_test_key_00000000000000000000';
const GH = 'ghp_e2b_test_secret';
const OAT = 'sk-ant-oat01-e2btest';
const SCRIPT = new URL('../install.sh', import.meta.url).pathname;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Connect-RPC envelope helpers: one request frame or a whole stream body.
const enc = (obj, flags = 0) => {
  const p = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(5 + p.length);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, p.length);
  out.set(p, 5);
  return out;
};
const stream = (events) => {
  const parts = events.map((e) => enc({ event: e }));
  parts.push(enc({}, 2)); // terminal frame, no error
  const total = parts.reduce((n, p) => n + p.length, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { body.set(p, off); off += p.length; }
  return body;
};
const decodeFrames = (bytes) => {
  const out = [];
  const u8 = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes));
  let off = 0;
  while (off + 5 <= u8.length) {
    const flags = u8[off];
    const len = new DataView(u8.buffer, u8.byteOffset + off + 1, 4).getUint32(0);
    out.push({ flags, json: JSON.parse(new TextDecoder().decode(u8.subarray(off + 5, off + 5 + len))) });
    off += 5 + len;
  }
  return out;
};

const respond = (status, obj, headers = {}) => new Response(
  obj === undefined ? null : (obj instanceof Uint8Array || typeof obj === 'string' ? obj : JSON.stringify(obj)),
  { status, headers },
);

// A fake E2B: the control plane (api.e2b.app) plus envd on the shared host (sandbox.e2b.app).
// `log` records every request (method, url, headers, parsed body/frames) so tests can assert which
// calls ran and that no secret value left the env-file write or the create envVars.
function fakeE2b() {
  const log = [];
  const store = new Map(); // id -> { detail record }
  const files = new Map(); // id -> Map(path -> body string)
  const execs = new Map(); // id -> [cmd]
  const fail = new Map(); // pathname -> (method, url) => Response (falsy falls through)
  const z = { execState: { code: 0, out: '', err: '' } }; // what the next Process/Start answers
  let n = 0;
  const row = (id, metadata, extra = {}) => ({
    sandboxID: id, templateID: 'base', clientID: 'c1', envdVersion: '0.2.0', alias: 'base',
    startedAt: '2026-01-01T00:00:00.000Z', endAt: '2026-01-01T06:00:00.000Z',
    cpuCount: 2, memoryMB: 1024, diskSizeMB: 2048, state: 'running', metadata,
    envdAccessToken: `et-${id}`, domain: 'e2b.app', ...extra,
  });
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    const isConnect = init.headers?.['Content-Type'] === 'application/connect+json';
    const body = isConnect && init.body ? decodeFrames(init.body)
      : typeof init.body === 'string' && init.headers?.['Content-Type'] === 'application/json' ? JSON.parse(init.body)
      : init.body;
    log.push({ method, url: String(url), path: u.pathname + u.search, headers: init.headers ?? {}, body });
    const forced = fail.get(u.pathname);
    if (forced) { const out = forced(method, u); if (out) return out; }
    if (u.hostname === 'api.e2b.app') {
      if (u.pathname === '/v2/sandboxes' && method === 'POST') {
        const id = `sbx-${++n}`;
        store.set(id, row(id, init.body ? JSON.parse(init.body).metadata : {}));
        return respond(200, row(id, store.get(id).metadata));
      }
      if (u.pathname === '/v2/sandboxes' && method === 'GET') {
        // Server-side metadata filter: "k=v&k2=v2" inside one URL-encoded param.
        const want = new URLSearchParams(u.searchParams.get('metadata') ?? '');
        const rows = [...store.values()].filter((r) => [...want.entries()].every(([k, v]) => r.metadata?.[k] === v));
        return respond(200, rows);
      }
      const v2c = u.pathname.match(/^\/v2\/sandboxes\/([^/]+?)\/connect$/);
      if (v2c && method === 'POST') {
        const rec = store.get(v2c[1]);
        if (!rec) return respond(404, { code: 404, message: 'no such sandbox' });
        rec.state = 'running';
        rec.envdAccessToken = `et-fresh-${v2c[1]}`; // resume rotates the envd token
        return respond(200, rec);
      }
      const m = u.pathname.match(/^\/sandboxes\/([^/]+?)(\/(timeout|connect|metrics))?$/);
      if (!m) return respond(404, { code: 404, message: 'unknown route' });
      const rec = store.get(m[1]);
      if (u.pathname.startsWith('/v2/')) return respond(404, { code: 404, message: 'unknown route' });
      if (m[3] === 'timeout') return rec ? respond(200, {}) : respond(404, { code: 404, message: 'no such sandbox' });
      if (m[3] === 'metrics') return rec ? respond(200, [{ timestampUnix: Math.floor(Date.now() / 1000) - 60, cpuCount: 2, cpuUsedPct: 12.5, memUsed: 100, memTotal: 1000, memCache: 0, diskUsed: 0, diskTotal: 0 }]) : respond(404, { code: 404, message: 'no such sandbox' });
      if (method === 'GET') return rec ? respond(200, rec) : respond(404, { code: 404, message: 'no such sandbox' });
      if (method === 'DELETE') { const had = store.delete(m[1]); return respond(had ? 204 : 404, had ? undefined : { code: 404, message: 'no such sandbox' }); }
      return respond(404, { code: 404, message: 'unknown route' });
    }
    if (u.hostname === 'sandbox.e2b.app') {
      const id = init.headers?.['E2b-Sandbox-Id'];
      const rec = store.get(id);
      if (!rec) return respond(502, { sandboxId: id, message: 'The sandbox was not found', code: 502 });
      if (u.pathname === '/health') return respond(204);
      if (u.pathname === '/files' && method === 'POST') {
        (files.get(id) ?? files.set(id, new Map()).get(id)).set(u.searchParams.get('path'), typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString());
        return respond(200, [{ path: u.searchParams.get('path'), name: 'f', type: 'file' }]);
      }
      if (u.pathname === '/files' && method === 'GET') {
        const d = files.get(id)?.get(u.searchParams.get('path'));
        return d === undefined ? respond(404, { code: 404, message: 'no such file' }) : respond(200, d);
      }
      if (u.pathname === '/process.Process/Start') {
        const req = body[0].json;
        (execs.get(id) ?? execs.set(id, []).get(id)).push(req.process.args.at(-1));
        const st = z.execState;
        if (st.raw !== undefined) return respond(200, st.raw, { 'Content-Type': 'application/connect+json' });
        return respond(200, stream([
          { start: { pid: 1234 } },
          ...(st.out ? [{ data: { stdout: b64(st.out) } }] : []),
          ...(st.err ? [{ data: { stderr: b64(st.err) } }] : []),
          // Like real envd (proto3 JSON), a zero exit code is omitted.
          { end: { ...(st.code ? { exitCode: st.code } : {}), exited: true, status: 'exited' } },
        ]), { 'Content-Type': 'application/connect+json' });
      }
      if (u.pathname === '/process.Process/Connect') {
        const sel = body[0].json.process;
        if (!sel?.tag?.startsWith('cc-')) return respond(200, enc({ error: { code: 'not_found', message: 'process not found' } }, 2), { 'Content-Type': 'application/connect+json' });
        return respond(200, stream([{ end: { ...(z.execState.code ? { exitCode: z.execState.code } : {}), exited: true, status: 'exited' } }]), { 'Content-Type': 'application/connect+json' });
      }
      if (u.pathname === '/process.Process/SendSignal') return respond(200, {});
      return respond(404, { code: 404, message: 'unknown route' });
    }
    throw new Error(`unhandled ${method} ${url}`);
  };
  return Object.assign(z, { fetch, log, store, files, execs, fail, row, respond });
}

const mk = (z, env = {}, deps = {}) => createProvider({
  E2B_API_KEY: KEY, CLOUDY_CLOUD_E2B_TOKEN_ON_BOX: 'yes', GH_TOKEN: GH,
  CLAUDE_CODE_OAUTH_TOKEN: OAT,
  ...env,
}, { fetchFn: z.fetch, ...deps });
const create = (p, extra = {}) => p.create({ image: 'x', envs: {}, labels: { purpose: 'cloudy-cloud' }, ttlSeconds: 3600, ...extra });

contractSuite('e2b', ({ withKey }) => mk(fakeE2b(), withKey ? {} : { E2B_API_KEY: undefined }));

test('e2b: create without the token-on-box consent refuses with a guided error and no network call', async () => {
  const z = fakeE2b();
  const p = mk(z, { CLOUDY_CLOUD_E2B_TOKEN_ON_BOX: undefined });
  const e = await create(p).then(() => { throw new Error('should refuse'); }, (x) => x);
  assert.match(e.message, /CLOUDY_CLOUD_E2B_TOKEN_ON_BOX=yes/);
  assert.match(e.message, /proxy secrets/i);
  assert.equal(z.log.length, 0, 'no HTTP call may run before the consent exists');
});

test('e2b: create sets server metadata + timeout, sends envVars and writes the env file', async () => {
  const z = fakeE2b();
  const p = mk(z);
  const s = await create(p, { envs: { FOO: 'bar', CLAUDE_CODE_OAUTH_TOKEN: OAT }, labels: { purpose: 'cloudy-cloud', owner: 'o1', name: 'bold-fox' }, ttlSeconds: 7200 });
  try {
    const post = z.log.find((l) => l.method === 'POST' && l.path === '/v2/sandboxes');
    assert.ok(post, z.log.map((l) => `${l.method} ${l.path}`).join('\n'));
    assert.equal(post.body.templateID, 'base');
    assert.equal(post.body.timeout, 7200);
    assert.equal(post.body.metadata.purpose, 'cloudy-cloud');
    assert.equal(post.body.metadata.owner, 'o1');
    assert.equal(post.body.metadata.name, 'bold-fox');
    assert.equal(post.body.metadata.agent, undefined); // labels only, no invented fields
    assert.equal(post.body.envVars.FOO, 'bar');
    assert.equal(post.body.envVars.GH_TOKEN, GH, 'consented values ride envVars');
    assert.ok(post.headers['Idempotency-Key'], 'create carries an idempotency key');
    // envd: health poll, then exactly one provision exec, env file write, one chmod exec.
    const starts = z.log.filter((l) => l.path === '/process.Process/Start');
    assert.equal(starts.length, 2, `expected provision + chmod, got: ${starts.map((s) => s.body[0].json.process.args.at(-1).slice(0, 40)).join(' | ')}`);
    assert.match(z.execs.get(s.id)[0], /cc-provisioned-v1/);
    const envFile = z.files.get(s.id)?.get('/home/user/.cloudy-cloud-env');
    assert.ok(envFile?.includes('GH_TOKEN=') && envFile.includes('FOO=') && envFile.includes('CLAUDE_CODE_OAUTH_TOKEN='));
    // The key, the envd token and the credential values appear only where they must:
    // the X-API-Key / X-Access-Token headers, the create envVars and the env-file write.
    for (const l of z.log) {
      assert.ok(!l.url.includes(KEY) && !l.url.includes(GH) && !l.url.includes(OAT), l.url);
      if (l.path === '/v2/sandboxes' || l.path.startsWith('/files')) continue;
      const text = typeof l.body === 'string' ? l.body : JSON.stringify(l.body ?? '');
      for (const v of [KEY, GH, OAT]) assert.ok(!text.includes(v), `${l.method} ${l.path}`);
    }
  } finally { await s.kill(); }
});

test('e2b: coordinators are refused clearly', async () => {
  const z = fakeE2b();
  await assert.rejects(create(mk(z), { labels: { purpose: 'cloudy-cloud', role: 'coordinator' } }), /[Cc]oordinator/);
  assert.equal(z.log.length, 0);
});

test('e2b: a missing key throws no_key before any call', async () => {
  const z = fakeE2b();
  const p = mk(z, { E2B_API_KEY: undefined });
  await assert.rejects(create(p), (e) => e.code === 'no_key');
  assert.equal(z.log.length, 0);
});

test('e2b: an egress allow list maps to network.allowOut with a deny-all default', async () => {
  const z = fakeE2b();
  const s = await create(mk(z), { egress: { allow: ['github.com', '*.anthropic.com'] } });
  try {
    const post = z.log.find((l) => l.path === '/v2/sandboxes');
    assert.deepEqual(post.body.network.allowOut, ['github.com', '*.anthropic.com']);
    assert.deepEqual(post.body.network.denyOut, ['0.0.0.0/0']);
  } finally { await s.kill(); }
});

test('e2b: a plan TTL cap walks the timeout ladder down', async () => {
  const z = fakeE2b();
  let calls = 0;
  z.fail.set('/v2/sandboxes', (m) => {
    if (m !== 'POST') return;
    calls++;
    return calls === 1 ? z.respond(400, { code: 400, message: 'Max instance length exceeded for this plan' }) : undefined;
  });
  const p = mk(z);
  const s = await create(p, { ttlSeconds: 7200 });
  try {
    const posts = z.log.filter((l) => l.method === 'POST' && l.path === '/v2/sandboxes');
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body.timeout, 7200);
    assert.equal(posts[1].body.timeout, 3600, 'second rung of the ladder');
  } finally { await s.kill(); }
});

test('e2b: list filters server-side and re-checks client-side; foreign sandboxes are never touched', async () => {
  const z = fakeE2b();
  const p = mk(z);
  const a = await create(p, { labels: { purpose: 'cloudy-cloud', owner: 'o1' } });
  const b = await create(p, { labels: { purpose: 'cloudy-cloud', owner: 'o2' } });
  try {
    z.store.set('foreign', z.row('foreign', { purpose: 'other-app', owner: 'someone' }));
    z.store.set('lax', z.row('lax', { owner: 'o1' })); // no purpose: fails the client-side recheck
    const ids = async (l) => (await p.list(l)).map((r) => r.id);
    assert.deepEqual(await ids({ owner: 'o1' }), [a.id]);
    assert.deepEqual((await ids({ purpose: 'cloudy-cloud' })).sort(), [a.id, b.id].sort());
    // The server saw the purpose filter: the request URL carries it.
    const q = z.log.filter((l) => l.path.startsWith('/v2/sandboxes?')).at(-1);
    assert.ok(decodeURIComponent(q.url).includes('purpose=cloudy-cloud'), q.url);
    const row = (await p.list({ owner: 'o1' }))[0];
    assert.equal(row.status, 'running');
    assert.ok(row.deleteAt, 'endAt reported as deleteAt');
    assert.ok(z.store.has('foreign'), 'the foreign sandbox was not swept');
  } finally { await a.kill(); await b.kill(); }
});

test('e2b: delete refuses a foreign id and never sends DELETE for it; a 404 counts as deleted', async () => {
  const z = fakeE2b();
  const p = mk(z);
  z.store.set('foreign', z.row('foreign', { purpose: 'other-app' }));
  await assert.rejects(p.delete('foreign'), (e) => e.code === 'not_found');
  assert.ok(z.store.has('foreign'), 'foreign sandbox must never be killed');
  assert.ok(!z.log.some((l) => l.method === 'DELETE'), 'no DELETE was sent');
  await p.delete('ghost-id'); // unknown id: the 404 counts as deleted
});

test('e2b: connect refuses a foreign id and rebuilds a handle for ours', async () => {
  const z = fakeE2b();
  const p = mk(z);
  const s = await create(p, { labels: { purpose: 'cloudy-cloud', owner: 'o1' } });
  z.store.set('foreign', z.row('foreign', { purpose: 'other-app' }));
  await assert.rejects(p.connect('foreign'), (e) => e.code === 'not_found');
  const s2 = await p.connect(s.id);
  assert.equal(s2.id, s.id);
  const r = await s2.commands.run('echo ok');
  assert.equal(r.exitCode, 0);
  // A paused sandbox resumes through /v2/sandboxes/{id}/connect and uses the fresh envd token.
  z.store.get(s.id).state = 'paused';
  const s3 = await p.connect(s.id);
  const resume = z.log.filter((l) => l.path.endsWith('/connect')).at(-1);
  assert.ok(resume && resume.body.timeout > 0, 'resume posts a timeout');
  await s3.commands.run('echo again');
  const call = z.log.filter((l) => l.headers['E2b-Sandbox-Id'] === s.id).at(-1);
  assert.equal(call.headers['X-Access-Token'], `et-fresh-${s.id}`, 'the rotated envd token is used');
  await s.kill();
});

test('e2b: metrics and publishPort check ownership; publish returns the public URL', async () => {
  const z = fakeE2b();
  const p = mk(z);
  const s = await create(p);
  z.store.set('foreign', z.row('foreign', { purpose: 'other-app' }));
  await assert.rejects(p.metrics('foreign'), (e) => e.code === 'not_found');
  await assert.rejects(p.publishPort('foreign', '3000'), (e) => e.code === 'not_found');
  const m = await p.metrics(s.id);
  assert.equal(m.samples[0].cpuPct, 12.5);
  const r = await p.publishPort(s.id, '3000');
  assert.equal(r.url, `https://3000-${s.id}.e2b.app`);
  await s.kill();
});

test('e2b: 429 is retried after Retry-After, then succeeds', async () => {
  const z = fakeE2b();
  let calls = 0;
  z.fail.set('/v2/sandboxes', (m) => {
    if (m !== 'GET') return;
    calls++;
    return calls === 1 ? z.respond(429, { code: 429, message: 'Rate limit exceeded' }, { 'Retry-After': '1' }) : undefined;
  });
  const p = mk(z, {}, { sleep: async () => {} });
  await p.list();
  assert.equal(calls, 2, 'the 429 was retried and the second call succeeded');
});

test('e2b: 401 maps to no_key and error text never contains the key', async () => {
  const z = fakeE2b();
  z.fail.set('/v2/sandboxes', () => z.respond(401, { code: 401, message: `authorization header is missing or invalid for ${KEY}` }));
  const p = mk(z);
  const e = await p.list().then(() => { throw new Error('should fail'); }, (x) => x);
  assert.equal(e.code, 'no_key');
  assert.ok(!e.message.includes(KEY), 'the key never appears in the error');
  // A create-time refusal also carries no key material.
  const e2 = await create(p).then(() => { throw new Error('should fail'); }, (x) => x);
  for (const v of [KEY, GH, OAT]) assert.ok(!e2.message.includes(v), v);
});

test('e2b: commands.run returns output, streams stdout and rejects on a nonzero exit or timeout', async () => {
  const z = fakeE2b();
  const p = mk(z);
  const s = await create(p);
  try {
    z.execState = { code: 0, out: 'hello\n', err: 'warn\n' };
    let streamed = '';
    const r = await s.commands.run('echo hi', { timeoutMs: 5000, onStdout: (c) => { streamed += c; } });
    assert.deepEqual(r, { stdout: 'hello\n', stderr: 'warn\n', exitCode: 0 });
    assert.equal(streamed, 'hello\n');
    // The wrapper applies the env file and the timeout inside the sandbox.
    const last = z.execs.get(s.id).at(-1);
    assert.match(last, /timeout -k 5 5 sh -c/);
    z.execState = { code: 2, out: 'o', err: 'e' };
    const e = await s.commands.run('exit 2').then(() => { throw new Error('should fail'); }, (x) => x);
    assert.equal(e.exitCode, 2);
    assert.equal(e.stdout, 'o');
    z.execState = { code: 124, out: '', err: '' };
    await assert.rejects(s.commands.run('sleep 99', { timeoutMs: 1000 }), (x) => x.code === 'timeout');
    // An RPC error in the terminal Connect frame surfaces as a normal error.
    z.execState = { raw: enc({ error: { code: 'invalid_argument', message: "cwd '/nope' does not exist" } }, 2) };
    await assert.rejects(s.commands.run('true'), (x) => x.code === 'invalid_request');
    z.execState = { code: 0, out: '', err: '' };
  } finally { await s.kill(); }
});

test('e2b: files.write/read go through envd /files', async () => {
  const z = fakeE2b();
  const p = mk(z);
  const s = await create(p);
  try {
    await s.files.write('/home/user/x.txt', 'payload');
    const out = await s.files.read('/home/user/x.txt');
    assert.equal(Buffer.from(out).toString(), 'payload');
  } finally { await s.kill(); }
});

test('e2b: provisioning runs exactly once inside create', async () => {
  const z = fakeE2b();
  const p = mk(z);
  const s = await create(p);
  try {
    const provisioned = z.execs.get(s.id).filter((c) => c.includes('cc-provisioned-v1'));
    assert.equal(provisioned.length, 1);
  } finally { await s.kill(); }
});

// install.sh --check-only: key presence and the consent — never a value. Tools are not stubbed,
// so the verdict may fail; the provider lines are what is asserted.
const checkOnly = (cfgText) => {
  const cfg = join(mkdtempSync(join(tmpdir(), 'cce-')), 'env');
  writeFileSync(cfg, cfgText, { mode: 0o600 });
  return spawnSync('/bin/bash', [SCRIPT, '--check-only'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), 'h-')), CLOUDY_CLOUD_CONFIG: cfg } });
};

test('setup --check-only on e2b checks only the E2B key, the consent, GH_TOKEN and a Claude credential', () => {
  let r = checkOnly('CLOUDY_CLOUD_PROVIDER=e2b\n');
  assert.match(r.stdout, /E2B_API_KEY/);
  assert.match(r.stdout, /CLOUDY_CLOUD_E2B_TOKEN_ON_BOX/);
  assert.doesNotMatch(r.stdout, /Instabox/);

  r = checkOnly(`CLOUDY_CLOUD_PROVIDER=e2b\nE2B_API_KEY=${KEY}\n`);
  assert.match(r.stdout, /CLOUDY_CLOUD_E2B_TOKEN_ON_BOX/);
  assert.doesNotMatch(r.stdout, new RegExp(esc(KEY)));

  r = checkOnly(`CLOUDY_CLOUD_PROVIDER=e2b\nE2B_API_KEY=${KEY}\nCLOUDY_CLOUD_E2B_TOKEN_ON_BOX=yes\n`);
  assert.match(r.stdout, /GH_TOKEN/);
  assert.doesNotMatch(r.stdout, new RegExp(esc(KEY)));

  r = checkOnly(`CLOUDY_CLOUD_PROVIDER=e2b\nE2B_API_KEY=${KEY}\nCLOUDY_CLOUD_E2B_TOKEN_ON_BOX=yes\nGH_TOKEN=${GH}\nCLAUDE_CODE_OAUTH_TOKEN=${OAT}\n`);
  assert.match(r.stdout, /GH_TOKEN is saved/);
  assert.match(r.stdout, /Claude credential is saved/);
  for (const v of [KEY, GH, OAT]) assert.doesNotMatch(r.stdout, new RegExp(esc(v)));
});

test('loadProvider knows e2b', async () => {
  const p = await loadProvider({ CLOUDY_CLOUD_PROVIDER: 'e2b' });
  assert.equal(p.name, 'e2b');
  assert.equal(p.keyName, 'E2B_API_KEY');
});
