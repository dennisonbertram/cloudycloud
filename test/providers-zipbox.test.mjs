import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractSuite } from './provider-contract.mjs';
import { createProvider } from '../src/providers/zipbox.mjs';
import { loadProvider } from '../src/providers/index.mjs';
import { isQuotaExceeded, isRateLimited } from '../src/limits.mjs';

const KEY = 'zb_test_key_0000000000000000000000';
const GH = 'ghp_zipbox_test_secret';
const OAT = 'sk-ant-oat01-zipboxtest';
const SCRIPT = new URL('../install.sh', import.meta.url).pathname;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A fake Zipbox: the control plane (api.tribes.xyz) plus each claimed box's own API at
// box--<name>.zbox.sh. `log` records every request (method, url, headers, parsed body) so
// tests can assert which calls ran and that no secret value left the env-file write.
function fakeZipbox() {
  const log = [];
  const store = new Map(); // id -> box record
  const files = new Map(); // id -> Map(path -> body string)
  const execs = new Map(); // id -> [cmd]
  const fail = new Map(); // pathname -> (method, url) => response (a falsy return falls through to normal handling)
  const idem = new Map(); // Idempotency-Key -> stored claim answer (a replay returns it unchanged)
  const z = { execState: { code: 0, out: '', err: '', timedOut: false } }; // what the next /exec answers
  let n = 0;
  const boxRow = (id, name, extra = {}) => ({ id, name, status: 'running', ready: true, readiness: 'ready', tier: 's',
    createdAt: '2026-01-01T00:00:00.000Z', baseUrl: `https://box--${name}.zbox.sh`, boxToken: `bt-${id}`, ...extra });
  const respond = (status, obj) => ({ ok: status >= 200 && status < 300, status,
    text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
    json: async () => (typeof obj === 'string' ? JSON.parse(obj) : obj) });
  const sse = (events) => respond(200, `${events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n`).join('\n')}\n`);
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' && u.pathname !== '/files/write' ? JSON.parse(init.body) : init.body;
    log.push({ method, url: String(url), path: u.pathname + u.search, headers: init.headers ?? {}, body, redirect: init.redirect });
    const forced = fail.get(u.pathname);
    if (forced) { const out = forced(method, u); if (out) return out; }
    if (u.hostname === 'api.tribes.xyz') {
      if (u.pathname === '/sandbox/identity/claim' && method === 'POST') {
        const k = init.headers?.['Idempotency-Key'];
        if (k && idem.has(k)) return idem.get(k);
        const id = `sbx-${++n}`;
        store.set(id, boxRow(id, body.name));
        const r = respond(200, { sandboxId: id, name: body.name, status: 'provisioning', created: true, ready: false, readiness: 'settling' });
        if (k) idem.set(k, r);
        return r;
      }
      if (u.pathname === '/sandbox' && method === 'GET') return respond(200, [...store.values()]);
      const m = u.pathname.match(/^\/sandbox\/([^/]+?)(\/wait)?$/);
      if (m && method === 'GET') {
        const rec = store.get(m[1]);
        return rec ? respond(200, { ...rec, ready: true, status: 'running' }) : respond(404, { error: { code: 'not_found', message: 'no such box' } });
      }
      if (m && method === 'DELETE') { store.delete(m[1]); return respond(200, { success: true }); }
      return respond(404, { error: { code: 'not_found', message: 'unknown route' } });
    }
    const bm = u.hostname.match(/^box--(.+)\.zbox\.sh$/);
    if (bm) {
      const rec = [...store.values()].find((r) => r.name === bm[1]);
      if (!rec) return respond(404, { error: { code: 'not_found', message: 'no box' } });
      if (u.pathname === '/exec' && method === 'POST') {
        (execs.get(rec.id) ?? execs.set(rec.id, []).get(rec.id)).push(body.cmd);
        const st = z.execState;
        if (st.raw !== undefined) return respond(200, st.raw); // a literal SSE body (malformed-event tests)
        if (st.events) return sse(st.events); // an exact event list (gap-event tests)
        return sse([['start', { id: 'cmd_1' }], ...(st.out ? [['stdout', { data: st.out }]] : []), ...(st.err ? [['stderr', { data: st.err }]] : []),
          ['exit', { state: 'exited', exitCode: st.code, signal: null, timedOut: !!st.timedOut }]]);
      }
      if (u.pathname === '/files/write' && method === 'POST') {
        (files.get(rec.id) ?? files.set(rec.id, new Map()).get(rec.id)).set(`${u.searchParams.get('dir')}/${u.searchParams.get('name')}`, String(init.body));
        return respond(200, { ok: true });
      }
      if (u.pathname === '/files/download') {
        const d = files.get(rec.id)?.get(u.searchParams.get('path'));
        return d === undefined ? respond(404, { error: { code: 'not_found', message: 'no such file' } }) : respond(200, d);
      }
      if (u.pathname === '/files/mutate') return respond(200, { ok: true });
      return respond(404, { error: { code: 'not_found', message: 'unknown route' } });
    }
    throw new Error(`unhandled ${method} ${url}`);
  };
  return Object.assign(z, { fetch, log, store, files, execs, fail, boxRow, respond, sse });
}

// Every provider gets its own env-file directory, so its boxes state file is isolated.
const mk = (z, env = {}, deps = {}) => createProvider({
  ZIPBOX_API_KEY: KEY, CLOUDY_CLOUD_ZIPBOX_TOKEN_ON_BOX: 'yes', GH_TOKEN: GH,
  CLAUDE_CODE_OAUTH_TOKEN: OAT, CLOUDY_CLOUD_CONFIG: join(mkdtempSync(join(tmpdir(), 'ccz-')), 'env'),
  ...env,
}, { fetchFn: z.fetch, ...deps });
const create = (p, extra = {}) => p.create({ image: 'x', envs: {}, labels: { purpose: 'cloudy-cloud' }, ttlSeconds: 3600, ...extra });

contractSuite('zipbox', ({ withKey }) => mk(fakeZipbox(), withKey ? {} : { ZIPBOX_API_KEY: undefined }));

test('zipbox: create without the token-on-box consent refuses with a guided error and no network call', async () => {
  const z = fakeZipbox();
  const p = mk(z, { CLOUDY_CLOUD_ZIPBOX_TOKEN_ON_BOX: undefined });
  const e = await create(p).then(() => { throw new Error('should refuse'); }, (x) => x);
  assert.match(e.message, /CLOUDY_CLOUD_ZIPBOX_TOKEN_ON_BOX=yes/);
  assert.match(e.message, /proxy secrets/i);
  assert.equal(z.log.length, 0, 'no HTTP call may run before the consent exists');
});

test('zipbox: create with consent claims a box, waits, provisions it and writes the env file', async () => {
  const z = fakeZipbox();
  const p = mk(z);
  const s = await create(p, { envs: { FOO: 'bar', CLAUDE_CODE_OAUTH_TOKEN: OAT }, labels: { purpose: 'cloudy-cloud', owner: 'o1', name: 'bold-fox' } });
  try {
    const calls = z.log.map((l) => `${l.method} ${l.path}`);
    assert.ok(calls.includes('POST /sandbox/identity/claim'), calls.join('\n'));
    assert.ok(calls.some((c) => /GET \/sandbox\/.+\/wait\?until=ready/.test(c)), calls.join('\n'));
    const claim = z.log.find((l) => l.path === '/sandbox/identity/claim');
    assert.match(claim.body.name, /^cc-[0-9a-z]+-[0-9a-z]{6}$/);
    // provision ran on the box as one exec, then the env file was written with the consented values
    assert.ok(z.execs.get(s.id)?.some((c) => /apt-get|claude-code/.test(c)), JSON.stringify(z.execs.get(s.id)));
    const envFile = z.files.get(s.id)?.get('/root/.cloudy-cloud-env');
    assert.ok(envFile?.includes('GH_TOKEN=') && envFile.includes('FOO=') && envFile.includes('CLAUDE_CODE_OAUTH_TOKEN='));
    // The API key, the box token and the credential values appear only where they must:
    // the bearer headers and the env-file write. Never in a URL, a name, or another body.
    for (const l of z.log) {
      assert.ok(!l.url.includes(KEY) && !l.url.includes(GH) && !l.url.includes(OAT), l.url);
      if (l.path.startsWith('/files/write')) continue;
      const text = typeof l.body === 'string' ? l.body : JSON.stringify(l.body ?? '');
      for (const v of [KEY, GH, OAT]) assert.ok(!text.includes(v), `${l.method} ${l.path}`);
    }
  } finally { await s.kill(); }
});

test('zipbox: an egress allow list is refused', async () => {
  const z = fakeZipbox();
  await assert.rejects(create(mk(z), { egress: { allow: ['example.com'] } }), (e) => e.code === 'egress_unsupported');
  assert.equal(z.log.length, 0);
});

test('zipbox: coordinators are refused clearly', async () => {
  const z = fakeZipbox();
  await assert.rejects(create(mk(z), { labels: { purpose: 'cloudy-cloud', role: 'coordinator' } }), /[Cc]oordinator/);
  assert.equal(z.log.length, 0);
});

test('zipbox: list returns only our boxes, filters by labels and sweeps a box past its deadline', async () => {
  const z = fakeZipbox();
  const p = mk(z);
  const a = await create(p, { labels: { purpose: 'cloudy-cloud', owner: 'o1' } });
  const b = await create(p, { labels: { purpose: 'cloudy-cloud', owner: 'o2' } });
  try {
    z.store.set('foreign', z.boxRow('foreign', 'someone-elses'));
    const past = Math.floor((Date.now() - 60_000) / 1000).toString(36);
    z.store.set('dead', z.boxRow('dead', `cc-${past}-zzzz99`)); // ours by name, no state row, already expired
    const ids = async (l) => (await p.list(l)).map((r) => r.id);
    assert.deepEqual(await ids({ owner: 'o1' }), [a.id]);
    assert.deepEqual((await ids({ purpose: 'cloudy-cloud' })).sort(), [a.id, b.id].sort());
    assert.ok(!z.store.has('dead'), 'the expired box was deleted by the list sweep');
    assert.ok(z.store.has('foreign'), 'a foreign box is never touched');
    assert.ok(z.log.some((l) => l.method === 'DELETE' && l.path === '/sandbox/dead'));
    const row = (await p.list({ owner: 'o1' }))[0];
    assert.ok(row.deleteAt && Date.parse(row.deleteAt) > Date.now(), 'deleteAt is reported');
    assert.equal(row.machineName, z.store.get(a.id).name);
  } finally { await a.kill(); await b.kill(); }
});

test('zipbox: delete sends archiveBeforeDestroy=false and a 404 counts as deleted', async () => {
  const z = fakeZipbox();
  const p = mk(z);
  await p.delete('ghost-id');
  const d = z.log.find((l) => l.method === 'DELETE');
  assert.equal(d.path, '/sandbox/ghost-id');
  assert.deepEqual(d.body, { archiveBeforeDestroy: false });
});

test('zipbox: connect refuses a box past its deadline and deletes it', async () => {
  const z = fakeZipbox();
  const p = mk(z);
  const past = Math.floor((Date.now() - 60_000) / 1000).toString(36);
  z.store.set('old', z.boxRow('old', `cc-${past}-aaaa11`));
  await assert.rejects(p.connect('old'), (e) => e.code === 'not_found');
  assert.ok(!z.store.has('old'));
});

test('zipbox: http errors normalize (429, 401, 5xx, quota)', async () => {
  const z = fakeZipbox();
  const p = mk(z);
  z.fail.set('/sandbox', () => z.respond(429, { error: { code: 'rate_limited', message: 'slow down', retryAfterMs: 2500 } }));
  const e1 = await p.list().then(() => { throw new Error('should fail'); }, (x) => x);
  assert.equal(e1.code, 'rate_limited');
  assert.equal(e1.retryAfterSeconds, 3);
  z.fail.set('/sandbox', () => z.respond(401, { error: { code: 'unauthorized', message: 'bad key' } }));
  await assert.rejects(p.list(), (e) => e.code === 'no_key');
  z.fail.set('/sandbox', () => z.respond(503, { error: { code: 'unavailable', message: 'maintenance' } }));
  await assert.rejects(p.list(), (e) => e.code === 'transient');
  z.fail.clear();
  z.fail.set('/sandbox/identity/claim', () => z.respond(402, { error: { code: 'insufficient_credits', message: 'top up' } }));
  await assert.rejects(create(p), (e) => e.code === 'quota_exceeded');
  // machine_limit_reached is permanent (a name is never freed) — never quota_exceeded, never retried.
  z.fail.set('/sandbox/identity/claim', () => z.respond(403, { error: { code: 'machine_limit_reached', message: 'limit' } }));
  const lim = await create(p).then(() => { throw new Error('should fail'); }, (x) => x);
  assert.equal(lim.code, 'machine_limit_reached');
  assert.ok(!isQuotaExceeded(lim) && !isRateLimited(lim));
});

test('zipbox: publishPort creates a public preview and unpublishPort removes it', async () => {
  const z = fakeZipbox();
  const p = mk(z);
  const s = await create(p);
  try {
    const name = z.store.get(s.id).name;
    const r = await p.publishPort(s.id, '8080');
    assert.equal(r.url, `https://p8080.${name}.zbox.sh`);
    assert.ok(z.execs.get(s.id).at(-1).includes(`tribes-caddy add p8080.${name}.zbox.sh 127.0.0.1:8080`));
    await p.unpublishPort(s.id, '8080');
    assert.ok(z.execs.get(s.id).at(-1).includes(`tribes-caddy rm p8080.${name}.zbox.sh`));
  } finally { await s.kill(); }
});

test('zipbox: commands.run returns output, streams stdout and rejects on a nonzero exit', async () => {
  const z = fakeZipbox();
  const p = mk(z);
  const s = await create(p);
  try {
    z.execState = { code: 0, out: 'hello\n', err: 'warn\n' };
    let streamed = '';
    const r = await s.commands.run('echo hi', { timeoutMs: 5000, onStdout: (c) => { streamed += c; } });
    assert.deepEqual(r, { stdout: 'hello\n', stderr: 'warn\n', exitCode: 0 });
    assert.equal(streamed, 'hello\n');
    const last = z.log.filter((l) => l.path === '/exec').at(-1).body;
    assert.equal(last.timeoutMs, 5000);
    z.execState = { code: 2, out: 'o', err: 'e' };
    const e = await s.commands.run('exit 2', { timeoutMs: 5000 }).then(() => { throw new Error('should fail'); }, (x) => x);
    assert.equal(e.exitCode, 2);
    assert.equal(e.stdout, 'o');
    assert.equal(e.stderr, 'e');
    z.execState = { code: 124, timedOut: true };
    await assert.rejects(s.commands.run('sleep 99', { timeoutMs: 1000 }), (x) => x.code === 'timeout');
  } finally { await s.kill(); }
});

// install.sh --check-only, on the zipbox branch: key presence, consent, GH_TOKEN and a Claude
// credential — and never a value. Tools are not stubbed, so the verdict may fail; the provider
// lines are what is asserted.
const checkOnly = (cfgText) => {
  const cfg = join(mkdtempSync(join(tmpdir(), 'ccz-')), 'env');
  writeFileSync(cfg, cfgText, { mode: 0o600 });
  return spawnSync('/bin/bash', [SCRIPT, '--check-only'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), 'h-')), CLOUDY_CLOUD_CONFIG: cfg } });
};

test('setup --check-only on zipbox checks only the Zipbox key, the consent, GH_TOKEN and a Claude credential', () => {
  let r = checkOnly('CLOUDY_CLOUD_PROVIDER=zipbox\n');
  assert.match(r.stdout, /ZIPBOX_API_KEY/);
  assert.match(r.stdout, /CLOUDY_CLOUD_ZIPBOX_TOKEN_ON_BOX/);
  assert.doesNotMatch(r.stdout, /Instabox/);

  r = checkOnly(`CLOUDY_CLOUD_PROVIDER=zipbox\nZIPBOX_API_KEY=${KEY}\n`);
  assert.match(r.stdout, /CLOUDY_CLOUD_ZIPBOX_TOKEN_ON_BOX/);
  assert.doesNotMatch(r.stdout, new RegExp(esc(KEY)));

  r = checkOnly(`CLOUDY_CLOUD_PROVIDER=zipbox\nZIPBOX_API_KEY=${KEY}\nCLOUDY_CLOUD_ZIPBOX_TOKEN_ON_BOX=yes\n`);
  assert.match(r.stdout, /GH_TOKEN/);
  assert.doesNotMatch(r.stdout, new RegExp(esc(KEY)));

  r = checkOnly(`CLOUDY_CLOUD_PROVIDER=zipbox\nZIPBOX_API_KEY=${KEY}\nCLOUDY_CLOUD_ZIPBOX_TOKEN_ON_BOX=yes\nGH_TOKEN=${GH}\nCLAUDE_CODE_OAUTH_TOKEN=${OAT}\n`);
  assert.match(r.stdout, /GH_TOKEN is saved/);
  assert.match(r.stdout, /Claude credential is saved/);
  for (const v of [KEY, GH, OAT]) assert.doesNotMatch(r.stdout, new RegExp(esc(v)));
});

test('loadProvider knows zipbox', async () => {
  const p = await loadProvider({ CLOUDY_CLOUD_PROVIDER: 'zipbox' });
  assert.equal(p.name, 'zipbox');
  assert.equal(p.keyName, 'ZIPBOX_API_KEY');
});

// ---- Astra review fixes ----

// A provider with an isolated state file (no env dir needed): env values plus a chosen stateFile.
const mkState = (z, dir, deps = {}) => createProvider({
  ZIPBOX_API_KEY: KEY, CLOUDY_CLOUD_ZIPBOX_TOKEN_ON_BOX: 'yes', GH_TOKEN: GH,
  CLAUDE_CODE_OAUTH_TOKEN: OAT, CLOUDY_CLOUD_CONFIG: join(dir, 'env'),
}, { fetchFn: z.fetch, stateFile: join(dir, 'zipbox-boxes.json'), ...deps });

// create: a claim answer lost on the wire is recovered by replaying the SAME Idempotency-Key,
// which returns the original box instead of claiming a second one.
test('zipbox: a dropped claim answer is retried with the same Idempotency-Key', async () => {
  const z = fakeZipbox();
  const realFetch = z.fetch;
  let dropped = false;
  z.fetch = async (url, init) => {
    if (!dropped && new URL(String(url)).pathname === '/sandbox/identity/claim') {
      dropped = true;
      await realFetch(url, init); // the claim landed; the answer never arrived
      throw new Error('socket hang up');
    }
    return realFetch(url, init);
  };
  const p = mk(z, {}, { sleep: async () => {} });
  const s = await create(p);
  try {
    const claims = z.log.filter((l) => l.path === '/sandbox/identity/claim');
    assert.equal(claims.length, 2);
    assert.equal(claims[0].headers['Idempotency-Key'], claims[1].headers['Idempotency-Key']);
    assert.equal(z.store.size, 1, 'the replay returned the original box instead of claiming a second one');
  } finally { await s.kill(); }
});

// create: the first state write (and everything after the claim) is covered by cleanup —
// a failure there deletes the claimed box.
test('zipbox: a state-write failure after claim deletes the box', async () => {
  const z = fakeZipbox();
  const dir = mkdtempSync(join(tmpdir(), 'ccz-'));
  const blocker = join(dir, 'blocked');
  writeFileSync(blocker, 'x'); // a file where the state file's parent directory must be
  const p = mkState(z, dir, { stateFile: join(blocker, 'zipbox-boxes.json') });
  await assert.rejects(create(p));
  assert.equal(z.store.size, 0, 'the claimed box was deleted');
  assert.ok(z.log.some((l) => l.method === 'DELETE'));
});

// delete: ownership survives a failed delete — the state row stays (marked with the error) and
// list() keeps the box visible.
test('zipbox: a failed delete keeps the record and list shows the error', async () => {
  const z = fakeZipbox();
  const dir = mkdtempSync(join(tmpdir(), 'ccz-'));
  const p = mkState(z, dir, { sleep: async () => {} });
  const s = await create(p, { labels: { purpose: 'cloudy-cloud', owner: 'o1' } });
  z.fail.set(`/sandbox/${s.id}`, (m) => (m === 'DELETE' ? z.respond(503, { error: { code: 'unavailable', message: 'down' } }) : undefined));
  await assert.rejects(p.delete(s.id, { retries: 0 }), (e) => e.code === 'transient');
  const rows = await p.list({ owner: 'o1' });
  assert.equal(rows.length, 1, 'a failed delete stays visible');
  assert.match(rows[0].deleteError ?? '', /delete failed|unavailable|down/i);
  const st = JSON.parse(readFileSync(join(dir, 'zipbox-boxes.json'), 'utf8'));
  assert.match(st.boxes[s.id]?.deleteError ?? '', /unavailable|down/, 'the state record keeps the failure');
  z.fail.delete(`/sandbox/${s.id}`);
  await s.kill();
});

// The deadline sweep in list(): a failed delete is reported through onError and the row stays listed
// (so the reaper and machines ls keep seeing it and retry).
test('zipbox: the deadline sweep reports a failed delete and keeps the row', async () => {
  const z = fakeZipbox();
  const p = mk(z, {}, { sleep: async () => {} });
  const past = Math.floor((Date.now() - 60_000) / 1000).toString(36);
  z.store.set('stuck', z.boxRow('stuck', `cc-${past}-bbbb22`));
  z.fail.set('/sandbox/stuck', (m) => (m === 'DELETE' ? z.respond(503, { error: { code: 'unavailable', message: 'down' } }) : undefined));
  const errs = [];
  const rows = await p.list({ purpose: 'cloudy-cloud' }, { onError: (e) => errs.push(e) });
  assert.equal(errs.length, 1, 'the sweep reported the failed delete');
  assert.equal(rows[0]?.id, 'stuck', 'the row is still listed');
  assert.match(rows[0].deleteError ?? '', /unavailable|down/);
});

// connect() must not report an expired box removed when the delete itself failed.
test('zipbox: connect does not report an expired box removed when the delete failed', async () => {
  const z = fakeZipbox();
  const p = mk(z, {}, { sleep: async () => {} });
  const past = Math.floor((Date.now() - 60_000) / 1000).toString(36);
  z.store.set('old', z.boxRow('old', `cc-${past}-aaaa11`));
  z.fail.set('/sandbox/old', (m) => (m === 'DELETE' ? z.respond(503, { error: { code: 'unavailable', message: 'down' } }) : undefined));
  const e = await p.connect('old').then(() => { throw new Error('x'); }, (x) => x);
  assert.notEqual(e.code, 'not_found', 'must not claim removal when the delete failed');
  assert.ok(z.store.has('old'), 'the box is still there');
});

// State writes are serialised with a lock dir: a lock held by another process fails loudly
// (never a half-written file or a silently lost row).
test('zipbox: a held state lock fails create loudly and the claimed box is deleted', async () => {
  const z = fakeZipbox();
  const dir = mkdtempSync(join(tmpdir(), 'ccz-'));
  const p = mkState(z, dir, { sleep: async () => {} });
  mkdirSync(`${join(dir, 'zipbox-boxes.json')}.lock`);
  await assert.rejects(create(p), (e) => e.code === 'transient');
  assert.equal(z.store.size, 0, 'the claimed box was deleted');
});

// A stale lock (crashed process) is taken over.
test('zipbox: a stale state lock is taken over', async () => {
  const z = fakeZipbox();
  const dir = mkdtempSync(join(tmpdir(), 'ccz-'));
  const p = mkState(z, dir);
  const lock = `${join(dir, 'zipbox-boxes.json')}.lock`;
  mkdirSync(lock);
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  const s = await create(p);
  try {
    assert.ok(JSON.parse(readFileSync(join(dir, 'zipbox-boxes.json'), 'utf8')).boxes[s.id]);
  } finally { await s.kill(); }
});

// secrets: the full error field is scrubbed BEFORE truncation, so a token crossing the 200-char
// cut cannot leave a visible fragment.
test('zipbox: error text is redacted before it is truncated', async () => {
  const z = fakeZipbox();
  const p = mk(z);
  z.fail.set('/sandbox', () => z.respond(500, { error: { code: 'unavailable', message: `${'x'.repeat(195)}${KEY}` } }));
  const e = await p.list().then(() => { throw new Error('x'); }, (x) => x);
  assert.ok(!e.message.includes('zb_'), `key fragment leaked: ${e.message}`);
});

// secrets: the boxToken from /wait is registered with the scrubber before the first box call,
// so a provisioning exec error cannot leak it.
test('zipbox: the box token is scrubbed from provisioning exec errors', async () => {
  const z = fakeZipbox();
  const p = mk(z);
  z.execState = { code: 1, out: '', err: 'provision died: bt-sbx-1' };
  const e = await create(p).then(() => { throw new Error('x'); }, (x) => x);
  assert.ok(!e.message.includes('bt-sbx-1'), e.message);
  assert.ok(!(e.stderr ?? '').includes('bt-sbx-1'), e.stderr);
});

// secrets: a failed exec attaches redacted stdout/stderr, never raw secret-bearing output.
test('zipbox: exec errors carry redacted stdout and stderr', async () => {
  const z = fakeZipbox();
  const p = mk(z);
  const s = await create(p, { envs: { CLAUDE_CODE_OAUTH_TOKEN: OAT } });
  try {
    z.execState = { code: 3, out: `out ${GH}`, err: `err ${GH} ${OAT}` };
    const e = await s.commands.run('x').then(() => { throw new Error('x'); }, (x) => x);
    for (const v of [GH, OAT]) {
      assert.ok(!e.message.includes(v), e.message);
      assert.ok(!(e.stdout ?? '').includes(v));
      assert.ok(!(e.stderr ?? '').includes(v));
    }
  } finally { await s.kill(); }
});

// The diagnostic hints pipe the Authorization header to curl on stdin; the key never sits in argv.
test('zipbox: the diagnostic curl hints pass the key on stdin, never in argv', () => {
  const p = mk(fakeZipbox());
  for (const t of [p.text.listMachines, p.text.apiFix]) {
    assert.doesNotMatch(t, /curl[^\n|]*-H/); // no -H flag on the curl argv
    assert.match(t, /curl -s -K - /);
  }
});

// Uploads carrying credentials (the env file write) must not follow redirects to another origin.
test('zipbox: box calls refuse redirects so credential bodies cannot leave the origin', async () => {
  const z = fakeZipbox();
  const p = mk(z);
  const s = await create(p);
  try {
    const boxCalls = z.log.filter((l) => l.url.includes('zbox.sh'));
    assert.ok(boxCalls.length > 0);
    for (const l of boxCalls) assert.equal(l.redirect, 'error', `${l.method} ${l.path}`);
  } finally { await s.kill(); }
});

// machine_limit_reached is permanent (names are never freed) — it must not look like a retryable quota.
test('zipbox: machine_limit_reached is a permanent error, not a retryable quota', async () => {
  const z = fakeZipbox();
  const p = mk(z);
  z.fail.set('/sandbox/identity/claim', () => z.respond(403, { error: { code: 'machine_limit_reached', message: "You've reached this account's limit of 250 machines." } }));
  const e = await create(p).then(() => { throw new Error('x'); }, (x) => x);
  assert.equal(e.code, 'machine_limit_reached');
  assert.match(e.message, /250|name/);
  assert.ok(!isQuotaExceeded(e) && !isRateLimited(e), 'the start queue must not retry it');
});

// Exec SSE: a `gap` event (dropped output) or a malformed output event fails explicitly instead
// of returning partial stdout as a success.
test('zipbox: a gap event or a malformed output event fails with incomplete_output', async () => {
  const z = fakeZipbox();
  const p = mk(z);
  const s = await create(p);
  try {
    z.execState = { events: [['start', { id: 'c' }], ['stdout', { data: 'partial' }], ['gap', { dropped: 64 }], ['exit', { state: 'exited', exitCode: 0, signal: null, timedOut: false }]] };
    const e1 = await s.commands.run('x').then(() => { throw new Error('x'); }, (x) => x);
    assert.equal(e1.code, 'incomplete_output');
    z.execState = { raw: 'event: stdout\ndata: {broken\n\nevent: exit\ndata: {"exitCode":0}\n\n' };
    const e2 = await s.commands.run('x').then(() => { throw new Error('x'); }, (x) => x);
    assert.equal(e2.code, 'incomplete_output');
  } finally { await s.kill(); }
});

// Error normalisation: a malformed list answer is an error (not an empty account), a locally
// missing key is no_key (not transient), and box-API 400/403 errors get their permanent codes.
test('zipbox: a malformed list answer is an error, a missing key is no_key, box 400/403 are permanent', async () => {
  const z = fakeZipbox();
  const p = mk(z);
  z.fail.set('/sandbox', () => z.respond(200, { boxes: [] })); // a success in the wrong shape
  await assert.rejects(p.list(), (e) => e.code === 'transient');
  z.fail.set('/sandbox', () => z.respond(200, '<html>not json</html>'));
  await assert.rejects(p.list(), (e) => e.code === 'transient');
  z.fail.delete('/sandbox');
  const noKey = mk(z, { ZIPBOX_API_KEY: undefined });
  await assert.rejects(noKey.list(), (e) => e.code === 'no_key');
  await assert.rejects(noKey.delete('sbx-1'), (e) => e.code === 'no_key');
  const s = await create(p);
  try {
    z.fail.set('/files/download', () => z.respond(400, { error: 'path must be absolute', code: 'invalid_request' }));
    await assert.rejects(s.files.read('rel/path'), (e) => e.code === 'invalid_request');
    z.fail.set('/files/download', () => z.respond(403, { error: 'This folder is read-only.' }));
    await assert.rejects(s.files.read('/root/x'), (e) => e.code === 'forbidden');
  } finally { await s.kill(); }
});

// publishPort propagates the last caddy failure; publish/unpublish validate the port range.
test('zipbox: publishPort propagates a caddy failure and both calls validate the port', async () => {
  const z = fakeZipbox();
  const p = mk(z);
  const s = await create(p);
  try {
    z.execState = { code: 1, out: '', err: 'caddy exploded' };
    await assert.rejects(p.publishPort(s.id, '8080'), (e) => /caddy exploded/.test(e.message ?? '') || e.exitCode === 1);
    for (const bad of ['x', '0', '65536', '80; rm -rf /']) {
      await assert.rejects(p.publishPort(s.id, bad), /port/);
      await assert.rejects(p.unpublishPort(s.id, bad), /port/);
    }
  } finally { await s.kill(); }
});

// The README consent line must be copy-pasteable: config readers keep an inline comment as part
// of the value, and the provider requires exactly `yes`.
test('zipbox: the README consent line has no inline comment', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /^CLOUDY_CLOUD_ZIPBOX_TOKEN_ON_BOX=yes$/m);
});
