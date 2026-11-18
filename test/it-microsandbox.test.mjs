// Opt-in integration test for the microsandbox provider: CLOUDY_CLOUD_IT_MSB=1 node --test test/it-microsandbox.test.mjs
// Needs `msb` installed (CLOUDY_CLOUD_MSB_BIN or on PATH) and the worker image loaded:
//   docker build --build-arg VERSION=<V> -t cloudy-cloud-worker:<V> - < docker/worker.Dockerfile
//   docker save cloudy-cloud-worker:<V> | msb load
// Uses only synthetic tokens. Everything it creates is removed in `after`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ON = process.env.CLOUDY_CLOUD_IT_MSB === '1';
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const BIN = process.env.CLOUDY_CLOUD_MSB_BIN || spawnSync('sh', ['-c', 'command -v msb'], { encoding: 'utf8' }).stdout.trim();
const OWNER = `it-${randomBytes(4).toString('hex')}`;
const GH = `cc-it-${randomBytes(12).toString('hex')}`; // synthetic; only checked for where it ends up
const IT_TOKEN = `cc-it-${randomBytes(12).toString('hex')}`;
const ECHO_HOST = process.env.CLOUDY_CLOUD_IT_ECHO || 'httpbin.org';
const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const msbRun = (...a) => spawnSync(BIN, a, { encoding: 'utf8' });
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

let provider;
const cleanup = () => {
  if (!ON || !BIN) return;
  const rows = JSON.parse(msbRun('ls', '--label', 'cloudy-cloud.purpose=cloudy-cloud', '--format', 'json').stdout || '[]');
  for (const r of rows) spawnSync(BIN, ['rm', '--force', r.name]);
};
after(() => {
  cleanup();
  const left = ON && BIN ? (msbRun('ls', '--label', 'cloudy-cloud.purpose=cloudy-cloud', '--format', 'json').stdout || '[]').trim() : '[]';
  assert.equal(left, '[]', `sandboxes left behind: ${left}`);
});

test('microsandbox end to end on this computer', { skip: !ON && 'set CLOUDY_CLOUD_IT_MSB=1 (needs msb)', timeout: 20 * 60_000 }, async (t) => {
  assert.ok(BIN, 'no msb: set CLOUDY_CLOUD_MSB_BIN');
  const { createProvider } = await import('../src/providers/microsandbox.mjs');
  provider = createProvider(
    { CLOUDY_CLOUD_MSB_BIN: BIN, GH_TOKEN: GH, CC_IT_TOKEN: IT_TOKEN },
    { secretHosts: { CC_IT_TOKEN: [ECHO_HOST] } },
  );
  const mk = (extra = {}) => provider.create({ envs: {}, labels: { purpose: 'cloudy-cloud', owner: OWNER }, ttlSeconds: 600, ...extra });

  await t.test('create; secrets reach only their hosts; the value is never on disk', async () => {
    const s = await mk({ secrets: ['CC_IT_TOKEN'] });
    try {
      const shown = (await s.commands.run('printf %s "$CC_IT_TOKEN"')).stdout;
      assert.notEqual(shown, IT_TOKEN, 'the guest saw the real value');
      assert.ok(shown.length > 0, 'no placeholder env reached the guest');
      const viaCurl = (await s.commands.run(`curl -sS https://${ECHO_HOST}/headers -H "Authorization: Bearer $CC_IT_TOKEN"`, { timeoutMs: 30_000 })).stdout;
      assert.ok(viaCurl.includes(IT_TOKEN), `host did not see the swapped value: ${viaCurl.slice(0, 300)}`);
      const viaNode = (await s.commands.run(`node -e "fetch('https://${ECHO_HOST}/headers',{headers:{authorization:'Bearer '+process.env.CC_IT_TOKEN}}).then(r=>r.text()).then(t=>console.log(t))"`, { timeoutMs: 30_000 })).stdout;
      assert.ok(viaNode.includes(IT_TOKEN), `node fetch did not see the swapped value: ${viaNode.slice(0, 300)}`);
      const grep = spawnSync('grep', ['-rF', IT_TOKEN, join(homedir(), '.microsandbox')], { encoding: 'utf8' });
      assert.notEqual(grep.status, 0, 'the token value is stored under ~/.microsandbox');
    } finally { await provider.delete(s.id); }
  });

  await t.test('files round-trip 1 MiB binary, owned by worker; commands: exit, timeout, cwd, user, onStdout', async () => {
    const s = await mk({ envs: { FOO: 'bar' } });
    try {
      const data = randomBytes(1024 * 1024);
      await s.files.write('/home/worker/big.bin', data);
      assert.equal(sha256(await s.files.read('/home/worker/big.bin')), sha256(data));
      assert.equal((await s.commands.run('stat -c %U /home/worker/big.bin')).stdout.trim(), 'worker');
      assert.equal((await s.commands.run('id -un')).stdout.trim(), 'worker');
      await assert.rejects(s.commands.run('exit 3'), (e) => e.exitCode === 3);
      await assert.rejects(s.commands.run('sleep 30', { timeoutMs: 1000 }), (e) => e.code === 'timeout');
      assert.equal((await s.commands.run('pwd', { cwd: '/tmp' })).stdout.trim(), '/tmp');
      const seen = [];
      const done = s.commands.run('echo early; sleep 1; echo late', { onStdout: (d) => seen.push([Date.now(), d]) });
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(seen.length >= 1 && seen[0][1].includes('early'), 'onStdout did not stream');
      await done;
    } finally { await provider.delete(s.id); }
  });

  await t.test('egress allowlist: an allowed host works, a denied one fails; default policy blocks metadata', async () => {
    const s = await mk({ egress: { allow: ['example.com'] } });
    try {
      assert.equal((await s.commands.run('curl -s -o /dev/null -w %{http_code} https://example.com --max-time 15', { timeoutMs: 30_000 })).stdout.trim(), '200');
      await assert.rejects(s.commands.run('curl -sS https://github.com --max-time 10', { timeoutMs: 30_000 }));
    } finally { await provider.delete(s.id); }
    const d = await mk();
    try {
      await assert.rejects(d.commands.run('curl -sS http://169.254.169.254 --max-time 5', { timeoutMs: 20_000 }), 'metadata address reachable');
      assert.equal((await d.commands.run('curl -s -o /dev/null -w %{http_code} https://example.com --max-time 15', { timeoutMs: 30_000 })).stdout.trim(), '200');
    } finally { await provider.delete(d.id); }
  });

  await t.test('TTL: a 60 s sandbox is gone or stopped after 100 s (settles hasServerTTL)', async () => {
    const s = await mk({ ttlSeconds: 60 });
    await new Promise((r) => setTimeout(r, 100_000));
    const row = (await provider.list({ owner: OWNER })).find((r) => r.id === s.id);
    if (row === undefined) console.log('hasServerTTL could be true: the sandbox was removed at its deadline');
    else console.log(`hasServerTTL is false: the deadline left the sandbox ${row.status}`);
    assert.ok(row === undefined || row.status !== 'running', `sandbox still running after its deadline: ${JSON.stringify(row)}`);
    await provider.delete(s.id); // remove the stopped sandbox if it stayed
  });

  await t.test('forwardPort reaches a guest HTTP server; abort resolves 0; shellArgv runs a command', async () => {
    const s = await mk();
    try {
      await s.commands.run(`nohup python3 -m http.server 8765 >/dev/null 2>&1 &`);
      await new Promise((r) => setTimeout(r, 1500));
      const lport = await freePort();
      const ac = new AbortController();
      const done = provider.forwardPort(s.id, `${lport}:8765`, { signal: ac.signal });
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch(`http://127.0.0.1:${lport}/`);
        assert.equal(res.status, 200);
      } finally { ac.abort(); }
      assert.equal(await done, 0);
      const argv = provider.shellArgv(s.id, ['echo', 'hi']);
      const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^hi$/m);
    } finally { await provider.delete(s.id); }
  });
});
