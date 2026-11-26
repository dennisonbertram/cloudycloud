import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { watch, reaperSpawn, startReaper, providerKey } from '../src/reaper.mjs';
import { createFakeProvider } from './fake-provider.mjs';

const KEY = 'sk-secret-key';
const OWNER = 'abc123def456';

async function setup(rows) {
  const provider = createFakeProvider();
  for (const [i, labels] of rows.entries()) provider.machines.set(`m${i + 1}`, { id: `m${i + 1}`, name: `n${i + 1}`, labels, state: 'running', status: 'running', startedAt: 1 });
  return { provider, logs: [], log(m) { this.logs.push(m); } };
}
const run = (s, aliveSeq) => {
  let i = 0;
  return watch({ pid: 1, owner: OWNER, provider: s.provider, log: (m) => s.log(m), alive: () => aliveSeq[Math.min(i++, aliveSeq.length - 1)], sleep: async () => {}, maxMs: 20, pollMs: 1 });
};

test('nothing is deleted while the parent is alive', async () => {
  const s = await setup([{ owner: OWNER }]);
  await run(s, [true]);
  assert.deepEqual(s.provider.log.list, []);
  assert.deepEqual(s.provider.log.delete, []);
});

test('after the parent exits, deletes only machines with a matching owner', async () => {
  const s = await setup([{ owner: OWNER }, { owner: 'other' }, {}, { purpose: 'x' }]);
  await run(s, [true, true, false]);
  assert.deepEqual(s.provider.log.list, [{ owner: OWNER }]);
  assert.deepEqual(s.provider.log.delete, ['m1']);
});

test('a failed list or delete is logged without the key, and reaping continues', async () => {
  const s = await setup([{ owner: OWNER }, { owner: OWNER }]);
  const del = s.provider.delete;
  s.provider.delete = async (id) => { if (id === 'm1') throw new Error('Delete of m1 failed: HTTP 500'); return del(id); };
  await run(s, [false]);
  assert.deepEqual(s.provider.log.delete, ['m2']);
  assert.match(s.logs.join('\n'), /delete m1 failed/);
  assert.ok(!JSON.stringify(s.logs).includes(KEY));
  const bad = await setup([]);
  bad.provider.list = async () => { throw new Error('Could not list machines: HTTP 500'); };
  await run(bad, [false]);
  assert.match(bad.logs[0], /list failed/);
});

test('the reaper retries temporary list and delete failures after the parent exits', async () => {
  const s = await setup([{ owner: OWNER }]);
  const list = s.provider.list;
  let listCalls = 0, deleteCalls = 0;
  s.provider.list = async (...args) => {
    if (++listCalls === 1) throw new Error('temporary list failure');
    return list(...args);
  };
  const del = s.provider.delete;
  s.provider.delete = async (id, opts) => {
    if (++deleteCalls === 1) throw new Error('temporary delete failure');
    return del(id, opts);
  };
  await watch({ pid: 1, owner: OWNER, provider: s.provider, alive: () => false, log: (m) => s.log(m), retryMs: 0, sleep: async () => {}, maxMs: 20 });
  assert.equal(listCalls, 3, 'retries a failed listing and then a failed delete');
  assert.equal(deleteCalls, 2);
  assert.deepEqual(s.provider.log.delete, ['m1']);
  assert.match(s.logs.join('\n'), /temporary list failure/);
  assert.match(s.logs.join('\n'), /temporary delete failure/);
});

test('spawn options pass the key and provider only in env', () => {
  const provider = createFakeProvider();
  const { args, options } = reaperSpawn(42, OWNER, KEY, provider, { PATH: '/bin' });
  assert.ok(!JSON.stringify(args).includes(KEY));
  assert.deepEqual(args.slice(1), ['42', OWNER]);
  assert.equal(options.env.FAKE_API_KEY, KEY);
  assert.equal(options.env.CLOUDY_CLOUD_PROVIDER, 'fake');
  assert.equal(options.detached, true);
  assert.equal(options.stdio, 'ignore');
});

test('the reaper process exits 1 with no key, without touching the network', () => {
  const env = { PATH: process.env.PATH, CLOUDY_CLOUD_CONFIG: '/nonexistent/cloudy-cloud-env' };
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../src/reaper.mjs', import.meta.url)), '1', OWNER], { env, timeout: 5000 });
  assert.equal(r.status, 1);
});

test('the reaper runs on microsandbox when msb is found on PATH, with no CLOUDY_CLOUD_MSB_BIN', () => {
  // A dead pid makes watch reap at once; the stub msb logs the list call it proves the gate passed.
  const dir = mkdtempSync(join(tmpdir(), 'cc-rpmsb-'));
  const log = join(dir, 'msb-calls');
  writeFileSync(join(dir, 'msb'), `#!/bin/sh\necho "msb $*" >> "${log}"\ncase "$1" in ls) echo '[]' ;; *) exit 0 ;; esac\n`);
  chmodSync(join(dir, 'msb'), 0o755);
  const env = { PATH: `${dir}:${process.env.PATH}`, HOME: mkdtempSync(join(tmpdir(), 'cc-rphome-')), CLOUDY_CLOUD_PROVIDER: 'microsandbox', CLOUDY_CLOUD_CONFIG: '/nonexistent/cloudy-cloud-env' };
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../src/reaper.mjs', import.meta.url)), '99999999', OWNER], { env, timeout: 10000 });
  assert.equal(r.status, 0, String(r.stderr));
  assert.match(readFileSync(log, 'utf8'), /msb ls /);
});

test('the reaper logs each failed delete attempt (3 attempts) through the adapter', async () => {
  const { createProvider } = await import('../src/providers/instabox.mjs');
  const { reap } = await import('../src/reaper.mjs');
  const fetchFn = async (url, init = {}) => (init.method === 'DELETE' ? new Response('', { status: 500 }) : Response.json({ machines: [{ id: 'm1', metadata: { owner: OWNER } }] }));
  const logs = [];
  const n = await reap({ owner: OWNER, provider: createProvider({ INSTABOX_API_KEY: KEY }, { fetchFn }), log: (l) => logs.push(l) });
  assert.equal(n, 0);
  assert.deepEqual(logs, Array(3).fill('delete m1 failed: HTTP 500'));
});

test('startReaper passes the provider and its key to the spawned reaper (the call server.mjs makes)', () => {
  const calls = [];
  const child = { on() { return this; }, unref() { calls.push('unref'); } };
  const provider = createFakeProvider();
  startReaper(42, OWNER, { FAKE_API_KEY: KEY }, provider, (cmd, args, options) => { calls.push({ cmd, args, options }); return child; });
  assert.equal(calls[0].options.env.FAKE_API_KEY, KEY);
  assert.equal(calls[0].options.env.CLOUDY_CLOUD_PROVIDER, 'fake');
  assert.deepEqual(calls[0].args.slice(1), ['42', OWNER]);
  assert.equal(calls[1], 'unref');
});

test('the reaper never loads the SDK: reap through the real adapter, and exit 1 on an empty env', () => {
  const hook = fileURLToPath(new URL('./fixtures/block-sdk.mjs', import.meta.url));
  const reaper = fileURLToPath(new URL('../src/reaper.mjs', import.meta.url));
  const adapter = fileURLToPath(new URL('../src/providers/instabox.mjs', import.meta.url));
  const empty = spawnSync(process.execPath, ['--import', hook, reaper, '1', OWNER], { env: { PATH: process.env.PATH, CLOUDY_CLOUD_CONFIG: '/nonexistent/cloudy-cloud-env' }, timeout: 5000, encoding: 'utf8' });
  assert.equal(empty.status, 1);
  assert.ok(!empty.stderr.includes('SDK_LOADED'), empty.stderr);
  const code = `
    import { reap } from ${JSON.stringify(reaper)};
    import { createProvider } from ${JSON.stringify(adapter)};
    const fetchFn = async (url, init = {}) => (init.method === 'DELETE' ? new Response('') : Response.json({ machines: [{ id: 'm1', metadata: { owner: '${OWNER}' } }] }));
    console.log(await reap({ owner: '${OWNER}', provider: createProvider({ INSTABOX_API_KEY: 'k' }, { fetchFn }) }));`;
  const full = spawnSync(process.execPath, ['--import', hook, '--input-type=module', '-e', code], { env: { PATH: process.env.PATH }, timeout: 5000, encoding: 'utf8' });
  assert.equal(full.stdout.trim(), '1', full.stderr);
});

test('the reaper deletes the machines of page 1 when page 2 of the list fails, and logs the error', async () => {
  const { reap } = await import('../src/reaper.mjs');
  const { createProvider } = await import('../src/providers/instabox.mjs');
  const deleted = [], logs = [];
  const fetchFn = async (url, init = {}) => {
    if (init.method === 'DELETE') { deleted.push(String(url).split('/').pop()); return new Response('{}'); }
    if (String(url).includes('cursor=c2')) return new Response('no', { status: 500 });
    return Response.json({ machines: [{ id: 'm1', metadata: { owner: OWNER }, state: 'running' }], nextCursor: 'c2' });
  };
  const n = await reap({ owner: OWNER, provider: createProvider({ INSTABOX_API_KEY: KEY }, { fetchFn }), log: (l) => logs.push(l) });
  assert.equal(n, 1);
  assert.deepEqual(deleted, ['m1']);
  assert.match(logs.join('\n'), /list failed.*HTTP 500/);
});

// server.mjs may start without the provider key (cloudy-cloud mcp-server before setup). A key saved later
// still gets crash cleanup: the first env refresh that sees it (the top of cloud_agent) starts the reaper.
test('a server started without the key starts the reaper on the first env refresh that finds one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-reaper-late-'));
  const cfg = join(dir, 'env');
  writeFileSync(cfg, '');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], {
    cwd: dir, env: { PATH: process.env.PATH, HOME: dir, CLOUDY_CLOUD_CONFIG: cfg },
  });
  const reapers = () => { try { return execFileSync('pgrep', ['-f', `reaper.mjs ${child.pid} `], { encoding: 'utf8' }).trim(); } catch { return ''; } };
  try {
    let buf = '', stderr = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    for (const end = Date.now() + 10000; !buf.includes('\n') && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
    assert.ok(buf.includes('"id":1'), `no initialize response; stderr: ${stderr}`);
    assert.equal(reapers(), '', 'a reaper started without a key');
    writeFileSync(cfg, 'INSTABOX_API_KEY=ibk_FAKEKEY0123456789\n'); // what `cloudy-cloud setup` writes
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cloud_agent', arguments: { prompt: 'x', description: 'd' } } });
    for (const end = Date.now() + 15000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
      const pids = reapers();
      if (pids) return; // the refresh inside cloud_agent started it; the call itself may still fail
    }
    assert.fail(`no reaper after the key arrived; stderr: ${stderr}`);
  } finally {
    child.kill('SIGKILL');
    try { execFileSync('pkill', ['-f', `reaper.mjs ${child.pid} `]); } catch { /* none left */ }
  }
});

test('the reaper reads the saved settings file, so a self-hosted reaper uses the saved docker path and ssh key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-reaper-'));
  try {
    writeFileSync(join(dir, 'env'), 'CLOUDY_CLOUD_CONTAINER_BIN=/saved/bin/docker\nCLOUDY_CLOUD_SSH_KEY=/saved/key\n');
    // a fake ssh that records its argv and answers with no containers
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/ssh'), `#!/bin/sh\necho "$@" >> ${join(dir, 'log')}\n`, { mode: 0o755 });
    const dead = spawnSync('true').pid;
    const env = { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, CLOUDY_CLOUD_CONFIG: join(dir, 'env'), CLOUDY_CLOUD_PROVIDER: 'self-hosted', CLOUDY_CLOUD_SSH_HOST: 'me@box' };
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../src/reaper.mjs', import.meta.url)), String(dead), OWNER], { env, timeout: 10000, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const log = readFileSync(join(dir, 'log'), 'utf8');
    assert.match(log, /-i \/saved\/key/);
    const cmd = Buffer.from(log.match(/printf %s (\S+) \| base64 -d/)[1], 'base64').toString();
    assert.match(cmd, /^'\/saved\/bin\/docker' 'ps'/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The reaper's key check must match the adapter's: a coordinator's machine holds the Instabox key only as the
// proxy secret CLOUDY_CLOUD_INSTABOX_API_KEY, and `cloudy-cloud mcp-server` execs before the launcher maps it.
test('providerKey resolves like the adapter: canonical name, coordinator secret, or the msb binary', () => {
  const provider = createFakeProvider();
  assert.equal(providerKey({ FAKE_API_KEY: KEY }, provider), KEY);
  const instabox = { name: 'instabox', keyName: 'INSTABOX_API_KEY' };
  assert.equal(providerKey({ CLOUDY_CLOUD_INSTABOX_API_KEY: 'proxy' }, instabox), 'proxy');
  assert.equal(providerKey({ INSTABOX_API_KEY: KEY, CLOUDY_CLOUD_INSTABOX_API_KEY: 'proxy' }, instabox), KEY);
  assert.equal(providerKey({}, instabox), '');
  const home = mkdtempSync(join(tmpdir(), 'cc-key-'));
  const msb = { name: 'microsandbox', keyName: 'CLOUDY_CLOUD_MSB_BIN' };
  assert.equal(providerKey({ HOME: home, PATH: '' }, msb), '');
  const bin = join(home, '.local/bin/msb');
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(providerKey({ HOME: home, PATH: '' }, msb), bin);
});

test('startReaper passes the adapter-resolved key under the canonical name', () => {
  const seen = [];
  const child = { on() { return this; }, unref() { seen.push('unref'); } };
  const instabox = { name: 'instabox', keyName: 'INSTABOX_API_KEY' };
  startReaper(42, OWNER, { CLOUDY_CLOUD_INSTABOX_API_KEY: 'proxy-placeholder' }, instabox, (cmd, args, options) => { seen.push(options); return child; });
  assert.equal(seen[0].env.INSTABOX_API_KEY, 'proxy-placeholder');
  assert.equal(seen[1], 'unref');
});

const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const reaperPids = (pid) => { try { return execFileSync('pgrep', ['-f', `reaper.mjs ${pid} `], { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch { return []; } };
const killReapers = (pid) => { try { execFileSync('pkill', ['-f', `reaper.mjs ${pid} `]); } catch { /* none left */ } };
const until = async (fn, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) { const v = fn(); if (v) return v; }
  return fn();
};

// A coordinator credential without INSTABOX_API_KEY: the adapter launches workers, so cleanup must start too.
test('the server starts the reaper from CLOUDY_CLOUD_INSTABOX_API_KEY alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-coordkey-'));
  writeFileSync(join(dir, 'env'), '');
  const child = spawn(process.execPath, [serverPath], {
    env: { PATH: process.env.PATH, HOME: dir, CLOUDY_CLOUD_CONFIG: join(dir, 'env'), CLOUDY_CLOUD_INSTABOX_API_KEY: 'coordinator-placeholder' },
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  try {
    assert.equal((await until(() => reaperPids(child.pid).length === 1 && reaperPids(child.pid))).length, 1, `no reaper for the coordinator credential; stderr: ${stderr}`);
  } finally { child.kill('SIGKILL'); killReapers(child.pid); }
});

// The reaper gives up after MAX_LIFETIME_MS or can fail to spawn; the next refresh must start a new one.
test('a reaper that exited is replaced on the next refresh, never two at once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-respawn-'));
  writeFileSync(join(dir, 'env'), 'INSTABOX_API_KEY=ibk_FAKEKEY0123456789\n');
  const child = spawn(process.execPath, [serverPath], {
    env: { PATH: process.env.PATH, HOME: dir, CLOUDY_CLOUD_CONFIG: join(dir, 'env') },
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cloud_agent', arguments: { prompt: 'x', description: 'd' } } };
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } })}\n`);
    const first = await until(() => reaperPids(child.pid)[0]);
    assert.ok(first, `no reaper at boot; stderr: ${stderr}`);
    process.kill(Number(first), 'SIGKILL');
    const next = await (async () => { // resend until a call lands after the server saw the child die
      for (const end = Date.now() + 15000; Date.now() < end;) {
        child.stdin.write(`${JSON.stringify(call)}\n`);
        for (const stop = Date.now() + 1000; Date.now() < stop; await new Promise((r) => setTimeout(r, 100))) {
          const p = reaperPids(child.pid).find((x) => x !== first);
          if (p) return p;
        }
      }
    })();
    assert.ok(next, `no replacement reaper after ${first} died; stderr: ${stderr}`);
    assert.deepEqual(await until(() => reaperPids(child.pid).length === 1 && reaperPids(child.pid)), [next], 'two reapers ran at once');
  } finally { child.kill('SIGKILL'); killReapers(child.pid); }
});

// ~/.config/cloudy-cloud holds credentials; the server's owner-file write must not leave it group-writable.
test('the server creates the config directory with mode 0700, even under a permissive umask', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-perm-'));
  const dir = join(home, 'priv');
  const child = spawn('/bin/sh', ['-c', 'umask 0; exec "$0" "$@"', process.execPath, serverPath], {
    env: { PATH: process.env.PATH, HOME: home, CLOUDY_CLOUD_CONFIG: join(dir, 'env') },
  });
  try {
    assert.ok(await until(() => existsSync(join(dir, 'owner'))), 'the server never wrote its owner file');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally { child.kill('SIGKILL'); killReapers(child.pid); }
});

// The whole route: `cloudy-cloud mcp-server` migrates a legacy config first (notice on stderr — stdout is the
// JSON-RPC channel), answers initialize, and runs exactly one reaper however often the env is refreshed.
test('bin/cloudy-cloud mcp-server: migration first, clean stdout, one reaper across refreshes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-msrv-'));
  mkdirSync(join(home, '.config/claude-cloud'), { recursive: true });
  writeFileSync(join(home, '.config/claude-cloud/env'), 'INSTABOX_API_KEY=ibk_FAKEKEY0123456789\n');
  const bin = fileURLToPath(new URL('../bin/cloudy-cloud', import.meta.url));
  const child = spawn('/bin/sh', [bin, 'mcp-server'], { env: { PATH: process.env.PATH, HOME: home } });
  const io = { out: '', err: '' };
  child.stdout.on('data', (d) => { io.out += d; });
  child.stderr.on('data', (d) => { io.err += d; });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cloud_agent', arguments: { prompt: 'x', description: 'd' } } };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    assert.ok(await until(() => io.out.includes('\n')), `no initialize reply; stderr: ${io.err}`);
    const reply = JSON.parse(io.out.split('\n')[0]);
    assert.equal(reply.jsonrpc, '2.0');
    assert.equal(reply.id, 1);
    assert.ok(reply.result, `initialize failed: ${io.out}`);
    const cfg = join(home, '.config/cloudy-cloud/env');
    assert.ok(existsSync(cfg), 'the legacy config was not migrated before the server started');
    assert.match(readFileSync(cfg, 'utf8'), /^INSTABOX_API_KEY=ibk_FAKEKEY0123456789$/m);
    assert.match(io.err, /Moved your saved keys/, 'the migration notice is missing from stderr');
    assert.equal((await until(() => reaperPids(child.pid).length === 1 && reaperPids(child.pid))).length, 1, `no reaper; stderr: ${io.err}`);
    let pings = 0;
    const sync = async () => { // a ping replies after the earlier calls were handled (stdio is in order)
      const want = io.out.split('\n').filter(Boolean).length + 1;
      send({ jsonrpc: '2.0', id: `p${++pings}`, method: 'ping' });
      assert.ok(await until(() => io.out.split('\n').filter(Boolean).length >= want, 15000), `no ping reply; stderr: ${io.err}`);
    };
    for (const line of ['CLOUDY_CLOUD_WORKER_HOURS=1', 'CLOUDY_CLOUD_STARTS_PER_MIN=1']) {
      writeFileSync(cfg, `${readFileSync(cfg, 'utf8')}${line}\n`);
      send(call);
      await sync();
      assert.equal(reaperPids(child.pid).length, 1, 'a refresh started a second reaper');
    }
    for (const line of io.out.split('\n').filter(Boolean)) {
      const j = JSON.parse(line);
      assert.equal(j.jsonrpc, '2.0', `stdout carried a non-RPC line: ${line}`);
    }
  } finally { child.kill('SIGKILL'); killReapers(child.pid); }
});
