import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from '../src/coordinator.mjs';
import { makeUi } from '../src/ui.mjs';
import { safeText, redact } from '../src/terminal.mjs';

const IBK = 'ibk_REALKEY_0123456789';
const TOK = 'sk-ant-oat01-REALTOKEN0123';
const PROV = 'sk-or-PROVIDERKEY0123';
const applied = { proxy: { revision: 2, appliedRevision: 2 }, guest: { revision: 2, appliedRevision: 2 } };

test('coordinator help is local, with a guide for each command', async () => {
  for (const args of [['--help'], ['-h'], ...['image', 'start', 'attach', 'ls', 'stop', 'finish'].map((cmd) => [cmd, '--help'])]) {
    const output = [];
    await main(args, { env: {}, out: (s) => output.push(s), get sdk() { throw new Error('must not load SDK'); } });
    assert.match(output.join('\n'), /Usage: cloudy-cloud coordinator/);
    assert.doesNotMatch(output.join('\n'), /\x1b|claude-cloud/);
  }
});

test('invalid arguments are rejected before keys or the SDK are used', async () => {
  for (const args of [
    ['start'], ['start', 'Bad'], ['start', 'boss', '--repo'],
    ['start', 'boss', '--repo', 'https://github.com/o/r', '--branch'],
    ['start', 'boss', '--repo', 'https://github.com/o/r', '--repo', 'https://github.com/o/s'],
    ['start', 'boss', '--repo', 'https://github.com/o/r', '--typo', 'x'],
    ['ls', '--all'], ['image', '--save', '--save'], ['stop'], ['stop', 'a', 'b'],
    ['attach', 'Bad'], ['finish', '--nope'], ['constructor'], ['--help', 'extra'],
  ]) {
    await assert.rejects(main(args, { env: {}, get sdk() { throw new Error('SDK touched'); } }), (e) => {
      assert.match(e.message, /cloudy-cloud coordinator/);
      assert.doesNotMatch(e.message, /INSTABOX_API_KEY|SDK touched/);
      return true;
    }, args.join(' '));
  }
});

function fixture({ machines = [], snapshot = 'sn_1' } = {}) {
  const log = { create: [], cmds: [], writes: [], killed: [], snapshots: [], fetches: [], out: [] };
  const dir = mkdtempSync(join(tmpdir(), 'cc-coord-'));
  const configFile = join(dir, 'env');
  const mk = (id, name, metadata) => ({ sandboxId: id, name, metadata, state: 'running', startedAt: new Date('2026-01-02T03:04:05Z') });
  const sandbox = (id, name) => ({
    sandboxId: id,
    getInfo: async () => ({ name }),
    files: { write: async (p, d) => { log.writes.push({ p, d }); } },
    commands: { run: async (cmd, o) => { log.cmds.push(cmd); return { stdout: '/data/home', stderr: '', exitCode: 0 }; } },
    createSnapshot: async (o) => { log.snapshots.push(o); return { id: 'sn_new', status: 'pending' }; },
    kill: async () => { log.killed.push(id); return true; },
  });
  const sdk = { Sandbox: {
    async create(template, opts) { log.create.push({ template, opts }); return sandbox('m_new', opts.name ?? 'sbx-abc'); },
    async list({ metadata }) { return machines.filter((m) => Object.entries(metadata).every(([k, v]) => m.metadata[k] === v)); },
    async connect(id) { return sandbox(id, 'img-1'); },
    async getSnapshot(id) { return { id, status: 'ready' }; },
    async kill(id) { log.killed.push(id); return true; },
  } };
  const fetchFn = async (url, init) => { log.fetches.push({ url, ...init }); return init.method === 'PATCH' ? new Response('{}') : Response.json(applied); };
  const env = { INSTABOX_API_KEY: IBK, CLAUDE_CODE_OAUTH_TOKEN: TOK, OPENROUTER_API_KEY: PROV, CLOUDY_CLOUD_CONFIG: configFile, ...(snapshot && { CLOUDY_CLOUD_COORDINATOR_SNAPSHOT: snapshot }), PATH: '/x' };
  const deps = { sdk, fetchFn, env, root: resolve('.'), sleep: async () => {}, out: (s) => log.out.push(s) };
  return { log, deps, configFile, mk };
}

test('image creates a labelled machine, installs cloudy-cloud and prints the login steps', async () => {
  const f = fixture();
  await main(['image'], f.deps);
  assert.equal(f.log.create[0].opts.metadata.role, 'coordinator-image');
  assert.ok(f.log.cmds.some((c) => /npm install/.test(c)));
  assert.ok(f.log.fetches.some((x) => x.method === 'PATCH' && /secrets/.test(x.url)));
  const text = f.log.out.join('\n');
  assert.match(text, /npx --yes instabox@latest ssh sbx-abc/);
  assert.match(text, /claude auth login/);
  assert.match(text, /coordinator image --save/);
});

test('image --save records the snapshot id and deletes the image machine', async () => {
  const f = fixture({ snapshot: '' });
  f.deps.sdk.Sandbox.list = async () => [f.mk('m_img', 'img-1', { role: 'coordinator-image' })];
  await main(['image', '--save'], f.deps);
  assert.equal(f.log.snapshots.length, 1);
  assert.match(readFileSync(f.configFile, 'utf8'), /^CLOUDY_CLOUD_COORDINATOR_SNAPSHOT=sn_new$/m);
  assert.equal(statSync(f.configFile).mode & 0o777, 0o600);
  assert.deepEqual(f.log.killed, ['m_img']);
});

test('start without a snapshot fails and points to coordinator image', async () => {
  const f = fixture({ snapshot: '' });
  await assert.rejects(main(['start', 'boss', '--repo', 'https://github.com/o/r'], f.deps), /coordinator image/);
  assert.equal(f.log.create.length, 0);
});

test('start creates from the snapshot, attaches GH_TOKEN, writes keys by file and starts tmux', async () => {
  const f = fixture();
  await main(['start', 'boss', '--repo', 'https://github.com/o/r', '--branch', 'main'], f.deps);
  const { template, opts } = f.log.create[0];
  assert.equal(template, 'sn_1');
  assert.equal(opts.autoSuspendMs, 0);
  assert.deepEqual(opts.metadata, { purpose: 'cloudy-cloud', role: 'coordinator', name: 'boss' });
  assert.ok(f.log.fetches.some((x) => x.method === 'PATCH' && x.body.includes('GH_TOKEN')));
  const w = f.log.writes.find((x) => x.p === '/data/home/.config/cloudy-cloud/env');
  assert.ok(w.d.includes(`INSTABOX_API_KEY=${IBK}`) && w.d.includes(`CLAUDE_CODE_OAUTH_TOKEN=${TOK}`) && w.d.includes(`OPENROUTER_API_KEY=${PROV}`));
  assert.ok(!w.d.includes('PATH='));
  for (const c of f.log.cmds) for (const secret of [IBK, TOK, PROV]) assert.ok(!c.includes(secret), `secret in command: ${c}`);
  assert.ok(f.log.cmds.some((c) => /chmod 600/.test(c)));
  assert.ok(f.log.cmds.some((c) => /git clone -q -b 'main' 'https:\/\/github.com\/o\/r'/.test(c)));
  assert.ok(f.log.cmds.some((c) => /tmux new-session -d -s claude/.test(c) && /cloudy-cloud --remote-control .*boss/.test(c)));
  // Claude Code's first-run screens would block Remote Control on an unattended machine; they are marked done first.
  const prep = f.log.cmds.findIndex((c) => c.includes('hasCompletedOnboarding'));
  const tmux = f.log.cmds.findIndex((c) => /tmux new-session/.test(c));
  assert.ok(prep > -1 && prep < tmux, 'first-run setup is marked done before Claude starts');
  // A fresh machine has no git identity; the coordinator needs one to commit merges and its report.
  assert.ok(f.log.cmds.some((c) => c.includes('git config --global user.name') && c.includes('git config --global user.email')), 'git identity set');
  for (const name of ['SKILL.md', 'handoff.md', 'brief-template.md']) assert.ok(f.log.writes.some((w) => w.p === `/data/home/.claude/skills/cloud-fleet/${name}`), `skill file ${name} uploaded`);
  for (const k of ['hasTrustDialogAccepted', 'fullscreenUpsellSeenCount', 'hasSeenAutoDefaultNotice']) assert.ok(f.log.cmds[prep].includes(k), k);
  const text = f.log.out.join('\n');
  assert.match(text, /"boss"/);
  assert.match(text, /coordinator attach boss/);
});

test('start --task uploads ~/task.md by file and launches with it as the first prompt', async () => {
  const f = fixture();
  const task = "do it; $(rm -rf /) 'quoted'";
  await main(['start', 'boss', '--repo', 'https://github.com/o/r', '--task', task], f.deps);
  assert.ok(f.log.writes.find((x) => x.p === '/data/home/task.md').d.endsWith(`\n\n${task}`));
  for (const c of f.log.cmds) assert.ok(!c.includes('rm -rf /'), `task text in command: ${c}`);
  const tmux = f.log.cmds.find((c) => /tmux new-session/.test(c));
  assert.ok(tmux.includes(`--remote-control '\\''boss'\\'' "$(cat '\\''/data/home/task.md'\\'')"`), tmux);
  assert.match(f.log.out.join('\n'), /started on the task/);
});

test('start --task-file reads the file; empty or over 100 KB tasks are refused before any machine', async () => {
  const f = fixture();
  const file = join(mkdtempSync(join(tmpdir(), 'cc-task-')), 't.md');
  writeFileSync(file, 'from file');
  await main(['start', 'boss', '--repo', 'https://github.com/o/r', '--task-file', file], f.deps);
  assert.ok(f.log.writes.find((x) => x.p === '/data/home/task.md').d.endsWith('\n\nfrom file'));
  const g = fixture();
  await assert.rejects(main(['start', 'boss', '--repo', 'https://github.com/o/r', '--task', '  '], g.deps), /empty/);
  await assert.rejects(main(['start', 'boss', '--repo', 'https://github.com/o/r', '--task', 'x'.repeat(100_001)], g.deps), /larger/);
  assert.equal(g.log.create.length, 0);
});

test('start --json prints name, machine, remoteControlName and attach', async () => {
  const f = fixture();
  await main(['start', 'boss', '--repo', 'https://github.com/o/r', '--json'], f.deps);
  assert.deepEqual(JSON.parse(f.log.out.join('\n')), { name: 'boss', machine: 'coord-boss', remoteControlName: 'boss', attach: 'npx --yes instabox@latest ssh coord-boss -- tmux attach -t claude' });
});

test('start rejects bad repo urls and duplicate names', async () => {
  const f = fixture({ machines: [{ sandboxId: 'm1', name: 'coord-boss', metadata: { role: 'coordinator', name: 'boss' } }] });
  await assert.rejects(main(['start', 'x', '--repo', 'git@github.com:o/r.git'], f.deps), /--repo/);
  await assert.rejects(main(['start', 'boss', '--repo', 'https://github.com/o/r'], f.deps), /already exists/);
});

test('ls lists only coordinators', async () => {
  const f = fixture({ machines: [
    { sandboxId: 'm1', name: 'coord-boss', state: 'running', startedAt: new Date('2026-01-02T03:04:05Z'), metadata: { role: 'coordinator', name: 'boss' } },
    { sandboxId: 'm2', name: 'worker-1', state: 'running', startedAt: new Date(), metadata: { purpose: 'cloudy-cloud', owner: 'x' } },
    { sandboxId: 'm3', name: 'img', state: 'running', startedAt: new Date(), metadata: { role: 'coordinator-image' } },
  ] });
  await main(['ls'], f.deps);
  const text = f.log.out.join('\n');
  assert.match(text, /boss\trunning\t2026-01-02T03:04:05.000Z\tcoord-boss/);
  assert.ok(!/worker-1|img/.test(text));
});

test('stop deletes only the named coordinator', async () => {
  const f = fixture({ machines: [
    { sandboxId: 'm1', name: 'coord-a', metadata: { role: 'coordinator', name: 'a' } },
    { sandboxId: 'm2', name: 'coord-b', metadata: { role: 'coordinator', name: 'b' } },
  ] });
  await main(['stop', 'b'], f.deps);
  assert.deepEqual(f.log.killed, ['m2']);
  assert.match(f.log.out.join('\n'), /cleanup process/);
  await assert.rejects(main(['stop', 'zzz'], f.deps), /No coordinator named zzz/);
});

test('attach prints the ssh command', async () => {
  const f = fixture({ machines: [{ sandboxId: 'm1', name: 'coord-a', metadata: { role: 'coordinator', name: 'a' } }] });
  await main(['attach', 'a'], f.deps);
  assert.equal(f.log.out[0], 'npx --yes instabox@latest ssh coord-a -- tmux attach -t claude');
});

test('terminal control characters and key-shaped text are removed from displayed values', () => {
  assert.equal(safeText('a\x1b[2Jb\tc\r'), 'ab c');
  assert.equal(redact('HTTP 401 ibk_FAKEKEY123 sk-ant-test123'), 'HTTP 401 [redacted] [redacted]');
});

test('ls strips control characters from names and stacks records in a narrow terminal', async () => {
  const m = { sandboxId: 'm1', name: 'coord-a', state: 'running', startedAt: '2026-01-02T03:04:05Z', metadata: { role: 'coordinator', name: 'a\x1b[2J\nforged' } };
  const f = fixture({ machines: [m] });
  await main(['ls'], f.deps);
  assert.match(f.log.out[1], /^a forged\trunning\t/);
  assert.doesNotMatch(f.log.out.join(''), /\x1b/);
  f.log.out.length = 0;
  f.deps.ui = makeUi({ tty: true, env: { TERM: 'xterm' }, cols: 40 });
  await main(['ls'], f.deps);
  assert.match(f.log.out.join('\n').replace(/\x1b\[[0-9;]*m/g, ''), /a forged \[running\]\n {4}Machine: coord-a\n {4}Created: 2026-01-02T03:04:05\.000Z/);
});

test('empty list on a terminal points to image or start; piped output stays "No coordinators."', async () => {
  for (const snapshot of ['', 'sn_1']) {
    const f = fixture({ snapshot });
    f.deps.ui = makeUi({ tty: true, env: { TERM: 'xterm' }, cols: 80 });
    await main(['ls'], f.deps);
    const text = f.log.out.join('\n');
    assert.match(text, /No coordinators yet/);
    assert.ok(text.includes(snapshot ? 'coordinator start NAME' : 'coordinator image'));
    f.log.out.length = 0;
    f.deps.ui = makeUi({ tty: false });
    await main(['ls'], f.deps);
    assert.deepEqual(f.log.out, ['No coordinators.']);
  }
});

test('progress goes only to an interactive stderr and never contains keys', async () => {
  for (const isTTY of [true, false]) {
    const f = fixture();
    const progress = [];
    f.deps.stderr = { isTTY, write: (x) => progress.push(x) };
    await main(['start', 'boss', '--repo', 'https://github.com/o/r'], f.deps);
    assert.equal(progress.length, isTTY ? 4 : 0);
    if (isTTY) assert.match(progress.join(''), /Creating[\s\S]*Connecting[\s\S]*Cloning[\s\S]*Starting/);
    for (const key of [IBK, TOK, PROV]) assert.ok(!progress.join('').includes(key));
  }
});

test('launcher: coordinator goes to the script; plain cloudy-cloud still starts claude', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-coord-l-'));
  const stub = join(dir, 'claude');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\n`);
  chmodSync(stub, 0o755);
  const cfg = join(dir, 'env');
  writeFileSync(cfg, `INSTABOX_API_KEY=${IBK}\nCLAUDE_CODE_OAUTH_TOKEN=${TOK}\n`);
  const env = { PATH: `${dir}:${process.env.PATH}`, HOME: dir, CLOUDY_CLOUD_CONFIG: cfg };
  const sh = (args, extra = {}) => spawnSync('/bin/sh', [resolve('bin/cloudy-cloud'), ...args], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' });
  const r = sh(['coordinator']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: cloudy-cloud coordinator/);
  assert.ok(!existsSync(join(dir, 'argv')));
  assert.equal(sh([]).status, 0);
  const plain = readFileSync(join(dir, 'argv'), 'utf8');
  assert.ok(!/cloud coordinator/.test(plain));
  sh(['--remote-control', 'boss'], { CLOUDY_CLOUD_COORDINATOR: '1' });
  const coord = readFileSync(join(dir, 'argv'), 'utf8');
  assert.match(coord, /Never print, share, commit or send these keys/);
  assert.match(coord, /--remote-control\nboss/);
});

test('tmux is installed after refreshing package lists (Instabox images ship without them)', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/coordinator.mjs', import.meta.url), 'utf8');
  assert.match(src, /apt-get update[^\n]*&&[^\n]*apt-get install -y[^\n]*tmux/);
});

test('start uploads the laptop cloudy-cloud as a bundle and never clones the tool from GitHub', async () => {
  const f = fixture();
  await main(['start', 'boss', '--repo', 'https://github.com/o/r'], f.deps);
  const w = f.log.writes.find((x) => x.p === '/data/home/cloudy-cloud.bundle');
  assert.ok(w && w.d.length > 0, 'bundle uploaded');
  const i = f.log.cmds.findIndex((c) => /git init -q cloudy-cloud/.test(c) && /git fetch -q \/data\/home\/cloudy-cloud\.bundle refs\/cc-keep\//.test(c) && /checkout -q --detach/.test(c) && /npm install/.test(c));
  assert.ok(i > -1, 'recreated from the bundle');
  assert.ok(f.log.cmds.findIndex((c) => c.includes('gh auth setup-git')) < i);
  const clones = f.log.cmds.filter((c) => /git clone/.test(c));
  assert.equal(clones.length, 1, 'only the work repo is cloned');
  assert.match(clones[0], /github\.com\/o\/r/);
});


// ---- how it looks ----
import { makeUi } from '../src/ui.mjs';
const tty = (env = {}) => makeUi({ tty: true, cols: 80, env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8', ...env } });
const ANSI = /\u001b\[/;
const plainText = (s) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

test('ui: plain when piped, NO_COLOR, CLICOLOR=0 or TERM=dumb; styled on a colour terminal', () => {
  assert.equal(makeUi({ tty: false, env: { TERM: 'xterm' } }).on, false);
  for (const env of [{ NO_COLOR: '1' }, { CLICOLOR: '0' }, { TERM: 'dumb' }]) assert.equal(tty(env).on, false, JSON.stringify(env));
  assert.equal(tty().on, true);
  assert.ok(!ANSI.test(makeUi({ tty: false }).ok('x', 'y')));
  assert.match(tty().ok('Done', 'detail'), /✔/);
  assert.match(tty({ LANG: 'C' }).ok('Done'), /\[ok\]/); // ASCII marks without UTF-8
});

test('ui: relative times', () => {
  const u = tty(), now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(u.rel('2026-01-02T00:00:00Z', now), 'in 24h');
  assert.equal(u.rel('2026-01-01T00:45:00Z', now), 'in 45m');
  assert.equal(u.rel('2025-12-31T22:00:00Z', now), '2h ago');
  assert.equal(u.rel('2026-01-05T00:00:00Z', now), 'in 4d');
});

test('ls on a terminal: aligned table, state colours, relative deadline with the date dim', async () => {
  const f = fixture({ machines: [{ sandboxId: 'm1', name: 'coord-boss', state: 'running', startedAt: new Date(Date.now() - 2 * 3600e3), machine: { deleteAt: new Date(Date.now() + 23 * 3600e3).toISOString() }, metadata: { role: 'coordinator', name: 'boss' } },
    { sandboxId: 'm2', name: 'coord-a', state: 'stopped', startedAt: new Date(), metadata: { role: 'coordinator', name: 'a' } }] });
  f.deps.ui = tty();
  await main(['ls'], f.deps);
  const raw = f.log.out.join('\n'), text = plainText(raw);
  assert.match(raw, /\u001b\[38;5;42mrunning/); // green
  assert.match(text, /NAME\s+STATE\s+STARTED\s+MACHINE\s+DELETES/);
  assert.match(text, /boss\s+running\s+2h ago\s+coord-boss\s+in 23h\s+\d{4}-\d\d-\d\dT\d\d:\d\dZ/);
  assert.match(text, /a\s+stopped\s+.*coord-a\s+never/);
  for (const l of text.split('\n')) assert.ok(l.length <= 80, l);
});

test('start on a terminal shows a Reach it block; --json stays exactly the same', async () => {
  const f = fixture();
  f.deps.ui = tty();
  await main(['start', 'boss', '--repo', 'https://github.com/o/r'], f.deps);
  const text = plainText(f.log.out.join('\n'));
  assert.match(text, /✔ Coordinator boss is running/);
  assert.match(text, /Reach it\n\s+Remote Control\s+open claude\.ai\/code .* "boss"/);
  assert.match(text, /Terminal\s+cloudy-cloud coordinator attach boss\n\s+runs: npx --yes instabox@latest ssh coord-boss -- tmux attach -t claude/);
  const g = fixture();
  g.deps.ui = tty();
  await main(['start', 'boss', '--repo', 'https://github.com/o/r', '--json'], g.deps);
  assert.deepEqual(JSON.parse(g.log.out.join('\n')), { name: 'boss', machine: 'coord-boss', remoteControlName: 'boss', attach: 'npx --yes instabox@latest ssh coord-boss -- tmux attach -t claude' });
});

test('stop and image on a terminal use status lines; piped output has no escapes', async () => {
  const f = fixture({ machines: [{ sandboxId: 'm1', name: 'coord-a', metadata: { role: 'coordinator', name: 'a' } }] });
  f.deps.ui = tty();
  await main(['stop', 'a'], f.deps);
  assert.match(plainText(f.log.out.join('\n')), /✔ Deleted coordinator a {2}machine coord-a/);
  const g = fixture();
  g.deps.ui = tty();
  await main(['image'], g.deps);
  assert.match(plainText(g.log.out.join('\n')), /✔ Image machine sbx-abc is ready/);
  const h = fixture();
  await main(['image'], h.deps); // default ui: stdout is not a terminal under test
  assert.ok(!ANSI.test(h.log.out.join('\n')));
  assert.match(h.log.out.join('\n'), /^Image machine sbx-abc is ready and cloudy-cloud is installed on it\./); // install.sh reads this line
});
