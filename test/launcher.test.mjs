import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const launcher = resolve('bin/cloudy-cloud');
const IBK = 'ibk_FAKEINSTABOXKEY0123456789';
const TOK = 'sk-ant-oat01-FAKECLAUDETOKEN0123';

// Runs the launcher with a stub `claude` that records its argv.
function run({ config, cwd }) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-launcher-'));
  const argvFile = join(dir, 'argv');
  const stub = join(dir, 'claude');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\n`);
  chmodSync(stub, 0o755);
  const cfg = join(dir, 'env');
  if (config !== undefined) writeFileSync(cfg, config);
  const env = { PATH: `${dir}:${process.env.PATH}`, HOME: dir, CLOUDY_CLOUD_CONFIG: cfg };
  const r = spawnSync('/bin/sh', [launcher], { cwd: cwd ?? dir, env, input: '', encoding: 'utf8' });
  return { ...r, started: existsSync(argvFile), argv: existsSync(argvFile) ? readFileSync(argvFile, 'utf8') : '', dir };
}

function repo(origin) {
  const d = mkdtempSync(join(tmpdir(), 'cc-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: d });
  return d;
}

const full = `INSTABOX_API_KEY=${IBK}\nCLAUDE_CODE_OAUTH_TOKEN=${TOK}\n`;

test('missing keys: points to install.sh, exits 1, never starts claude', () => {
  const r = run({ config: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not set up yet/);
  assert.match(r.stderr, /Run: cloudy-cloud setup/);
  assert.equal(r.started, false);
});

test('missing Claude token only: still stops with install.sh message', () => {
  const r = run({ config: `INSTABOX_API_KEY=${IBK}\n` });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Claude token/);
  assert.match(r.stderr, /cloudy-cloud setup/);
  assert.equal(r.started, false);
});

test('keys present: claude starts with expected flags and no secret in argv', () => {
  const r = run({ config: full, cwd: repo('https://github.com/test/repo.git') });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.started, true);
  assert.doesNotMatch(r.stderr, /warning/);
  for (const flag of ['--mcp-config', '--settings', '--append-system-prompt']) assert.ok(r.argv.includes(flag + '\n'), flag);
  assert.ok(!r.argv.includes(IBK) && !r.argv.includes(TOK));
});

test('not a git repo: warns on stderr and still starts', () => {
  const r = run({ config: full });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /not a git repository/);
  assert.equal(r.started, true);
});

test('non-GitHub origin: warns on stderr and still starts', () => {
  const r = run({ config: full, cwd: repo('https://example.com/x/y.git') });
  assert.match(r.stderr, /no github\.com origin/);
  assert.equal(r.started, true);
});

test('no origin at all: warns and still starts', () => {
  const r = run({ config: full, cwd: repo() });
  assert.match(r.stderr, /no github\.com origin/);
  assert.equal(r.started, true);
});

test('reached through a linked folder (as npm link installs it), the missing-keys message points to cloudy-cloud setup', () => {
  const linkDir = mkdtempSync(join(tmpdir(), 'cc-link-'));
  const pkg = join(linkDir, 'cloudy-cloud');
  symlinkSync(resolve('.'), pkg); // like <npm prefix>/lib/node_modules/cloudy-cloud -> the clone
  const dir = mkdtempSync(join(tmpdir(), 'cc-launcher-'));
  const r = spawnSync('/bin/sh', [join(pkg, 'bin/cloudy-cloud')], {
    cwd: dir, env: { PATH: process.env.PATH, HOME: dir, CLOUDY_CLOUD_CONFIG: join(dir, 'env') }, input: '', encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Run: cloudy-cloud setup/);
});

test('CLOUDY_CLOUD_EXTRA_PROMPT is appended to the launcher prompt, in one --append-system-prompt', () => {
  const d = repo('https://github.com/o/r.git');
  const dir = mkdtempSync(join(tmpdir(), 'cc-launcher-'));
  const argvFile = join(dir, 'argv');
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\n`);
  chmodSync(join(dir, 'claude'), 0o755);
  writeFileSync(join(dir, 'env'), full);
  const r = spawnSync('/bin/sh', [launcher, '-p'], { cwd: d, env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, CLOUDY_CLOUD_CONFIG: join(dir, 'env'), CLOUDY_CLOUD_EXTRA_PROMPT: 'EXTRA-RULES-HERE' }, input: '', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const argv = readFileSync(argvFile, 'utf8').split('\n');
  assert.equal(argv.filter((a) => a === '--append-system-prompt').length, 1);
  assert.match(argv[argv.indexOf('--append-system-prompt') + 1], /mcp__cloud__cloud_agent[\s\S]*EXTRA-RULES-HERE/);
});

test('cloudy-cloud setup and --setup run install.sh from any folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-setup-'));
  for (const n of ['git', 'npm', 'curl', 'claude']) { writeFileSync(join(dir, n), '#!/bin/sh\nexit 0\n'); chmodSync(join(dir, n), 0o755); }
  for (const flag of ['setup', '--setup']) {
    // --check-only is passed through to install.sh, which prints its step line and exits 0
    const r = spawnSync('/bin/sh', [launcher, flag, '--check-only'], { cwd: dir, env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\[1\/4\] Tools/);
  }
});

test('missing keys without a terminal: message and exit 1, no prompt', () => {
  const r = run({ config: '' });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /Run setup now/);
});
