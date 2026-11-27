import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { contractSuite } from './provider-contract.mjs';
import { createProvider } from '../src/providers/boat.mjs';
import { loadProvider } from '../src/providers/index.mjs';
import { installId } from '../src/config.mjs';

const KEY = 'boat_test_key_0000000000000000000000';
const GH = 'ghp_boat_test_secret';
const OAT = 'sk-ant-oat01-boattest';

// A fake boat control plane: the documented /api/v1 surface. `log` records every request
// (method, url, headers, parsed body) so tests can assert what the adapter sent and that
// no secret value ever rode a URL or an unexpected body.
function fakeBoat({ serverLabelFilter = true } = {}) {
  const log = [];
  const boxes = new Map(); // id -> sandbox record
  const files = new Map(); // id -> Map(path -> Buffer)
  const procs = new Map(); // processId -> {command, out, err, code, killed}
  const hosted = new Map(); // id -> Map(port -> url)
  const idem = new Map(); // Idempotency-Key -> stored create response
  const fail = new Map(); // /path or 'METHOD /path' -> (method, u, body, init) => response (falsy falls through)
  const z = { exec: (cmd) => ({ code: 0, out: '', err: '' }) }; // what the next command answers
  let n = 0, pidN = 0;
  const respond = (status, obj, extraHeaders = {}) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => JSON.stringify(obj),
    headers: { get: (h) => extraHeaders[String(h).toLowerCase()] ?? null },
  });
  const err = (status, code, message, extra) => respond(status, { ok: false, status, code, message, error: { code, message, ...(extra && { details: extra }) }, requestId: 'req_fake' });
  const row = (id, extra = {}) => ({ id, name: `boat-${id}`, state: 'ready', labels: {}, ttlSeconds: 3600, archiveAfter: '2027-01-01T00:00:00.000Z', url: `https://${id}.boat.dev`, sshEndpoint: `ssh://${id}.boat.dev`, createdAt: '2026-01-01T00:00:00.000Z', access: 'owner', visibility: 'private', createdBy: 'someone', ...extra });
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    const path = u.pathname.replace(/^\/api\/v1/, '') || u.pathname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    log.push({ method, url: String(url), path: path + u.search, headers: init.headers ?? {}, body, redirect: init.redirect });
    const forced = fail.get(`${method} ${path}`) ?? fail.get(path);
    if (forced) { const out = forced(method, u, body, init); if (out) return out; }
    if (path === '/sandboxes' && method === 'POST') {
      const k = init.headers?.['Idempotency-Key'];
      if (k && idem.has(k)) return idem.get(k);
      const id = `bx_fake${String(++n).padStart(3, '0')}`;
      boxes.set(id, row(id, { name: body.name ?? `boat-${id}`, state: 'ready', labels: body.labels ?? {}, ttlSeconds: body.ttlSeconds, createBody: body }));
      const r = respond(202, { ok: true, type: 'sandbox.created', status: 'created', ttlSeconds: body.ttlSeconds, sandbox: boxes.get(id) });
      if (k) idem.set(k, r);
      return r;
    }
    if (path === '/sandboxes' && method === 'GET') {
      let all = [...boxes.values()];
      const want = u.searchParams.getAll('label').map((s) => s.split('='));
      if (serverLabelFilter) all = all.filter((b) => want.every(([k, v]) => b.labels?.[k] === v));
      const limit = Number(u.searchParams.get('limit')) || 200;
      const cursor = u.searchParams.get('cursor');
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + limit);
      const next = start + limit < all.length ? String(start + limit) : null;
      return respond(200, { ok: true, type: 'sandbox.list', sandboxes: page, pageInfo: { nextCursor: next, hasMore: !!next } });
    }
    const sm = path.match(/^\/sandboxes\/([^/]+)(\/.*)?$/);
    if (sm) {
      const [, id, sub] = sm;
      const rec = boxes.get(id);
      if (!rec) return err(404, 'not_found', `sandbox ${id} not found`);
      if (!sub && method === 'GET') return respond(200, { ok: true, type: 'sandbox.info', sandbox: rec });
      if (!sub && method === 'DELETE') {
        if (init.headers?.['X-Ascii-Confirm-Delete'] !== id) return err(409, 'delete_not_confirmed', 'confirm header mismatch');
        boxes.delete(id);
        return respond(202, { ok: true, type: 'deletion.operation', operation: { id: 'bdop_fake', kind: 'sandbox', targetId: id, status: 'accepted', reason: 'user', attemptCount: 1, requestedAt: '2026-01-01T00:00:00.000Z', completedAt: null } });
      }
      if (sub === '/commands' && method === 'POST') {
        const pid = ++pidN;
        const r = z.exec(body.command, rec) ?? { code: 0, out: '', err: '' };
        procs.set(pid, { id, command: body.command, ...r, running: !!r.running, killed: false });
        if (body.detached) return respond(200, { ok: true, type: 'command.started', success: true, processId: pid, pid, command: body.command, startedAt: '2026-01-01T00:00:00.000Z' });
        return respond(200, { ok: true, type: 'command.finished', success: r.code === 0 && !r.timedOut, commandId: `cmd_${pid}`, exitCode: r.code, stdout: r.out, stderr: r.err, timedOut: !!r.timedOut, stdoutTruncated: false, stderrTruncated: false });
      }
      const cm = sub?.match(/^\/commands\/(\d+)(\/stream)?$/);
      if (cm) {
        const p = procs.get(Number(cm[1]));
        if (!p) return err(404, 'not_found', 'no such process');
        if (method === 'DELETE') { p.killed = true; p.running = false; return respond(200, { ok: true, type: 'command.stopped', running: false }); }
        if (method === 'GET' && !cm[2]) {
          if (z.statusPages?.length) return respond(200, { ok: true, type: 'command.status', processId: Number(cm[1]), ...z.statusPages.shift() });
          const so = Number(u.searchParams.get('stdoutOffset')) || 0;
          const eo = Number(u.searchParams.get('stderrOffset')) || 0;
          return respond(200, { ok: true, type: 'command.status', success: !p.killed && !p.running && p.code === 0, processId: Number(cm[1]),
            status: p.killed ? 'exited' : p.running ? 'running' : 'exited', running: !p.killed && p.running,
            exitCode: p.killed ? 143 : p.running ? null : p.code, signal: null, stdout: p.out.slice(so), stderr: p.err.slice(eo), stdoutOffset: so, stderrOffset: eo,
            stdoutNextOffset: p.out.length, stderrNextOffset: p.err.length, stdoutTruncated: false, stderrTruncated: false });
        }
      }
      if (sub === '/files' && method === 'PUT') {
        const dir = files.get(id) ?? files.set(id, new Map()).get(id);
        dir.set(body.path, body.encoding === 'base64' ? Buffer.from(body.content, 'base64') : Buffer.from(body.content, 'utf8'));
        return respond(200, { ok: true, type: 'file.written', path: body.path, encoding: body.encoding ?? 'utf8' });
      }
      if (sub === '/files' && method === 'GET') {
        const f = files.get(id)?.get(u.searchParams.get('path'));
        if (f === undefined) return err(404, 'not_found', 'no such file');
        return respond(200, { ok: true, type: 'file.read', content: f.toString('base64'), encoding: 'base64' });
      }
      if (sub === '/host' && method === 'POST') {
        const h = hosted.get(id) ?? hosted.set(id, new Map()).get(id);
        const url = h.get(body.port) ?? `https://t-${id}-${body.port}.on.boat.dev?_token=tok_${id}_${body.port}`;
        h.set(body.port, url);
        return respond(200, { ok: true, type: 'port.hosted', port: body.port, url, access: body.public ? 'public' : 'private' });
      }
      return err(404, 'not_found', `unknown route ${method} ${path}`);
    }
    if (path === '/limits' && method === 'GET') {
      return respond(200, { ok: true, type: 'limits.info', canStart: true, maxActiveSandboxes: 100, sandboxPlanKey: 'box_20', sandboxPlanDollars: 20,
        startLimits: { perMinute: 10 }, starts: { minute: { remaining: 9 } }, machineTypes: [{ type: 'default', available: true }] });
    }
    return err(404, 'not_found', `unknown route ${method} ${path}`);
  };
  return Object.assign(z, { fetch, log, boxes, files, procs, hosted, idem, fail, row, respond, err });
}

// The consent lives in a config file, like a real user's: the adapter re-reads the file at
// every create and does not trust a copy inside the (possibly stale) env object it was built with.
// baseEnv plays the real process environment (kept empty so the developer's own exports can't leak in).
const cfgFile = (lines = 'CLOUDY_CLOUD_BOAT_TOKEN_ON_BOX=yes\n') => {
  const f = join(mkdtempSync(join(tmpdir(), 'cc-boat-')), 'env');
  writeFileSync(f, lines, { mode: 0o600 });
  return f;
};
const mk = (z, env = {}, deps = {}) => createProvider({
  BOAT_API_KEY: KEY, GH_TOKEN: GH,
  CLAUDE_CODE_OAUTH_TOKEN: OAT, CLOUDY_CLOUD_CONFIG: cfgFile(), ...env,
}, { fetchFn: z.fetch, sleep: async () => {}, baseEnv: {}, ...deps });
const create = (p, extra = {}) => p.create({ image: 'x', envs: {}, labels: { purpose: 'cloudy-cloud' }, ttlSeconds: 3600, ...extra });

contractSuite('boat', ({ withKey }) => mk(fakeBoat(), withKey ? {} : { BOAT_API_KEY: undefined }));

test('boat: create without the token-on-box consent refuses with a guided error and no network call', async () => {
  const z = fakeBoat();
  const p = mk(z, { CLOUDY_CLOUD_CONFIG: cfgFile('BOAT_API_KEY=x\n') });
  const e = await create(p).then(() => { throw new Error('should refuse'); }, (x) => x);
  assert.match(e.message, /CLOUDY_CLOUD_BOAT_TOKEN_ON_BOX=yes/);
  assert.match(e.message, /proxy secrets/i);
  assert.equal(z.log.length, 0, 'no HTTP call may run before the consent exists');
});

test('boat: a consent value inside the env object alone does not count — the file is authoritative', async () => {
  const z = fakeBoat();
  // The in-memory env still holds a yes the file no longer has (the server's shared object
  // between install.sh refreshes). The fresh file read must not consent.
  const p = mk(z, { CLOUDY_CLOUD_BOAT_TOKEN_ON_BOX: 'yes', CLOUDY_CLOUD_CONFIG: cfgFile('BOAT_API_KEY=x\n') });
  const e = await create(p).then(() => { throw new Error('should refuse'); }, (x) => x);
  assert.match(e.message, /CLOUDY_CLOUD_BOAT_TOKEN_ON_BOX=yes/);
  assert.equal(z.log.length, 0);
});

test('boat: consent is re-read from the file at each create — revoking it stops the next queued worker', async () => {
  const z = fakeBoat();
  const cfg = cfgFile('CLOUDY_CLOUD_BOAT_TOKEN_ON_BOX=yes\n');
  const p = mk(z, { CLOUDY_CLOUD_CONFIG: cfg });
  await (await create(p)).kill();
  // The setup flow removed the line while a worker waited in the queue.
  writeFileSync(cfg, 'BOAT_API_KEY=x\n', { mode: 0o600 });
  const n = z.log.length;
  await assert.rejects(create(p), /CLOUDY_CLOUD_BOAT_TOKEN_ON_BOX=yes/);
  assert.equal(z.log.length, n, 'no HTTP call is made once consent is revoked');
});

test('boat: a real environment value consents, and an exported no beats a saved yes', async () => {
  const z = fakeBoat();
  const p = mk(z, { CLOUDY_CLOUD_CONFIG: cfgFile('BOAT_API_KEY=x\n') }, { baseEnv: { CLOUDY_CLOUD_BOAT_TOKEN_ON_BOX: 'yes' } });
  await (await create(p)).kill();
  const n = z.log.length;
  const refused = mk(z, {}, { baseEnv: { CLOUDY_CLOUD_BOAT_TOKEN_ON_BOX: 'no' } }); // the file still says yes; the shell says no
  await assert.rejects(create(refused), /CLOUDY_CLOUD_BOAT_TOKEN_ON_BOX=yes/);
  assert.equal(z.log.length, n, 'the shell override is honoured before the saved line');
});

test('boat: create sends labels, TTL, noEnv, private visibility, monitoring off and an Idempotency-Key', async () => {
  const z = fakeBoat();
  const p = mk(z);
  const s = await create(p, { envs: { FOO: 'bar', CLAUDE_CODE_OAUTH_TOKEN: OAT }, labels: { purpose: 'cloudy-cloud', owner: 'o1', name: 'bold-fox' }, ttlSeconds: 1800 });
  try {
    const post = z.log.find((l) => l.method === 'POST' && l.path === '/sandboxes');
    assert.equal(post.headers['Idempotency-Key'].length > 20, true);
    assert.equal(post.body.ttlSeconds, 1800);
    assert.equal(post.body.labels.purpose, 'cloudy-cloud');
    assert.equal(post.body.labels.owner, 'o1');
    assert.ok(post.body.labels.deleteAt, 'the delete deadline is stored as a label');
    assert.equal(post.body.noEnv, true, 'workers never carry the account secrets');
    assert.equal(post.body.visibility, 'private', 'other organization members cannot use the sandbox');
    assert.equal(post.body.snapshots, false, 'the disk is erased on stop');
    assert.equal(post.body.monitoring, false, 'the Boat agent never streams process output home');
    assert.equal(post.body.files, undefined, 'no credential value travels in the create body');
    // The env file exists at mode 600 before any credential value lands, and the mode is verified after the write.
    const cmds = z.log.filter((l) => l.method === 'POST' && l.path === `/sandboxes/${s.id}/commands`);
    const install = cmds.findIndex((l) => l.body.command.includes('install -m 600'));
    const verify = cmds.findIndex((l) => l.body.command.includes('chmod 600') && l.body.command.includes('stat -c %a'));
    const put = z.log.findIndex((l) => l.method === 'PUT' && l.path === `/sandboxes/${s.id}/files`);
    assert.ok(install !== -1 && put !== -1 && verify !== -1, 'install, write and verify all ran');
    const cmdI = z.log.indexOf(cmds[install]);
    const cmdV = z.log.indexOf(cmds[verify]);
    assert.ok(cmdI < put && put < cmdV, 'the file is 600 before values land; mode is enforced after');
    // The consented credential values reach the box only inside the env file — never in a URL or a plain body field.
    const envBody = Buffer.from(z.log[put].body.content, 'base64').toString('utf8');
    assert.ok(envBody.includes('GH_TOKEN=') && envBody.includes('FOO=') && envBody.includes('CLAUDE_CODE_OAUTH_TOKEN='));
    for (const l of z.log) {
      assert.ok(!l.url.includes(KEY) && !l.url.includes(GH) && !l.url.includes(OAT), l.url);
      const text = JSON.stringify(l.body ?? '');
      for (const v of [KEY, GH, OAT]) assert.ok(!text.includes(v), `${l.method} ${l.path}`);
    }
    // provisioning ran once on this box, after the env file was in place
    const provision = cmds.findIndex((l) => /apt-get|claude-code/.test(l.body.command));
    assert.ok(provision !== -1 && z.log.indexOf(cmds[provision]) > cmdV);
  } finally { await s.kill(); }
});

test('boat: create fails and deletes the sandbox when the env file cannot be locked to 600', async () => {
  const z = fakeBoat();
  z.exec = (cmd) => (cmd.includes('stat -c %a') ? { code: 1, out: '', err: 'operation not permitted' } : { code: 0, out: '', err: '' });
  const p = mk(z);
  await assert.rejects(create(p), /600|env file|permission/i);
  assert.ok(z.log.some((l) => l.method === 'DELETE' && l.path.startsWith('/sandboxes/bx_')), 'the half-created sandbox was deleted');
});

test('boat: an unconfirmed cleanup after provisioning failure is reported as an allocated sandbox', async () => {
  const z = fakeBoat();
  z.exec = (cmd) => (cmd.includes('MARK=') ? { code: 1, out: '', err: 'provisioning failed' } : { code: 0, out: '', err: '' });
  z.fail.set('DELETE /sandboxes/bx_fake001', () => z.err(503, 'unavailable', 'delete unavailable'));
  const p = mk(z);
  await assert.rejects(create(p), (e) => e.code === 'cleanup_unconfirmed' && e.machineId === 'bx_fake001' && /cleanup.*confirmed/i.test(e.message));
  assert.equal(z.boxes.has('bx_fake001'), true, 'the test leaves the allocated machine present when delete is unconfirmed');
  assert.equal(z.log.filter((l) => l.method === 'POST' && l.path === '/sandboxes').length, 1);
  assert.ok(z.log.filter((l) => l.method === 'DELETE' && l.path === '/sandboxes/bx_fake001').length >= 3, 'delete retries are exhausted before reporting uncertainty');
});

test('boat: an egress allow list, a coordinator, another kind and an explicit size are refused before any HTTP call', async () => {
  const z = fakeBoat();
  const p = mk(z);
  await assert.rejects(create(p, { egress: { allow: ['example.com'] } }), (e) => e.code === 'egress_unsupported');
  await assert.rejects(create(p, { role: 'coordinator' }), /[Cc]oordinator/);
  await assert.rejects(create(p, { kind: { name: 'gpu' } }), (e) => e.code === 'machine_kind_unsupported');
  await assert.rejects(create(p, { size: { vcpus: 8, memMiB: 16384 } }), (e) => e.code === 'size_not_allowed');
  assert.equal(z.log.length, 0);
});

test('boat: list filters out foreign sandboxes even when the server ignores the label filter', async () => {
  const z = fakeBoat({ serverLabelFilter: false });
  const p = mk(z);
  const a = await create(p, { labels: { purpose: 'cloudy-cloud', owner: 'o1' } });
  const b = await create(p, { labels: { purpose: 'cloudy-cloud', owner: 'o2' } });
  try {
    z.boxes.set('foreign1', z.row('foreign1', { name: 'cc-deadbeef', labels: {} }));
    z.boxes.set('foreign2', z.row('foreign2', { name: 'cc-deadbee2', labels: { purpose: 'someone-else', owner: 'o1' } }));
    const ids = async (l) => (await p.list(l)).map((r) => r.id).sort();
    assert.deepEqual(await ids({ owner: 'o1' }), [a.id]);
    assert.deepEqual(await ids({ purpose: 'cloudy-cloud' }), [a.id, b.id].sort());
    // the label filter was still sent server-side (belt and suspenders)
    const listCall = z.log.find((l) => l.method === 'GET' && l.path.startsWith('/sandboxes?'));
    assert.match(decodeURIComponent(listCall.path), /label=purpose=cloudy-cloud/);
    assert.ok(z.boxes.has('foreign1') && z.boxes.has('foreign2'), 'foreign sandboxes are never touched');
  } finally { await a.kill(); await b.kill(); }
});

test('boat: delete and connect refuse a foreign sandbox with not_found and never mutate it', async () => {
  const z = fakeBoat();
  const p = mk(z);
  z.boxes.set('alien', z.row('alien', { labels: { purpose: 'someone-else' } }));
  z.boxes.set('alien2', z.row('alien2', { labels: {} }));
  await assert.rejects(p.delete('alien'), (e) => e.code === 'not_found');
  await assert.rejects(p.delete('alien2'), (e) => e.code === 'not_found');
  await assert.rejects(p.connect('alien'), (e) => e.code === 'not_found' && e.foreign === true);
  await assert.rejects(p.connect('missing'), (e) => e.code === 'not_found' && e.foreign !== true, 'an explicit 404 for an absent id is distinct from an extant foreign sandbox');
  await assert.rejects(p.publishPort('alien', '8080'), (e) => e.code === 'not_found');
  assert.ok(!z.log.some((l) => l.method === 'DELETE'), 'no delete was ever sent for a foreign sandbox');
  assert.ok(z.boxes.has('alien') && z.boxes.has('alien2'));
});

test('boat: a listed but unavailable owned sandbox keeps an explicit exists marker', async () => {
  const z = fakeBoat();
  const env = { CLOUDY_CLOUD_CONFIG: cfgFile() };
  const p = mk(z, env);
  z.boxes.set('archived', z.row('archived', { state: 'archived', labels: { purpose: 'cloudy-cloud', install: installId(env), agent: 'deadbeef' } }));
  await assert.rejects(p.connect('archived'), (e) => e.code === 'not_found' && e.exists === true);
  assert.ok(z.boxes.has('archived'), 'the adapter reports state without deleting the extant sandbox');
});

test('boat: create stamps the shared install id, and another session of this installation owns the worker', async () => {
  const z = fakeBoat();
  const cfg = cfgFile();
  // Two providers = two server sessions of the same installation: same config dir, different per-session owners.
  const p1 = mk(z, { CLOUDY_CLOUD_CONFIG: cfg }, { owner: 'sess-a' });
  const p2 = mk(z, { CLOUDY_CLOUD_CONFIG: cfg }, { owner: 'sess-b' });
  const s = await create(p1, { labels: { purpose: 'cloudy-cloud', owner: 'sess-a' } });
  try {
    const install = readFileSync(join(dirname(cfg), 'install-id'), 'utf8').trim();
    assert.match(install, /^[0-9a-f]{16}$/);
    assert.equal(z.boxes.get(s.id).labels.install, install, 'the install label is the installation id, not a session id');
    assert.equal(z.boxes.get(s.id).labels.owner, 'sess-a', 'the per-session owner label still rides for the reaper');
    const ids = (await p2.list({ purpose: 'cloudy-cloud' })).map((r) => r.id);
    assert.ok(ids.includes(s.id), 'a new session of this installation lists the first session\'s worker');
    assert.equal((await p2.connect(s.id)).id, s.id, 'and connects to it');
    // An explicit owner filter still scopes to one session — the reaper deletes only its own workers.
    assert.deepEqual((await p2.list({ owner: 'sess-b' })).map((r) => r.id), []);
    assert.deepEqual((await p2.list({ owner: 'sess-a' })).map((r) => r.id), [s.id]);
    await p2.delete(s.id);
    assert.ok(!z.boxes.has(s.id), 'a new session can stop the first session\'s worker');
  } finally { await p1.delete(s.id).catch(() => {}); }
});

test('boat: a sandbox stamped with another installation\'s id is never ours', async () => {
  const z = fakeBoat({ serverLabelFilter: false });
  const p = mk(z, {}, { owner: 'o1' });
  // Another installation's worker: same purpose label, and even the same owner label — a different install excludes it.
  z.boxes.set('other-install', z.row('other-install', { name: 'cc-elsewhere', labels: { purpose: 'cloudy-cloud', owner: 'o1', install: 'ffffeeee11112222' } }));
  assert.deepEqual(await p.list({ purpose: 'cloudy-cloud' }), []);
  assert.deepEqual(await p.list({ owner: 'o1' }), [], 'an explicit owner filter stays within this installation');
  await assert.rejects(p.connect('other-install'), (e) => e.code === 'not_found');
  await assert.rejects(p.delete('other-install'), (e) => e.code === 'not_found');
  await assert.rejects(p.publishPort('other-install', '8080'), (e) => e.code === 'not_found');
  assert.ok(z.boxes.has('other-install'), 'untouched');
  assert.ok(!z.log.some((l) => l.method !== 'GET'), 'no mutation was ever attempted');
});

test('boat: a teammate\'s cloudy-cloud sandbox is not ours — without our install id every op is refused', async () => {
  const z = fakeBoat({ serverLabelFilter: false });
  const p = mk(z, {}, { owner: 'o1' });
  // Same org, same purpose label, different installation owner: must be invisible to us.
  z.boxes.set('mate', z.row('mate', { name: 'cc-teammate', labels: { purpose: 'cloudy-cloud', owner: 'o2', deleteAt: new Date(Date.now() - 60_000).toISOString() } }));
  await assert.rejects(p.connect('mate'), (e) => e.code === 'not_found');
  await assert.rejects(p.delete('mate'), (e) => e.code === 'not_found');
  await assert.rejects(p.publishPort('mate', '8080'), (e) => e.code === 'not_found');
  const ids = (await p.list({ purpose: 'cloudy-cloud' })).map((r) => r.id);
  assert.ok(!ids.includes('mate'), 'list never returns another installation\'s sandbox');
  assert.ok(z.boxes.has('mate'), 'the teammate\'s expired sandbox was not swept or deleted');
  assert.ok(!z.log.some((l) => l.method !== 'GET'), 'no mutation was ever attempted');
});

test('boat: a sandbox stamped our install id is ours to connect, publish and delete', async () => {
  const z = fakeBoat();
  const p = mk(z, {}, { owner: 'o1' });
  const s = await create(p, { labels: { purpose: 'cloudy-cloud', owner: 'o1' } });
  const c = await p.connect(s.id);
  assert.equal(c.id, s.id);
  const r = await p.publishPort(s.id, '8080');
  assert.ok(r.url);
  await s.kill();
});

test('boat: a lost create answer recovers only the sandbox labelled with our ccid and install id', async () => {
  const z = fakeBoat({ serverLabelFilter: false });
  // A teammate's ready, expired, purpose-labelled sandbox sorts first in the org list;
  // trusting sandboxes[0] would adopt (and provision) it.
  z.boxes.set('mate-first', z.row('mate-first', { name: 'cc-ready', labels: { purpose: 'cloudy-cloud', owner: 'o2' }, state: 'ready' }));
  const realFetch = z.fetch;
  z.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname === '/api/v1/sandboxes' && init?.method === 'POST') {
      await realFetch(url, init); // the create landed (deduped by idempotency); every answer is lost
      throw new Error('socket hang up');
    }
    return realFetch(url, init);
  };
  const p = mk(z, {}, { owner: 'o1' });
  const s = await create(p, { labels: { purpose: 'cloudy-cloud', owner: 'o1' } });
  try {
    assert.notEqual(s.id, 'mate-first');
    assert.ok(z.boxes.get(s.id).labels.ccid, 'the recovered box is the one our ccid labels');
    assert.equal(z.boxes.get(s.id).labels.owner, 'o1');
    const mutations = z.log.filter((l) => l.method !== 'GET' && l.path.includes('mate-first'));
    assert.deepEqual(mutations, [], 'no file, command, port or delete ever touched the foreign sandbox');
  } finally { await s.kill(); }
});

test('boat: a create answer with no sandbox in the body recovers the created box by ccid', async () => {
  const z = fakeBoat();
  const realFetch = z.fetch;
  let once = false;
  z.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (!once && u.pathname === '/api/v1/sandboxes' && init?.method === 'POST') {
      once = true;
      await realFetch(url, init); // accepted and stored — the sandbox exists
      return z.respond(202, {});  // but the body was lost on the wire
    }
    return realFetch(url, init);
  };
  const p = mk(z);
  const s = await create(p, { labels: { purpose: 'cloudy-cloud', owner: 'o1' } });
  try {
    assert.ok(s.id, 'the ccid recovery found the created sandbox');
    assert.equal(z.boxes.size, 1, 'no second sandbox was created');
  } finally { await s.kill(); }
});

test('boat: BOAT_API_BASE is ignored — the bearer key only ever goes to boat.dev', async () => {
  const z = fakeBoat();
  const p = mk(z, { BOAT_API_BASE: 'http://evil.example/api/v1' });
  const s = await create(p);
  try {
    for (const l of z.log) assert.ok(l.url.startsWith('https://boat.dev/api/v1'), l.url);
  } finally { await s.kill(); }
});

test('boat: delete sends the X-Ascii-Confirm-Delete header and a 404 counts as deleted', async () => {
  const z = fakeBoat();
  const p = mk(z);
  await p.delete('bx_ghost00'); // never existed: GET 404 -> resolve without DELETE
  assert.ok(!z.log.some((l) => l.method === 'DELETE'), 'unknown id resolves before any delete');
  const s = await create(p);
  await s.kill();
  const d = z.log.find((l) => l.method === 'DELETE' && l.path === `/sandboxes/${s.id}`);
  assert.equal(d.headers['X-Ascii-Confirm-Delete'], s.id);
});

test('boat: 429 retries honoring Retry-After, 401 becomes no_key and never leaks the key', async () => {
  const z = fakeBoat();
  const p = mk(z);
  let hits = 0;
  z.fail.set('/sandboxes', (m, u, b, i) => {
    if (m !== 'GET') return undefined;
    hits += 1;
    if (hits === 1) return z.respond(429, { ok: false, status: 429, code: 'rate_limited', message: 'slow down', error: { code: 'rate_limited', message: 'slow down' } }, { 'retry-after': '1' });
    return undefined;
  });
  const rows = await p.list({ purpose: 'cloudy-cloud' });
  assert.equal(hits, 2, 'the rate-limited call was retried');
  assert.equal(rows.length, 0);
  z.fail.clear();
  z.fail.set('/sandboxes', (m) => (m === 'GET' ? z.err(401, 'unauthorized', 'bad key') : undefined));
  const e = await p.list().then(() => { throw new Error('should fail'); }, (x) => x);
  assert.equal(e.code, 'no_key');
  assert.ok(!e.message.includes(KEY), 'the error must never carry the key');
});

test('boat: error text is scrubbed of the api key and consented values', async () => {
  const z = fakeBoat();
  const p = mk(z);
  z.fail.set('/sandboxes', (m) => (m === 'GET' ? z.err(500, 'http_500', `backend broke near ${KEY} and ${GH}`) : undefined));
  const e = await p.list().then(() => { throw new Error('should fail'); }, (x) => x);
  assert.equal(e.code, 'transient');
  for (const v of [KEY, GH, OAT]) assert.ok(!e.message.includes(v), `error leaked ${v.slice(0, 8)}…`);
});

test('boat: a dropped create answer retries with the same Idempotency-Key and makes one sandbox', async () => {
  const z = fakeBoat();
  const realFetch = z.fetch;
  let dropped = false;
  z.fetch = async (url, init) => {
    if (!dropped && new URL(String(url)).pathname === '/api/v1/sandboxes' && init?.method === 'POST') {
      dropped = true;
      await realFetch(url, init); // the create landed; the answer never arrived
      throw new Error('socket hang up');
    }
    return realFetch(url, init);
  };
  const p = mk(z);
  const s = await create(p);
  try {
    const posts = z.log.filter((l) => l.method === 'POST' && l.path === '/sandboxes');
    assert.equal(posts.length, 2, 'the create was retried once');
    assert.equal(posts[0].headers['Idempotency-Key'], posts[1].headers['Idempotency-Key']);
    assert.equal(z.boxes.size, 1, 'the replay returned the original sandbox instead of creating a second one');
  } finally { await s.kill(); }
});

test('boat: pagination follows pageInfo.nextCursor', async () => {
  // the first page is forced short; the adapter must ask for the next cursor to see the rest
  const z2 = fakeBoat();
  const cfg = cfgFile();
  const labels = { purpose: 'cloudy-cloud', owner: 'o1', install: installId({ CLOUDY_CLOUD_CONFIG: cfg }) };
  for (let i = 0; i < 3; i++) z2.boxes.set(`bx_page${i}`, z2.row(`bx_page${i}`, { labels }));
  let calls = 0;
  const realFetch = z2.fetch;
  z2.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname === '/api/v1/sandboxes' && (init?.method ?? 'GET') === 'GET' && calls++ === 0) {
      return z2.respond(200, { ok: true, type: 'sandbox.list', sandboxes: [...z2.boxes.values()].slice(0, 1), pageInfo: { nextCursor: '1', hasMore: true } });
    }
    return realFetch(url, init);
  };
  const p = mk(z2, { CLOUDY_CLOUD_CONFIG: cfg });
  const rows = await p.list({ owner: 'o1' });
  assert.equal(rows.length, 3, 'all pages were followed');
  assert.ok(calls >= 2);
});

test('boat: the list sweep deletes one of our sandboxes whose deleteAt label has passed', async () => {
  const z = fakeBoat();
  const cfg = cfgFile();
  const p = mk(z, { CLOUDY_CLOUD_CONFIG: cfg }, { owner: 'o1' });
  const past = new Date(Date.now() - 60_000).toISOString();
  z.boxes.set('bx_expired', z.row('bx_expired', { labels: { purpose: 'cloudy-cloud', owner: 'o1', install: installId({ CLOUDY_CLOUD_CONFIG: cfg }), deleteAt: past } }));
  const rows = await p.list({ purpose: 'cloudy-cloud' });
  assert.equal(rows.length, 0);
  assert.ok(!z.boxes.has('bx_expired'), 'the expired sandbox was deleted');
  assert.ok(z.log.some((l) => l.method === 'DELETE' && l.path === '/sandboxes/bx_expired' && l.headers['X-Ascii-Confirm-Delete'] === 'bx_expired'));
});

test('boat: commands.run streams stdout, returns output and rejects on a nonzero exit', async () => {
  const z = fakeBoat();
  const p = mk(z);
  const s = await create(p);
  try {
    z.exec = () => ({ code: 0, out: 'hello\n', err: 'warn\n' });
    let streamed = '', streamedErr = '';
    const r = await s.commands.run('echo hi', { timeoutMs: 5000, onStdout: (c) => { streamed += c; }, onStderr: (c) => { streamedErr += c; } });
    assert.deepEqual(r, { stdout: 'hello\n', stderr: 'warn\n', exitCode: 0 });
    assert.equal(streamed, 'hello\n');
    assert.equal(streamedErr, 'warn\n');
    const last = z.log.filter((l) => l.path === `/sandboxes/${s.id}/commands`).at(-1).body;
    assert.equal(last.detached, true);
    z.exec = () => ({ code: 2, out: 'o', err: 'e' });
    const e = await s.commands.run('exit 2', { timeoutMs: 5000 }).then(() => { throw new Error('should fail'); }, (x) => x);
    assert.equal(e.exitCode, 2);
    assert.equal(e.stdout, 'o');
    assert.equal(e.stderr, 'e');
    z.exec = () => ({ code: 2, out: '', err: `leak ${OAT}` });
    const e2 = await s.commands.run('exit 2', { timeoutMs: 5000 }).then(() => { throw new Error('should fail'); }, (x) => x);
    assert.equal(e2.stderr, 'leak <redacted>', 'a credential value in output is redacted on the error');
    assert.ok(!e2.message.includes(OAT), 'the thrown message is scrubbed');
  } finally { await s.kill(); }
});

test('boat: a finished command with `more` buffered output is drained before finishing', async () => {
  const z = fakeBoat();
  const p = mk(z);
  const s = await create(p);
  try {
    z.statusPages = [
      { status: 'exited', running: false, success: true, exitCode: 0, stdout: 'part1\n', stderr: '', stdoutNextOffset: 6, stderrNextOffset: 0, more: true },
      { status: 'exited', running: false, success: true, exitCode: 0, stdout: 'part2\n', stderr: '', stdoutNextOffset: 12, stderrNextOffset: 0, more: false },
    ];
    const r = await s.commands.run('echo hello', { timeoutMs: 10_000 });
    assert.equal(r.stdout, 'part1\npart2\n', 'the buffered page after the finished flag is read too');
    assert.equal(r.exitCode, 0);
  } finally { await s.kill(); }
});

test('boat: old status API fallback emits only newly appended stderr tail', async () => {
  const z = fakeBoat();
  const p = mk(z);
  const s = await create(p);
  try {
    let offsetsRejected = false;
    z.fail.set(`GET /sandboxes/${s.id}/commands/${z.procs.size + 1}`, (_method, u) => {
      if (!u.searchParams.has('stdoutOffset')) return undefined;
      offsetsRejected = true;
      return z.err(409, 'agent_outdated', 'offsets unsupported');
    });
    z.statusPages = [
      { status: 'running', running: true, stdout: 'out1', stderr: 'err1' },
      { status: 'exited', running: false, success: true, exitCode: 0, stdout: 'out1out2', stderr: 'err1err2' },
    ];
    let streamed = '';
    const r = await s.commands.run('echo hello', { timeoutMs: 10_000, onStderr: (c) => { streamed += c; } });
    assert.equal(offsetsRejected, true);
    assert.equal(r.stderr, 'err1err2');
    assert.equal(streamed, r.stderr, 'the whole-tail fallback delivers each new suffix once');
  } finally { await s.kill(); }
});

test('boat: an abort raised mid-poll still kills the detached process', async () => {
  const z = fakeBoat();
  const realFetch = z.fetch;
  let armed = false;
  z.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (armed && /\/commands\/\d+$/.test(u.pathname) && (init?.method ?? 'GET') === 'GET') {
      const e = new Error('the operation was aborted');
      e.name = 'AbortError'; // the signal landed while the status GET was in flight
      throw e;
    }
    return realFetch(url, init);
  };
  const p = mk(z);
  const s = await create(p);
  try {
    const ac = new AbortController();
    z.exec = () => ({ code: 0, out: '', err: '', running: true });
    armed = true;
    const e = await s.commands.run('sleep 99', { timeoutMs: 60_000, signal: ac.signal }).then(() => { throw new Error('should abort'); }, (x) => x);
    assert.equal(e.name, 'AbortError');
    assert.ok(z.log.some((l) => l.method === 'DELETE' && /\/commands\/\d+$/.test(l.path)), 'the detached process was still killed');
    assert.ok([...z.procs.values()].some((p) => p.killed), 'the fake records the stop');
  } finally { await s.kill(); }
});

test('boat: a command that hits its timeout is stopped with DELETE and reports timeout', async () => {
  const z = fakeBoat();
  let t = 0;
  const p = mk(z, {}, { now: () => (t += 2000) }); // every clock read jumps 2 s -> the deadline passes at once
  const s = await create(p);
  try {
    z.exec = () => ({ code: 0, out: '', err: '', running: true });
    const e = await s.commands.run('sleep 99', { timeoutMs: 1000 }).then(() => { throw new Error('should fail'); }, (x) => x);
    assert.equal(e.code, 'timeout');
    assert.ok(z.log.some((l) => l.method === 'DELETE' && /\/commands\/\d+$/.test(l.path)), 'the detached process was stopped');
  } finally { await s.kill(); }
});

test('boat: a command observed to exit only after the deadline is a timeout, not a success', async () => {
  const z = fakeBoat();
  let t = 0;
  const realFetch = z.fetch;
  let armed = false, statusGets = 0;
  z.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (armed && /\/commands\/\d+$/.test(u.pathname) && (init?.method ?? 'GET') === 'GET' && ++statusGets === 2) t = 2000; // the exit answer lands after the deadline
    return realFetch(url, init);
  };
  const p = mk(z, {}, { now: () => t });
  const s = await create(p);
  try {
    z.statusPages = [
      { status: 'running', running: true, stdout: 'half\n', stderr: '', stdoutNextOffset: 5, stderrNextOffset: 0 },
      { status: 'exited', running: false, success: true, exitCode: 0, stdout: 'done\n', stderr: '', stdoutNextOffset: 10, stderrNextOffset: 0 },
    ];
    armed = true;
    const e = await s.commands.run('sleepy', { timeoutMs: 1000 }).then(() => { throw new Error('should time out'); }, (x) => x);
    assert.equal(e.code, 'timeout', 'an exit seen after the deadline must not be reported as success');
    assert.equal(e.stdout, 'half\ndone\n', 'the output that arrived is still returned');
    assert.ok(z.log.some((l) => l.method === 'DELETE' && /\/commands\/\d+$/.test(l.path)), 'the detached process was stopped at the deadline');
    assert.ok([...z.procs.values()].some((pr) => pr.killed), 'the fake records the stop');
  } finally { await s.kill(); }
});

test('boat: files.write and files.read round-trip through the files API', async () => {
  const z = fakeBoat();
  const p = mk(z);
  const s = await create(p);
  try {
    await s.files.write('/home/user/work/blob.bin', Buffer.from([0, 1, 2, 250]));
    const w = z.log.filter((l) => l.path === `/sandboxes/${s.id}/files` && l.method === 'PUT').at(-1);
    assert.equal(w.body.encoding, 'base64');
    assert.deepEqual([...(await s.files.read('/home/user/work/blob.bin'))], [0, 1, 2, 250]);
    const r = z.log.filter((l) => l.path.startsWith(`/sandboxes/${s.id}/files?`) && l.method === 'GET').at(-1);
    assert.match(decodeURIComponent(r.path), /path=\/home\/user\/work\/blob\.bin/);
  } finally { await s.kill(); }
});

test('boat: publishPort hosts the port on a token-gated URL and unpublishPort hides it', async () => {
  const z = fakeBoat();
  const p = mk(z);
  const s = await create(p);
  try {
    const r = await p.publishPort(s.id, '8080');
    assert.equal(r.url, `https://t-${s.id}-8080.on.boat.dev?_token=tok_${s.id}_8080`);
    const host = z.log.find((l) => l.path === `/sandboxes/${s.id}/host`);
    assert.equal(host.body.port, 8080);
    const rc = await p.unpublishPort(s.id, '8080');
    assert.equal(rc, 0);
    const cmds = z.log.filter((l) => l.path === `/sandboxes/${s.id}/commands` && l.method === 'POST');
    assert.ok(cmds.at(-1).body.command.includes('host hide 8080'));
  } finally { await s.kill(); }
});

test('boat: plan maps GET /limits into a plan row', async () => {
  const z = fakeBoat();
  const p = mk(z);
  const plan = await p.plan();
  assert.equal(plan.tier, 'box_20');
  assert.equal(plan.startsPerMinute, 10);
  assert.equal(plan.maxMachines, 100);
  assert.equal(plan.maxRunning, 100);
  assert.deepEqual(plan.specs, [], 'the contract\'s specs field is present');
});

test('boat: caps tell the truth about TTL, and list returns archiveAt in epoch ms', async () => {
  const z = fakeBoat();
  const p = mk(z);
  assert.equal(p.caps.hasServerTTL, false, 'Boat archives at the deadline — cloudy-cloud sweeps and deletes');
  assert.equal(p.caps.hasSudo, true, 'the worker user has passwordless sudo — apt packages may install');
  const s = await create(p, { labels: { purpose: 'cloudy-cloud', owner: 'o1' } });
  try {
    const [r] = await p.list({ owner: 'o1' });
    assert.equal(r.archiveAt, Date.parse('2027-01-01T00:00:00.000Z'), 'archiveAfter arrives as epoch ms like the other adapters');
  } finally { await s.kill(); }
});

test('boat: a sandbox that fails while starting reports a scrubbed error and is deleted', async () => {
  const z = fakeBoat();
  const realFetch = z.fetch;
  z.fetch = async (url, init) => {
    const r = await realFetch(url, init);
    const u = new URL(String(url));
    if (u.pathname === '/api/v1/sandboxes' && init?.method === 'POST') {
      const rec = z.boxes.get('bx_fake001');
      rec.state = 'error';
      rec.error = `provisioning died near ${GH} and ${KEY}`;
    }
    return r;
  };
  const p = mk(z);
  const e = await create(p).then(() => { throw new Error('should fail'); }, (x) => x);
  assert.ok(!e.message.includes(GH) && !e.message.includes(KEY), 'rec.error is scrubbed before it reaches the caller');
  assert.match(e.message, /<redacted>/);
  assert.ok(z.log.some((l) => l.method === 'DELETE' && l.path.startsWith('/sandboxes/bx_')), 'the failed sandbox was deleted');
});

test('loadProvider knows boat', async () => {
  const p = await loadProvider({ CLOUDY_CLOUD_PROVIDER: 'boat', BOAT_API_KEY: KEY, CLOUDY_CLOUD_BOAT_TOKEN_ON_BOX: 'yes' });
  assert.equal(p.name, 'boat');
  assert.equal(p.keyName, 'BOAT_API_KEY');
});
