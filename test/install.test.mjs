import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('install.sh');
const KEY = 'ibk_' + 'abcdefghij234567'.repeat(4).slice(0, 52);
const TOKEN = 'sk-ant-oat01-' + 'x'.repeat(95); // 108 characters
const tmp = () => mkdtempSync(join(tmpdir(), 'cc-install-'));
// Runs one function from install.sh in a fresh bash, without running main.
const fn = (code, args = [], env = {}) =>
  spawnSync('/bin/bash', ['-c', `. "${script}"; ${code}`, '_', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp(), ...env } });
const ok = (code, ...args) => fn(code, args).status === 0;

function stubDir(names, bodies = {}) {
  const dir = tmp();
  for (const n of names) {
    writeFileSync(join(dir, n), bodies[n] ?? '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, n), 0o755);
  }
  return dir;
}
const nodeStub = '#!/bin/sh\necho v22.1.0\n';
const all = ['git', 'node', 'npm', 'curl', 'claude'];

test('Instabox key format', () => {
  assert.ok(ok('valid_ibk "$1"', KEY));
  assert.ok(!ok('valid_ibk "$1"', KEY.slice(0, -1)));
  assert.ok(!ok('valid_ibk "$1"', KEY + 'a'));
  assert.ok(!ok('valid_ibk "$1"', KEY.toUpperCase()));
  assert.ok(!ok('valid_ibk "$1"', KEY.replace('ibk_', 'xyz_')));
  assert.ok(!ok('valid_ibk "$1"', 'ibk_' + '1'.repeat(52))); // 1 is not base32
});

test('Claude token prefix and length warning', () => {
  assert.ok(ok('valid_claude "$1"', TOKEN));
  assert.ok(!ok('valid_claude "$1"', 'sk-ant-api03-' + 'x'.repeat(95)));
  assert.ok(ok('claude_len_ok "$1"', TOKEN));
  assert.ok(!ok('claude_len_ok "$1"', TOKEN.slice(0, 100)));
  assert.ok(!ok('claude_len_ok "$1"', TOKEN + 'x'));
});

test('mask shows prefix and last four only', () => {
  const r = fn('mask ibk_ "$1"', [KEY]);
  assert.equal(r.stdout, 'ibk_…' + KEY.slice(-4));
  assert.ok(!r.stdout.includes(KEY.slice(5, 20)));
});

test('write_env is atomic, idempotent, private, and keeps other lines', () => {
  const dir = join(tmp(), 'cfg');
  const file = join(dir, 'env');
  const env = { CLAUDE_CLOUD_CONFIG: file };
  fn('write_env INSTABOX_API_KEY aaa', [], env);
  writeFileSync(file, readFileSync(file, 'utf8') + 'OTHER=keep me\nINSTABOX_API_KEY=duplicate\n', { mode: 0o600 });
  const r = fn('write_env INSTABOX_API_KEY "$1"; write_env INSTABOX_API_KEY "$1"; write_env CLAUDE_CODE_OAUTH_TOKEN "$2"', [KEY, TOKEN], env);
  assert.equal(r.status, 0, r.stderr);
  const lines = readFileSync(file, 'utf8').trim().split('\n').sort();
  assert.deepEqual(lines, [`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`, `INSTABOX_API_KEY=${KEY}`, 'OTHER=keep me']);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(dir), ['env']); // no temp file left
  assert.equal(r.stdout + r.stderr, ''); // nothing printed
});

test('refuses without a terminal', () => {
  const r = spawnSync('/bin/bash', [script], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /run it in a terminal: \.\/install\.sh/);
});

for (const missing of all) {
  test(`--check-only reports missing ${missing}`, () => {
    const dir = stubDir(all.filter((n) => n !== missing), { node: nodeStub });
    const r = spawnSync('/bin/bash', [script, '--check-only'], { encoding: 'utf8', env: { PATH: dir } });
    assert.equal(r.status, 1);
    const want = { git: /git is missing/, node: /Node\.js 20 or later is needed \(found none\)/, npm: /npm is missing/, curl: /curl is missing/, claude: /Claude Code is missing/ }[missing];
    assert.match(r.stdout, want);
  });
}

test('--check-only rejects old Node and passes with everything present', () => {
  const old = stubDir(all, { node: '#!/bin/sh\necho v18.2.0\n' });
  const r1 = spawnSync('/bin/bash', [script, '--check-only'], { encoding: 'utf8', env: { PATH: old } });
  assert.equal(r1.status, 1);
  assert.match(r1.stdout, /found v18\.2\.0/);
  const good = stubDir(all, { node: nodeStub });
  const r2 = spawnSync('/bin/bash', [script, '--check-only'], { encoding: 'utf8', env: { PATH: good } });
  assert.equal(r2.status, 0, r2.stdout);
});

test('CLAUDE_CLOUD_CONFIG is honoured and the default is under HOME', () => {
  assert.equal(fn('cfg', [], { CLAUDE_CLOUD_CONFIG: '/x/y' }).stdout, '/x/y');
  const home = tmp();
  assert.equal(fn('cfg', [], { HOME: home }).stdout, join(home, '.config/claude-cloud/env'));
});

test('http_code maps curl results and keeps the key out of argv', () => {
  for (const code of ['200', '401', '000']) {
    const dir = tmp();
    const log = join(dir, 'argv');
    const bin = stubDir(['curl'], { curl: `#!/bin/sh\necho "$@" >> "${log}"\ncat > "${dir}/stdin"\nprintf ${code}\n` });
    const r = fn('http_code "$1"', [KEY], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.stdout, code);
    assert.ok(!readFileSync(log, 'utf8').includes(KEY), 'key in argv');
    assert.ok(readFileSync(join(dir, 'stdin'), 'utf8').includes(KEY), 'key sent on stdin');
    assert.ok(!existsSync(join(dir, 'x')));
  }
});

test('optional provider key step: Enter skips and saves nothing; a pasted key is saved privately and masked', () => {
  const dir = tmp();
  const env = { CLAUDE_CLOUD_CONFIG: join(dir, 'env') };
  // read_secret reads /dev/tty, so run it under script(1)-free override: replace read_secret with a stub reading a variable.
  const run = (answer) => fn(`read_secret() { printf -v "$1" '%s' "${answer}"; }; setup_provider PARTICLE_API_KEY Particle.ai https://platform.particle.ai`, [], env);
  const skipped = run('');
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /Enter to skip/);
  assert.match(skipped.stdout, /Skipped Particle\.ai/);
  assert.ok(!existsSync(env.CLAUDE_CLOUD_CONFIG));
  const saved = run('pk-1234567890abcdef');
  assert.equal(saved.status, 0);
  assert.equal(readFileSync(env.CLAUDE_CLOUD_CONFIG, 'utf8'), 'PARTICLE_API_KEY=pk-1234567890abcdef\n');
  assert.ok(!saved.stdout.includes('pk-1234567890abcdef'));
  assert.match(saved.stdout, /…cdef/);
  assert.equal(statSync(env.CLAUDE_CLOUD_CONFIG).mode & 0o777, 0o600);
});
