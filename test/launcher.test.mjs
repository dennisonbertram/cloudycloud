import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, cpSync, symlinkSync, realpathSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { egressAllow } from '../src/config.mjs';

const launcher = resolve('bin/cloudy-cloud');
const IBK = 'ibk_FAKEINSTABOXKEY0123456789';
const TOK = 'sk-ant-oat01-FAKECLAUDETOKEN0123';

// Runs the launcher with a stub `claude` that records its argv.
function run({ config, cwd, provider, socketIn, extraEnv, args = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-launcher-'));
  const argvFile = join(dir, 'argv');
  const stub = join(dir, 'claude');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\nprintf '%s' "$CLOUDY_CLOUD_BIN" > "${argvFile}.bin"\n`);
  chmodSync(stub, 0o755);
  const cfg = join(dir, 'env');
  if (config !== undefined) writeFileSync(cfg, config);
  const env = { PATH: `${dir}:${process.env.PATH}`, HOME: dir, CLOUDY_CLOUD_CONFIG: cfg, ...(provider && { CLOUDY_CLOUD_PROVIDER: provider }), ...(socketIn && { CLOUDY_CLOUD_DOCKER_SOCKET_IN: socketIn }), ...extraEnv };
  const r = spawnSync('/bin/sh', [launcher, ...args], { cwd: cwd ?? dir, env, input: '', encoding: 'utf8' });
  return { ...r, bin: existsSync(`${argvFile}.bin`) ? readFileSync(`${argvFile}.bin`, 'utf8') : '', started: existsSync(argvFile), argv: existsSync(argvFile) ? readFileSync(argvFile, 'utf8') : '', dir };
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

test('a Claude secret named in CLOUDY_CLOUD_PROXY_SECRETS counts as set up, and the server is passed the setting', () => {
  const r = run({ config: `INSTABOX_API_KEY=${IBK}\nCLOUDY_CLOUD_PROXY_SECRETS=PARTICLE_API_KEY,CLAUDE_CODE_OAUTH_TOKEN\n`, cwd: repo('https://github.com/test/repo.git') });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.started, true);
  assert.match(r.argv, /"CLOUDY_CLOUD_PROXY_SECRETS":"[^"]*"/);
});

test('keys present: claude starts with expected flags and no secret in argv', () => {
  const r = run({ config: full, cwd: repo('https://github.com/test/repo.git') });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.started, true);
  assert.doesNotMatch(r.stderr, /warning/);
  for (const flag of ['--mcp-config', '--settings', '--append-system-prompt']) assert.ok(r.argv.includes(flag + '\n'), flag);
  assert.ok(!r.argv.includes(IBK) && !r.argv.includes(TOK));
});

test('CLOUDY_CLOUD_PROVIDER is passed through Claude Code env expansion', () => {
  const r = run({ config: full, cwd: repo('https://github.com/test/repo.git'), provider: 'instabox' });
  assert.equal(r.status, 0, r.stderr);
  const config = r.argv.slice(r.argv.indexOf('--mcp-config\n') + '--mcp-config\n'.length).split('\n')[0];
  assert.equal(JSON.parse(config).mcpServers.cloud.env.CLOUDY_CLOUD_PROVIDER, '${CLOUDY_CLOUD_PROVIDER:-}');
});

const mcpEnv = (argv) => JSON.parse(argv.slice(argv.indexOf('--mcp-config\n') + '--mcp-config\n'.length).split('\n')[0]).mcpServers.cloud.env;

test('a shell-set CLOUDY_CLOUD_EGRESS_ALLOW reaches the MCP server env; unset stays absent', () => {
  const d = repo('https://github.com/test/repo.git');
  for (const [label, extraEnv] of [['a list', { CLOUDY_CLOUD_EGRESS_ALLOW: 'example.com' }], ['empty', { CLOUDY_CLOUD_EGRESS_ALLOW: '' }]]) {
    const r = run({ config: full, cwd: d, extraEnv });
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.equal(mcpEnv(r.argv).CLOUDY_CLOUD_EGRESS_ALLOW, '${CLOUDY_CLOUD_EGRESS_ALLOW:- }', label);
  }
  const r = run({ config: full, cwd: d });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(mcpEnv(r.argv).CLOUDY_CLOUD_EGRESS_ALLOW, undefined);
});

test('a set-but-empty CLOUDY_CLOUD_EGRESS_ALLOW expands to a value the server validator refuses', () => {
  const expanded = spawnSync('/bin/sh', ['-c', 'printf %s "${CLOUDY_CLOUD_EGRESS_ALLOW:- }"'], { env: { CLOUDY_CLOUD_EGRESS_ALLOW: '' }, encoding: 'utf8' }).stdout;
  assert.equal(expanded, ' '); // still set, never collapses to absent
  assert.match(egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: expanded }).error ?? '', /CLOUDY_CLOUD_EGRESS_ALLOW is set but lists no hosts/);
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
    // --check-only is passed through to install.sh, which runs every check; with no keys saved it ends in a failed verdict
    const r = spawnSync('/bin/sh', [launcher, flag, '--check-only'], { cwd: dir, env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir }, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /\[2\/4\] Provider/); // the Tools step may be skipped when all is well
    assert.match(r.stdout, /Check failed/);
  }
});

test('missing keys without a terminal: message and exit 1, no prompt', () => {
  const r = run({ config: '' });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /Run setup now/);
});

test('--help, -h and help print Cloudy Cloud help; --version prints the package version; claude is not started', () => {
  for (const a of ['--help', '-h', 'help']) {
    const r = spawnSync('/bin/sh', [launcher, a], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmpdir() } });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: cloudy-cloud/);
    assert.match(r.stdout, /Claude Code's own options: claude --help/);
  }
  const v = spawnSync('/bin/sh', [launcher, '--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmpdir() } });
  const [l1, l2] = v.stdout.trim().split('\n');
  assert.equal(l1, JSON.parse(readFileSync('package.json', 'utf8')).version);
  assert.equal(l2, `installed at ${realpathSync(resolve('.'))}`);
});

test('--version shows the install path with ~ for the home directory', () => {
  const home = dirname(realpathSync(resolve('.')));
  const v = spawnSync('/bin/sh', [launcher, '--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home } });
  assert.equal(v.status, 0);
  assert.equal(v.stdout.trim().split('\n')[1], `installed at ~/${basename(realpathSync(resolve('.')))}`);
});

test('top-level help lists setup with its --more and --check-only flags, within 80 columns', () => {
  const r = spawnSync('/bin/sh', [launcher, '--help'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmpdir() } });
  assert.match(r.stdout, /^  setup \[--more\] \[--check-only\]/m);
});

// Runs a command in a pty; returns the merged terminal transcript and exit code.
const pty = (spec) => {
  const r = spawnSync('python3', [resolve('test/pty_run.py'), JSON.stringify({ timeout: 30, steps: [], ...spec })], { encoding: 'utf8' });
  const m = r.stdout.match(/EXIT:(\d+)\s*$/);
  return { text: r.stdout, code: m ? Number(m[1]) : -1 };
};

test('a bare-word typo on a colour terminal prints a styled error line and a Next line', () => {
  const env = { PATH: '/usr/bin:/bin', HOME: tmpdir(), TERM: 'xterm-256color', LANG: 'en_US.UTF-8' };
  const r = pty({ cmd: ['/bin/sh', launcher, 'ls'], env });
  assert.equal(r.code, 2);
  assert.match(r.text, /\x1b\[31m✖\x1b\[0m cloudy-cloud: "ls" is not a command\./);
  assert.match(r.text, /\x1b\[1;34m→ Next: cloudy-cloud --help\x1b\[0m/);
  assert.match(r.text, /› To send it to Claude as a prompt: cloudy-cloud -p "ls"/);
  const n = pty({ cmd: ['/bin/sh', launcher, 'ls'], env: { ...env, NO_COLOR: '1' } });
  assert.match(n.text, / {2}✖ cloudy-cloud: "ls" is not a command\.\n {2}→ Next: cloudy-cloud --help/);
  assert.doesNotMatch(n.text, /\x1b\[/);
});

test('mcp subcommand runs src/mcp-cli.mjs with the remaining arguments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-mcp-'));
  const argvFile = join(dir, 'argv');
  writeFileSync(join(dir, 'node'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\n`);
  chmodSync(join(dir, 'node'), 0o755);
  const r = spawnSync('/bin/sh', [launcher, 'mcp', 'ls'], { encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir } });
  assert.equal(r.status, 0);
  const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
  assert.match(argv[0], /src\/mcp-cli\.mjs$/);
  assert.equal(argv[1], 'ls');
});

test("Claude Code's own mcp subcommands still go to claude", () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-mcp-'));
  for (const [cmd, file] of [['node', 'node-argv'], ['claude', 'claude-argv']]) {
    writeFileSync(join(dir, cmd), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, file)}"\n`);
    chmodSync(join(dir, cmd), 0o755);
  }
  const cfg = join(dir, 'env');
  writeFileSync(cfg, full);
  const env = { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, CLOUDY_CLOUD_CONFIG: cfg };
  for (const args of [['mcp', 'list'], ['mcp', 'add', 'x', '--', 'npx', 'y'], ['mcp', 'get', 'x']]) {
    const r = spawnSync('/bin/sh', [launcher, ...args], { cwd: repo('https://github.com/test/repo.git'), encoding: 'utf8', env, input: '' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readFileSync(join(dir, 'claude-argv'), 'utf8').endsWith(`${args.join('\n')}\n`), args.join(' '));
    assert.ok(!existsSync(join(dir, 'node-argv')), args.join(' '));
  }
});

test('mcp add <name> --allow-literal goes to src/mcp-cli.mjs with the flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-mcp-'));
  const argvFile = join(dir, 'argv');
  writeFileSync(join(dir, 'node'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\n`);
  chmodSync(join(dir, 'node'), 0o755);
  const r = spawnSync('/bin/sh', [launcher, 'mcp', 'add', 'notion', '--allow-literal'], { encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir } });
  assert.equal(r.status, 0, r.stderr);
  const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
  assert.match(argv[0], /src\/mcp-cli\.mjs$/);
  assert.deepEqual(argv.slice(1), ['add', 'notion', '--allow-literal']);
});

test('self-hosted provider needs the SSH host, not the Instabox key (#41)', () => {
  const claude = `CLAUDE_CODE_OAUTH_TOKEN=${TOK}\n`;
  const ok = run({ config: `CLOUDY_CLOUD_PROVIDER=self-hosted\nCLOUDY_CLOUD_SSH_HOST=me@box\n${claude}`, cwd: repo('https://github.com/test/repo.git') });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.started, true);
  const noHost = run({ config: `CLOUDY_CLOUD_PROVIDER=self-hosted\nINSTABOX_API_KEY=${IBK}\n${claude}` });
  assert.equal(noHost.status, 1);
  assert.match(noHost.stderr, /CLOUDY_CLOUD_SSH_HOST/);
  assert.equal(noHost.started, false);
  // Instabox stays the default when the saved provider is instabox or absent.
  const ib = run({ config: `CLOUDY_CLOUD_PROVIDER=instabox\nCLOUDY_CLOUD_SSH_HOST=me@box\n${claude}` });
  assert.match(ib.stderr, /Instabox API key/);
});

test('boat provider needs BOAT_API_KEY, not the Instabox key', () => {
  const claude = `CLAUDE_CODE_OAUTH_TOKEN=${TOK}\n`;
  const ok = run({ config: `CLOUDY_CLOUD_PROVIDER=boat\nBOAT_API_KEY=boat_test\n${claude}`, cwd: repo('https://github.com/test/repo.git') });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.started, true);
  const noKey = run({ config: `CLOUDY_CLOUD_PROVIDER=boat\nINSTABOX_API_KEY=${IBK}\n${claude}` });
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /Boat API key/);
  assert.equal(noKey.started, false);
  const codex = runHost('codex', `CLOUDY_CLOUD_PROVIDER=boat\nBOAT_API_KEY=boat_test\n`);
  assert.equal(codex.status, 0, codex.stderr);
});

test('e2b provider needs E2B_API_KEY, not the Instabox key', () => {
  const claude = `CLAUDE_CODE_OAUTH_TOKEN=${TOK}\n`;
  const ok = run({ config: `CLOUDY_CLOUD_PROVIDER=e2b\nE2B_API_KEY=e2b_test\nCLOUDY_CLOUD_E2B_TOKEN_ON_BOX=yes\n${claude}`, cwd: repo('https://github.com/test/repo.git') });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.started, true);
  const mcp = JSON.parse(ok.argv.slice(ok.argv.indexOf('--mcp-config\n') + '--mcp-config\n'.length).split('\n')[0]).mcpServers.cloud.env;
  assert.equal(mcp.E2B_API_KEY, '${E2B_API_KEY:-}');
  assert.equal(mcp.CLOUDY_CLOUD_E2B_TOKEN_ON_BOX, '${CLOUDY_CLOUD_E2B_TOKEN_ON_BOX:-}');
  const noKey = run({ config: `CLOUDY_CLOUD_PROVIDER=e2b\nINSTABOX_API_KEY=${IBK}\n${claude}` });
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /E2B API key/);
  assert.equal(noKey.started, false);
});

test('proxy secret names do not count as a Claude token on the e2b provider', () => {
  const r = run({ config: `CLOUDY_CLOUD_PROVIDER=e2b\nE2B_API_KEY=e2b_test\nCLOUDY_CLOUD_PROXY_SECRETS=CLAUDE_CODE_OAUTH_TOKEN\n`, cwd: repo('https://github.com/test/repo.git') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Claude token/);
});

test('self-hosted local mode (a coordinator) needs the Docker socket setting and the socket, not the SSH host (#41)', () => {
  const claude = `CLAUDE_CODE_OAUTH_TOKEN=${TOK}\n`;
  const sock = join(mkdtempSync(join(tmpdir(), 'cc-sock-')), 'docker.sock');
  writeFileSync(sock, '');
  const base = `CLOUDY_CLOUD_PROVIDER=self-hosted\nCLOUDY_CLOUD_SELF_HOSTED_LOCAL=1\n${claude}`;
  const noSetting = run({ config: base });
  assert.equal(noSetting.status, 1);
  assert.match(noSetting.stderr, /CLOUDY_CLOUD_DOCKER_SOCKET/);
  assert.equal(noSetting.started, false);
  const gone = run({ config: `${base}CLOUDY_CLOUD_DOCKER_SOCKET=/nonexistent/docker.sock\n`, socketIn: '/nonexistent/in.sock' });
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /CLOUDY_CLOUD_DOCKER_SOCKET/);
  const ok = run({ config: `${base}CLOUDY_CLOUD_DOCKER_SOCKET=/run/user/1000/docker.sock\n`, socketIn: sock, cwd: repo('https://github.com/test/repo.git') });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.started, true);
});

test('proxy secret names may have spaces after commas', () => {
  const r = run({ config: `INSTABOX_API_KEY=${IBK}\nCLOUDY_CLOUD_PROXY_SECRETS=PARTICLE_API_KEY, CLAUDE_CODE_OAUTH_TOKEN\n`, cwd: repo('https://github.com/test/repo.git') });
  assert.equal(r.status, 0, r.stderr);
});

test('proxy secret names do not count as a Claude token on the self-hosted provider', () => {
  const r = run({ config: `CLOUDY_CLOUD_PROVIDER=self-hosted\nCLOUDY_CLOUD_SSH_HOST=h\nCLOUDY_CLOUD_PROXY_SECRETS=CLAUDE_CODE_OAUTH_TOKEN\n`, cwd: repo('https://github.com/test/repo.git') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Claude token/);
});

test('proxy secret names do not count as a Claude token on the boat provider', () => {
  const r = run({ config: `CLOUDY_CLOUD_PROVIDER=boat\nBOAT_API_KEY=boat_test\nCLOUDY_CLOUD_PROXY_SECRETS=CLAUDE_CODE_OAUTH_TOKEN\n`, cwd: repo('https://github.com/test/repo.git') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Claude token/);
});

test('CLOUDY_CLOUD_BIN names this launcher, an existing executable, even when it is not on PATH (#46)', () => {
  const r = run({ config: full, cwd: repo('https://github.com/test/repo.git') });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.bin, join(resolve('.'), 'bin/cloudy-cloud'));
  accessSync(r.bin, constants.X_OK);
});

test('--strict-mcp-config is passed only on a coordinator, so a repo .mcp.json cannot block it on an approval prompt (#44)', () => {
  const d = repo('https://github.com/test/repo.git');
  assert.doesNotMatch(run({ config: full, cwd: d }).argv, /--strict-mcp-config/);
  const r = run({ config: full, cwd: d, extraEnv: { CLOUDY_CLOUD_COORDINATOR: '1' } });
  assert.match(r.argv, /^--strict-mcp-config$/m);
});

test('a coordinator runs Claude with permission checks off, keeps the Workflow deny and gains Agent; a laptop session does not (#88)', () => {
  const d = repo('https://github.com/test/repo.git');
  const laptop = run({ config: full, cwd: d });
  assert.doesNotMatch(laptop.argv, /--dangerously-skip-permissions|--permission-mode/);
  assert.match(laptop.argv, /"deny":\["Agent","Workflow"\]/);
  const r = run({ config: full, cwd: d, extraEnv: { CLOUDY_CLOUD_COORDINATOR: '1' } });
  assert.match(r.argv, /^--dangerously-skip-permissions$/m);
  assert.match(r.argv, /"deny":\["Workflow"\]/);
  assert.match(r.argv, /permission checks are off/);
  assert.match(r.argv, /built-in Agent tool is enabled/);
  // The deadline reminder hook is in the coordinator's settings only, for both events, and takes the
  // event name as an argument so the hook never parses stdin.
  const settings = JSON.parse(r.argv.slice(r.argv.indexOf('--settings\n') + '--settings\n'.length).split('\n')[0]);
  for (const event of ['UserPromptSubmit', 'PostToolUse']) {
    assert.match(settings.hooks?.[event]?.[0]?.hooks?.[0]?.command ?? '', new RegExp(`deadline-hook\\.sh" ${event}$`), event);
    assert.equal(settings.hooks[event][0].hooks[0].type, 'command');
  }
  assert.doesNotMatch(laptop.argv.slice(laptop.argv.indexOf('--settings\n')), /"hooks"/, 'the laptop settings carry no hooks key');
});

test('an install path with a character the hook command cannot quote skips the deadline hooks with a one-line note', async () => {
  const hookTest = async (mark) => {
    const bad = mkdtempSync(join(tmpdir(), `cc-${mark}-`));
    mkdirSync(join(bad, 'bin'), { recursive: true });
    cpSync(launcher, join(bad, 'bin', 'cloudy-cloud'));
    cpSync(resolve('bin/migrate-config.sh'), join(bad, 'bin', 'migrate-config.sh'));
    chmodSync(join(bad, 'bin', 'cloudy-cloud'), 0o755);
    const dir = mkdtempSync(join(tmpdir(), 'cc-launcher-'));
    const argvFile = join(dir, 'argv');
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\n`);
    chmodSync(join(dir, 'claude'), 0o755);
    const cfg = join(dir, 'env');
    writeFileSync(cfg, full);
    const r = spawnSync('/bin/sh', [join(bad, 'bin', 'cloudy-cloud')], { cwd: repo('https://github.com/test/repo.git'), env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, CLOUDY_CLOUD_CONFIG: cfg, CLOUDY_CLOUD_COORDINATOR: '1' }, input: '', encoding: 'utf8' });
    return { ...r, argv: existsSync(argvFile) ? readFileSync(argvFile, 'utf8') : '' };
  };
  for (const mark of ['has$dollar', 'has`tick`']) {
    const r = await hookTest(mark);
    assert.equal(r.status, 0, `${mark}: ${r.stderr}`);
    assert.match(r.stderr, /the deadline hook is off/, mark);
    assert.doesNotMatch(r.argv, /"hooks"|deadline-hook/, mark);
  }
});

test('only CLOUDY_CLOUD_COORDINATOR=1 marks a coordinator: "0" and "false" keep the laptop behaviour', () => {
  const d = repo('https://github.com/test/repo.git');
  for (const v of ['0', 'false']) {
    const r = run({ config: full, cwd: d, extraEnv: { CLOUDY_CLOUD_COORDINATOR: v } });
    assert.match(r.argv, /"deny":\["Agent","Workflow"\]/, v);
    assert.doesNotMatch(r.argv, /--dangerously-skip-permissions|--strict-mcp-config|deadline-hook|"hooks"/, v);
    assert.doesNotMatch(r.argv, /permission checks are off|built-in Agent tool is enabled/, v);
  }
});

test('shell subcommand runs src/shell.mjs and help lists it', () => {
  const h = spawnSync('/bin/sh', [launcher, '--help'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmpdir() } });
  assert.match(h.stdout, /shell <agent> \[-- cmd\]/);
  const r = spawnSync('/bin/sh', [launcher, 'shell'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir() } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: cloudy-cloud shell/);
});

test('display subcommand runs src/display.mjs and help lists it', () => {
  const h = spawnSync('/bin/sh', [launcher, '--help'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmpdir() } });
  assert.match(h.stdout, /display <agent>/);
  const r = spawnSync('/bin/sh', [launcher, 'display'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir() } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: cloudy-cloud display/);
});

// A host subcommand starts without a Claude token, but says what the default worker needs and the exact profile to pass.
function runHost(sub, config, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-host-'));
  const argvFile = join(dir, 'argv');
  for (const bin of ['codex', 'opencode', 'pi']) {
    writeFileSync(join(dir, bin), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\n`);
    chmodSync(join(dir, bin), 0o755);
  }
  const cfg = join(dir, 'env');
  writeFileSync(cfg, config);
  const r = spawnSync('/bin/sh', [launcher, sub], { cwd: repo('https://github.com/test/repo.git'), env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, CLOUDY_CLOUD_CONFIG: cfg, CLOUDY_CLOUD_OPENCODE_BIN: join(dir, 'opencode'), ...extraEnv }, input: '', encoding: 'utf8' });
  return { ...r, argv: existsSync(argvFile) ? readFileSync(argvFile, 'utf8') : '' };
}

for (const sub of ['codex', 'opencode']) {
  test(`${sub} host with no Claude token starts, and names the profile to pass`, () => {
    const r = runHost(sub, `INSTABOX_API_KEY=${IBK}\nCLOUDY_CLOUD_PROXY_SECRETS=OPENAI_API_KEY\n`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /No Claude token is saved/);
    assert.match(r.stderr, /Next step: .*profile/);
    assert.match(r.stderr, /profile: codex/);
    assert.notEqual(r.argv, '');
  });
}

test('codex host with a Claude token prints no worker warning', () => {
  const r = runHost('codex', full);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /No Claude token/);
});

test('host with no Claude token and no other worker key says to run setup', () => {
  const r = runHost('codex', `INSTABOX_API_KEY=${IBK}\n`);
  assert.match(r.stderr, /No Claude token is saved/);
  assert.match(r.stderr, /cloudy-cloud setup/);
});

// `<command> --help` and `help <command>` print that command's help (80 columns at most), exit 0 and never start anything.
const helpCommands = ['setup', 'coordinator', 'coordinator start', 'coordinator status', 'shell', 'display', 'open', 'mcp', 'protect', 'doctor', 'dashboard', 'machines', 'branches'];
test('every help screen fits 80 columns and --help / help <command> never run the command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-help-'));
  const env = { PATH: process.env.PATH, HOME: dir, CLOUDY_CLOUD_CONFIG: join(dir, 'none') };
  const screens = [['--help']];
  for (const c of helpCommands) { screens.push([...c.split(' '), '--help'], ['help', ...c.split(' ')]); }
  for (const args of screens) {
    const r = spawnSync('/bin/sh', [launcher, ...args], { cwd: dir, encoding: 'utf8', env, input: '', timeout: 10000 });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stderr, '', args.join(' '));
    assert.match(r.stdout, /Usage: cloudy-cloud/, args.join(' '));
    for (const line of r.stdout.split('\n')) assert.ok(line.length <= 80, `${args.join(' ')}: ${line.length} columns: ${line}`);
  }
  const c = spawnSync('/bin/sh', [launcher, 'coordinator', '--help'], { encoding: 'utf8', env });
  assert.match(c.stdout, /^ {2}status NAME/m);
  const s = spawnSync('/bin/sh', [launcher, 'setup', '--help'], { encoding: 'utf8', env });
  assert.doesNotMatch(s.stdout + s.stderr, /\[1\/4\]|not set up/);
});

test('options after a known subcommand still show that command\'s help', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-help-'));
  const env = { PATH: process.env.PATH, HOME: dir, CLOUDY_CLOUD_CONFIG: join(dir, 'none') };
  for (const args of [['machines', 'stop', '--all', '--help'], ['branches', 'prune', '--dry-run', '--help'], ['help', 'machines', 'stop']]) {
    const r = spawnSync('/bin/sh', [launcher, ...args], { cwd: dir, encoding: 'utf8', env, input: '', timeout: 10000 });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stdout, /Usage: cloudy-cloud/, args.join(' '));
  }
  const r = spawnSync('/bin/sh', [launcher, 'help', 'machines', 'stop', 'extra'], { cwd: dir, encoding: 'utf8', env, input: '', timeout: 10000 });
  assert.equal(r.status, 2, 'a non-option extra still has no help');
});

test('one bare word that is not a command is refused with the way to send it as a prompt', () => {
  const r = spawnSync('/bin/sh', [launcher, 'ls'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir() } });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'cloudy-cloud: "ls" is not a command. See: cloudy-cloud --help\nTo send it to Claude as a prompt: cloudy-cloud -p "ls"\n');
});

test("Claude Code's own subcommands still reach claude; any other bare word is refused", () => {
  for (const word of ['auth', 'update']) {
    const r = run({ config: full, cwd: repo('https://github.com/test/repo.git'), args: [word] });
    assert.equal(r.started, true, `${word}: ${r.stderr}`);
    assert.match(r.argv, new RegExp(`^${word}$`, 'm'));
  }
  const r = run({ config: full, cwd: repo('https://github.com/test/repo.git'), args: ['ls'] });
  assert.equal(r.status, 2);
  assert.equal(r.started, false);
});

// Review fixes: help routing must not capture arguments that belong to claude or to a command.
const repoOrigin = 'https://github.com/test/repo.git';
const reachesClaude = (...args) => { const r = run({ config: full, cwd: repo(repoOrigin), args }); return r.started && args.every((a) => r.argv.split('\n').includes(a)); };
const helpRun = (...args) => spawnSync('/bin/sh', [launcher, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir(), CLOUDY_CLOUD_CONFIG: '/nonexistent' }, input: '' });

test('arguments that belong to claude are not taken as typos or help requests', () => {
  assert.ok(reachesClaude('summarize', '--model', 'sonnet'));
  assert.ok(reachesClaude('project', 'purge', '--help'));
  assert.ok(reachesClaude('help', '-p'));
  assert.ok(reachesClaude('help', '--print'));
  assert.ok(reachesClaude('mcp', 'list', '-h'));
  assert.ok(reachesClaude('mcp', 'get', '--help'));
});

test('--help counts only as the last argument before any --; mcp help only for add|ls|rm or no subcommand', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-help2-'));
  const r = spawnSync('/bin/sh', [launcher, 'coordinator', 'start', 'x', '--repo', 'U', '--task', '--help', '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, CLOUDY_CLOUD_CONFIG: join(dir, 'none') }, input: '' });
  assert.doesNotMatch(r.stdout, /^Usage: /m);
  assert.equal(helpRun('mcp', 'add', '--help').status, 0);
  assert.match(helpRun('mcp', '--help').stdout, /Usage: cloudy-cloud mcp/);
  assert.match(helpRun('--setup', '--help').stdout, /Usage: cloudy-cloud setup/);
});

test('help for an unknown topic is a short error with exit 2; host commands get a one-line entry', () => {
  for (const args of [['help', 'nope'], ['help', 'coordinator', 'typo'], ['help', 'coordinator', 'constructor'], ['help', 'constructor']]) {
    const r = helpRun(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /no help for .* See: cloudy-cloud --help/);
  }
  const c = helpRun('help', 'codex');
  assert.equal(c.status, 0);
  assert.match(c.stdout, /^cloudy-cloud codex starts the Codex CLI.*cloudy-cloud codex --help\n$/);
});

test('the typo hint omits the -p suggestion for words that are unsafe to paste', () => {
  const r = helpRun('a"b$c');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /is not a command/);
  assert.doesNotMatch(r.stderr, /To send it to Claude/);
});
