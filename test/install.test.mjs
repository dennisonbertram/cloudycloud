import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, existsSync, symlinkSync, readlinkSync, mkdirSync, lstatSync } from 'node:fs';
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

function rig({ saved = '', claudeExtra = {}, githubState = 'yes' } = {}) {
  const cl = claudeStub(claudeExtra);
  const cfgDir = tmp(); const cfg = join(cfgDir, 'env');
  if (saved) writeFileSync(cfg, saved, { mode: 0o600 });
  const secrets = githubState === 'yes' ? '[{"name":"GH_TOKEN","hosts":["github.com","api.github.com"]}]' : '[]';
  writeFileSync(join(cl, 'curl'), `#!/bin/sh\ncat >/dev/null\ncase "$*" in\n *"-w"*) printf 200 ;;\n *secrets*) echo '${secrets}' ;;\n *) echo '[{"id":"o1","personal":true}]' ;;\nesac\n`);
  writeFileSync(join(cl, 'npm'), '#!/bin/sh\n[ "$1" = prefix ] && echo /nowhere\nexit 0\n');
  writeFileSync(join(cl, 'npx'), '#!/bin/sh\nexit 0\n');
  for (const n of ['curl', 'npm', 'npx']) chmodSync(join(cl, n), 0o755);
  symlinkSync(resolve('bin/cloudy-cloud'), join(cl, 'cloudy-cloud'));
  const tdir = tmp();
  const env = { PATH: `${cl}:${process.env.PATH}`, HOME: tdir, TMPDIR: tdir, CLOUDY_CLOUD_CONFIG: cfg, TERM: 'xterm', NO_COLOR: '1' };
  const run = (steps) => pty({ cmd: ['/bin/bash', script], env, steps });
  return { cl, cfg, tdir, run };
}
const P_IB = ['Paste it', null]; // placeholders, built per test
const tail = [['Replace it\\? \\[y/N\\]', 'n\n'], ['Paste it', '\n'], ['Paste it', '\n'], ['cloud coordinators.*\\[y/N\\]', 'n\n']];
const savedBoth = `INSTABOX_API_KEY=${KEY}\nCLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`;

test('pty: a two-line paste gives the full token; live check runs; token is not in argv', () => {
  const g = rig();
  const r = g.run([['Paste it', KEY + '\n'], ['Enter, or paste', TOKEN.slice(0, 60) + '\n' + TOKEN.slice(60) + '\n'], ...tail]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /\[1\/4\] Tools/);
  assert.match(r.text, /Claude token works/);
  assert.match(r.text, /this uses a very small amount of Claude usage/);
  const cfg = readFileSync(g.cfg, 'utf8');
  assert.ok(cfg.includes(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`), r.text);
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
  assert.match(readFileSync(g.cfg, 'utf8'), new RegExp(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\\n`));
  assert.match(readFileSync(g.cfg, 'utf8'), new RegExp(`INSTABOX_API_KEY=${KEY}\\n`));
});

test('pty: a bracketed-paste-wrapped value works', () => {
  const g = rig();
  const r = g.run([['Paste it', `${ESC}[200~${KEY}${ESC}[201~\n`], ['Enter, or paste', `${ESC}[200~${TOKEN}${ESC}[201~\n`], ...tail]);
  assert.equal(r.code, 0, r.text);
  assert.match(readFileSync(g.cfg, 'utf8'), new RegExp(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\\n`));
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
  const r = g.run([['Replace it\\? \\[y/N\\]', 'n\n'], ['Replace it\\? \\[y/N\\]', 'y\n'], ['Enter, or paste', bad + '\n'], ['Paste the token', bad + '\n'], ['Paste the token', bad + '\n'], ...tail]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Stopped the Claude step after 3 tries\. Your saved token is unchanged\. Run .* again to retry\./);
  assert.equal(readFileSync(g.cfg, 'utf8'), savedBoth);
});

test('pty: Enter keeps the saved token', () => {
  const g = rig({ saved: savedBoth });
  const r = g.run([['Replace it\\? \\[y/N\\]', 'n\n'], ['Replace it\\? \\[y/N\\]', 'y\n'], ['Enter, or paste', '\n'], ['Paste the token', '\n'], ...tail]);
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
  assert.match(readFileSync(g.cfg, 'utf8'), new RegExp(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\\n`));
  assert.deepEqual(readdirSync(g.tdir).filter((f) => !f.startsWith('.')), []);
});

// ---- how it looks ----
const UI_ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: undefined };
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/;
function uiRig(opts, env = {}) {
  const g = rig(opts);
  const e = { PATH: `${g.cl}:${process.env.PATH}`, HOME: g.tdir, TMPDIR: g.tdir, CLOUDY_CLOUD_CONFIG: g.cfg, ...UI_ENV, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return { ...g, env: e, run: (steps, extra = {}) => pty({ cmd: ['/bin/bash', script], env: e, steps, ...extra }) };
}
const answers = [['Replace it\\?.*\\[y/N\\]', 'n\n'], ['Replace it\\?.*\\[y/N\\]', 'n\n'], ['Replace it\\?.*\\[y/N\\]', 'n\n'], ['Paste it', '\n'], ['Paste it', '\n'], ['cloud coordinators.*\\[y/N\\]', 'n\n']];
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
  const r = g.run([['\\?25l', 'yy'], ['Replace it\\?.*\\[y/N\\]', 'n\n'], ['Replace it\\?.*\\[y/N\\]', 'n\n'], ['Replace it\\?.*\\[y/N\\]', 'n\n'], ['Paste it', '\n'], ['Paste it', '\n'], ['cloud coordinators.*\\[y/N\\]', 'n\n']]);
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
