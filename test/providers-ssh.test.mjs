import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { rmSync, statSync } from 'node:fs';
import { createSsh } from '../src/providers/ssh.mjs';

const ENV = { CLOUDY_CLOUD_SSH_HOST: 'me@box', CLOUDY_CLOUD_SSH_KEY: '/home/me/.ssh/id', CLOUDY_CLOUD_SSH_PORT: '2222' };

// A fake spawn: records each call; `script(child, call)` drives the fake ssh process.
function harness(script) {
  const calls = [];
  const dirs = [];
  const spawn = (bin, args, opts) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false });
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null, 'SIGTERM')); };
    const call = { bin, args, opts, stdin: '' };
    child.stdin.on('data', (d) => { call.stdin += d; });
    calls.push(call);
    setImmediate(() => script(child, call));
    return child;
  };
  const make = (env = ENV) => { const s = createSsh(env, { spawn }); dirs.push(s.dir); return s; };
  return { calls, make, cleanup: () => dirs.forEach((d) => d && rmSync(d, { recursive: true, force: true })) };
}
const exit = (child, code, out = '', err = '') => { if (out) child.stdout.write(out); if (err) child.stderr.write(err); child.emit('close', code, null); };
const decode = (args) => {
  const cmd = args.at(-1);
  const b64 = cmd.match(/printf %s ([A-Za-z0-9+/=]+) \| base64 -d/)[1];
  return Buffer.from(b64, 'base64').toString();
};

test('argv has the multiplexing options, host, key and port; command round-trips through base64', async () => {
  const h = harness((c) => exit(c, 0, 'ok'));
  try {
    const ssh = h.make();
    const text = `echo 'a "b"' $HOME; cat <<'X'\n$(x)\nX`;
    const r = await ssh.run(text);
    assert.deepEqual(r, { stdout: 'ok', stderr: '', exitCode: 0 });
    const { bin, args } = h.calls[0];
    assert.equal(bin, 'ssh');
    const joined = args.join(' ');
    for (const o of ['BatchMode=yes', 'ConnectTimeout=15', 'ControlMaster=auto', 'ControlPersist=10m', 'ServerAliveInterval=15']) assert.ok(joined.includes(`-o ${o}`), o);
    assert.match(joined, /-o ControlPath=\S+\/cc-%C/);
    assert.ok(args.includes('me@box'));
    assert.equal(args[args.indexOf('-i') + 1], '/home/me/.ssh/id');
    assert.equal(args[args.indexOf('-p') + 1], '2222');
    assert.equal(decode(args), text);
    assert.ok(!args.at(-1).includes('$HOME'), 'command text is not visible in argv');
    assert.equal(statSync(ssh.dir).mode & 0o777, 0o700);
  } finally { h.cleanup(); }
});

test('missing host throws no_key; host cannot look like an option', () => {
  assert.throws(() => createSsh({}, {}), (e) => e.code === 'no_key' && /Set CLOUDY_CLOUD_SSH_HOST \(user@host\) or run cloudy-cloud setup/.test(e.message));
  assert.throws(() => createSsh({ CLOUDY_CLOUD_SSH_HOST: '-oProxyCommand=x' }, {}), /invalid/);
});

test('env values other than the key path never appear in argv', async () => {
  const h = harness((c) => exit(c, 0));
  try {
    await h.make({ ...ENV, CLOUDY_CLOUD_GITHUB_TOKEN: 'sekrit', ANTHROPIC_API_KEY: 'sekrit2' }).run('true');
    assert.ok(!JSON.stringify(h.calls[0].args).includes('sekrit'));
  } finally { h.cleanup(); }
});

test('stdin arrives intact and stdout streams before the promise resolves', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness(async (c) => { c.stdout.write('one'); await gate; exit(c, 0, 'two'); });
  try {
    const chunks = [];
    const p = h.make().run('cat', { stdin: Buffer.from([0, 1, 2, 255, 10]), onStdout: (s) => chunks.push(s) });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(chunks, ['one']);
    release();
    const r = await p;
    assert.equal(r.stdout, 'onetwo');
    assert.equal(h.calls[0].stdin, Buffer.from([0, 1, 2, 255, 10]).toString());
  } finally { h.cleanup(); }
});

test('exit 255 is transient and names the host', async () => {
  const h = harness((c) => exit(c, 255, '', 'ssh: connect to host box port 22: Connection refused\n'));
  try {
    await assert.rejects(h.make().run('true'), (e) => e.code === 'transient' && /cannot reach me@box over ssh: .*Connection refused/.test(e.message));
  } finally { h.cleanup(); }
});

test('other non-zero exit rejects with exitCode, stdout, stderr', async () => {
  const h = harness((c) => exit(c, 3, 'o', 'e'));
  try {
    await assert.rejects(h.make().run('false'), (e) => e.exitCode === 3 && e.stdout === 'o' && e.stderr === 'e');
  } finally { h.cleanup(); }
});

test('timeoutMs is enforced on this side (macOS has no `timeout`): the ssh process is killed and the call rejects', async () => {
  const h = harness(() => {}); // never exits on its own
  try {
    const t0 = Date.now();
    await assert.rejects(h.make().run('sleep 99', { timeoutMs: 50 }), (e) => e.code === 'timeout' && /timed out after 1 s/.test(e.message));
    assert.ok(Date.now() - t0 < 1000);
    assert.match(h.calls[0].args.at(-1), /^sh -c /, 'no remote timeout command');
    const h2 = harness((c) => exit(c, 124)); // a remote exit 124 is just an exit code now
    await assert.rejects(h2.make().run('x', { timeoutMs: 5000 }), (e) => e.exitCode === 124 && e.code === undefined);
    h2.cleanup();
  } finally { h.cleanup(); }
});

test('abort kills the local ssh process; an already-aborted signal never spawns', async () => {
  const h = harness(() => {});
  try {
    const ac = new AbortController();
    const p = h.make().run('sleep 99', { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(p, (e) => e.name === 'AbortError');
    assert.ok(h.calls[0]);
    const pre = AbortSignal.abort();
    await assert.rejects(h.make().run('true', { signal: pre }), (e) => e.name === 'AbortError');
    assert.equal(h.calls.length, 1);
  } finally { h.cleanup(); }
});

test('spawn failure is transient; at most 8 sessions run at once', async () => {
  const bad = harness((c) => c.emit('error', Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })));
  try {
    await assert.rejects(bad.make().run('true'), (e) => e.code === 'transient');
  } finally { bad.cleanup(); }
  let live = 0, peak = 0;
  const h = harness((c) => { live++; peak = Math.max(peak, live); setTimeout(() => { live--; exit(c, 0); }, 10); });
  try {
    const ssh = h.make();
    await Promise.all(Array.from({ length: 20 }, () => ssh.run('true')));
    assert.equal(peak, 8);
  } finally { h.cleanup(); }
});
