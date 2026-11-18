import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as realSpawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect } from 'node:net';
import { contractSuite } from './provider-contract.mjs';
import { createProvider } from '../src/providers/microsandbox.mjs';
import { loadProvider } from '../src/providers/index.mjs';
import { missingSetup } from '../src/host-pi.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const BIN = '/fake/msb';
const IMAGE = `cloudy-cloud-worker:${VERSION}`;
const roots = [];
process.on('exit', () => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

// Flags that take a value, per `msb` CLI (SandboxOpts / ExecOpts). -t/-i/--stream/--no-tty/--no-stdin are boolean.
const VALS = new Set(['--name', '-c', '--cpus', '-m', '--memory', '-e', '--env', '--label', '--secret', '--max-duration',
  '--net-default', '--net-rule', '--port', '-w', '--workdir', '-u', '--user', '--timeout', '--format', '--shell']);
const at = (rest, n) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
const all = (rest, n) => rest.flatMap((a, i) => (a === n ? [rest[i + 1]] : []));
const pos = (rest) => rest.filter((a, i) => !a.startsWith('-') && !VALS.has(rest[i - 1]));
const kv = (s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; };

// A fake msb: an in-memory sandbox table; `exec` runs the command locally under a temp root with the sandbox's
// env (`-e` vars plus a placeholder per --secret, never the value — the value stays in the create call's env).
function fakeMsb({ imageOk = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cc-msb-'));
  roots.push(root);
  const table = new Map(); // name -> { name, status, created_at, image, labels, env }
  const calls = []; // { bin, args, env } — env is the spawn env the adapter gave this child
  const local = (s) => s.replaceAll('/home/worker', `${root}/home/worker`);
  function handle(args, stdin, child) {
    const done = (code, out = '', err = '') => { if (out) child.stdout.write(out); if (err) child.stderr.write(err); child.emit('close', code, null); };
    const [cmd, ...rest] = args;
    if (cmd === 'image' && rest[0] === 'inspect') return imageOk ? done(0, '{}\n') : done(1, '', `image ${rest.at(-1)} not found`);
    if (cmd === 'create') {
      const name = at(rest, '--name');
      const labels = Object.fromEntries(all(rest, '--label').map(kv));
      const senv = Object.fromEntries([...all(rest, '-e'), ...all(rest, '--env')].map(kv));
      for (const s of all(rest, '--secret')) senv[s.split(/[:@]/)[0]] = `msb-placeholder-${s.split(/[:@]/)[0]}`;
      table.set(name, { name, status: 'Running', created_at: new Date().toISOString(), image: pos(rest)[0], labels, env: senv });
      return done(0, `${name}\n`);
    }
    if (cmd === 'ls') {
      let rows = [...table.values()];
      const labs = all(rest, '--label').map(kv);
      rows = rows.filter((r) => labs.every(([k, v]) => r.labels[k] === v));
      if (rest.includes('--running')) rows = rows.filter((r) => r.status === 'Running');
      if (at(rest, '--format') === 'json') return done(0, `${JSON.stringify(rows.map(({ name, status, created_at, image }) => ({ name, status, created_at, image })))}\n`);
      return done(0, `${rows.map((r) => r.name).join('\n')}\n`);
    }
    if (cmd === 'inspect') {
      const s = table.get(pos(rest)[0]);
      if (!s) return done(1, '', `sandbox ${pos(rest)[0]} not found`);
      return done(0, `${JSON.stringify({ name: s.name, status: s.status, created_at: s.created_at, config: { labels: s.labels, env: s.env } })}\n`);
    }
    if (cmd === 'exec') {
      const i = rest.indexOf('--');
      const before = rest.slice(0, i), runArgs = rest.slice(i + 1);
      const s = table.get(pos(before)[0]);
      if (!s) return done(1, '', `sandbox ${pos(before)[0]} not found`);
      const runLocal = (cmd, argv) => {
        const cwd = local(at(before, '-w') ?? at(before, '--workdir') ?? '/home/worker');
        realSpawn('mkdir', ['-p', cwd]).on('close', () => {
          const p = realSpawn(cmd, argv, { cwd, env: { ...process.env, ...s.env } });
          p.stdout.on('data', (d) => child.stdout.write(d));
          p.stderr.on('data', (d) => child.stderr.write(d));
          p.on('close', (c) => child.emit('close', c, null));
          child.kill = () => p.kill('SIGKILL');
          p.stdin.on('error', () => {});
          p.stdin.end(stdin); // the client's buffered bytes; enough for a request/response round trip
        });
      };
      if (runArgs[0] === 'node' && runArgs[1] === '-e') return runLocal(process.execPath, ['-e', runArgs[2]]); // the port-forward bridge
      const inner = runArgs[2]; // ['sh','-c',inner] or ['bash','-lc',inner]
      if (inner?.includes('TRIGGER_TIMEOUT')) return done(124);
      // the real guest has `timeout`; macOS does not, so drop it here (same as the self-hosted fake box)
      return runLocal('sh', ['-c', local(inner).replace(/exec timeout -k 5 \d+ /, 'exec ')]);
    }
    if (cmd === 'rm') return table.delete(rest.at(-1)) ? done(0, `${rest.at(-1)}\n`) : done(1, '', `sandbox ${rest.at(-1)} not found`);
    done(1, '', `unknown command ${cmd}`);
  }
  const spawn = (bin, args, opts = {}) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} });
    calls.push({ bin, args, env: opts.env });
    const chunks = [];
    child.stdin.on('data', (d) => chunks.push(Buffer.from(d)));
    child.stdin.on('end', () => handle(args, Buffer.concat(chunks), child));
    return child;
  };
  return { spawn, table, calls, root };
}

// A spawn whose binary is missing: 'error' ENOENT then close, like node does.
const enoentSpawn = () => {
  const c = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} });
  c.stdin.resume();
  setImmediate(() => { c.emit('error', Object.assign(new Error('spawn msb ENOENT'), { code: 'ENOENT' })); c.emit('close', -2, null); });
  return c;
};

const ENV = { CLOUDY_CLOUD_MSB_BIN: BIN, GH_TOKEN: 'cc-gh-x' };
function make(extraEnv = {}, boxOpts, deps = {}) {
  const box = fakeMsb(boxOpts);
  const provider = createProvider({ ...ENV, ...extraEnv }, { spawn: box.spawn, ...deps });
  return { box, provider };
}

contractSuite('microsandbox', ({ withKey }) => createProvider(withKey ? ENV : {}, { spawn: fakeMsb().spawn }));

const mk = (p, extra = {}) => p.create({ image: 'x', envs: {}, labels: { purpose: 'cloudy-cloud', owner: 'o1' }, ttlSeconds: 600, ...extra });

test('caps and identity: linux only, proxy secrets, egress, no snapshots/publish/display/metrics', () => {
  const p = createProvider(ENV, { spawn: fakeMsb().spawn });
  assert.equal(p.name, 'microsandbox');
  assert.equal(p.keyName, 'CLOUDY_CLOUD_MSB_BIN');
  assert.equal(p.caps.hasProxySecrets, true);
  assert.equal(p.caps.hasEgressPolicy, true);
  assert.equal(p.caps.hasServerTTL, false); // --max-duration stops the sandbox but does not remove it
  assert.deepEqual([p.caps.hasSnapshots, p.caps.hasPublish, p.caps.hasDisplay, p.caps.hasMetrics, p.caps.hasSizes], [false, false, false, false, false]);
  assert.deepEqual([p.caps.hasPortForward, p.caps.hasShell, p.caps.machineKinds, p.caps.maxForegroundMs, p.caps.maxTtlSeconds, p.caps.startsPerMin, p.caps.maxConcurrentCalls, p.caps.uploadMaxBytes],
    [true, true, ['linux'], Infinity, 86400, 60, 8, 200 * 1024 * 1024]);
});

test('secrets: one --secret per name with host restrictions; values ride only in the create child env', async () => {
  const { box, provider } = make({ CLAUDE_CODE_OAUTH_TOKEN: 'cc-oauth-SECRET' });
  await mk(provider, { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'] });
  const create = box.calls.find((c) => c.args[0] === 'create');
  const secrets = all(create.args.slice(1), '--secret');
  assert.ok(secrets.some((s) => s.startsWith('GH_TOKEN:') && s.endsWith('@github.com,api.github.com')), JSON.stringify(secrets));
  assert.ok(secrets.some((s) => s.startsWith('CLAUDE_CODE_OAUTH_TOKEN:') && s.endsWith('@api.anthropic.com')));
  assert.ok(secrets.every((s) => s.includes('headers=[authorization,x-api-key]')));
  for (const v of ['cc-gh-x', 'cc-oauth-SECRET']) assert.ok(!create.args.join(' ').includes(v), `${v} in argv`);
  assert.ok(!JSON.stringify(box.calls.map((c) => c.args)).includes('cc-oauth-SECRET'));
  assert.equal(create.env.GH_TOKEN, 'cc-gh-x');
  assert.equal(create.env.CLAUDE_CODE_OAUTH_TOKEN, 'cc-oauth-SECRET');
  // the guest sees a placeholder, never the value
  const s = await provider.list({ owner: 'o1' });
  const sb = await provider.connect(s[0].id);
  assert.match((await sb.commands.run('printf %s "$GH_TOKEN"')).stdout, /^msb-placeholder/);
});

test('secret validation: env/secret name collision, unknown host, and missing value all throw before create', async () => {
  const { box, provider } = make({ MCP_X_TOKEN: 'mcp-x' });
  await assert.rejects(mk(provider, { envs: { GH_TOKEN: 'dup' } }), /also attached as a secret/);
  await assert.rejects(mk(provider, { secrets: ['MCP_X_TOKEN'] }), (e) => e.code === 'no_key' && e.message.includes('MCP_X_TOKEN') && e.message.includes('cloudy-cloud mcp rm') && e.message.includes('CLOUDY_CLOUD_PROVIDER=instabox'));
  await assert.rejects(mk(provider, { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'] }), (e) => e.code === 'no_key' && e.message.includes('has no value') && e.message.includes('api.anthropic.com') && e.message.includes('CLOUDY_CLOUD_PROXY_SECRETS'));
  assert.equal(box.table.size, 0, 'nothing was created');
});

test('custom secret hosts from deps.secretHosts; a missing GH_TOKEN throws no_key naming github.com', async () => {
  const box = fakeMsb();
  const p = createProvider({ ...ENV, CC_IT_TOKEN: 'cc-it-x' }, { spawn: box.spawn, secretHosts: { CC_IT_TOKEN: ['httpbin.org'] } });
  await mk(p, { secrets: ['CC_IT_TOKEN'] });
  const secrets = all(box.calls.find((c) => c.args[0] === 'create').args.slice(1), '--secret');
  assert.ok(secrets.some((s) => s.startsWith('CC_IT_TOKEN:') && s.endsWith('@httpbin.org')));
  const noGh = createProvider({ CLOUDY_CLOUD_MSB_BIN: BIN }, { spawn: box.spawn });
  await assert.rejects(mk(noGh), (e) => e.code === 'no_key' && e.message.includes('GH_TOKEN') && e.message.includes('github.com,api.github.com'));
});

test('egress allowlist: deny-by-default + allow@dns + each host; invalid and absent egress', async () => {
  const { box, provider } = make();
  await mk(provider, { egress: { allow: ['example.com', '*.npmjs.org'] } });
  const args = box.calls.find((c) => c.args[0] === 'create').args;
  assert.equal(args[args.indexOf('--net-default') + 1], 'deny');
  const rules = all(args.slice(1), '--net-rule');
  for (const r of ['allow@dns', 'allow@example.com', 'allow@*.npmjs.org']) assert.ok(rules.includes(r), JSON.stringify(rules));
  const n = box.calls.length;
  await assert.rejects(mk(provider, { egress: { allow: ['http://x'] } }), /invalid egress host/);
  assert.equal(box.calls.length, n, 'rejected before any msb call');
  await mk(provider);
  const plain = box.calls.filter((c) => c.args[0] === 'create').at(-1).args;
  assert.ok(!plain.includes('--net-default') && !plain.includes('--net-rule'), 'no egress: no network flags');
});

test('create builds the documented msb argv: image, name, resources, ttl, labels, envs', async () => {
  const { box, provider } = make();
  const s = await mk(provider, { name: 'w1', envs: { FOO: 'a b' }, labels: { purpose: 'cloudy-cloud', owner: 'o1' } });
  assert.match(s.id, /^cc-[0-9a-f]{12}$/);
  const a = box.calls.find((c) => c.args[0] === 'create').args;
  assert.equal(a[1], IMAGE); // the package-version worker image, not the image arg
  assert.equal(at(a.slice(1), '--name'), s.id);
  assert.equal(at(a.slice(1), '-c'), '2');
  assert.equal(at(a.slice(1), '-m'), '4G');
  assert.equal(at(a.slice(1), '--max-duration'), '600s');
  const labels = all(a.slice(1), '--label');
  for (const l of ['cloudy-cloud.purpose=cloudy-cloud', 'cloudy-cloud.owner=o1', 'cloudy-cloud.name=w1']) assert.ok(labels.includes(l), l);
  assert.ok(labels.some((l) => l.startsWith('cloudy-cloud.deleteAt=') && l.endsWith('Z')));
  assert.ok(labels.some((l) => l.startsWith('cloudy-cloud.startedAt=') && l.endsWith('Z')));
  assert.ok(all(a.slice(1), '-e').includes('FOO=a b'));
  await assert.rejects(mk(provider, { kind: { name: 'android' } }), (e) => e.code === 'machine_kind_unsupported' && e.message === 'microsandbox runs only linux machines, not android. Use machine "linux", or set CLOUDY_CLOUD_PROVIDER=instabox.');
  await assert.rejects(mk(provider, { envs: { '9BAD': 'x' } }), /invalid environment variable name/);
  await assert.rejects(mk(provider, { labels: { 'bad key': 'x' } }), /invalid label name/);
});

test('role coordinator is refused with coordinatorRefusal and never spawns msb create', async () => {
  const { box, provider } = make();
  assert.match(provider.text.coordinatorRefusal, /not supported on the microsandbox provider yet.*cloud_agent.*CLOUDY_CLOUD_PROVIDER=instabox/s);
  await assert.rejects(mk(provider, { role: 'coordinator' }), (e) => e.message === provider.text.coordinatorRefusal);
  await assert.rejects(mk(provider, { labels: { purpose: 'cloudy-cloud', role: 'coordinator' } }), (e) => e.message === provider.text.coordinatorRefusal);
  assert.ok(!box.calls.some((c) => c.args[0] === 'create'), 'msb create was spawned');
});

test('a missing worker image says how to build and load it', async () => {
  const { provider } = make({}, { imageOk: false });
  await assert.rejects(mk(provider), (e) => e.message.includes(`worker image ${IMAGE} is missing`) && e.message.includes('docker build') && e.message.includes(`${BIN} load`) && e.message.includes('worker.Dockerfile'));
});

test('slots full gives quota_exceeded naming the count; raising the env lets it through', async () => {
  const box = fakeMsb();
  const put = (n) => box.table.set(`cc-${n}`, { name: `cc-${n}`, status: 'Running', created_at: 'x', image: IMAGE, labels: { 'cloudy-cloud.purpose': 'cloudy-cloud' }, env: {} });
  put(1); put(2);
  const p = createProvider(ENV, { spawn: box.spawn });
  await assert.rejects(mk(p), (e) => e.code === 'quota_exceeded' && e.message === 'All 2 microsandbox slots on this computer are in use. Stop an agent or raise CLOUDY_CLOUD_MSB_SLOTS.');
  put(3);
  const p3 = createProvider({ ...ENV, CLOUDY_CLOUD_MSB_SLOTS: '3' }, { spawn: box.spawn });
  await assert.rejects(mk(p3), (e) => e.code === 'quota_exceeded' && e.message.startsWith('All 3 '));
  const p9 = createProvider({ ...ENV, CLOUDY_CLOUD_MSB_SLOTS: '9' }, { spawn: box.spawn });
  await mk(p9); // a foreign (unlabelled) sandbox is not counted
  box.table.set('other', { name: 'other', status: 'Running', created_at: 'x', image: 'x', labels: {}, env: {} });
  await mk(p9);
});

test('an unset CLOUDY_CLOUD_MSB_BIN is no_key with the install text; spawn ENOENT maps to the same', async () => {
  const p = createProvider({}, { spawn: fakeMsb().spawn });
  await assert.rejects(mk(p), (e) => e.code === 'no_key' && e.message.includes('curl -fsSL https://install.microsandbox.dev | sh') && e.message.includes('CLOUDY_CLOUD_MSB_BIN'));
  const calls = [];
  const p2 = createProvider(ENV, { spawn: (...a) => { calls.push(a); return enoentSpawn(); } });
  await assert.rejects(mk(p2), (e) => e.code === 'no_key' && e.message.includes('install.microsandbox.dev'));
});

test('commands.run: exit code, timeout, cwd, env from -e, onStdout streaming', async () => {
  const { provider } = make();
  const s = await mk(provider, { envs: { FOO: "it's $x" } });
  const out = [];
  const r = await s.commands.run('printf %s "$FOO" && pwd', { cwd: '/home/worker/app', onStdout: (d) => out.push(d) });
  assert.ok(r.stdout.startsWith("it's $x"), r.stdout);
  assert.ok(r.stdout.trim().endsWith('/home/worker/app'), r.stdout); // pwd inside the fake root maps to the guest path
  assert.equal(out.join(''), r.stdout);
  await assert.rejects(s.commands.run('exit 3'), (e) => e.exitCode === 3);
  await assert.rejects(s.commands.run('TRIGGER_TIMEOUT', { timeoutMs: 2000 }), (e) => e.code === 'timeout' && /2 s/.test(e.message));
});

test('files round-trip binary data', async () => {
  const { provider } = make();
  const s = await mk(provider);
  const bin = Buffer.from([0, 255, 254, 10, 13, 128]);
  await s.files.write('/home/worker/b/x.bin', bin);
  assert.deepEqual(await s.files.read('/home/worker/b/x.bin'), bin);
});

test('abort ends the local call and signals the process inside the guest', async () => {
  const { box, provider } = make();
  const s = await mk(provider);
  const ac = new AbortController();
  const p = s.commands.run('sleep 30', { signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(p, (e) => e.name === 'AbortError');
  await new Promise((r) => setTimeout(r, 200));
  const scan = box.calls.filter((c) => c.args[0] === 'exec').at(-1).args.join(' ');
  assert.match(scan, /CC_RUN=[0-9a-f]+/);
  assert.match(scan, /kill -TERM/);
});

test('connect, list, delete; snapshot and publish refuse', async () => {
  const { provider } = make();
  const s = await mk(provider, { name: 'w1' });
  assert.equal((await provider.connect(s.id)).id, s.id);
  assert.equal(await (await provider.connect(s.id)).loadName(), s.id);
  await assert.rejects(provider.connect('cc-nope'), (e) => e.code === 'not_found');
  const [row] = await provider.list({ owner: 'o1' });
  assert.equal(row.id, s.id);
  assert.equal(row.name, 'w1');
  assert.equal(row.status, 'running');
  assert.equal(row.labels.purpose, 'cloudy-cloud');
  assert.ok(row.startedAt > 0 && row.deleteAt);
  await provider.delete('cc-gone'); // a 404 counts as deleted
  await assert.rejects(provider.snapshot(s, { name: 'n' }), /snapshot/i);
  await assert.rejects(provider.getSnapshot('x'), /snapshot/i);
  await assert.rejects(provider.publishPort(s.id, '3000'), /does not publish links/);
  assert.equal(await provider.unpublishPort(s.id, '3000'), 1);
  assert.equal(provider.localMachineName('cc-abc'), 'cc-abc');
  assert.equal(provider.localMachineName('laptop'), '');
  await s.kill();
  assert.equal((await provider.list({})).length, 0);
});

test('shellArgv: a login shell or a quoted command; shellEnv is empty', () => {
  const p = createProvider(ENV, { spawn: fakeMsb().spawn });
  assert.deepEqual(p.shellArgv('cc-1'), [BIN, 'exec', '-t', 'cc-1', '--', 'bash', '-l']);
  assert.deepEqual(p.shellArgv('cc-1', []), p.shellArgv('cc-1'));
  assert.deepEqual(p.shellArgv('cc-1', ['echo', "it's x"]), [BIN, 'exec', '--no-tty', 'cc-1', '--', 'bash', '-lc', `'echo' 'it'\\''s x'`]);
  assert.deepEqual(p.shellArgv('cc-1', ['claude', 'auth', 'login'], { tty: true }), [BIN, 'exec', '-t', 'cc-1', '--', 'bash', '-lc', `'claude' 'auth' 'login'`]);
  assert.deepEqual(p.shellEnv(), {});
});

test('display and metrics refuse with their codes; plan is null; text names the fixes', async () => {
  const p = createProvider(ENV, { spawn: fakeMsb().spawn });
  for (const m of ['displayLink', 'revokeDisplayLinks', 'screenshot']) await assert.rejects(p[m]('cc-1', {}), (e) => e.code === 'display_unsupported', m);
  await assert.rejects(p.metrics('cc-1'), (e) => e.code === 'metrics_unsupported' && e.provider === 'microsandbox');
  assert.equal(await p.plan(), null);
  assert.equal(p.text.hostLabel, 'this computer');
  assert.match(p.text.listMachines, new RegExp(`^${BIN} ls --label `));
  assert.match(p.text.ssh('cc-1', ''), new RegExp(`^${BIN} exec -t cc-1 -- bash`));
  assert.match(p.text.githubTokenHelp, /GH_TOKEN.*github\.com/s);
});

test('forwardPort bridges a local connection through msb exec --stream into the guest', async () => {
  const { provider } = make();
  const s = await mk(provider);
  const echo = createServer((c) => c.pipe(c)).listen(0, '127.0.0.1');
  await once(echo, 'listening');
  const lport = await new Promise((r) => { const t = createServer().listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)); }); });
  const ac = new AbortController();
  const done = provider.forwardPort(s.id, `${lport}:${echo.address().port}`, { signal: ac.signal });
  try {
    await new Promise((r) => setTimeout(r, 200));
    const c = connect(lport, '127.0.0.1');
    c.end('ping');
    let got = '';
    for await (const d of c) got += d;
    assert.equal(got, 'ping');
  } finally { ac.abort(); echo.close(); }
  assert.equal(await done, 0);
  await assert.rejects(provider.forwardPort('cc-nope', '1:2'), (e) => e.code === 'not_found');
});

test('loadProvider picks microsandbox; the unknown-provider message lists all three', async () => {
  const p = await loadProvider({ CLOUDY_CLOUD_PROVIDER: 'microsandbox', CLOUDY_CLOUD_MSB_BIN: BIN });
  assert.equal(p.name, 'microsandbox');
  await assert.rejects(loadProvider({ CLOUDY_CLOUD_PROVIDER: 'nope' }), { message: 'Unknown CLOUDY_CLOUD_PROVIDER "nope". Known: instabox, self-hosted, microsandbox.' });
});

test('missingSetup: the msb binary counts, from env or unset', () => {
  assert.match(missingSetup({ CLOUDY_CLOUD_PROVIDER: 'microsandbox' }), /CLOUDY_CLOUD_MSB_BIN/);
  assert.equal(missingSetup({ CLOUDY_CLOUD_PROVIDER: 'microsandbox', CLOUDY_CLOUD_MSB_BIN: BIN }), '');
});
