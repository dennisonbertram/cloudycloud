import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
// A stream that dies mid-flight: no terminal frame, so the reader sees a dropped connection.
const partial = (events) => {
  const parts = events.map((e) => enc({ event: e }));
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
  const z = { execState: { code: 0, out: '', err: '' }, deleteFails: false }; // what the next Process/Start answers
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
        // serverMetaFilter: false simulates an API that ignores the filter, so the adapter's own
        // client-side ownership re-check is what the test proves.
        const rows = z.serverMetaFilter === false ? [...store.values()]
          : [...store.values()].filter((r) => [...want.entries()].every(([k, v]) => r.metadata?.[k] === v));
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
      if (method === 'DELETE') { if (z.deleteFails) return respond(503, { code: 503, message: 'temporary delete failure' }); const had = store.delete(m[1]); return respond(had ? 204 : 404, had ? undefined : { code: 404, message: 'no such sandbox' }); }
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
        if (z.hold) return new Promise((_, rej) => { // hangs until the caller's signal aborts
          init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('the operation was aborted'), { name: 'AbortError' })));
        });
        const cmd = req.process.args.at(-1);
        // stat -c %a reports the mode the fake keeps for the env file (600 once install -m 600 ran).
        const st = z.execFn?.(cmd) ?? (cmd.includes('stat -c %a') ? { code: 0, out: `${z.envMode ?? '600'}\n`, err: '' } : z.execState);
        // The adapter tees every command's output into per-tag io files inside the sandbox; a real
        // envd writes them too, so the fake seeds the complete transcript for recovery reads.
        const tag = req.tag; // envd's StartRequest carries the tag as a sibling of `process`
        if (tag) {
          const f = files.get(id) ?? files.set(id, new Map()).get(id);
          f.set(`/home/user/.cc-io-${tag}.out`, st.ioOut ?? st.out ?? '');
          f.set(`/home/user/.cc-io-${tag}.err`, st.ioErr ?? st.err ?? '');
        }
        if (st.raw !== undefined) return respond(200, st.raw, { 'Content-Type': 'application/connect+json' });
        if (st.dropMid) // the connection dies after the start: no end event, no terminal frame
          return respond(200, partial([
            { start: { pid: 1234 } },
            ...(st.out ? [{ data: { stdout: b64(st.out) } }] : []),
            ...(st.err ? [{ data: { stderr: b64(st.err) } }] : []),
          ]), { 'Content-Type': 'application/connect+json' });
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

// The consent lives in a config file, like a real user's: the adapter re-reads the file at
// dispatch and does not trust a copy inside the (possibly stale) env object it was built with.
// baseEnv plays the real process environment (kept empty so the developer's own exports can't leak in).
const cfgFile = (lines = 'E2B_API_KEY=x\nCLOUDY_CLOUD_E2B_TOKEN_ON_BOX=yes\n') => {
  const f = join(mkdtempSync(join(tmpdir(), 'cc-e2b-')), 'env');
  writeFileSync(f, lines, { mode: 0o600 });
  return f;
};
// A config file with a known installation id in the install-id file beside it (installId reads it back).
const cfgWithInstall = (id) => { const f = cfgFile(); writeFileSync(join(dirname(f), 'install-id'), `${id}\n`); return f; };
const mk = (z, env = {}, deps = {}) => createProvider({
  E2B_API_KEY: KEY, GH_TOKEN: GH,
  CLAUDE_CODE_OAUTH_TOKEN: OAT, CLOUDY_CLOUD_CONFIG: cfgFile(),
  ...env,
}, { fetchFn: z.fetch, sleep: async () => {}, baseEnv: {}, ...deps });
const create = (p, extra = {}) => p.create({ image: 'x', envs: {}, labels: { purpose: 'cloudy-cloud' }, ttlSeconds: 3600, ...extra });

contractSuite('e2b', ({ withKey }) => mk(fakeE2b(), withKey ? {} : { E2B_API_KEY: undefined }));

test('e2b: create without the token-on-box consent refuses with a guided error and no network call', async () => {
  const z = fakeE2b();
  const p = mk(z, { CLOUDY_CLOUD_E2B_TOKEN_ON_BOX: 'yes', CLOUDY_CLOUD_CONFIG: cfgFile('E2B_API_KEY=x\n') });
  const e = await create(p).then(() => { throw new Error('should refuse'); }, (x) => x);
  assert.match(e.message, /CLOUDY_CLOUD_E2B_TOKEN_ON_BOX=yes/);
  assert.match(e.message, /written into the sandbox|into each sandbox/i);
  assert.equal(z.log.length, 0, 'no HTTP call may run before the consent exists');
});

test('e2b: consent is re-read from the file at dispatch — a stale env copy cannot create', async () => {
  const z = fakeE2b();
  // The in-memory env still holds a yes the file no longer has (the server's shared object
  // between env refreshes). The fresh file read at dispatch must not consent.
  const p = mk(z, { CLOUDY_CLOUD_E2B_TOKEN_ON_BOX: 'yes', CLOUDY_CLOUD_CONFIG: cfgFile('E2B_API_KEY=x\n') });
  await assert.rejects(create(p), /CLOUDY_CLOUD_E2B_TOKEN_ON_BOX=yes/);
  assert.equal(z.log.length, 0);
});

test('e2b: consent revoked while a create retries stops the next credential-bearing POST', async () => {
  const z = fakeE2b();
  const cfg = cfgFile('E2B_API_KEY=x\nCLOUDY_CLOUD_E2B_TOKEN_ON_BOX=yes\n');
  const p = mk(z, { CLOUDY_CLOUD_CONFIG: cfg });
  let revoked = false;
  z.fail.set('/v2/sandboxes', (m) => {
    if (m !== 'POST' || revoked) return;
    // The user deleted the consent line while the first POST sat in the rate-limit retry.
    revoked = true;
    writeFileSync(cfg, 'E2B_API_KEY=x\n', { mode: 0o600 });
    return z.respond(429, { code: 429, message: 'Rate limit exceeded' }, { 'Retry-After': '1' });
  });
  await assert.rejects(create(p), /CLOUDY_CLOUD_E2B_TOKEN_ON_BOX=yes/);
  assert.equal(z.log.filter((l) => l.method === 'POST' && l.path === '/v2/sandboxes').length, 1,
    'the retried POST was refused before credentials went out again');
});

test('e2b: consent revoked while a create waits on the provider limiter stops the credential POST', async () => {
  const z = fakeE2b();
  const cfg = cfgFile('E2B_API_KEY=x\nCLOUDY_CLOUD_E2B_TOKEN_ON_BOX=yes\n');
  let release;
  const gate = new Promise((r) => { release = r; });
  // A saturated limiter: every call queues behind the gate, so the create POST waits inside run().
  const limiter = { run: (fn) => gate.then(() => fn()) };
  const p = mk(z, { CLOUDY_CLOUD_CONFIG: cfg }, { limiter });
  const pend = create(p).then(() => { throw new Error('should refuse'); }, (x) => x);
  writeFileSync(cfg, 'E2B_API_KEY=x\n', { mode: 0o600 }); // consent pulled while the create sat in the queue
  release();
  const e = await pend;
  assert.match(e.message, /revoked|CLOUDY_CLOUD_E2B_TOKEN_ON_BOX=yes/);
  assert.ok(!z.log.some((l) => l.method === 'POST' && l.path === '/v2/sandboxes'), 'no credential-bearing POST was sent');
});

test('e2b: a real environment value consents, and an exported no beats a saved yes', async () => {
  const z = fakeE2b();
  const p = mk(z, { CLOUDY_CLOUD_CONFIG: cfgFile('E2B_API_KEY=x\n') }, { baseEnv: { CLOUDY_CLOUD_E2B_TOKEN_ON_BOX: 'yes' } });
  await (await create(p)).kill();
  const n = z.log.length;
  const refused = mk(z, {}, { baseEnv: { CLOUDY_CLOUD_E2B_TOKEN_ON_BOX: 'no' } }); // the file still says yes; the shell says no
  await assert.rejects(create(refused), /CLOUDY_CLOUD_E2B_TOKEN_ON_BOX=yes/);
  assert.equal(z.log.length, n, 'the shell override is honoured before the saved line');
});

test('e2b: create sets server metadata + timeout, sends envVars and writes the env file', async () => {
  const z = fakeE2b();
  const cfg = cfgFile();
  const p = mk(z, { CLOUDY_CLOUD_CONFIG: cfg });
  const s = await create(p, { envs: { FOO: 'bar', CLAUDE_CODE_OAUTH_TOKEN: OAT }, labels: { purpose: 'cloudy-cloud', owner: 'o1', name: 'bold-fox' }, ttlSeconds: 7200 });
  try {
    const post = z.log.find((l) => l.method === 'POST' && l.path === '/v2/sandboxes');
    assert.ok(post, z.log.map((l) => `${l.method} ${l.path}`).join('\n'));
    assert.equal(post.body.templateID, 'base');
    assert.equal(post.body.timeout, 7200);
    assert.equal(post.body.metadata.purpose, 'cloudy-cloud');
    assert.equal(post.body.metadata.owner, 'o1');
    assert.equal(post.body.metadata.install, readFileSync(join(dirname(cfg), 'install-id'), 'utf8').trim(), 'the stable installation id is stamped as metadata');
    assert.equal(post.body.metadata.name, 'bold-fox');
    assert.equal(post.body.metadata.agent, undefined); // labels only, no invented fields
    assert.equal(post.body.envVars.FOO, 'bar');
    assert.equal(post.body.envVars.GH_TOKEN, GH, 'consented values ride envVars');
    assert.ok(post.headers['Idempotency-Key'], 'create carries an idempotency key');
    // envd: health poll, then provision, a private (600) env-file create, the write, and a
    // chmod+stat verify — in that order, so the file is never world-readable with values inside.
    const starts = z.log.filter((l) => l.path === '/process.Process/Start');
    assert.equal(starts.length, 3, `expected provision + install + verify, got: ${starts.map((s) => s.body[0].json.process.args.at(-1).slice(0, 40)).join(' | ')}`);
    const cmds = z.execs.get(s.id);
    assert.match(cmds[0], /cc-provisioned-v1/);
    const iInstall = cmds.findIndex((c) => c.includes('install -m 600'));
    const iVerify = cmds.findIndex((c) => c.includes('chmod 600') && c.includes('stat -c %a'));
    assert.ok(iInstall !== -1 && iVerify !== -1 && iInstall < iVerify, `private create before the write, mode enforced after: ${cmds.join(' | ')}`);
    const writeAt = z.log.findIndex((l) => l.path.startsWith('/files'));
    assert.ok(writeAt > z.log.indexOf(starts[iInstall]) && writeAt < z.log.indexOf(starts[iVerify]), 'the write lands between the private create and the verify');
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
    return calls === 1 ? z.respond(400, { code: 400, message: 'Timeout cannot be greater than 1 hours' }) : undefined; // the live API's wording
  });
  const p = mk(z);
  const s = await create(p, { ttlSeconds: 7200 });
  try {
    const posts = z.log.filter((l) => l.method === 'POST' && l.path === '/v2/sandboxes');
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body.timeout, 7200);
    assert.equal(posts[1].body.timeout, 3600, 'second rung of the ladder');
    assert.notEqual(posts[0].headers['Idempotency-Key'], posts[1].headers['Idempotency-Key'], 'E2B refuses a reused key with a different body');
  } finally { await s.kill(); }
});

test('e2b: caps.maxTtlSeconds is the largest plan limit and never clamps the request', async () => {
  const z = fakeE2b();
  const p = mk(z);
  assert.equal(p.caps.maxTtlSeconds, 86400, 'Pro\'s 24 h is the advertised ceiling — the Hobby hour is learned from the answer, not promised up front');
  const s = await create(p, { ttlSeconds: 7200 });
  try {
    assert.equal(z.log.find((l) => l.method === 'POST' && l.path === '/v2/sandboxes').body.timeout, 7200,
      'the requested timeout reaches E2B unclamped, so a wider plan limit can be discovered');
  } finally { await s.kill(); }
});

test('e2b: the real accepted deadline is stamped into metadata and returned on the handle', async () => {
  const z = fakeE2b();
  let calls = 0;
  z.fail.set('/v2/sandboxes', (m) => {
    if (m !== 'POST') return;
    calls++;
    return calls === 1 ? z.respond(400, { code: 400, message: 'Timeout cannot be greater than 1 hours' }) : undefined;
  });
  const p = mk(z);
  const s = await create(p, { ttlSeconds: 86400 });
  try {
    const posts = z.log.filter((l) => l.method === 'POST' && l.path === '/v2/sandboxes');
    assert.equal(posts.length, 2, 'the ladder fell back one rung');
    assert.equal(posts[1].body.timeout, 3600);
    const meta = z.store.get(s.id).metadata;
    assert.equal(meta.deleteAt, posts[1].body.metadata.deleteAt, 'the accepted POST stamped the real deadline, not the requested one');
    assert.notEqual(meta.deleteAt, posts[0].body.metadata.deleteAt, 'the refused request asked for the requested deadline');
    assert.equal(s.deleteAt, Date.parse(meta.deleteAt), 'the handle reports the same real deadline in epoch ms');
    assert.ok(Math.abs(s.deleteAt - (Date.now() + 3_600_000)) < 60_000, 'about an hour out, not the requested day');
  } finally { await s.kill(); }
});

test('e2b: E2B_API_BASE and E2B_DOMAIN are ignored — only the fixed E2B hosts are used', async () => {
  const z = fakeE2b();
  const p = mk(z, { E2B_API_BASE: 'http://evil.example/api', E2B_DOMAIN: 'evil.example' });
  const s = await create(p);
  try {
    for (const l of z.log) assert.match(l.url, /^https:\/\/(api|sandbox)\.e2b\.app\//, l.url);
    const r = await p.publishPort(s.id, '8080');
    assert.equal(r.url, `https://8080-${s.id}.e2b.app`, 'the preview host is fixed e2b.app');
  } finally { await s.kill(); }
});

test('e2b: E2B_TEMPLATE picks the sandbox template, defaulting to base', async () => {
  const z = fakeE2b();
  const p = mk(z, { E2B_TEMPLATE: 'bigbox' });
  const s = await create(p);
  try {
    const post = z.log.find((l) => l.method === 'POST' && l.path === '/v2/sandboxes');
    assert.equal(post.body.templateID, 'bigbox');
  } finally { await s.kill(); }
  const z2 = fakeE2b();
  const s2 = await create(mk(z2));
  try {
    assert.equal(z2.log.find((l) => l.method === 'POST' && l.path === '/v2/sandboxes').body.templateID, 'base');
  } finally { await s2.kill(); }
});

test('e2b: an egress list on a custom template also allows the provisioning hosts; base needs none', async () => {
  const z = fakeE2b();
  const p = mk(z, { E2B_TEMPLATE: 'custom-min' });
  const s = await create(p, { egress: { allow: ['github.com', 'api.anthropic.com'] } });
  try {
    const post = z.log.find((l) => l.method === 'POST' && l.path === '/v2/sandboxes');
    for (const h of ['github.com', 'api.anthropic.com', 'deb.debian.org', 'security.debian.org', 'cli.github.com', 'deb.nodesource.com', 'astral.sh', 'registry.npmjs.org'])
      assert.ok(post.body.network.allowOut.includes(h), `allowOut misses ${h}`);
    assert.deepEqual(post.body.network.denyOut, ['0.0.0.0/0']);
  } finally { await s.kill(); }
});

test('e2b: a teammate\'s cloudy-cloud sandbox — same purpose, no shared install — is never ours', async () => {
  const z = fakeE2b();
  z.serverMetaFilter = false; // the server returns everything; only the client-side re-check protects us
  const p = mk(z, {}, { owner: 'o1' });
  // Another installation's worker: same purpose, and even the same session owner — without our
  // install id it is foreign. A row with a DIFFERENT install id is foreign the same way.
  z.store.set('mate', z.row('mate', { purpose: 'cloudy-cloud', owner: 'o1', deleteAt: new Date(Date.now() + 60_000).toISOString() }));
  z.store.set('other-install', z.row('other-install', { purpose: 'cloudy-cloud', owner: 'o1', install: 'ffffeeee11112222', deleteAt: new Date(Date.now() + 60_000).toISOString() }));
  for (const id of ['mate', 'other-install']) {
    await assert.rejects(p.connect(id), (e) => e.code === 'not_found');
    await assert.rejects(p.delete(id), (e) => e.code === 'not_found');
    await assert.rejects(p.publishPort(id, '8080'), (e) => e.code === 'not_found');
    await assert.rejects(p.metrics(id), (e) => e.code === 'not_found');
  }
  for (const rows of [await p.list(), await p.list({ purpose: 'cloudy-cloud' })]) {
    assert.ok(!rows.some((r) => r.id === 'mate'), 'a matching owner alone does not make a sandbox ours');
    assert.ok(!rows.some((r) => r.id === 'other-install'), 'another installation\'s sandbox is invisible');
  }
  assert.ok(z.store.has('mate') && z.store.has('other-install'), 'the foreign sandboxes were not swept or deleted');
  assert.ok(!z.log.some((l) => l.method === 'DELETE'), 'no delete was ever sent for them');
});

test('e2b: create stamps the shared install id, and another session of this installation owns the worker', async () => {
  const z = fakeE2b();
  const cfg = cfgFile();
  // Two providers = two server sessions of the same installation: same config dir, different per-session owners.
  const p1 = mk(z, { CLOUDY_CLOUD_CONFIG: cfg }, { owner: 'sess-a' });
  const p2 = mk(z, { CLOUDY_CLOUD_CONFIG: cfg }, { owner: 'sess-b' });
  const s = await create(p1, { labels: { purpose: 'cloudy-cloud', owner: 'sess-a' } });
  try {
    const install = readFileSync(join(dirname(cfg), 'install-id'), 'utf8').trim();
    assert.match(install, /^[0-9a-f]{16}$/);
    assert.equal(z.store.get(s.id).metadata.install, install, 'the install metadata is the installation id, not a session id');
    assert.equal(z.store.get(s.id).metadata.owner, 'sess-a', 'the per-session owner metadata still rides for the reaper');
    const ids = (await p2.list({ purpose: 'cloudy-cloud' })).map((r) => r.id);
    assert.ok(ids.includes(s.id), 'a new session of this installation lists the first session\'s worker');
    assert.equal((await p2.connect(s.id)).id, s.id, 'and connects to it');
    // An explicit owner filter still scopes to one session — the reaper deletes only its own workers.
    assert.deepEqual((await p2.list({ owner: 'sess-b' })).map((r) => r.id), []);
    assert.deepEqual((await p2.list({ owner: 'sess-a' })).map((r) => r.id), [s.id]);
    await p2.delete(s.id);
    assert.ok(!z.store.has(s.id), 'a new session can stop the first session\'s worker');
  } finally { await p1.delete(s.id).catch(() => {}); }
});

test('e2b: a sandbox stamped our install id is ours even from an earlier session', async () => {
  const z = fakeE2b();
  const cfg = cfgWithInstall('aaaabbbbccccdddd');
  const p = mk(z, { CLOUDY_CLOUD_CONFIG: cfg }, { owner: 'sess-b' });
  // Planted directly, as if an earlier session created it: same install id, a foreign session owner.
  z.store.set('older', z.row('older', { purpose: 'cloudy-cloud', owner: 'sess-a', install: 'aaaabbbbccccdddd', deleteAt: new Date(Date.now() + 60_000).toISOString() }));
  assert.deepEqual((await p.list({ purpose: 'cloudy-cloud' })).map((r) => r.id), ['older']);
  assert.equal((await p.connect('older')).id, 'older');
  await p.delete('older');
  assert.ok(!z.store.has('older'));
});

test('e2b: a lost create answer recovers the sandbox our ccIdem labels — and only that one', async () => {
  const z = fakeE2b();
  z.serverMetaFilter = false; // the recovery list sees every row; only the client-side re-check protects it
  // Another installation's purpose-labelled sandbox is NOT adoptable: same purpose AND same owner
  // metadata, but a different install id — it would match a purpose- or owner-only filter.
  z.store.set('mate', z.row('mate', { purpose: 'cloudy-cloud', owner: 'o1', install: 'ffffeeee11112222', ccIdem: 'not-ours' }));
  const realFetch = z.fetch;
  z.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname === '/v2/sandboxes' && init?.method === 'POST') {
      await realFetch(url, init); // the create landed (deduped by idempotency); the answer never arrived
      throw new Error('socket hang up');
    }
    return realFetch(url, init);
  };
  const p = mk(z, {}, { owner: 'o1' });
  const s = await create(p, { labels: { purpose: 'cloudy-cloud', owner: 'o1' } });
  try {
    assert.notEqual(s.id, 'mate');
    const meta = z.store.get(s.id).metadata;
    assert.ok(meta.ccIdem, 'the recovered sandbox is the one our ccIdem labels');
    assert.equal(meta.owner, 'o1');
    assert.ok(meta.install && meta.install !== 'ffffeeee11112222', 'it carries OUR install id');
    assert.ok(z.store.has('mate'), 'the foreign sandbox was not touched');
    const mutations = z.log.filter((l) => l.method !== 'GET' && l.path.includes('mate'));
    assert.deepEqual(mutations, [], 'no delete or mutation ever touched the foreign sandbox');
  } finally { await s.kill(); }
});

test('e2b: a truncated create answer still resolves the created sandbox by ccIdem', async () => {
  const z = fakeE2b();
  const realFetch = z.fetch;
  let once = false;
  z.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (!once && u.pathname === '/v2/sandboxes' && init?.method === 'POST') {
      once = true;
      await realFetch(url, init); // accepted and stored — the sandbox exists
      return z.respond(200, '{'); // but the body was cut off on the wire
    }
    return realFetch(url, init);
  };
  const p = mk(z);
  const s = await create(p);
  try {
    assert.ok(s.id, 'the ccIdem recovery found the created sandbox');
    assert.equal(z.store.size, 1, 'no second sandbox was created');
  } finally { await s.kill(); }
});

test('e2b: two sandboxes sharing our idempotency marker are never adopted — both are deleted', async () => {
  const z = fakeE2b();
  const realFetch = z.fetch;
  let once = false;
  z.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (!once && u.pathname === '/v2/sandboxes' && init?.method === 'POST') {
      once = true;
      const r = await realFetch(url, init);
      // An E2B fork inherits every metadata key, ccIdem included.
      const made = [...z.store.values()].at(-1);
      z.store.set('fork1', z.row('fork1', { ...made.metadata }));
      throw new Error('socket hang up'); // the answer was still lost
    }
    return realFetch(url, init);
  };
  const p = mk(z);
  const e = await create(p).then(() => { throw new Error('should not adopt'); }, (x) => x);
  assert.match(e.message, /idempotency|fork|ambiguous/i);
  assert.equal(z.store.size, 0, 'the unresolvable copies were deleted, not adopted');
});

test('e2b: a create answer with an id but no envd token cleans the known sandbox up', async () => {
  const z = fakeE2b();
  const realFetch = z.fetch;
  let once = false;
  z.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (!once && u.pathname === '/v2/sandboxes' && init?.method === 'POST') {
      once = true;
      await realFetch(url, init);
      const rec = [...z.store.values()].at(-1);
      delete rec.envdAccessToken; // the stored detail also lacks it
      return z.respond(200, { sandboxID: rec.sandboxID }); // the answer lost the token field
    }
    return realFetch(url, init);
  };
  const p = mk(z);
  await assert.rejects(create(p), /envd access token|transient/i);
  assert.equal(z.store.size, 0, 'the unusable sandbox was deleted');
});

test('e2b: the recovery list is retried when its first call fails', async () => {
  const z = fakeE2b();
  const realFetch = z.fetch;
  let once = false;
  z.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname === '/v2/sandboxes' && init?.method === 'POST') {
      await realFetch(url, init);
      throw new Error('socket hang up');
    }
    if (!once && u.pathname === '/v2/sandboxes' && (init?.method ?? 'GET') === 'GET') {
      once = true;
      throw new Error('socket hang up'); // the first recovery list dies too
    }
    return realFetch(url, init);
  };
  const p = mk(z);
  const s = await create(p);
  try { assert.ok(s.id); } finally { await s.kill(); }
});

test('e2b: a create cancelled during provisioning deletes the sandbox', async () => {
  const z = fakeE2b();
  const p = mk(z);
  const ac = new AbortController();
  z.hold = true; // every Process/Start hangs until its signal aborts
  const pend = create(p, { signal: ac.signal }).then(() => { throw new Error('should cancel'); }, (x) => x);
  for (let i = 0; i < 50 && !z.log.some((l) => l.path === '/process.Process/Start'); i++) await new Promise((r) => setImmediate(r));
  ac.abort();
  const e = await pend;
  assert.match(e.message, /cancelled|aborted/i);
  assert.ok(z.log.some((l) => l.method === 'DELETE' && l.path.startsWith('/sandboxes/')), 'the half-created sandbox was deleted');
  assert.equal(z.store.size, 0);
});

test('e2b: a provision failure with unconfirmed cleanup is typed for stop retry', async () => {
  const z = fakeE2b();
  z.execState = { code: 1, out: '', err: 'provision failed' };
  z.deleteFails = true;
  const p = mk(z);
  await assert.rejects(create(p), (e) => e.code === 'cleanup_unconfirmed' && e.provider === 'e2b' && e.machineId === 'sbx-1' && e.allocated === true);
  assert.equal(z.store.size, 1, 'the fake sandbox remains when cleanup is unconfirmed');
});

test('e2b: a create aborted after the POST landed recovers the sandbox by ccIdem and deletes it', async () => {
  const z = fakeE2b();
  const realFetch = z.fetch;
  z.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname === '/v2/sandboxes' && init?.method === 'POST') {
      await realFetch(url, init); // E2B accepted the create — the sandbox exists
      throw Object.assign(new Error('aborted'), { name: 'AbortError' }); // but the caller hung up before the answer
    }
    return realFetch(url, init);
  };
  const p = mk(z);
  const e = await create(p).then(() => { throw new Error('should abort'); }, (x) => x);
  assert.equal(e.name, 'AbortError');
  assert.ok(z.log.some((l) => l.method === 'DELETE' && l.path.startsWith('/sandboxes/')), 'cleanup ran without the aborted signal');
  assert.equal(z.store.size, 0, 'the orphaned sandbox was recovered by ccIdem and deleted, not left running');
});

test('e2b: a UTF-8 character split across output events decodes whole', async () => {
  const z = fakeE2b();
  const p = mk(z);
  const s = await create(p);
  try {
    // é is C3 A9 in UTF-8; envd event boundaries do not respect character boundaries.
    z.execState = {
      raw: stream([
        { start: { pid: 1234 } },
        { data: { stdout: Buffer.from([0x68, 0x69, 0x20, 0xc3]).toString('base64') } },
        { data: { stdout: Buffer.from([0xa9, 0x0a]).toString('base64') } },
        { data: { stderr: Buffer.from([0xc3]).toString('base64') } },
        { data: { stderr: Buffer.from([0xa9]).toString('base64') } },
        { end: { exited: true, status: 'exited' } },
      ]),
    };
    let streamed = '', streamedErr = '';
    const r = await s.commands.run('x', { onStdout: (c) => { streamed += c; }, onStderr: (c) => { streamedErr += c; } });
    assert.equal(r.stdout, 'hi é\n', 'the accumulated output joins the split character');
    assert.equal(r.stderr, 'é');
    assert.equal(streamed, 'hi é\n', 'the concatenated stdout callbacks carry no replacement characters');
    assert.equal(streamedErr, 'é', 'the concatenated stderr callbacks carry no replacement characters');
  } finally { await s.kill(); }
});

test('e2b: a dropped command stream reattaches and recovers the complete transcript from the io files', async () => {
  const z = fakeE2b();
  const p = mk(z);
  const s = await create(p);
  try {
    z.execState = { code: 0, out: 'part1\n', err: 'warn', dropMid: true, ioOut: 'part1\npart2\n', ioErr: 'warned\n' };
    let streamed = '', streamedErr = '';
    const r = await s.commands.run('work', { onStdout: (c) => { streamed += c; }, onStderr: (c) => { streamedErr += c; } });
    assert.equal(r.stdout, 'part1\npart2\n', 'the gap output is recovered from the io file envd cannot replay');
    assert.equal(r.stderr, 'warned\n');
    assert.equal(r.exitCode, 0);
    assert.equal(streamed, 'part1\npart2\n', 'onStdout still receives the full stream');
    assert.equal(streamedErr, 'warned\n', 'readback emits only stderr missing from the dropped stream');
    const connects = z.log.filter((l) => l.path === '/process.Process/Connect');
    assert.equal(connects.length, 1, 'the dropped stream was re-attached once');
  } finally { await s.kill(); }
});

test('e2b: a failed command scrubs secrets from the attached stdout and stderr too', async () => {
  const z = fakeE2b();
  const p = mk(z);
  const s = await create(p);
  try {
    z.execState = { code: 2, out: `near ${GH}`, err: `leak ${OAT}` };
    const e = await s.commands.run('x').then(() => { throw new Error('should fail'); }, (x) => x);
    assert.equal(e.exitCode, 2);
    for (const v of [KEY, GH, OAT]) {
      assert.ok(!e.stdout.includes(v) && !e.stderr.includes(v) && !e.message.includes(v), `leaked ${v.slice(0, 8)}`);
    }
    assert.match(e.stdout + e.stderr, /<redacted>/);
  } finally { await s.kill(); }
});

test('e2b: the diagnostic curl commands pass the key on stdin, never in argv', () => {
  const p = mk(fakeE2b());
  for (const t of [p.text.listMachines, p.text.apiFix]) {
    assert.match(t, /-K -/, 'curl reads the header config from stdin');
    assert.doesNotMatch(t, /-H "X-API-Key/, 'the expanded key is not a curl argument');
  }
});

test('e2b: resuming a paused sandbox never extends its expiry past the recorded deleteAt', async () => {
  const z = fakeE2b();
  const p = mk(z);
  const s = await create(p, { ttlSeconds: 3600 });
  try {
    const rec = z.store.get(s.id);
    rec.metadata.deleteAt = new Date(Date.now() + 20_000).toISOString(); // 20 s left
    rec.state = 'paused';
    await p.connect(s.id);
    const resume = z.log.filter((l) => l.path.endsWith('/connect')).at(-1);
    assert.ok(resume.body.timeout >= 1 && resume.body.timeout <= 21, `the resume asked for ${resume.body.timeout}s, past the deadline`);
  } finally { await s.kill(); }
});

test('e2b: list rows carry archiveAt in epoch milliseconds for the dashboard', async () => {
  const z = fakeE2b();
  const p = mk(z);
  const s = await create(p);
  try {
    const [r] = await p.list({ purpose: 'cloudy-cloud' });
    assert.equal(r.archiveAt, Date.parse('2026-01-01T06:00:00.000Z'), 'endAt arrives as epoch ms like the other adapters');
  } finally { await s.kill(); }
});

test('e2b: list filters server-side and re-checks client-side; foreign sandboxes are never touched', async () => {
  const z = fakeE2b();
  z.serverMetaFilter = false; // every planted row reaches the client-side ownership re-check
  const p = mk(z);
  const a = await create(p, { labels: { purpose: 'cloudy-cloud', owner: 'o1' } });
  const b = await create(p, { labels: { purpose: 'cloudy-cloud', owner: 'o2' } });
  try {
    z.store.set('foreign', z.row('foreign', { purpose: 'other-app', owner: 'someone' }));
    z.store.set('lax', z.row('lax', { owner: 'o1' })); // no purpose: fails the client-side recheck
    z.store.set('noinst', z.row('noinst', { purpose: 'cloudy-cloud', owner: 'o1' })); // purpose+owner but no install
    z.store.set('otherinst', z.row('otherinst', { purpose: 'cloudy-cloud', owner: 'o1', install: 'ffffeeee11112222' }));
    const ids = async (l) => (await p.list(l)).map((r) => r.id);
    assert.deepEqual(await ids({ owner: 'o1' }), [a.id], 'the owner filter narrows, but install still gates ownership');
    assert.deepEqual((await ids({ purpose: 'cloudy-cloud' })).sort(), [a.id, b.id].sort());
    // The server saw the purpose AND install filters: the request URL carries both.
    const q = z.log.filter((l) => l.path.startsWith('/v2/sandboxes?')).at(-1);
    const query = decodeURIComponent(q.url);
    assert.ok(query.includes('purpose=cloudy-cloud') && query.includes('install='), query);
    const row = (await p.list({ owner: 'o1' }))[0];
    assert.equal(row.status, 'running');
    assert.equal(row.archiveAt, Date.parse('2026-01-01T06:00:00.000Z'), 'endAt reported as archiveAt epoch ms');
    assert.ok(z.store.has('foreign') && z.store.has('noinst') && z.store.has('otherinst'), 'the foreign sandboxes were not swept');
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
    // The command keeps the normal umask; only the transcripts are created private (a global umask 077 made
    // `sudo npm install -g` leave claude unrunnable for the sandbox user).
    assert.doesNotMatch(last, /set \+a; umask 077; exec/);
    assert.match(last, /\(umask 077; : > /);
    assert.match(last, /timeout -k 5 5 bash -o pipefail -c/);
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
