import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as realSpawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { contractSuite } from './provider-contract.mjs';
import { golden } from './golden-util.mjs';
import { createProvider } from '../src/providers/self-hosted.mjs';
import { loadProvider } from '../src/providers/index.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const BIN = '/opt/homebrew/bin/docker';
const roots = [];
process.on('exit', () => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

// POSIX single-quote parser: the inverse of the adapter's quoting.
function words(s) {
  const out = []; let cur = '', inq = false, any = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inq) { if (c === "'") inq = false; else cur += c; } else if (c === "'") { inq = true; any = true; } else if (c === '\\' && s[i + 1] === "'") { cur += "'"; i++; } else if (/\s/.test(c)) { if (cur || any) out.push(cur); cur = ''; any = false; } else cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}

// A fake box: an in-memory container table behind a fake `ssh`; `exec` runs the command locally under a temp root.
function fakeBox({ imageVersion = VERSION, daemonDown = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cc-sh-'));
  roots.push(root);
  const table = new Map();
  const log = []; // every decoded remote command, as argv
  const sshCalls = [];
  const local = (s) => s.replaceAll('/run/secrets', `${root}/run/secrets`).replaceAll('/home/worker', `${root}/home/worker`);
  function handle(argv, stdin, child) {
    const done = (code, out = '', err = '') => { if (out) child.stdout.write(out); if (err) child.stderr.write(err); child.emit('close', code, null); };
    const [bin, cmd, ...rest] = argv;
    if (bin !== BIN) return done(127, '', `${bin}: not found`);
    if (daemonDown) return done(1, '', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock');
    const opt = (n) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
    const find = (n) => table.get(n) ?? [...table.values()].find((c) => c.Id.startsWith(n));
    if (cmd === 'run') {
      const labels = {};
      rest.forEach((a, i) => { if (a === '--label') { const [k, ...v] = rest[i + 1].split('='); labels[k] = v.join('='); } });
      const name = opt('--name');
      table.set(name, { Id: randomBytes(32).toString('hex'), Name: `/${name}`, Config: { Labels: labels }, State: { Status: 'running', StartedAt: new Date().toISOString() }, NetworkSettings: { IPAddress: `172.17.0.${table.size + 2}` } });
      return done(0, `${table.get(name).Id}\n`);
    }
    if (cmd === 'ps') return done(0, [...table.values()].filter((c) => 'cloudy-cloud.purpose' in c.Config.Labels).map((c) => c.Id.slice(0, 12)).join('\n') + '\n');
    if (cmd === 'image') return done(0, `${imageVersion}\n`);
    if (cmd === 'inspect') {
      const fmt = rest.includes('--format') ? opt('--format') : null;
      const names = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--format');
      const cs = names.map(find);
      if (cs.some((c) => !c)) return done(1, '', `Error: No such object: ${names.find((n) => !find(n))}`);
      if (fmt === '{{.Name}}') return done(0, `${cs[0].Name}\n`);
      if (fmt?.includes('IPAddress')) return done(0, `${cs[0].NetworkSettings.IPAddress}\n`);
      return done(0, JSON.stringify(cs));
    }
    if (cmd === 'rm') {
      const c = find(rest.at(-1));
      if (!c) return done(1, '', `Error response from daemon: No such container: ${rest.at(-1)}`);
      table.delete(c.Name.slice(1));
      return done(0, `${rest.at(-1)}\n`);
    }
    if (cmd === 'exec' && rest.includes('node')) { // the port-forward bridge: runs locally, stdio piped through
      const ni = rest.indexOf('node');
      if (!find(rest[ni - 1])) return done(1, '', `Error response from daemon: No such container: ${rest[ni - 1]}`);
      const p = realSpawn(process.execPath, rest.slice(ni + 1));
      p.stdout.on('data', (d) => child.stdout.write(d));
      p.on('close', (code) => child.emit('close', code, null));
      p.stdin.end(stdin);
      return;
    }
    if (cmd === 'exec') {
      const i = rest.indexOf('sh');
      const inner = rest[i + 2];
      if (!find(rest[i - 1])) return done(1, '', `Error response from daemon: No such container: ${rest[i - 1]}`);
      if (inner.includes('TRIGGER_TIMEOUT')) return done(124);
      const cwd = local(opt('-w') ?? '/home/worker');
      realSpawn('mkdir', ['-p', cwd, `${root}/run/secrets`]).on('close', () => {
        // the real container has `timeout`; macOS does not, so drop it here
        const p = realSpawn('sh', ['-c', local(inner).replace(/exec timeout -k 5 \d+ /, 'exec ')], { cwd });
        p.stdout.on('data', (d) => child.stdout.write(d));
        p.stderr.on('data', (d) => child.stderr.write(d));
        p.on('close', (code) => child.emit('close', code, null));
        p.stdin.on('error', () => {});
        p.stdin.end(stdin);
      });
      return;
    }
    done(1, '', `unknown command ${cmd}`);
  }
  const spawn = (bin, args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} });
    sshCalls.push({ bin, args });
    const chunks = [];
    child.stdin.on('data', (d) => chunks.push(Buffer.from(d)));
    child.stdin.on('end', () => {
      const b64 = args.at(-1).match(/printf %s ([A-Za-z0-9+/=]+) \| base64 -d/)[1];
      const text = Buffer.from(b64, 'base64').toString();
      const argv = words(text);
      log.push(argv);
      handle(argv, Buffer.concat(chunks), child);
    });
    return child;
  };
  return { spawn, table, log, root, sshCalls };
}

const ENV = { CLOUDY_CLOUD_SSH_HOST: 'me@box', CLOUDY_CLOUD_CONTAINER_BIN: BIN, CLOUDY_CLOUD_SELF_HOSTED_SLOTS: '5' };
function make(extraEnv = {}, boxOpts) {
  const box = fakeBox(boxOpts);
  const provider = createProvider({ ...ENV, ...extraEnv }, { spawn: box.spawn });
  return { box, provider };
}

contractSuite('self-hosted', ({ withKey }) => createProvider(withKey ? ENV : { CLOUDY_CLOUD_CONTAINER_BIN: BIN }, { spawn: fakeBox().spawn }));

const mk = (p, extra = {}) => p.create({ image: 'x', envs: {}, labels: { purpose: 'cloudy-cloud', owner: 'o1' }, ttlSeconds: 600, ...extra });

test('golden: exact docker commands for create, run, write, list and delete; no secret in any argv or label', async () => {
  const { box, provider } = make({ GH_TOKEN: 'ghp_SECRETVALUE', CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX: 'yes' });
  assert.equal(provider.caps.hasConsentedSecrets, true);
  const s = await mk(provider, { envs: { FOO: 'env-value-123' }, name: 'w1' }); // the core never names GH_TOKEN; the adapter adds it
  await s.commands.run("echo hi; echo \"$FOO\" $GH_TOKEN | wc -c", { cwd: '/home/worker/app', timeoutMs: 5000 });
  await s.files.write('/home/worker/dir/a.txt', 'hello');
  await provider.list({ owner: 'o1' });
  await s.kill();
  const strip = (argv) => argv.map((a) => a.replace(/cc-[0-9a-f]{12}/g, 'cc-ID').replace(/[0-9a-f]{16}(?=;| )/g, 'MARKER')
    .replace(/(deleteAt|startedAt)=\S+/g, '$1=ISO').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'ISO').replace(/^[0-9a-f]{12}$/, 'ID'));
  const flat = box.log.flat().join('\n');
  for (const v of ['ghp_SECRETVALUE', 'env-value-123']) assert.ok(!flat.includes(v), `${v} must not appear in argv`);
  assert.ok(!box.sshCalls.some((c) => c.args.join(' ').includes('ghp_SECRETVALUE')));
  golden('self-hosted-commands', box.log.map(strip));
  // the secret did reach the container's env file
  assert.match(readFileSync(join(box.root, 'run/secrets/env'), 'utf8'), /GH_TOKEN='ghp_SECRETVALUE'/);
});

test('commands.run sees the env file and streams stdout; files round-trip binary', async () => {
  const { provider } = make();
  const s = await mk(provider, { envs: { FOO: "it's $x" } });
  const out = [];
  const r = await s.commands.run('printf %s "$FOO"', { onStdout: (d) => out.push(d) });
  assert.equal(r.stdout, "it's $x");
  assert.equal(out.join(''), "it's $x");
  const bin = Buffer.from([0, 255, 254, 10, 13, 128]);
  await s.files.write('/home/worker/b/x.bin', bin);
  assert.deepEqual(await s.files.read('/home/worker/b/x.bin'), bin);
  await assert.rejects(s.commands.run('exit 3'), (e) => e.exitCode === 3);
});

test('slots full gives quota_exceeded', async () => {
  const { provider } = make({ CLOUDY_CLOUD_SELF_HOSTED_SLOTS: '1' });
  await mk(provider);
  await assert.rejects(mk(provider), (e) => e.code === 'quota_exceeded' && /cloudy-cloud|SLOTS/.test(e.message));
});

test('wrong image label gives the setup message', async () => {
  const { provider } = make({}, { imageVersion: '0.0.1' });
  await assert.rejects(mk(provider), (e) => e.message.includes(`version 0.0.1 but cloudy-cloud is ${VERSION}`) && e.message.includes('Run: cloudy-cloud setup'));
});

test('exit 124 gives the timeout error', async () => {
  const { provider } = make();
  const s = await mk(provider);
  await assert.rejects(s.commands.run('TRIGGER_TIMEOUT', { timeoutMs: 2000 }), (e) => e.code === 'timeout' && /2 s/.test(e.message));
});

test('abort ends the local call and signals the process inside the container', async () => {
  const { box, provider } = make();
  const s = await mk(provider);
  const ac = new AbortController();
  const p = s.commands.run('sleep 30', { signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(p, (e) => e.name === 'AbortError');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(box.log.some((a) => a.includes('exec') && /CC_RUN=[0-9a-f]+/.test(a.at(-1)) && a.at(-1).includes('kill -TERM')));
});

test('delete of a missing container resolves; other failures retry then throw', async () => {
  const { provider } = make();
  await provider.delete('cc-gone');
  const { provider: down } = make({}, { daemonDown: true });
  const lines = [];
  await assert.rejects(down.delete('cc-x', { retries: 1, log: (l) => lines.push(l) }), (e) => e.code === 'transient' && e.message.includes('cloudy-cloud doctor'));
  assert.equal(lines.length, 1);
});

test('connect: unknown id is not_found; known id works', async () => {
  const { provider } = make();
  const s = await mk(provider);
  assert.equal((await provider.connect(s.id)).id, s.id);
  await assert.rejects(provider.connect('cc-nope'), (e) => e.code === 'not_found');
});

test('GH_TOKEN goes in the env file only with consent; consent without a saved token is refused before anything starts', async () => {
  const { box, provider } = make({ GH_TOKEN: 'ghp_NOCONSENT' });
  await mk(provider);
  assert.ok(!readFileSync(join(box.root, 'run/secrets/env'), 'utf8').includes('ghp_NOCONSENT'));
  const { box: b2, provider: p2 } = make({ CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX: 'yes' });
  await assert.rejects(mk(p2), (e) => e.code === 'no_key' && e.message.includes('GH_TOKEN') && e.message.includes('cloudy-cloud setup'));
  assert.equal(b2.table.size, 0);
});

test('hostLabel names the machine without the user@ part, which the core scrubs as the key value', () => {
  const { provider } = make();
  assert.equal(provider.text.hostLabel, 'box');
  assert.match(provider.text.githubTokenHelp, /cloudy-cloud setup --provider self-hosted.*GitHub token/);
});

test('secrets without consent throw no_key naming the secret; nothing is started', async () => {
  const { box, provider } = make({ GH_TOKEN: 'x' });
  assert.equal(provider.caps.hasConsentedSecrets, false);
  await assert.rejects(mk(provider, { secrets: ['GH_TOKEN'] }), (e) => e.code === 'no_key' && e.message.includes('GH_TOKEN'));
  assert.equal(box.table.size, 0);
});

test('list maps fields; snapshots and publish are refused', async () => {
  const { box, provider } = make();
  const s = await mk(provider, { name: 'w1' });
  const [row] = await provider.list({ owner: 'o1' });
  assert.equal(row.id, s.id);
  assert.equal(row.name, 'w1');
  assert.equal(row.status, 'running');
  assert.equal(row.labels.purpose, 'cloudy-cloud');
  assert.ok(row.startedAt > 0 && row.deleteAt);
  await assert.rejects(provider.snapshot(s, { name: 'n' }), (e) => e.code === 'not_found' && /no snapshots yet/.test(e.message));
  await assert.rejects(provider.publishPort(s.id, '3000'), /does not publish links/);
  assert.equal(await provider.unpublishPort(s.id, '3000'), 1);
  assert.equal(provider.localMachineName('cc-abc'), 'cc-abc');
  assert.equal(provider.localMachineName('laptop'), '');
});

test('forwardPort bridges each local connection through docker exec (no container IP, so Docker Desktop works)', async () => {
  const { box, provider } = make();
  const s = await mk(provider);
  const echo = createServer((c) => c.pipe(c)).listen(0, '127.0.0.1');
  await once(echo, 'listening');
  const local = await new Promise((r) => { const t = createServer().listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)); }); });
  const ac = new AbortController();
  const done = provider.forwardPort(s.id, `${local}:${echo.address().port}`, { signal: ac.signal });
  try {
    await new Promise((r) => setTimeout(r, 100));
    const c = connect(local, '127.0.0.1');
    c.end('ping');
    let got = '';
    for await (const d of c) got += d;
    assert.equal(got, 'ping');
    const fwd = box.log.at(-1);
    assert.deepEqual(fwd.slice(0, 4), [BIN, 'exec', '-i', s.id]);
    assert.equal(fwd[4], 'node');
  } finally { ac.abort(); echo.close(); }
  assert.equal(await done, 0);
  await assert.rejects(provider.forwardPort('cc-nope', '1:2'), (e) => e.code === 'not_found');
});

test('podman swaps the binary only; unknown runtime throws', async () => {
  const { box, provider } = make({ CLOUDY_CLOUD_CONTAINER_BIN: '', CLOUDY_CLOUD_CONTAINER_RUNTIME: 'podman' });
  await mk(provider).catch(() => {}); // the fake only knows the docker path, so this fails at the first command
  assert.equal(box.log[0][0], 'podman');
  assert.throws(() => createProvider({ ...ENV, CLOUDY_CLOUD_CONTAINER_RUNTIME: 'lxc' }), /docker or podman/);
});

test('loadProvider finds self-hosted; text names the fix', async () => {
  const p = await loadProvider({ CLOUDY_CLOUD_PROVIDER: 'self-hosted', CLOUDY_CLOUD_SSH_HOST: 'u@h' });
  assert.equal(p.name, 'self-hosted');
  assert.match(p.text.noKeyFix, /cloudy-cloud setup/);
  assert.match(p.text.apiFix, /cloudy-cloud doctor/);
  assert.equal(p.text.ssh('cc-1', ''), 'ssh -t u@h docker exec -it cc-1 bash');
});
