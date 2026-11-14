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
  const images = new Map(); // committed coordinator images: ref -> { labels, from, message }
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
    if (cmd === 'run' && rest.includes('--entrypoint')) return done(0, '998\n'); // the gid probe: stat of the mounted socket
    if (cmd === 'run') {
      const labels = {};
      rest.forEach((a, i) => { if (a === '--label') { const [k, ...v] = rest[i + 1].split('='); labels[k] = v.join('='); } });
      const name = opt('--name');
      table.set(name, { Args: rest, Id: randomBytes(32).toString('hex'), Name: `/${name}`, Config: { Labels: labels }, State: { Status: 'running', StartedAt: new Date().toISOString() }, NetworkSettings: { IPAddress: `172.17.0.${table.size + 2}` } });
      return done(0, `${table.get(name).Id}\n`);
    }
    if (cmd === 'ps') return done(0, [...table.values()].filter((c) => 'cloudy-cloud.purpose' in c.Config.Labels).map((c) => c.Id.slice(0, 12)).join('\n') + '\n');
    if (cmd === 'image') {
      const ref = rest.at(-1);
      if (rest[0] === 'ls') return done(0, [...images.keys()].join('\n') + '\n');
      if (ref.startsWith('cloudy-cloud-coordinator:')) return images.has(ref) ? done(0, `sha256:${ref}\n`) : done(1, '', `Error response from daemon: No such image: ${ref}`);
      return done(0, `${imageVersion}\n`);
    }
    if (cmd === 'commit') {
      const c = find(rest.at(-2));
      if (!c) return done(1, '', `Error response from daemon: No such container: ${rest.at(-2)}`);
      images.set(rest.at(-1), { from: c.Name.slice(1), message: opt('-m'), change: opt('--change') });
      return done(0, `sha256:${rest.at(-1)}\n`);
    }
    if (cmd === 'rmi') return images.delete(rest.at(-1)) ? done(0, `Untagged: ${rest.at(-1)}\n`) : done(1, '', `Error response from daemon: No such image: ${rest.at(-1)}`);
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
  return { spawn, table, images, log, root, sshCalls };
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
  const snap = await provider.snapshot(s, { name: 'coord-1', description: 'cloudy-cloud coordinator image' });
  await provider.getSnapshot(snap.id);
  const c = await mk(provider, { image: snap.id, name: 'coord' });
  await provider.listSnapshots();
  await provider.deleteSnapshot(snap.id);
  await c.kill();
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
  assert.equal(await (await provider.connect(s.id, { retry: false })).loadName(), s.id, 'docker exec needs the container name');
  assert.equal(await (await mk(provider, { name: 'coord-x', retry: false })).loadName?.().then((n) => n.startsWith('cc-')), true);
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

test('list maps fields; publish is refused', async () => {
  const { box, provider } = make();
  const s = await mk(provider, { name: 'w1' });
  const [row] = await provider.list({ owner: 'o1' });
  assert.equal(row.id, s.id);
  assert.equal(row.name, 'w1');
  assert.equal(row.status, 'running');
  assert.equal(row.labels.purpose, 'cloudy-cloud');
  assert.ok(row.startedAt > 0 && row.deleteAt);
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

test('coordinator snapshots: commit, inspect, create from the image without the worker label check, list, delete', async () => {
  const { box, provider } = make({ GH_TOKEN: 'ghp_SECRETVALUE', CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX: 'yes' }, { imageVersion: '0.0.1' }); // worker image is stale
  assert.equal(provider.caps.hasSnapshots, true);
  box.table.set('cc-src', { Id: 'a'.repeat(64), Name: '/cc-src', Config: { Labels: {} }, State: { Status: 'running' } });
  const src = await provider.connect('cc-src');
  const snap = await provider.snapshot(src, { name: 'coord-1', description: 'd' });
  assert.deepEqual(snap, { id: 'cloudy-cloud-coordinator:coord-1', status: 'ready' });
  assert.deepEqual(await provider.getSnapshot(snap.id), { id: snap.id, status: 'ready' });
  const commit = box.log.find((a) => a[1] === 'commit');
  assert.deepEqual(commit.slice(1, 5), ['commit', '--pause=true', '-m', 'd']);
  assert.equal(commit.at(-2), 'cc-src');
  assert.ok(!commit.join(' ').includes('/run/secrets'), 'the commit never names the secrets dir');
  assert.ok(!commit.join(' ').includes('ghp_SECRETVALUE'));
  // the stale worker image would fail the label check, but a coordinator image is used as is
  const c = await provider.create({ image: snap.id, envs: {}, labels: { purpose: 'cloudy-cloud', role: 'coordinator' }, ttlSeconds: 60, neverSuspend: true });
  const run = box.log.find((a) => a[1] === 'run');
  assert.equal(run[run.indexOf('--user') + 2], snap.id);
  assert.ok(run.includes('--tmpfs'), 'a fresh /run/secrets tmpfs is mounted on the new container');
  assert.ok(!box.log.some((a) => a[1] === 'image' && a.includes('{{index .Config.Labels "cloudy-cloud.image"}}')), 'worker label check skipped');
  await c.kill();
  assert.deepEqual((await provider.listSnapshots()).map((i) => i.id), [snap.id]);
  await provider.deleteSnapshot(snap.id);
  assert.deepEqual(await provider.listSnapshots(), []);
  await assert.rejects(provider.getSnapshot(snap.id), (e) => e.code === 'not_found');
  await assert.rejects(provider.create({ image: snap.id, envs: {}, labels: {}, ttlSeconds: 60 }), (e) => e.code === 'not_found');
  await assert.rejects(provider.snapshot(src, { name: 'bad name; rm -rf /' }), /invalid snapshot name/);
  await assert.rejects(provider.deleteSnapshot('cloudy-cloud-worker:0.1.2'), /only deletes coordinator images/);
});

test('GitHub token consent covers GH_TOKEN only: unrequested env secrets are never copied, requested MCP secrets are', async () => {
  const { box, provider } = make({ CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX: 'yes', GH_TOKEN: 'ghp_X', MCP_A_TOKEN: 'mcp-a-value', MCP_B_TOKEN: 'mcp-b-value' });
  await mk(provider, { secrets: ['MCP_A_TOKEN'] });
  const file = readFileSync(join(box.root, 'run/secrets/env'), 'utf8');
  assert.match(file, /GH_TOKEN='ghp_X'/);
  assert.match(file, /MCP_A_TOKEN='mcp-a-value'/);
  assert.ok(!file.includes('mcp-b-value'));
});

test('two concurrent creates with one free slot: one starts, the other gets quota_exceeded', async () => {
  const { box, provider } = make({ CLOUDY_CLOUD_SELF_HOSTED_SLOTS: '1' });
  const r = await Promise.allSettled([mk(provider), mk(provider)]);
  assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(r.find((x) => x.status === 'rejected').reason.code, 'quota_exceeded');
  assert.equal(box.table.size, 1);
});

const SOCK = '/run/user/1000/docker.sock';
const coordEnv = { CLOUDY_CLOUD_SELF_HOSTED_COORDINATORS: 'yes', CLOUDY_CLOUD_DOCKER_SOCKET: SOCK };
const mkCoord = (p) => mk(p, { image: 'x', labels: { purpose: 'cloudy-cloud', owner: 'o1', role: 'coordinator' }, neverSuspend: true });

test('coordinators stay refused without the consent, with a next step; consent lifts the refusal (#41)', async () => {
  const off = make();
  assert.match(off.provider.text.coordinatorRefusal, /not allowed.*cloudy-cloud setup --provider self-hosted/s);
  await assert.rejects(mkCoord(off.provider), /setup --provider self-hosted/);
  assert.equal(off.box.table.size, 0);
  const on = make(coordEnv);
  assert.equal(on.provider.text.coordinatorRefusal, undefined);
  assert.equal(on.provider.caps.hasSnapshots, true);
});

test('only a coordinator container gets the Docker socket, with the socket owner group; workers never do', async () => {
  const { box, provider } = make(coordEnv);
  await mk(provider);
  await mkCoord(provider);
  const [w, c] = [...box.table.values()].map((x) => x.Args);
  for (const a of [w, c]) assert.ok(!a.includes('--privileged'));
  assert.ok(!w.includes('-v') && !w.includes('--group-add'), 'worker got the socket');
  assert.equal(c[c.indexOf('-v') + 1], `${SOCK}:/var/run/docker.sock`);
  assert.equal(c[c.indexOf('--group-add') + 1], '998');
  assert.ok(box.log.some((a) => a.includes('--entrypoint') && a.includes('stat')), 'gid probe');
});

test('coordinatorEnv: the names a coordinator gets from this provider; no SSH host, key or port; token only with consent', () => {
  const base = { ...ENV, ...coordEnv, CLOUDY_CLOUD_SSH_KEY: '/k', CLOUDY_CLOUD_SSH_PORT: '2222', CLOUDY_CLOUD_SELF_HOSTED_CPUS: '2', CLOUDY_CLOUD_SELF_HOSTED_MEMORY: '4g',
    CLOUDY_CLOUD_CONTAINER_RUNTIME: 'docker', GH_TOKEN: 'ghp_x' };
  const own = (e) => createProvider(e, { spawn: fakeBox().spawn }).coordinatorEnv();
  const o = own(base);
  assert.deepEqual(o.fixed.map((l) => l.split('=')[0]), ['CLOUDY_CLOUD_PROVIDER', 'CLOUDY_CLOUD_SELF_HOSTED_LOCAL', 'CLOUDY_CLOUD_SELF_HOSTED_COORDINATORS', 'CLOUDY_CLOUD_DOCKER_SOCKET', 'CLOUDY_CLOUD_CONTAINER_BIN']);
  assert.ok(o.fixed.includes('CLOUDY_CLOUD_SELF_HOSTED_LOCAL=1') && o.fixed.includes('CLOUDY_CLOUD_PROVIDER=self-hosted') && o.fixed.includes(`CLOUDY_CLOUD_DOCKER_SOCKET=${SOCK}`));
  assert.deepEqual(o.names, ['CLOUDY_CLOUD_CONTAINER_RUNTIME', 'CLOUDY_CLOUD_SELF_HOSTED_SLOTS', 'CLOUDY_CLOUD_SELF_HOSTED_CPUS', 'CLOUDY_CLOUD_SELF_HOSTED_MEMORY']);
  assert.deepEqual(own({ ...base, CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX: 'yes' }).names.slice(-2), ['CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX', 'GH_TOKEN']);
  assert.ok(!JSON.stringify(o).match(/SSH|me@box|INSTABOX/));
});

// The local transport: inside a coordinator container the same docker commands run through `sh -c` against the socket, no ssh.
test('local mode runs the same command strings through sh, never ssh; slots count all containers by label', async () => {
  const box = fakeBox();
  const calls = [];
  // Adapt the box's ssh-shaped fake: re-wrap the local `sh -c <cmd>` the way ssh.mjs would send it.
  const spawn = (bin, args) => {
    calls.push({ bin, args });
    assert.equal(bin, 'sh');
    assert.equal(args[0], '-c');
    return box.spawn('ssh', [`sh -c "$(printf %s ${Buffer.from(args[1]).toString('base64')} | base64 -d)"`]);
  };
  const env = { CLOUDY_CLOUD_SELF_HOSTED_LOCAL: '1', CLOUDY_CLOUD_DOCKER_SOCKET: '/var/run/docker.sock', CLOUDY_CLOUD_CONTAINER_BIN: BIN, CLOUDY_CLOUD_SELF_HOSTED_SLOTS: '2',
    CLOUDY_CLOUD_SELF_HOSTED_COORDINATORS: 'yes', CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX: 'yes', GH_TOKEN: 'ghp_L' };
  const p = createProvider(env, { spawn });
  assert.equal(p.keyName, 'CLOUDY_CLOUD_DOCKER_SOCKET'); // not the SSH host; the core's missing-key check and scrub use it
  box.table.set('cc-laptop', { Id: 'a'.repeat(64), Name: '/cc-laptop', Config: { Labels: { 'cloudy-cloud.purpose': 'cloudy-cloud' } }, State: { Status: 'running' } });
  const s = await mk(p); // a sibling worker, next to the one the laptop started
  assert.equal((await s.commands.run('echo hi')).stdout, 'hi\n');
  await assert.rejects(mk(p), (e) => e.code === 'quota_exceeded'); // 2 slots: the laptop's container and this one
  assert.equal((await p.list({})).length, 2);
  await p.delete(s.id);
  assert.ok(calls.length > 5 && calls.every((c) => c.bin === 'sh'));
  assert.ok(!JSON.stringify(calls).includes('ssh '), 'no ssh in any command');
  assert.match(p.text.ssh('cc-1', 'bash'), /^docker exec -it cc-1 bash$|exec -it cc-1 bash/);
  await assert.rejects(p.forwardPort('cc-x', '3000'), /not available/);
  assert.equal(p.text.coordinatorRefusal, undefined);
});

test('local mode: a missing docker CLI in the image says how to rebuild it', async () => {
  const spawn = () => { const c = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} });
    c.stdin.on('end', () => { c.stderr.write('sh: 1: docker: not found'); c.emit('close', 127, null); }); return c; };
  const p = createProvider({ CLOUDY_CLOUD_SELF_HOSTED_LOCAL: '1', CLOUDY_CLOUD_DOCKER_SOCKET: '/var/run/docker.sock' }, { spawn });
  await assert.rejects(p.list({}), /docker CLI.*cloudy-cloud setup/s);
});
