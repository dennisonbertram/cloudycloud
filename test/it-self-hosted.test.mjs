// Opt-in integration test for the self-hosted provider: CLOUDY_CLOUD_IT_SSH=1 node --test test/it-self-hosted.test.mjs
// Needs Docker (Docker Desktop or OrbStack) on this computer. It starts a throwaway "box" container (sshd + docker CLI on
// the mounted Docker socket), runs the real setup and doctor against it over ssh, builds the worker image, then drives the
// provider: create, write, run, timeout, list, forwardPort, delete and the TTL. Everything it creates is removed in
// `after`, even on failure. It never reads or writes ~/.ssh or ~/.config: ssh runs with a private config and known_hosts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';

const ON = process.env.CLOUDY_CLOUD_IT_SSH === '1';
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const BOX_IMAGE = 'cloudy-cloud-it-sshd:test';
const WORKER_IMAGE = `cloudy-cloud-worker:${VERSION}`;
const OWNER = `it-${randomBytes(4).toString('hex')}`;
const TOKEN = `ghp_IT${randomBytes(12).toString('hex')}`; // fake; only checked for where it ends up
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sink = () => { const w = new Writable({ write(c, _e, cb) { w.text += c; cb(); } }); w.text = ''; return w; };

let dir, box, port, env, hadWorkerImage;

before(async () => {
  if (!ON) return;
  dir = mkdtempSync(join(tmpdir(), 'cc-it-'));
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'key')]);
  // A private ssh: own config and known_hosts, so the user's ~/.ssh is never read or written.
  writeFileSync(join(dir, 'ssh_config'), `UserKnownHostsFile ${dir}/known_hosts\nGlobalKnownHostsFile /dev/null\nStrictHostKeyChecking accept-new\nIdentitiesOnly yes\n`);
  writeFileSync(join(dir, 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F ${dir}/ssh_config "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${process.env.PATH}`;
  hadWorkerImage = spawnSync('docker', ['image', 'inspect', WORKER_IMAGE]).status === 0;
  docker('build', '-q', '-t', BOX_IMAGE, '-f', new URL('./it/sshd.Dockerfile', import.meta.url).pathname, new URL('./it', import.meta.url).pathname);
  box = docker('run', '-d', '--rm', '-p', '127.0.0.1::22', '-v', '/var/run/docker.sock:/var/run/docker.sock', '-e', `AUTHORIZED_KEY=${readFileSync(join(dir, 'key.pub'), 'utf8').trim()}`, BOX_IMAGE);
  port = docker('port', box, '22/tcp').split('\n')[0].split(':').pop();
  for (let i = 0; i < 50 && spawnSync('ssh', ['-o', 'BatchMode=yes', '-i', join(dir, 'key'), '-p', port, 'root@127.0.0.1', 'true']).status !== 0; i++) await new Promise((r) => setTimeout(r, 200));
  env = { CLOUDY_CLOUD_CONFIG: join(dir, 'env'), CLOUDY_CLOUD_SSH_PORT: port };
});

after(() => {
  if (!ON) return;
  const ids = spawnSync('docker', ['ps', '-aq', '--filter', `label=cloudy-cloud.owner=${OWNER}`], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  if (ids.length) spawnSync('docker', ['rm', '-f', ...ids]);
  if (box) spawnSync('docker', ['rm', '-f', box]);
  spawnSync('docker', ['rmi', '-f', BOX_IMAGE]);
  if (!hadWorkerImage) spawnSync('docker', ['rmi', '-f', WORKER_IMAGE]);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('self-hosted end to end over ssh to a Docker box', { skip: !ON && 'set CLOUDY_CLOUD_IT_SSH=1 (needs Docker)', timeout: 30 * 60_000 }, async (t) => {
  const { runSetup, runDoctor } = await import('../src/self-hosted-setup.mjs');
  const { loadEnv } = await import('../src/config.mjs');
  const { createProvider } = await import('../src/providers/self-hosted.mjs');

  await t.test('setup checks the box, builds the image and saves the settings', async () => {
    const out = sink();
    const answers = `root@127.0.0.1\n${join(dir, 'key')}\n2\ny\n${TOKEN}\n`;
    const code = await runSetup({ env, input: Readable.from([answers]), out });
    assert.equal(code, 0, out.text);
    assert.ok(!out.text.includes(TOKEN));
    assert.match(out.text, /ok\s+Worker image: cloudy-cloud-worker:/);
    const saved = loadEnv(env);
    assert.equal(saved.CLOUDY_CLOUD_CONTAINER_RUNTIME, 'docker');
    assert.match(saved.CLOUDY_CLOUD_CONTAINER_BIN, /^\/.*docker$/);
    assert.equal(saved.CLOUDY_CLOUD_SELF_HOSTED_SLOTS, '2');
    assert.ok(Number(saved.CLOUDY_CLOUD_SELF_HOSTED_CPUS) >= 1 && /^\d+m$/.test(saved.CLOUDY_CLOUD_SELF_HOSTED_MEMORY));
    const d = sink();
    assert.equal(await runDoctor({ env: saved, out: d }), 0, d.text);
    console.log(`--- setup ---\n${out.text}--- doctor ---\n${d.text}`);
  });

  const p = createProvider(loadEnv(env));
  let s;
  await t.test('create, write, run, timeout, list; the token is only in the tmpfs env file', async () => {
    s = await p.create({ envs: { FOO: "it's $x" }, labels: { purpose: 'cloudy-cloud', owner: OWNER }, ttlSeconds: 600 });
    await s.files.write('/home/worker/d/a.txt', 'hello');
    assert.equal((await s.commands.run('cat d/a.txt; printf " %s" "$FOO"')).stdout, "hello it's $x");
    assert.equal((await s.commands.run('[ "$GH_TOKEN" = "$(cat /run/secrets/env | sed -n "s/^GH_TOKEN=.//p" | tr -d "\'")" ] && stat -c %a /run/secrets/env')).stdout.trim(), '600');
    assert.ok(!docker('inspect', s.id).includes(TOKEN), 'token visible in docker inspect');
    const t0 = Date.now();
    await assert.rejects(s.commands.run('sleep 30', { timeoutMs: 1000 }), (e) => e.code === 'timeout');
    assert.ok(Date.now() - t0 < 10_000);
    const rows = await p.list({ owner: OWNER });
    assert.deepEqual(rows.map((r) => [r.id, r.status]), [[s.id, 'running']]);
  });

  await t.test('forwardPort reaches a server inside the container', async () => {
    await s.commands.run(`nohup node -e "require('http').createServer((q,r)=>r.end('hi-from-worker')).listen(8000)" >/dev/null 2>&1 &`);
    await new Promise((r) => setTimeout(r, 1000));
    const local = await freePort();
    const ac = new AbortController();
    const done = p.forwardPort(s.id, `${local}:8000`, { signal: ac.signal });
    try {
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(await (await fetch(`http://127.0.0.1:${local}/`)).text(), 'hi-from-worker');
    } finally { ac.abort(); }
    assert.equal(await done, 0);
  });

  await t.test('delete removes it; a short TTL removes a container on its own', async () => {
    await p.delete(s.id);
    assert.deepEqual(await p.list({ owner: OWNER }), []);
    const short = await p.create({ envs: {}, labels: { purpose: 'cloudy-cloud', owner: OWNER }, ttlSeconds: 5 });
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) { await new Promise((r) => setTimeout(r, 1000)); gone = !(await p.list({ owner: OWNER })).some((r) => r.id === short.id); }
    assert.ok(gone, 'container with ttlSeconds 5 still there after 30 s');
  });
});
