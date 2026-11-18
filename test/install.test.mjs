import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, existsSync, symlinkSync, readlinkSync, mkdirSync, lstatSync, rmSync, renameSync } from 'node:fs';
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

test('Claude token prefix', () => {
  assert.ok(ok('valid_claude "$1"', TOKEN));
  assert.ok(!ok('valid_claude "$1"', 'sk-ant-api03-' + 'x'.repeat(95)));
});

test('mask shows prefix and last four only', () => {
  const r = fn('mask ibk_ "$1"', [KEY]);
  assert.equal(r.stdout, 'ibk_…' + KEY.slice(-4));
  assert.ok(!r.stdout.includes(KEY.slice(5, 20)));
});

test('write_env is atomic, idempotent, private, and keeps other lines', () => {
  const dir = join(tmp(), 'cfg');
  const file = join(dir, 'env');
  const env = { CLOUDY_CLOUD_CONFIG: file };
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

test('refuses without a terminal from an npm install, naming cloudy-cloud setup', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cc-npm-')), 'node_modules', 'cloudycloud');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'install.sh'), readFileSync(script));
  const r = spawnSync('/bin/bash', [join(dir, 'install.sh')], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /run it in a terminal: cloudy-cloud setup/);
  assert.doesNotMatch(r.stdout + r.stderr, /\.\/install\.sh/);
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
  assert.equal(r2.status, 1, r2.stdout); // tools pass; no keys are saved, so the verdict fails
  assert.match(r2.stdout, /git, node|\[1\/4\] Tools[\s\S]*Check failed/);
});

test('CLOUDY_CLOUD_CONFIG is honoured and the default is under HOME', () => {
  assert.equal(fn('cfg', [], { CLOUDY_CLOUD_CONFIG: '/x/y' }).stdout, '/x/y');
  const home = tmp();
  assert.equal(fn('cfg', [], { HOME: home }).stdout, join(home, '.config/cloudy-cloud/env'));
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
  const env = { CLOUDY_CLOUD_CONFIG: join(dir, 'env') };
  // read_secret reads /dev/tty, so run it under script(1)-free override: replace read_secret with a stub reading a variable.
  const run = (answer) => fn(`read_secret() { printf -v "$1" '%s' "${answer}"; }; setup_provider PARTICLE_API_KEY Particle.ai https://platform.particle.ai`, [], env);
  const skipped = run('');
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /Enter to skip/);
  assert.match(skipped.stdout, /Skipped Particle\.ai/);
  assert.ok(!existsSync(env.CLOUDY_CLOUD_CONFIG));
  const saved = run('pk-1234567890abcdef');
  assert.equal(saved.status, 0);
  assert.equal(readFileSync(env.CLOUDY_CLOUD_CONFIG, 'utf8'), 'PARTICLE_API_KEY=pk-1234567890abcdef\n');
  assert.ok(!saved.stdout.includes('pk-1234567890abcdef'));
  assert.match(saved.stdout, /…cdef/);
  assert.equal(statSync(env.CLOUDY_CLOUD_CONFIG).mode & 0o777, 0o600);
});

// ---- paste handling, live check, capture, coordinators ----
const ESC = '\u001b';
const out1 = (r) => r.stdout.trim();

test('clean_paste removes whitespace, CR/LF and escape sequences', () => {
  const r = fn('clean_paste "$1"', [`${ESC}[200~ab c\r\nde\tf${ESC}[201~${ESC}[2K\n`]);
  assert.equal(r.stdout, 'abcdef');
  assert.equal(fn('clean_paste "$1"', ['[200~xy[201~']).stdout, 'xy'); // ESC already dropped
});

test('parse_claude finds the token in labels, exports and quotes', () => {
  for (const raw of [TOKEN, `export CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`, `"${TOKEN}"`, `Your token: ${TOKEN.slice(0, 50)}\n${TOKEN.slice(50)}\n`]) {
    assert.equal(out1(fn('parse_claude "$1" >/dev/null && printf %s "$PARSED"', [raw])), TOKEN);
  }
});

test('parse_claude: cut off and wrong shape messages never echo the value', () => {
  const short = fn('parse_claude "$1"', [TOKEN.slice(0, 103)]);
  assert.match(short.stdout, /Got 103 of 108 characters, so it looks cut off\.\s+Copy the whole token again; it may wrap onto two lines, which is fine to paste\./);
  const wrong = fn('parse_claude "$1"', ['sk-ant-api03-SECRETSECRETSECRET']);
  assert.match(wrong.stdout, /should start with sk-ant-oat01-/);
  assert.ok(!wrong.stdout.includes('SECRET'));
  assert.equal(wrong.status, 1);
});

test('parse_ibk extracts, and explains cut off, wrong shape and the once-only dashboard key', () => {
  assert.equal(out1(fn('parse_ibk "$1" >/dev/null && printf %s "$PARSED"', [`"${KEY}"`])), KEY);
  assert.equal(out1(fn('parse_ibk "$1" >/dev/null && printf %s "$PARSED"', [`export INSTABOX_API_KEY=${KEY}`])), KEY);
  const short = fn('parse_ibk "$1"', [KEY.slice(0, 40)]);
  assert.match(short.stdout, /Got 40 of 56 characters, so it looks cut off/);
  assert.match(short.stdout, /shows a key only once/);
  const bad = fn('parse_ibk "$1"', ['ibk_' + 'ABCDEFGH1234567890'.repeat(3)]);
  assert.match(bad.stdout, /starts like an Instabox key \(ibk_ABCD…7890\)/);
  const other = fn('parse_ibk "$1"', ['ghp_SECRETSECRETSECRETSECRET']);
  assert.ok(!other.stdout.includes('SECRET'));
  assert.match(other.stdout, /should start with ibk_/);
});

// A stub claude: logs argv and the token it saw; behaviour comes from files in its folder.
function claudeStub(extra = {}) {
  const dir = tmp();
  const body = `#!/bin/sh
echo "$@" >> "${dir}/argv"
case "$1" in
  auth) echo '{"email":"me@example.com"}'; exit 0 ;;
  setup-token) [ -f "${dir}/setup-out" ] && cat "${dir}/setup-out"; exit 0 ;;
esac
echo "$CLAUDE_CODE_OAUTH_TOKEN" >> "${dir}/seen"
[ -f "${dir}/sleep" ] && sleep 5
if [ -f "${dir}/fail" ]; then cat "${dir}/fail"; exit 1; fi
echo ok
`;
  writeFileSync(join(dir, 'claude'), body); chmodSync(join(dir, 'claude'), 0o755);
  for (const [k, v] of Object.entries(extra)) writeFileSync(join(dir, k), v);
  return dir;
}
const withPath = (dir, more = {}) => ({ PATH: `${dir}:${process.env.PATH}`, ...more });

test('claude_check: ok, rejected, no network and timeout; token only in the environment', () => {
  const d = claudeStub();
  let r = fn('claude_check "$1"', [TOKEN], withPath(d));
  assert.equal(out1(r), 'ok');
  assert.match(readFileSync(join(d, 'argv'), 'utf8'), /^-p --model haiku Reply with ok$/m);
  assert.ok(!readFileSync(join(d, 'argv'), 'utf8').includes(TOKEN));
  assert.equal(readFileSync(join(d, 'seen'), 'utf8').trim(), TOKEN);
  const bad = claudeStub({ fail: '401 invalid authentication credentials\n' });
  assert.match(out1(fn('claude_check "$1"', [TOKEN], withPath(bad))), /^fail 401 invalid/);
  const net = claudeStub({ fail: 'getaddrinfo ENOTFOUND api.anthropic.com\n' });
  assert.match(out1(fn('claude_check "$1"', [TOKEN], withPath(net))), /^unrun /);
  const slow = claudeStub({ sleep: '1' });
  assert.match(out1(fn('claude_check "$1"', [TOKEN], withPath(slow, { CLOUDY_CLOUD_CHECK_SECONDS: '1' }))), /^unrun it took longer than 1 seconds/);
});

test('capture_token extracts a wrapped, escaped token and always deletes the temp file', () => {
  const t = tmp();
  const script = (body) => fn(`run_setup_token() { printf '%b' "$SETUP" > "$1"; }; ${body}`, [], { TMPDIR: t, SETUP: `${ESC}[2Kyour token:\\r\\n${ESC}[1m${TOKEN}${ESC}[0m\\r\\nStore it safely\\r\\n` });
  const r = script('capture_token');
  assert.equal(r.stdout, TOKEN);
  assert.deepEqual(readdirSync(t), []);
  const wrapped = fn(`run_setup_token() { printf '%s\\n%s\\n' "${TOKEN.slice(0, 80)}" "${TOKEN.slice(80)}" > "$1"; }; capture_token`, [], { TMPDIR: t });
  assert.equal(wrapped.status, 1);
  assert.match(wrapped.stderr, /gave only 80 of 108/);
  const none = fn(`run_setup_token() { echo nothing > "$1"; }; capture_token`, [], { TMPDIR: t });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /Could not find a token/);
  assert.deepEqual(readdirSync(t), []);
  // Ctrl-C path: the exit trap calls cleanup_capture
  const c = fn(`CAPTURE_FILE=$(mktemp); trap cleanup_capture EXIT; exit 130`, [], { TMPDIR: t });
  assert.equal(c.status, 130);
  assert.deepEqual(readdirSync(t), []);
});

// A stub folder with bin/cloudy-cloud and an npx that records its calls.
function coordStub({ imageOut = 'Image machine img-1 is ready and cloudy-cloud is installed on it.', sshFail = false, saveFail = false } = {}) {
  const dir = tmp();
  const root = join(dir, 'root'); const bin = join(root, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'cloudy-cloud'), `#!/bin/sh\necho "cc $@" >> "${dir}/calls"\ncase "$*" in\n *--save*) ${saveFail ? 'echo save failed; exit 1' : 'echo saved'} ;;\n *) echo "${imageOut}" ;;\nesac\n`);
  chmodSync(join(bin, 'cloudy-cloud'), 0o755);
  writeFileSync(join(dir, 'npx'), `#!/bin/sh\necho "npx $@" >> "${dir}/calls"\ncase "$*" in\n *"auth login"*) ${sshFail ? 'exit 1' : 'exit 0'} ;;\n *"auth status"*) echo '{"email":"coord@example.com"}' ;;\nesac\n`);
  chmodSync(join(dir, 'npx'), 0o755);
  return { dir, root };
}
import { execFileSync } from 'node:child_process';

test('coordinators: skipped on N; full flow signs in on the machine, saves, and records the account', () => {
  const s = coordStub();
  const cfg = join(tmp(), 'env');
  const skip = fn(`yn() { return 1; }; setup_coordinators "$1"; echo "$STATUS_COORD"`, [s.root], { CLOUDY_CLOUD_CONFIG: cfg });
  assert.equal(out1(skip), 'not set up');
  assert.ok(!existsSync(join(s.dir, 'calls')));
  const r = fn(`yn() { return 0; }; setup_coordinators "$1"; echo "$STATUS_COORD"`, [s.root], withPath(s.dir, { CLOUDY_CLOUD_CONFIG: cfg }));
  assert.match(r.stdout, /ready \(coord@example\.com\)/);
  const calls = readFileSync(join(s.dir, 'calls'), 'utf8');
  assert.match(calls, /npx --yes instabox@latest ssh img-1 -- -t claude auth login/);
  assert.match(calls, /coordinator image --save/);
  assert.match(readFileSync(cfg, 'utf8'), /CLOUDY_CLOUD_SNAPSHOT_ACCOUNT=coord@example\.com/);
});

// The coordinator step of main, run on an npm-style root (inside node_modules, no .git) with a git stub that logs its calls.
test('coordinators from an npm install: the step is offered, never says it needs a clone, and makes no git call', () => {
  const s = coordStub();
  const root = join(s.dir, 'node_modules/cloudycloud');
  mkdirSync(join(s.dir, 'node_modules'), { recursive: true });
  renameSync(s.root, root);
  writeFileSync(join(s.dir, 'git'), `#!/bin/sh\necho "git $@" >> "${s.dir}/gitcalls"\n`);
  chmodSync(join(s.dir, 'git'), 0o755);
  const cfg = join(tmp(), 'env');
  const r = fn(`PROVIDER=instabox; yn() { echo "ASKED: $1"; return 0; }; offer_coordinators "$1"; echo "$STATUS_COORD"`, [root], withPath(s.dir, { CLOUDY_CLOUD_CONFIG: cfg }));
  assert.match(r.stdout, /ASKED: Set up cloud coordinators/);
  assert.match(r.stdout, /ready \(coord@example\.com\)/);
  assert.doesNotMatch(r.stdout + r.stderr, /needs a git clone|from a clone/);
  assert.ok(!existsSync(join(s.dir, 'gitcalls')), 'no git call on the package root');
});

test('coordinators: a failed sign-in removes the image machine and says how to retry', () => {
  const s = coordStub({ sshFail: true });
  const r = fn(`yn() { return 0; }; setup_coordinators "$1"; echo "$STATUS_COORD"`, [s.root], withPath(s.dir, { CLOUDY_CLOUD_CONFIG: join(tmp(), 'env') }));
  assert.match(r.stdout, /failed \(run (cloudy-cloud setup|\.\/install\.sh) again\)/);
  assert.match(readFileSync(join(s.dir, 'calls'), 'utf8'), /npx --yes instabox@latest rm --yes img-1/);
  assert.ok(!/--save/.test(readFileSync(join(s.dir, 'calls'), 'utf8')));
});

// ---- the real script through a pty ----
const pty = (spec) => {
  const r = spawnSync('python3', [resolve('test/pty_run.py'), JSON.stringify({ timeout: 60, ...spec })], { encoding: 'utf8' });
  const m = r.stdout.match(/EXIT:(\d+)\s*$/);
  return { text: r.stdout, code: m ? Number(m[1]) : -1 };
};

// The first question of every run: Enter keeps the default, Instabox.
const WHERE = ['Where should subagents run', '\n'];
const AGENTS = ['Which agents do you run', 'claude\n']; // the agent question: this suite's default is the Claude flow
function rig({ saved = '', claudeExtra = {}, githubState = 'yes' } = {}) {
  const cl = claudeStub(claudeExtra);
  const cfgDir = tmp(); const cfg = join(cfgDir, 'env');
  if (saved) writeFileSync(cfg, saved, { mode: 0o600 });
  const claudeSecret = '{"name":"CLAUDE_CODE_OAUTH_TOKEN","hosts":["api.anthropic.com"]}';
  const secrets = githubState === 'yes' ? `[{"name":"GH_TOKEN","hosts":["github.com","api.github.com"]},${claudeSecret}]` : `[${claudeSecret}]`;
  writeFileSync(join(cl, 'curl'), `#!/bin/sh\ncat >/dev/null\ncase "$*" in\n *"-w"*) printf 200 ;;\n *secrets*) echo '${secrets}' ;;\n *) echo '[{"id":"o1","personal":true}]' ;;\nesac\n`);
  writeFileSync(join(cl, 'npm'), '#!/bin/sh\n[ "$1" = prefix ] && echo /nowhere\nexit 0\n');
  writeFileSync(join(cl, 'npx'), '#!/bin/sh\nexit 0\n');
  for (const n of ['curl', 'npm', 'npx']) chmodSync(join(cl, n), 0o755);
  symlinkSync(resolve('bin/cloudy-cloud'), join(cl, 'cloudy-cloud'));
  const tdir = tmp();
  const env = { PATH: `${cl}:${process.env.PATH}`, HOME: tdir, TMPDIR: tdir, CLOUDY_CLOUD_CONFIG: cfg, TERM: 'xterm', NO_COLOR: '1' };
  const run = (steps) => pty({ cmd: ['/bin/bash', script], env, steps: [WHERE, AGENTS, ...steps] });
  return { cl, cfg, tdir, run, env };
}
const P_IB = ['Paste it', null]; // placeholders, built per test
const tail = [['Replace it\\? \\[y/N\\]', 'n\n'], ['Paste it', '\n'], ['Paste it', '\n'], ['cloud coordinators.*\\[y/N\\]', 'n\n']];
const MOVE = ['Move CLAUDE_CODE_OAUTH_TOKEN into', 'n\n']; // saved Claude token in the env file: decline moving it, so the old flow is unchanged
const savedBoth = `INSTABOX_API_KEY=${KEY}\nCLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`;

test('pty: a two-line paste gives the full token; live check runs; token is not in argv', () => {
  const g = rig();
  const r = g.run([['Paste it', KEY + '\n'], ['Enter, or paste', TOKEN.slice(0, 60) + '\n' + TOKEN.slice(60) + '\n'], ...tail]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /\[1\/4\] Tools/);
  assert.match(r.text, /Claude token works/);
  assert.match(r.text, /this uses a very small amount of Claude usage/);
  const cfg = readFileSync(g.cfg, 'utf8');
  assert.ok(!cfg.includes(TOKEN), r.text); // the token went to an Instabox secret, not the env file
  assert.ok(cfg.includes('CLOUDY_CLOUD_PROXY_SECRETS=CLAUDE_CODE_OAUTH_TOKEN\n'));
  assert.ok(cfg.includes(`INSTABOX_API_KEY=${KEY}\n`));
  assert.ok(cfg.includes('CLOUDY_CLOUD_TOKEN_ACCOUNT=me@example.com'));
  assert.equal(statSync(g.cfg).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(g.cl, 'argv'), 'utf8').includes(TOKEN));
  assert.equal(readFileSync(join(g.cl, 'seen'), 'utf8').split('\n')[0], TOKEN);
  assert.ok(!r.text.includes(TOKEN) && !r.text.includes(KEY)); // nothing secret on screen
  assert.match(r.text, /Summary[\s\S]*Instabox key\s+OK[\s\S]*Claude token\s+OK[\s\S]*Coordinators\s+not set up/);
});

test('pty: pasted export lines and quoted values work', () => {
  const g = rig();
  const r = g.run([['Paste it', `"${KEY}"\n`], ['Enter, or paste', `export CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`], ...tail]);
  assert.equal(r.code, 0, r.text);
  assert.match(readFileSync(g.cfg, 'utf8'), /CLOUDY_CLOUD_PROXY_SECRETS=CLAUDE_CODE_OAUTH_TOKEN\n/);
  assert.match(readFileSync(g.cfg, 'utf8'), new RegExp(`INSTABOX_API_KEY=${KEY}\\n`));
});

test('pty: a bracketed-paste-wrapped value works', () => {
  const g = rig();
  const r = g.run([['Paste it', `${ESC}[200~${KEY}${ESC}[201~\n`], ['Enter, or paste', `${ESC}[200~${TOKEN}${ESC}[201~\n`], ...tail]);
  assert.equal(r.code, 0, r.text);
  assert.match(readFileSync(g.cfg, 'utf8'), /CLOUDY_CLOUD_PROXY_SECRETS=CLAUDE_CODE_OAUTH_TOKEN\n/);
});

test('pty: leftover input cannot answer a [y/N] question', () => {
  const r = pty({ cmd: ['/bin/bash', '-c', `sleep 0.5; . "${script}"; yn "Q?" && echo ANSWER-YES || echo ANSWER-NO`], env: { PATH: process.env.PATH, HOME: tmp() }, steps: [['', 'yes\n'], ['Q\\?', 'n\n']] });
  assert.match(r.text, /ANSWER-NO/);
  assert.ok(!/ANSWER-YES/.test(r.text), r.text);
});

test('pty: a short token says it is cut off, asks no [y/N], and saves nothing', () => {
  const g = rig({ saved: `INSTABOX_API_KEY=${KEY}\n` });
  const r = g.run([['Replace it\\? \\[y/N\\]', 'n\n'], ['Enter, or paste', TOKEN.slice(0, 103) + '\n'], ['Paste the token', '\n']]);
  assert.match(r.text, /Got 103 of 108 characters, so it looks cut off/);
  assert.ok(!/Save it anyway/.test(r.text));
  assert.equal(r.code, 1);
  assert.ok(!readFileSync(g.cfg, 'utf8').includes('CLAUDE_CODE_OAUTH_TOKEN'));
});

test('pty: three bad tries stop the step cleanly and keep the saved token', () => {
  const g = rig({ saved: savedBoth });
  const bad = TOKEN.slice(0, 90);
  const r = g.run([['Replace it\\? \\[y/N\\]', 'n\n'], MOVE, ['Replace it\\? \\[y/N\\]', 'y\n'], ['Enter, or paste', bad + '\n'], ['Paste the token', bad + '\n'], ['Paste the token', bad + '\n'], ...tail]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Stopped the Claude step after 3 tries\. Your saved token is unchanged\. Run .* again to retry\./);
  assert.equal(readFileSync(g.cfg, 'utf8'), savedBoth);
});

test('pty: Enter keeps the saved token', () => {
  const g = rig({ saved: savedBoth });
  const r = g.run([['Replace it\\? \\[y/N\\]', 'n\n'], MOVE, ['Replace it\\? \\[y/N\\]', 'y\n'], ['Enter, or paste', '\n'], ['Paste the token', '\n'], ...tail]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Kept the saved token/);
  assert.equal(readFileSync(g.cfg, 'utf8'), savedBoth);
});

test('pty: a rejected token is retried at most 3 times and not saved', () => {
  const g = rig({ saved: `INSTABOX_API_KEY=${KEY}\n`, claudeExtra: { fail: '401 invalid authentication\n' } });
  const r = g.run([['Replace it\\? \\[y/N\\]', 'n\n'], ['Enter, or paste', TOKEN + '\n'], ['Paste the token', TOKEN + '\n'], ['Paste the token', TOKEN + '\n'], ['Paste it', '\n'], ['Paste it', '\n'], ['cloud coordinators.*\\[y/N\\]', 'n\n']]);
  assert.match(r.text, /Claude rejected this token: 401 invalid authentication/);
  assert.match(r.text, /Stopped the Claude step after 3 tries\. No token is saved/);
  assert.ok(!readFileSync(g.cfg, 'utf8').includes('CLAUDE_CODE_OAUTH_TOKEN'));
  assert.ok(!readFileSync(join(g.cl, 'argv'), 'utf8').includes(TOKEN));
});

test('pty: pressing Enter gets the token from claude setup-token, with no copying and no temp file left', () => {
  const g = rig({ saved: `INSTABOX_API_KEY=${KEY}\n`, claudeExtra: { 'setup-out': `Open the browser...\n${ESC}[2K\nYour token:\n${TOKEN}\nStore it safely\n` } });
  const r = g.run([['Replace it\\? \\[y/N\\]', 'n\n'], ['Enter, or paste', '\n'], ...tail]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Claude token works/);
  assert.match(readFileSync(g.cfg, 'utf8'), /CLOUDY_CLOUD_PROXY_SECRETS=CLAUDE_CODE_OAUTH_TOKEN\n/);
  assert.deepEqual(readdirSync(g.tdir).filter((f) => !f.startsWith('.')), []);
});

// ---- how it looks ----
const UI_ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: undefined };
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/;
function uiRig(opts, env = {}) {
  const g = rig(opts);
  const e = { PATH: `${g.cl}:${process.env.PATH}`, HOME: g.tdir, TMPDIR: g.tdir, CLOUDY_CLOUD_CONFIG: g.cfg, ...UI_ENV, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return { ...g, env: e, run: (steps, extra = {}) => pty({ cmd: ['/bin/bash', script], env: e, steps: [WHERE, AGENTS, ...steps], ...extra }) };
}
const answers = [['Replace it\\?.*\\[y/N\\]', 'n\n'], MOVE, ['Replace it\\?.*\\[y/N\\]', 'n\n'], ['Replace it\\?.*\\[y/N\\]', 'n\n'], ['Paste it', '\n'], ['Paste it', '\n'], ['cloud coordinators.*\\[y/N\\]', 'n\n']];
const NOANIM = { CLOUDY_CLOUD_NO_ANIMATION: '1' };

test('piped output has no escape sequences and uses ASCII marks', () => {
  const r = spawnSync('/bin/bash', ['-c', `. "${script}"; ok "Done" "detail"; warn "Careful"; bad "Broke"; hint "Try this"; step 2 Claude; box_open Summary; box_row "$C_OK" "$M_OK" "Label" "value"; box_close; banner`],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp(), LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
  assert.ok(!ANSI.test(r.stdout), JSON.stringify(r.stdout));
  assert.match(r.stdout, /\[ok\] Done  detail/);
  assert.match(r.stdout, /! Careful/);
  assert.match(r.stdout, /\[x\] Broke/);
  assert.match(r.stdout, /\[2\/4\] Claude/);
  assert.ok(!/[✔✖▲›╭│]/.test(r.stdout));
});

test('pty: NO_COLOR and TERM=dumb turn styling off even on a terminal', () => {
  for (const extra of [{ NO_COLOR: '1' }, { TERM: 'dumb' }, { CLICOLOR: '0' }]) {
    const g = uiRig({ saved: savedBoth }, { ...NOANIM, ...extra });
    const r = g.run(answers);
    assert.equal(r.code, 0, r.text);
    assert.ok(!ANSI.test(r.text.replace(/\u001b\[2K/g, '')), JSON.stringify(extra) + JSON.stringify(r.text.slice(0, 300)));
    assert.match(r.text, /\[1\/4\] Tools/);
  }
});

test('pty: on a terminal the output is styled, fits 80 columns, and the flow still works', () => {
  const g = uiRig({ saved: savedBoth }, NOANIM);
  const r = g.run(answers, { cols: 80 });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /\u001b\[38;5;\d+m/); // 256-colour accent
  const plain = r.text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  assert.match(plain, /✔ git, node/);
  assert.match(plain, /╭─ Summary ─+╮/);
  assert.match(plain, /╭─ Next ─+╮/);
  assert.match(plain, /●━━○━━○━━○ {2}Tools/);
  for (const l of plain.split('\n')) if (/[│╭╰]/.test(l)) assert.ok([...l.replace(/\r/g, '')].length <= 80, `box line too wide: ${l}`);
  assert.ok(!r.text.includes(TOKEN) && !r.text.includes(KEY));
  assert.equal(readFileSync(g.cfg, 'utf8'), savedBoth);
});

test('pty: the spinner leaves no stray characters and shows the result line', () => {
  const g = uiRig({}, NOANIM);
  const r = pty({ cmd: ['/bin/bash', '-c', `. "${script}"; spin_start "Waiting a bit"; sleep 1; spin_stop; ok "Finished" "$SPIN_T"; echo END`], env: g.env, steps: [] });
  assert.match(r.text, /Waiting a bit/);
  assert.match(r.text, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  const last = r.text.split('\r').pop();
  assert.match(last, /\u001b\[K\u001b\[\?25h/);
  assert.match(r.text, /Finished {2}\u001b\[[0-9;]*m1s/); // elapsed time
  assert.match(r.text, /✔[^\n]*Finished/);
  assert.ok(r.text.lastIndexOf('\u001b[?25h') > r.text.lastIndexOf('\u001b[?25l'));
});

test('pty: Ctrl-C during a spinner restores the cursor and terminal echo', () => {
  const g = uiRig({}, NOANIM);
  const wrapper = `trap : INT; /bin/bash -c '. "${script}"; trap "ui_cleanup; stty echo" EXIT; trap "exit 130" INT; spin_start "Working"; sleep 20' ; echo; echo "ECHO:$(stty -a | tr ' ' '\\n' | grep -x -e '-*echo' | head -1)"`;
  const r = pty({ cmd: ['/bin/bash', '-c', wrapper], env: g.env, steps: [['Working', '\u0003']] });
  assert.ok(r.text.lastIndexOf('\u001b[?25h') > r.text.lastIndexOf('\u001b[?25l'), JSON.stringify(r.text));
  assert.match(r.text, /ECHO:echo/);
});

test('animation: skipped without a terminal, with NO_COLOR, CI or CLOUDY_CLOUD_NO_ANIMATION', () => {
  const piped = spawnSync('/bin/bash', ['-c', `. "${script}"; banner`], { encoding: 'utf8', env: { PATH: process.env.PATH, ...UI_ENV, HOME: tmp() } });
  assert.equal(piped.stdout, 'Cloudy Cloud setup\nChecks your tools, links the command and saves your keys.\n');
  for (const extra of [{ NO_COLOR: '1' }, { CI: '1' }, { CLOUDY_CLOUD_NO_ANIMATION: '1' }]) {
    const r = pty({ cmd: ['/bin/bash', '-c', `. "${script}"; banner`], env: { PATH: process.env.PATH, HOME: tmp(), ...UI_ENV, ...extra }, steps: [] });
    assert.ok(!r.text.includes('\u001b[?25l'), JSON.stringify(extra)); // no cursor hiding means no animation
    assert.ok(r.text.includes('Cloudy Cloud') || r.text.includes('cloudy-cloud') || r.text.includes('█▀▀'), r.text);
  }
});

test('animation: plays on a terminal and the cursor is shown again afterwards', () => {
  const g = uiRig({});
  const r = pty({ cmd: ['/bin/bash', '-c', `. "${script}"; banner; echo END`], env: g.env, steps: [] });
  assert.ok(r.text.includes('\u001b[?25l'));
  assert.ok(r.text.lastIndexOf('\u001b[?25h') > r.text.lastIndexOf('\u001b[?25l'));
  assert.ok((r.text.match(/\u001b\[6A/g) || []).length >= 10, 'frames redraw in place');
  assert.match(r.text, /END/);
});

test('animation: Ctrl-C restores the cursor and echo', () => {
  const g = uiRig({});
  const wrapper = `trap : INT; /bin/bash -c '. "${script}"; trap "ui_cleanup; stty echo" EXIT; trap "exit 130" INT; banner; sleep 5'; echo; echo "ECHO:$(stty -a | tr ' ' '\\n' | grep -x -e '-*echo' | head -1)"`;
  const r = pty({ cmd: ['/bin/bash', '-c', wrapper], env: g.env, steps: [['\\?25l', '\u0003']] });
  assert.ok(r.text.lastIndexOf('\u001b[?25h') > r.text.lastIndexOf('\u001b[?25l'), JSON.stringify(r.text));
  assert.match(r.text, /ECHO:echo/);
});

test('animation: a key pressed during it skips it and does not reach the first prompt', () => {
  const g = uiRig({ saved: savedBoth });
  const r = pty({ cmd: ['/bin/bash', script], env: g.env, steps: [['\\?25l', 'yy'], WHERE, AGENTS, ['Replace it\\?.*\\[y/N\\]', 'n\n'], MOVE, ['Replace it\\?.*\\[y/N\\]', 'n\n'], ['Replace it\\?.*\\[y/N\\]', 'n\n'], ['Paste it', '\n'], ['Paste it', '\n'], ['cloud coordinators.*\\[y/N\\]', 'n\n']] });
  assert.equal(r.code, 0, r.text);
  assert.ok(!/create one at|Create one at/.test(r.text), 'the y reached the Replace prompt'); // a leaked y would have said yes
  assert.equal(readFileSync(g.cfg, 'utf8'), savedBoth);
  assert.match(r.text, /Summary/);
});

test('mask_token hides the token, passes prompts straight through, and handles a token split across writes', () => {
  const head = TOKEN.slice(0, 30), rest = TOKEN.slice(30);
  const r = fn(`{ printf 'Open https://x.test/a\\nPaste code > '; sleep 1; printf 'Your token: ${head}'; sleep 1; printf '${rest}\\ndone\\n'; } | mask_token`, [], {});
  const out = r.stdout ?? String(r);
  assert.ok(!out.includes(TOKEN) && !out.includes(rest), 'token hidden');
  assert.match(out, /https:\/\/x\.test\/a/);
  assert.match(out, /Paste code > /);
  assert.match(out, /sk-ant-oat01-\(hidden\)/);
  assert.match(out, /done/);
});

test('link_skill links the fleet skill, and leaves an existing real folder alone', () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-home-'));
  fn(`link_skill /tool/root`, [], { HOME: home });
  assert.equal(readlinkSync(join(home, '.claude/skills/cloud-fleet')), '/tool/root/skills/cloud-fleet');
  assert.equal(readlinkSync(join(home, '.claude/skills/cloudy-cloud-setup')), '/tool/root/skills/cloudy-cloud-setup');
  const home2 = mkdtempSync(join(tmpdir(), 'cc-home-'));
  mkdirSync(join(home2, '.claude/skills/cloud-fleet'), { recursive: true });
  fn(`link_skill /tool/root`, [], { HOME: home2 });
  assert.ok(lstatSync(join(home2, '.claude/skills/cloud-fleet')).isDirectory());
});

test('link_skill copies both skills from an npm install, and skips identical copies', () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-home-'));
  const root = join(tmp(), 'node_modules/cloudycloud');
  for (const n of ['cloud-fleet', 'cloudy-cloud-setup']) {
    mkdirSync(join(root, 'skills', n), { recursive: true });
    writeFileSync(join(root, 'skills', n, 'SKILL.md'), `---\nname: ${n}\n---\n`);
  }
  fn(`link_skill "${root}"`, [], { HOME: home });
  for (const n of ['cloud-fleet', 'cloudy-cloud-setup']) {
    assert.ok(lstatSync(join(home, '.claude/skills', n)).isDirectory(), `${n} is a real folder`);
    assert.match(readFileSync(join(home, '.claude/skills', n, 'SKILL.md'), 'utf8'), new RegExp(`name: ${n}`));
  }
  assert.match(fn(`link_skill "${root}"`, [], { HOME: home }).stdout + '', /up to date/);
});

test('banner: the final frame has the wordmark, three cloud rows, and no line over 60 columns', () => {
  const r = fn("UI=1; UTF=1; WIDE=1; C_X=$'\\e[0m'; banner_frame 99", [], { LC_ALL: 'en_US.UTF-8' });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').split('\n').slice(0, -1);
  assert.equal(lines.length, 6);
  assert.ok(lines[4].includes('█▀▀ █   █▀█ █ █ █▀▄ █▄█   █▀▀ █   █▀█ █ █ █▀▄'));
  assert.ok(lines[5].includes('█▄▄ █▄▄ █▄█ █▄█ █▄▀  █    █▄▄ █▄▄ █▄█ █▄█ █▄▀'));
  assert.ok(lines[2].includes('(___.__)__)'));
  for (const l of lines) assert.ok([...l].length <= 60, l);
  // an early frame is a different picture of the same size
  const early = fn('UI=1; UTF=1; WIDE=0; banner_frame 3', [], { LC_ALL: 'en_US.UTF-8' }).stdout;
  assert.notEqual(early.replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''), lines.join('\n') + '\n');
});

test('link_command (npm mode): a cloudy-cloud found only in the npx cache does not count as installed', () => {
  const cache = join(tmp(), '_npx/abc123/node_modules');
  const bin = join(cache, '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'cloudy-cloud'), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, 'cloudy-cloud'), 0o755);
  const run = (path) => fn(`yn() { echo ASKED; return 1; }; link_command "${cache}/cloudycloud"`, [], { PATH: `${path}:${process.env.PATH}` }).stdout;
  const npx = run(bin);
  assert.match(npx, /ASKED/);
  assert.doesNotMatch(npx, /already on your PATH/);
  const global = stubDir(['cloudy-cloud']); // a real global install lives outside node_modules
  assert.match(run(global), /already on your PATH/);
});

// A stub npm that logs its calls; "install" fails with EEXIST while the old link exists unless it was removed first.
function npmStub(withOldLink) {
  const prefix = tmp(), calls = join(prefix, 'calls');
  mkdirSync(join(prefix, 'bin'));
  const link = join(prefix, 'bin/cloudy-cloud');
  if (withOldLink) symlinkSync('../lib/node_modules/cloudy-cloud/bin/cloudy-cloud', link);
  const dir = stubDir(['npm'], { npm: `#!/bin/sh
echo "npm $*" >> "${calls}"
case "$*" in
  "prefix -g") echo "${prefix}" ;;
  "rm -g cloudy-cloud") rm -f "${link}" ;;
  "install -g cloudycloud") if [ -L "${link}" ]; then echo "npm error code EEXIST" >&2; echo "npm error EEXIST: file already exists" >&2; exit 1; fi ;;
esac
` });
  return { dir, calls, link };
}
const runLink = (stub, answer) => fn(`yn() { case "$1" in Install*) return 0 ;; *) return ${answer} ;; esac; }; link_command "${tmp()}/node_modules/cloudycloud"`, [], { PATH: `${stub.dir}:/usr/bin:/bin` }); // no real cloudy-cloud on PATH

test('link_command (npm mode): npm install failure explains the fix and setup continues', () => {
  const s = npmStub(false);
  writeFileSync(join(s.dir, 'npm'), readFileSync(join(s.dir, 'npm'), 'utf8').replace('"install -g cloudycloud") if', '"install -g cloudycloud") if true; then echo "npm error code EEXIST" >&2; echo "npm error EEXIST: file already exists" >&2; exit 1; fi; if'));
  const r = runLink(s, 0);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /could not install[^\n]*EEXIST: file already exists/);
  assert.match(r.stdout, /npm rm -g cloudy-cloud && npm install -g cloudycloud/);
  assert.match(r.stdout, /npx cloudycloud/);
});

test('link_command (npm mode): an old cloudy-cloud link is replaced only with a yes, removal first', () => {
  const s = npmStub(true);
  const r = runLink(s, 0);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /older cloudy-cloud command/);
  assert.match(r.stdout, /Installed the cloudy-cloud command/);
  const calls = readFileSync(s.calls, 'utf8');
  assert.ok(calls.indexOf('rm -g cloudy-cloud') < calls.indexOf('install -g cloudycloud'));
  const n = npmStub(true);
  const no = runLink(n, 1);
  assert.doesNotMatch(readFileSync(n.calls, 'utf8'), /rm -g|install -g/);
  assert.match(no.stdout, /Left the old command in place/);
});

// ---- provider question ----
test('choose_provider: --provider skips the question; Enter and 1 mean Instabox; 2 means self-hosted; anything unknown is refused', () => {
  assert.equal(fn('choose_provider self-hosted; echo $PROVIDER').stdout, 'self-hosted\n');
  assert.equal(fn('choose_provider instabox; echo $PROVIDER').stdout, 'instabox\n');
  const r = fn('choose_provider other');
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /Unknown provider "other"/);
  for (const [ans, want] of [['\n', 'instabox'], ['1\n', 'instabox'], ['2\n', 'self-hosted']]) {
    const p = pty({ cmd: ['/bin/bash', '-c', `. "${script}"; choose_provider; echo PROVIDER=$PROVIDER`], env: { PATH: process.env.PATH, HOME: tmp(), NO_COLOR: '1' }, steps: [['Type 1 or 2', ans]] });
    assert.match(p.text, /Where should subagents run\?/);
    assert.match(p.text, /1  Instabox cloud \(default\)/);
    assert.match(p.text, /2  your own machine over SSH/);
    assert.match(p.text, new RegExp(`PROVIDER=${want}`));
  }
});

// A node wrapper that records calls to the self-hosted script and, when asked, replaces it with a stub that exits 0.
function nodeSpy(g, { stub }) {
  const dir = tmp(); const log = join(dir, 'node-calls');
  writeFileSync(join(dir, 'node'), `#!/bin/sh\ncase "$1" in\n *self-hosted-setup.mjs) echo "$*" >> "${log}"; ${stub ? 'exit 0' : `exec "${process.execPath}" "$@"`} ;;\n *) exec "${process.execPath}" "$@" ;;\nesac\n`);
  chmodSync(join(dir, 'node'), 0o755);
  return { env: { ...g.env, PATH: `${dir}:${g.env.PATH}` }, log };
}

test('pty: answer 1 (the default) is the Instabox flow and never runs the self-hosted script', () => {
  const g = rig({ saved: savedBoth });
  const spy = nodeSpy(g, { stub: true });
  const r = pty({ cmd: ['/bin/bash', script], env: spy.env, steps: [WHERE, AGENTS, ...answers] });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Instabox key saved and working/);
  assert.ok(!existsSync(spy.log), 'self-hosted script was called');
});

test('pty: answer 2 runs the self-hosted script, skips every Instabox step and keeps the Claude step', () => {
  const g = rig({ saved: `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\nCLOUDY_CLOUD_SSH_HOST=me@mac-studio\nCLOUDY_CLOUD_SELF_HOSTED_SLOTS=4\n` });
  const spy = nodeSpy(g, { stub: true });
  const r = pty({ cmd: ['/bin/bash', script], env: spy.env, steps: [['Where should subagents run', '2\n'], AGENTS, ['Replace it\\? \\[y/N\\]', 'n\n'], ['Paste it', '\n'], ['Paste it', '\n']] });
  assert.equal(r.code, 0, r.text);
  assert.equal(readFileSync(spy.log, 'utf8').trim().endsWith('self-hosted-setup.mjs setup'), true);
  assert.ok(!/Instabox API key|Instabox key saved|GH_TOKEN|coordinators/i.test(r.text), r.text);
  assert.match(r.text, /Your machine\s+OK \(me@mac-studio, 4 at once\)/);
});

test('pty: --provider self-hosted skips the question', () => {
  const g = rig({ saved: `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n` });
  const spy = nodeSpy(g, { stub: true });
  const r = pty({ cmd: ['/bin/bash', script, '--provider', 'self-hosted'], env: spy.env, steps: [AGENTS, ['Replace it\\? \\[y/N\\]', 'n\n'], ['Paste it', '\n'], ['Paste it', '\n']] });
  assert.equal(r.code, 0, r.text);
  assert.ok(!/Where should subagents run/.test(r.text));
  assert.ok(existsSync(spy.log));
});

test('npm package includes the file self-hosted setup reads (#41)', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
  const files = out[0].files.map((f) => f.path);
  for (const f of ['docker/worker.Dockerfile', 'src/self-hosted-setup.mjs', 'bin/cloudy-cloud', 'install.sh']) assert.ok(files.includes(f), `${f} missing from the npm package`);
});

// ---- Instabox proxy secrets (#65) ----
const PK = 'pk-1234567890abcdef';
// A stub npx: logs argv (one line per call) and the stdin of every `secrets set`.
function npxStub({ secrets = '[{"name":"PARTICLE_API_KEY","hosts":["api.particle.ai"]}]' } = {}) {
  const cl = claudeStub();
  const log = join(cl, 'npx-argv'); const stdin = join(cl, 'npx-stdin');
  writeFileSync(join(cl, 'npx'), `#!/bin/sh\necho "$@" >> "${log}"\ncase "$*" in *"secrets set"*) cat >> "${stdin}" ;; esac\nexit 0\n`);
  writeFileSync(join(cl, 'curl'), `#!/bin/sh\ncat >/dev/null\ncase "$*" in *secrets*) echo '${secrets}' ;; *) echo '[{"id":"o1","personal":true}]' ;; esac\n`);
  for (const n of ['npx', 'curl']) chmodSync(join(cl, n), 0o755);
  return { cl, log, stdin, path: `${cl}:${process.env.PATH}` };
}
const calls = (s) => (existsSync(s.log) ? readFileSync(s.log, 'utf8') : '');
const provCmd = (secretLine = '') => `. "${script}"; PROVIDER=instabox; read_secret() { printf -v "$1" '%s' "${PK}"; }; setup_provider PARTICLE_API_KEY Particle.ai https://platform.particle.ai`;

test('setup_provider stores a pasted key as an Instabox secret with its host, key on stdin only', () => {
  const s = npxStub();
  const cfg = join(tmp(), 'env');
  const r = spawnSync('/bin/bash', ['-c', provCmd()], { encoding: 'utf8', env: { PATH: s.path, HOME: tmp(), CLOUDY_CLOUD_CONFIG: cfg } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(calls(s), /secrets set PARTICLE_API_KEY --host api\.particle\.ai\n/);
  assert.equal(readFileSync(s.stdin, 'utf8'), PK);
  assert.ok(!calls(s).includes(PK), 'key in argv');
  assert.equal(readFileSync(cfg, 'utf8'), 'CLOUDY_CLOUD_PROXY_SECRETS=PARTICLE_API_KEY\n');
  assert.ok(!(r.stdout + r.stderr).includes(PK));
});

test('pty: an env-file key is moved into a secret on yes; on no the line stays and nothing is stored', () => {
  for (const answer of ['y', 'n']) {
    const s = npxStub();
    const cfg = join(tmp(), 'env');
    writeFileSync(cfg, `OTHER=keep\nPARTICLE_API_KEY=${PK}\n`, { mode: 0o600 });
    const env = { PATH: s.path, HOME: tmp(), CLOUDY_CLOUD_CONFIG: cfg, TERM: 'xterm', NO_COLOR: '1' };
    const r = pty({ cmd: ['/bin/bash', '-c', `. "${script}"; PROVIDER=instabox; setup_provider PARTICLE_API_KEY Particle.ai x`], env, steps: [['Move PARTICLE_API_KEY into an Instabox secret \\(host api\\.particle\\.ai\\)\\? \\[Y/n\\]', `${answer}\n`], ['Replace it\\? \\[y/N\\]', 'n\n']] });
    assert.ok(!r.text.includes(PK));
    if (answer === 'y') {
      assert.match(calls(s), /secrets set PARTICLE_API_KEY --host api\.particle\.ai/);
      assert.equal(readFileSync(s.stdin, 'utf8'), PK);
      assert.equal(readFileSync(cfg, 'utf8'), 'OTHER=keep\nCLOUDY_CLOUD_PROXY_SECRETS=PARTICLE_API_KEY\n');
    } else {
      assert.ok(!/secrets set/.test(calls(s)));
      assert.equal(readFileSync(cfg, 'utf8'), `OTHER=keep\nPARTICLE_API_KEY=${PK}\n`);
    }
  }
});

test('setup --check-only reports a proxied secret whose hosts miss a profile host, with the fix command', () => {
  const run = (hosts) => {
    const s = npxStub({ secrets: JSON.stringify([{ name: 'PARTICLE_API_KEY', hosts }, { name: 'CLAUDE_CODE_OAUTH_TOKEN', hosts: ['api.anthropic.com'] }, { name: 'GH_TOKEN', hosts: ['github.com', 'api.github.com'] }]) });
    const cfg = join(tmp(), 'env');
    writeFileSync(cfg, 'CLOUDY_CLOUD_PROXY_SECRETS=PARTICLE_API_KEY,CLAUDE_CODE_OAUTH_TOKEN\nINSTABOX_API_KEY=' + KEY + '\n', { mode: 0o600 });
    return spawnSync('/bin/bash', [script, '--check-only'], { encoding: 'utf8', env: { PATH: s.path, HOME: tmp(), CLOUDY_CLOUD_CONFIG: cfg } });
  };
  const bad = run(['example.com']);
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stdout, /PARTICLE_API_KEY.*api\.particle\.ai/);
  assert.match(bad.stdout, /npx --yes instabox@latest secrets set PARTICLE_API_KEY --host api\.particle\.ai/);
  const good = run(['api.particle.ai']);
  assert.equal(good.status, 0, good.stdout);
});

test('del_env keeps the file intact and fails when it cannot write the new copy', () => {
  const dir = tmp(); const file = join(dir, 'env');
  writeFileSync(file, 'A=1\nB=2\n', { mode: 0o600 });
  const bin = stubDir(['grep'], { grep: '#!/bin/sh\nexit 2\n' });
  const r = fn('del_env A', [], { CLOUDY_CLOUD_CONFIG: file, PATH: `${bin}:${process.env.PATH}` });
  assert.notEqual(r.status, 0);
  assert.equal(readFileSync(file, 'utf8'), 'A=1\nB=2\n');
  assert.deepEqual(readdirSync(dir), ['env']);
  const ok2 = fn('del_env A', [], { CLOUDY_CLOUD_CONFIG: file });
  assert.equal(ok2.status, 0);
  assert.equal(readFileSync(file, 'utf8'), 'B=2\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('a key is only deleted from the env file after the API-key org shows the secret; otherwise the line stays and setup warns', () => {
  const s = npxStub({ secrets: '[]' }); // the secret went to another org: the runtime would not see it
  const cfg = join(tmp(), 'env');
  writeFileSync(cfg, `PARTICLE_API_KEY=${PK}\nINSTABOX_API_KEY=${KEY}\n`, { mode: 0o600 });
  const env = { PATH: s.path, HOME: tmp(), CLOUDY_CLOUD_CONFIG: cfg, TERM: 'xterm', NO_COLOR: '1' };
  const r = pty({ cmd: ['/bin/bash', '-c', `. "${script}"; PROVIDER=instabox; setup_provider PARTICLE_API_KEY Particle.ai x`], env, steps: [['Move PARTICLE_API_KEY', 'y\n'], ['Replace it\\? \\[y/N\\]', 'n\n']] });
  assert.match(r.text, /could not confirm|not visible|stays in/i);
  assert.equal(readFileSync(cfg, 'utf8'), `PARTICLE_API_KEY=${PK}\nINSTABOX_API_KEY=${KEY}\n`);
  assert.ok(!r.text.includes(PK));
});

// ---- #67: the coordinator's copy of the Instabox key ----
const COORD_SECRET = 'CLOUDY_CLOUD_INSTABOX_API_KEY';
const coordSecretJson = JSON.stringify([{ name: COORD_SECRET, hosts: ['api.instabox.sh'] }]);

test('a changed Instabox key replaces the coordinator secret even when it is already stored; an unchanged one does not', () => {
  const run = (changed) => {
    const s = npxStub({ secrets: coordSecretJson });
    const cfg = join(tmp(), 'env');
    writeFileSync(cfg, `CLOUDY_CLOUD_PROXY_SECRETS=${COORD_SECRET}\nINSTABOX_API_KEY=${KEY}\n`, { mode: 0o600 });
    const r = spawnSync('/bin/bash', ['-c', `. "${script}"; PROVIDER=instabox; ${changed ? 'INSTABOX_KEY_CHANGED=1; ' : ''}store_coordinator_key`], { encoding: 'utf8', env: { PATH: s.path, HOME: tmp(), CLOUDY_CLOUD_CONFIG: cfg } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!calls(s).includes(KEY), 'key in argv');
    return s;
  };
  const s = run(true);
  assert.match(calls(s), /secrets set CLOUDY_CLOUD_INSTABOX_API_KEY --host api\.instabox\.sh\n/);
  assert.equal(readFileSync(s.stdin, 'utf8'), KEY);
  assert.ok(!/secrets set/.test(calls(run(false))));
});

test('pty: declining the coordinator image still stores the coordinator secret', () => {
  const g = rig({ saved: savedBoth });
  const log = join(g.cl, 'npx-argv'); const stdin = join(g.cl, 'npx-stdin');
  writeFileSync(join(g.cl, 'npx'), `#!/bin/sh\necho "$@" >> "${log}"\ncase "$*" in *"secrets set"*) cat >> "${stdin}" ;; esac\nexit 0\n`);
  writeFileSync(join(g.cl, 'curl'), `#!/bin/sh\ncat >/dev/null\ncase "$*" in\n *"-w"*) printf 200 ;;\n *secrets*) echo '[{"name":"CLAUDE_CODE_OAUTH_TOKEN","hosts":["api.anthropic.com"]},{"name":"GH_TOKEN","hosts":["github.com","api.github.com"]},{"name":"${COORD_SECRET}","hosts":["api.instabox.sh"]}]' ;;\n *) echo '[{"id":"o1","personal":true}]' ;;\nesac\n`);
  const r = g.run(answers);
  assert.equal(r.code, 0, r.text);
  assert.match(readFileSync(log, 'utf8'), /secrets set CLOUDY_CLOUD_INSTABOX_API_KEY --host api\.instabox\.sh/);
  assert.equal(readFileSync(stdin, 'utf8'), KEY);
  assert.match(readFileSync(g.cfg, 'utf8'), /CLOUDY_CLOUD_PROXY_SECRETS=.*CLOUDY_CLOUD_INSTABOX_API_KEY/);
});

test('setup --check-only runs every check and ends with a verdict', () => {
  const run = (cfgText, secrets) => {
    const s = npxStub({ secrets });
    const cfg = join(tmp(), 'env');
    writeFileSync(cfg, cfgText, { mode: 0o600 });
    return spawnSync('/bin/bash', [script, '--check-only'], { encoding: 'utf8', env: { PATH: s.path, HOME: tmp(), CLOUDY_CLOUD_CONFIG: cfg } });
  };
  const empty = run('', '[]');
  assert.equal(empty.status, 1, empty.stdout);
  for (const re of [/\[2\/4\]/, /No Instabox key is saved/, /No Claude token is saved/, /GH_TOKEN is not stored/, /Check failed/]) assert.match(empty.stdout, re);
  const gh = JSON.stringify([{ name: 'GH_TOKEN', hosts: ['github.com', 'api.github.com'] }]);
  const both = JSON.stringify([{ name: 'GH_TOKEN', hosts: ['github.com', 'api.github.com'] }, { name: 'CLAUDE_CODE_OAUTH_TOKEN', hosts: ['api.anthropic.com'] }]);
  const good = run(`INSTABOX_API_KEY=${KEY}\nCLOUDY_CLOUD_PROXY_SECRETS=CLAUDE_CODE_OAUTH_TOKEN\n`, both);
  assert.equal(good.status, 0, good.stdout);
  assert.match(good.stdout, /Check passed/);
});

// A check-only run with its own config file and shell environment.
const checkOnly = (cfgText, env = {}, { stub = npxStub({ secrets: '[]' }), path } = {}) => {
  const cfg = join(tmp(), 'env');
  writeFileSync(cfg, cfgText, { mode: 0o600 });
  return spawnSync('/bin/bash', [script, '--check-only'], { encoding: 'utf8', env: { PATH: path ?? stub.path, HOME: tmp(), CLOUDY_CLOUD_CONFIG: cfg, ...env } });
};

test('check-only on Instabox fails a plain Claude token that is not a proxy secret, as the runtime does', () => {
  const gh = JSON.stringify([{ name: 'GH_TOKEN', hosts: ['github.com', 'api.github.com'] }]);
  const r = checkOnly(`INSTABOX_API_KEY=${KEY}\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-x\n`, {}, { stub: npxStub({ secrets: gh }) });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /proxy secret/);
  assert.doesNotMatch(r.stdout, /sk-ant-oat01-x/);
  const shell = checkOnly(`INSTABOX_API_KEY=${KEY}\n`, { ANTHROPIC_API_KEY: 'sk-ant-api03-y' }, { stub: npxStub({ secrets: gh }) });
  assert.equal(shell.status, 1, shell.stdout);
  assert.match(shell.stdout, /proxy secret/);
});

test('check-only on self-hosted requires GH_TOKEN and consent to put it on the machine', () => {
  const base = 'CLOUDY_CLOUD_PROVIDER=self-hosted\nCLOUDY_CLOUD_SSH_HOST=h\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-x\n';
  const none = checkOnly(base);
  assert.equal(none.status, 1, none.stdout);
  assert.match(none.stdout, /GH_TOKEN/);
  const noConsent = checkOnly(base + 'GH_TOKEN=ghp_x\n');
  assert.equal(noConsent.status, 1, noConsent.stdout);
  assert.match(noConsent.stdout, /CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX|allow/);
  const noToken = checkOnly(base + 'CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX=yes\n');
  assert.equal(noToken.status, 1, noToken.stdout);
  const ok = checkOnly(base + 'GH_TOKEN=ghp_x\nCLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX=yes\n');
  assert.equal(ok.status, 0, ok.stdout);
});

test('check-only keeps going after a missing tool and still prints the verdict', () => {
  const dir = stubDir(all.filter((n) => n !== 'git'), { node: nodeStub });
  const r = checkOnly('', {}, { path: dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /git is missing/);
  assert.match(r.stdout, /\[2\/4\]/);
  assert.match(r.stdout, /Check failed/);
});

test('check-only uses the shell Instabox key over the saved one, like the runtime, for every call', () => {
  const SHELL = 'ibk_shellshellshell', SAVED = 'ibk_savedsavedsaved';
  const stub = npxStub({ secrets: '[]' });
  const seen = join(stub.cl, 'curl-stdin');
  writeFileSync(join(stub.cl, 'curl'), `#!/bin/sh\ncat >> "${seen}"\ncase "$*" in *-w*) printf 200 ;; *secrets*) echo '[]' ;; *) echo '[{"id":"o1","personal":true}]' ;; esac\n`);
  chmodSync(join(stub.cl, 'curl'), 0o755);
  checkOnly(`INSTABOX_API_KEY=${SAVED}\nCLOUDY_CLOUD_PROXY_SECRETS=CLAUDE_CODE_OAUTH_TOKEN\n`, { INSTABOX_API_KEY: SHELL }, { stub });
  const used = readFileSync(seen, 'utf8');
  assert.match(used, new RegExp(SHELL));
  assert.doesNotMatch(used, new RegExp(SAVED));
  // with only a saved key, that key is used for the secrets calls too
  rmSync(seen);
  checkOnly(`INSTABOX_API_KEY=${SAVED}\nCLOUDY_CLOUD_PROXY_SECRETS=CLAUDE_CODE_OAUTH_TOKEN\n`, {}, { stub });
  assert.match(readFileSync(seen, 'utf8'), new RegExp(SAVED));
});

// ---- Instabox usage alert emails (#138) ----
const ALERTS_ON = '{"limits":{"usageAlertPercent":80,"overageAlert":true,"spendCapUSD":null}}';
const alertsBody = (usageAlertPercent, overageAlert, spendCapUSD = null) => JSON.stringify({ limits: { usageAlertPercent, overageAlert, spendCapUSD } });
// curl answers by URL: the -w probe 200, /v1/me an org, /v1/orgs/o1 the body in a file. npx logs every call;
// "workspace alerts" exits `alertsExit` and, on 0, makes the next read return ALERTS_ON.
function alertsRig({ body = ALERTS_ON, curlExit = 0, whoamiExit = 0, alertsExit = 0, orgId = 'o1' } = {}) {
  const cl = claudeStub();
  const bodyFile = join(cl, 'orgbody'); const log = join(cl, 'npx-argv'); const curlArgv = join(cl, 'curl-argv');
  writeFileSync(bodyFile, body);
  writeFileSync(join(cl, 'curl'), `#!/bin/sh\necho "$@" >> "${curlArgv}"\ncat >/dev/null\ncase "$*" in\n *"-w"*) printf 200 ;;\n *"/v1/me"*) echo '{"org":{"id":"${orgId}"}}' ;;\n *"/v1/orgs/o1/secrets"*) echo '[{"name":"GH_TOKEN","hosts":["github.com","api.github.com"]},{"name":"CLAUDE_CODE_OAUTH_TOKEN","hosts":["api.anthropic.com"]}]' ;;\n *"/v1/orgs/o1"*) [ ${curlExit} = 0 ] || exit ${curlExit}; cat "${bodyFile}" ;;\n *"/v1/orgs"*) echo '[{"id":"o1","personal":true}]' ;;\n *) echo '[]' ;;\nesac\n`);
  writeFileSync(join(cl, 'npx'), `#!/bin/sh\necho "npx $@" >> "${log}"\ncase "$*" in\n *whoami*) exit ${whoamiExit} ;;\n *login*) exit 1 ;;\n *"workspace alerts"*) [ ${alertsExit} = 0 ] && cp /dev/null "${bodyFile}" && printf '%s' '${ALERTS_ON}' > "${bodyFile}"; exit ${alertsExit} ;;\nesac\nexit 0\n`);
  for (const n of ['curl', 'npx']) chmodSync(join(cl, n), 0o755);
  const cfg = join(tmp(), 'env');
  writeFileSync(cfg, `INSTABOX_API_KEY=${KEY}\nCLOUDY_CLOUD_PROXY_SECRETS=CLAUDE_CODE_OAUTH_TOKEN\n`, { mode: 0o600 });
  const env = { PATH: `${cl}:${process.env.PATH}`, HOME: tmp(), CLOUDY_CLOUD_CONFIG: cfg, TERM: 'xterm', NO_COLOR: '1' };
  const npxCalls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  const check = () => spawnSync('/bin/bash', [script, '--check-only'], { encoding: 'utf8', env });
  const setup = (steps) => pty({ cmd: ['/bin/bash', '-c', `. "${script}"; setup_alerts; echo DONE`], env, steps });
  return { check, setup, npxCalls, curlArgv: () => readFileSync(curlArgv, 'utf8') };
}
const FIX = 'npx --yes instabox@latest workspace alerts o1 --usage 80 --overage on';

test('check-only: alerts on shows the real percent and the spend cap, exits without a prompt', () => {
  const g = alertsRig({ body: alertsBody(90, true, 25) });
  const r = g.check();
  assert.match(r.stdout, /Instabox emails you at 90% of included usage and when usage goes beyond it \(pay as you go\)/);
  assert.match(r.stdout, /spend cap: \$25/);
  assert.match(r.stdout, /workspace spend-cap o1 <usd>/);
  assert.ok(!/workspace alerts/.test(g.npxCalls()));
  assert.ok(!g.curlArgv().includes(KEY), 'key in curl argv');
});

test('check-only: alerts off warns with the exact command and the check still passes the step', () => {
  const g = alertsRig({ body: alertsBody(0, false) });
  const r = g.check();
  assert.match(r.stdout, /Instabox usage alert emails are off \(usage alert: off, overage alert: off, spend cap: none\)/);
  assert.ok(r.stdout.includes(FIX), r.stdout);
  assert.ok(!/workspace alerts/.test(g.npxCalls()), 'check-only must not run the CLI');
  assert.doesNotMatch(r.stdout, /\[x\] .*alert/i);
});

test('check-only: free tier, unreadable orgs, and key hygiene', () => {
  assert.match(alertsRig({ body: '{"limits":{}}' }).check().stdout, /Usage alert emails apply to paid Instabox plans only/);
  const g = alertsRig({ curlExit: 7 });
  assert.match(g.check().stdout, /Could not read your Instabox usage alerts/);
  assert.match(g.check().stdout, /npx --yes instabox@latest workspace alerts/);
});

test('check-only exits 0 when only the alerts are off', () => {
  const r = alertsRig({ body: alertsBody(0, true) }).check();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /alert emails are off/);
  assert.match(r.stdout, /Check passed/);
});

test('setup_alerts: alerts on is shown and nothing is asked or run', () => {
  const g = alertsRig();
  const r = g.setup([]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Instabox emails you at 80% of included usage/);
  assert.ok(!/Turn them on now/.test(r.text));
  assert.ok(!/workspace alerts/.test(g.npxCalls()));
});

test('setup_alerts: typed y runs the CLI with the org, only for the setting that is off, and confirms', () => {
  let g = alertsRig({ body: alertsBody(0, true) });
  let r = g.setup([['Turn them on now\\? \\[y/N\\]', 'y\n']]);
  assert.match(r.text, /usage alert off, overage alert on/);
  assert.match(g.npxCalls(), /^npx --yes instabox@latest workspace alerts o1 --usage 80$/m);
  assert.match(r.text, /Instabox will email you at 80% of included usage/);
  g = alertsRig({ body: alertsBody(90, false) });
  r = g.setup([['Turn them on now\\? \\[y/N\\]', 'y\n']]);
  assert.match(g.npxCalls(), /^npx --yes instabox@latest workspace alerts o1 --overage on$/m);
  assert.ok(!g.curlArgv().includes(KEY));
  assert.ok(!g.npxCalls().includes(KEY));
});

test('setup_alerts: Enter or n runs nothing and prints the command', () => {
  for (const answer of ['\n', 'n\n']) {
    const g = alertsRig({ body: alertsBody(0, false) });
    const r = g.setup([['Turn them on now\\? \\[y/N\\]', answer]]);
    assert.equal(r.code, 0, r.text);
    assert.ok(!/workspace alerts|whoami|login/.test(g.npxCalls()), g.npxCalls());
    assert.ok(r.text.includes(FIX), r.text);
  }
});

test('setup_alerts: no login session and a 403 each print one warning with the command, and setup goes on', () => {
  for (const opt of [{ whoamiExit: 1 }, { alertsExit: 1 }]) {
    const g = alertsRig({ body: alertsBody(0, true), ...opt });
    const r = g.setup([['Turn them on now\\? \\[y/N\\]', 'y\n']]);
    assert.equal(r.code, 0, r.text);
    assert.equal((r.text.match(/Could not change the alerts/g) || []).length, 1, r.text);
    assert.ok(r.text.includes(FIX), r.text);
    assert.match(r.text, /DONE/);
  }
});

test('setup_alerts: free tier says paid plans only and asks nothing; unreadable warns', () => {
  let g = alertsRig({ body: '{"limits":{}}' });
  let r = g.setup([]);
  assert.match(r.text, /Usage alert emails apply to paid Instabox plans only/);
  assert.ok(!/Turn them on now/.test(r.text));
  g = alertsRig({ curlExit: 7 });
  r = g.setup([]);
  assert.match(r.text, /Could not read your Instabox usage alerts/);
});

test('setup_alerts: only exactly y or yes (any case) confirms; "yellow" changes nothing', () => {
  let g = alertsRig({ body: alertsBody(0, false) });
  let r = g.setup([['Turn them on now\\? \\[y/N\\]', 'yellow\n']]);
  assert.ok(!/workspace alerts|whoami|login/.test(g.npxCalls()), g.npxCalls());
  assert.ok(r.text.includes(FIX), r.text);
  g = alertsRig({ body: alertsBody(0, false) });
  g.setup([['Turn them on now\\? \\[y/N\\]', ' YES \n']]);
  assert.match(g.npxCalls(), /workspace alerts o1 --usage 80 --overage on/);
});

test('a decimal alert percent counts as set: only --overage on runs, and 80.5% is shown', () => {
  let g = alertsRig({ body: alertsBody(80.5, false) });
  let r = g.setup([['Turn them on now\\? \\[y/N\\]', 'y\n']]);
  assert.match(r.text, /usage alert 80\.5%, overage alert off/);
  assert.match(g.npxCalls(), /^npx --yes instabox@latest workspace alerts o1 --overage on$/m);
  assert.ok(!/--usage/.test(g.npxCalls()), g.npxCalls());
  g = alertsRig({ body: alertsBody(80.5, false) });
  assert.match(g.check().stdout, /usage alert: 80\.5%, overage alert: off/);
});

test('the spend cap is shown when alerts are off, in check-only and in setup', () => {
  const g = alertsRig({ body: alertsBody(0, false, 25) });
  assert.match(g.check().stdout, /spend cap: \$25/);
  const r = g.setup([['Turn them on now\\? \\[y/N\\]', '\n']]);
  assert.match(r.text, /spend cap \$25/);
  assert.match(alertsRig({ body: alertsBody(0, false) }).check().stdout, /spend cap: none/);
});

test('an org id that starts with a hyphen is unknown, not a node option', () => {
  const r = alertsRig({ orgId: '--version' }).check();
  assert.match(r.stdout, /Could not read your Instabox usage alerts/);
});

// ---- setup does not require Claude ----
const CODEX = ['Which agents do you run', 'codex\n'];
const NO_CLAUDE_WORKERS = ['Also run Claude Code workers', 'n\n'];
// A PATH with the setup tools but no claude command.
const noClaudePath = (g) => stubDir(['git', 'curl', 'npm', 'npx', 'node'], { node: `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, curl: readFileSync(join(g.cl, 'curl'), 'utf8'), npm: readFileSync(join(g.cl, 'npm'), 'utf8') }) + ':/usr/bin:/bin';

test('pty: a Codex-only user finishes setup with no Claude token and no claude command', () => {
  const g = rig();
  const r = pty({ cmd: ['/bin/bash', script], env: { ...g.env, PATH: noClaudePath(g) }, steps: [WHERE, CODEX, NO_CLAUDE_WORKERS, ['Paste it', KEY + '\n'], ['Replace it\\? \\[y/N\\]', 'n\n'], ['Paste it', '\n'], ['Paste it', '\n'], ['Paste it', '\n'], ['cloud coordinators.*\\[y/N\\]', 'n\n']] });
  assert.equal(r.code, 0, r.text);
  assert.doesNotMatch(r.text, /Claude token for subagents|Claude token works|Claude Code is missing/);
  const cfg = readFileSync(g.cfg, 'utf8');
  assert.ok(cfg.includes('CLOUDY_CLOUD_AGENTS=codex\n'), cfg);
  assert.ok(cfg.includes(`INSTABOX_API_KEY=${KEY}\n`));
  assert.doesNotMatch(cfg, /CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/);
  assert.equal(statSync(g.cfg).mode & 0o777, 0o600);
  assert.match(r.text, /Summary[\s\S]*Instabox key\s+OK/);
  assert.doesNotMatch(r.text.split('Summary')[1], /Claude token/);
});

test('pty: choosing claude with no claude command stops with the install link', () => {
  const g = rig();
  const r = pty({ cmd: ['/bin/bash', script], env: { ...g.env, PATH: noClaudePath(g) }, steps: [WHERE, AGENTS] });
  assert.notEqual(r.code, 0);
  assert.match(r.text, /Claude Code is missing/);
});

test('check-only does not ask for a Claude token when the saved agents do not include claude', () => {
  const dir = stubDir(['git', 'npm', 'curl'].concat('node'), { node: nodeStub });
  const cfg = join(tmp(), 'env');
  writeFileSync(cfg, `CLOUDY_CLOUD_AGENTS=codex\nINSTABOX_API_KEY=${KEY}\n`, { mode: 0o600 });
  const r = spawnSync('/bin/bash', [script, '--check-only'], { encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin`, HOME: tmp(), CLOUDY_CLOUD_CONFIG: cfg } });
  assert.doesNotMatch(r.stdout, /Claude Code is missing|No Claude token is saved/);
});


test('check-only fails with a next step when no chosen agent has a usable worker credential, and passes with one', () => {
  const gh = JSON.stringify([{ name: 'GH_TOKEN', hosts: ['github.com', 'api.github.com'] }]);
  const withOpenai = JSON.stringify([{ name: 'GH_TOKEN', hosts: ['github.com', 'api.github.com'] }, { name: 'OPENAI_API_KEY', hosts: ['api.openai.com'] }]);
  const base = `INSTABOX_API_KEY=${KEY}\nCLOUDY_CLOUD_AGENTS=codex\n`;
  const none = checkOnly(base, {}, { stub: npxStub({ secrets: gh }) });
  assert.equal(none.status, 1, none.stdout);
  assert.match(none.stdout, /No worker credential is saved/);
  assert.match(none.stdout, /cloudy-cloud setup/);
  const plain = checkOnly(`${base}OPENAI_API_KEY=sk-plain-value-1234567890\n`, {}, { stub: npxStub({ secrets: gh }) });
  assert.equal(plain.status, 1, 'on Instabox a plain key value is not usable: it must be a proxy secret');
  assert.match(plain.stdout, /proxy secret/);
  assert.doesNotMatch(plain.stdout, /sk-plain-value/);
  const ok = checkOnly(`${base}CLOUDY_CLOUD_PROXY_SECRETS=OPENAI_API_KEY\n`, {}, { stub: npxStub({ secrets: withOpenai }) });
  assert.equal(ok.status, 0, ok.stdout);
  const cfgDir = tmp();
  writeFileSync(join(cfgDir, 'codex-auth.json'), '{}', { mode: 0o600 });
  const cfg = join(cfgDir, 'env');
  writeFileSync(cfg, base, { mode: 0o600 });
  const st = npxStub({ secrets: gh });
  const login = spawnSync('/bin/bash', [script, '--check-only'], { encoding: 'utf8', env: { PATH: st.path, HOME: tmp(), CLOUDY_CLOUD_CONFIG: cfg } });
  assert.equal(login.status, 0, login.stdout);
  const claude = checkOnly(`INSTABOX_API_KEY=${KEY}\nCLAUDE_CODE_OAUTH_TOKEN=x\nCLOUDY_CLOUD_PROXY_SECRETS=CLAUDE_CODE_OAUTH_TOKEN\n`, {}, { stub: npxStub({ secrets: JSON.stringify([{ name: 'GH_TOKEN', hosts: ['github.com', 'api.github.com'] }, { name: 'CLAUDE_CODE_OAUTH_TOKEN', hosts: ['api.anthropic.com'] }]) }) });
  assert.equal(claude.status, 0, 'a Claude-only user is unchanged');
});

test('check-only counts a saved Claude credential as a worker credential when claude is not in the chosen agents', () => {
  const sec = JSON.stringify([{ name: 'GH_TOKEN', hosts: ['github.com', 'api.github.com'] }, { name: 'CLAUDE_CODE_OAUTH_TOKEN', hosts: ['api.anthropic.com'] }]);
  const r = checkOnly(`INSTABOX_API_KEY=${KEY}\nCLOUDY_CLOUD_AGENTS=opencode\nCLOUDY_CLOUD_PROXY_SECRETS=CLAUDE_CODE_OAUTH_TOKEN\n`, {}, { stub: npxStub({ secrets: sec }) });
  assert.equal(r.status, 0, r.stdout);
});

test('check-only fails when the Claude credential a worker picks first is a plain value on Instabox', () => {
  // The runtime picks CLAUDE_CODE_OAUTH_TOKEN (it has a value) and refuses it, so a proxied ANTHROPIC_API_KEY does not help.
  const sec = JSON.stringify([{ name: 'GH_TOKEN', hosts: ['github.com', 'api.github.com'] }, { name: 'ANTHROPIC_API_KEY', hosts: ['api.anthropic.com'] }]);
  const r = checkOnly(`INSTABOX_API_KEY=${KEY}\nCLOUDY_CLOUD_AGENTS=opencode\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-plainvalue-for-test-only\nCLOUDY_CLOUD_PROXY_SECRETS=ANTHROPIC_API_KEY\n`, {}, { stub: npxStub({ secrets: sec }) });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /CLAUDE_CODE_OAUTH_TOKEN is a plain value/);
});

test('check-only finds a ChatGPT login at CLOUDY_CLOUD_CODEX_AUTH, as the runtime does', () => {
  const gh = JSON.stringify([{ name: 'GH_TOKEN', hosts: ['github.com', 'api.github.com'] }]);
  const auth = join(tmp(), 'custom-auth.json');
  writeFileSync(auth, '{}', { mode: 0o600 });
  const r = checkOnly(`INSTABOX_API_KEY=${KEY}\nCLOUDY_CLOUD_AGENTS=codex\n`, { CLOUDY_CLOUD_CODEX_AUTH: auth }, { stub: npxStub({ secrets: gh }) });
  assert.equal(r.status, 0, r.stdout);
});
