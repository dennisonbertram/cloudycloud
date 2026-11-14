import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main, toolRepoUrl } from '../src/coordinator.mjs';
import { safeText } from '../src/terminal.mjs';
import { redact } from '../src/events.mjs';
import { createFakeProvider } from './fake-provider.mjs';

const IBK = 'ibk_REALKEY_0123456789';
const TOK = 'sk-ant-oat01-REALTOKEN0123';
const PROV = 'sk-or-PROVIDERKEY0123';
const OTHER = 'sk_live_UNRELATED0123'; // an *_API_KEY in the shell that no profile uses
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

function fixture({ machines = [], snapshot = 'sn_1', pane = '' } = {}) {
  const log = { create: [], cmds: [], writes: [], killed: [], snapshots: [], fetches: [], out: [] };
  const dir = mkdtempSync(join(tmpdir(), 'cc-coord-'));
  const configFile = join(dir, 'env');
  const mk = (id, name, metadata) => ({ sandboxId: id, name, metadata, state: 'running', startedAt: new Date('2026-01-02T03:04:05Z') });
  const sandbox = (id, name) => ({
    sandboxId: id,
    getInfo: async () => ({ name }),
    files: { write: async (p, d) => { log.writes.push({ p, d }); } },
    commands: { run: async (cmd, o) => { log.cmds.push(cmd); return { stdout: /capture-pane/.test(cmd) ? pane : '/data/home', stderr: '', exitCode: 0 }; } },
    createSnapshot: async (o) => { log.snapshots.push(o); return { id: 'sn_new', status: 'pending' }; },
    kill: async () => { log.killed.push(id); return true; },
  });
  const sdk = { Sandbox: {
    async create(template, opts) { log.create.push({ template, opts }); return sandbox('m_new', opts.name ?? 'sbx-abc'); },
    async connect(id) { return sandbox(id, 'img-1'); },
    async getSnapshot(id) { return { id, status: 'ready' }; },
    async kill(id) { log.killed.push(id); return true; },
    // ls, attach, stop and the image/start duplicate checks list through the SDK ({ sdk: true }).
    async list(o) { return machines.filter((m) => Object.entries(o.metadata).every(([k, v]) => m.metadata?.[k] === v)); },
  } };
  // `coordinator finish` lists and deletes over raw HTTP; `machines` uses the SDK row shape and is served as API rows.
  const fetchFn = async (url, init = {}) => {
    log.fetches.push({ url, ...init });
    if (init.method === 'DELETE') { log.killed.push(decodeURIComponent(String(url).split('/').pop())); return new Response('{}'); }
    if (init.method === 'PATCH') return new Response('{}');
    if (/\/secrets$/.test(url)) return Response.json(applied);
    return Response.json({ machines: machines.map((m) => ({ id: m.sandboxId, name: m.name, state: m.state, createdAt: m.startedAt, metadata: m.metadata, deleteAt: m.machine?.deleteAt })) });
  };
  // The laptop holds the real Instabox key; the Claude token and the provider key are proxy secrets, so env has their names only (#67, #68).
  const env = { INSTABOX_API_KEY: IBK, CLOUDY_CLOUD_PROXY_SECRETS: 'CLOUDY_CLOUD_INSTABOX_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,OPENROUTER_API_KEY', STRIPE_API_KEY: OTHER, CLOUDY_CLOUD_PROFILES: join(dir, 'profiles.json'), CLOUDY_CLOUD_CONFIG: configFile, ...(snapshot && { CLOUDY_CLOUD_COORDINATOR_SNAPSHOT: snapshot }), PATH: '/x' };
  const deps = { sdk, fetchFn, env, root: resolve('.'), sleep: async () => {}, out: (s) => log.out.push(s) };
  return { log, deps, configFile, mk, machines };
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
  f.machines.push(f.mk('m_img', 'img-1', { role: 'coordinator-image' }));
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

test('the coordinator own Claude starts without the setup-token or API key, so its saved full login is used (#67)', async () => {
  const f = fixture();
  await main(['start', 'boss', '--repo', 'https://github.com/o/r'], f.deps);
  assert.ok(f.log.cmds.some((c) => /tmux new-session/.test(c) && /env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY CLOUDY_CLOUD_COORDINATOR=1/.test(c)));
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
  assert.match(w.d, /^CLOUDY_CLOUD_PROXY_SECRETS=CLOUDY_CLOUD_INSTABOX_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,OPENROUTER_API_KEY$/m);
  assert.ok(![IBK, TOK, PROV].some((v) => w.d.includes(v)), 'no key value in the env file');
  assert.ok(!w.d.includes('PATH='));
  assert.ok(!w.d.includes('STRIPE_API_KEY') && !w.d.includes(OTHER), 'a key no profile uses stays on the laptop');
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

test('start sends the key of a profile from profiles.json, and still not an unrelated key', async () => {
  const f = fixture();
  writeFileSync(f.deps.env.CLOUDY_CLOUD_PROFILES, JSON.stringify({ mine: { format: 'anthropic', baseUrl: 'https://x.test/api', model: 'm', keyName: 'MINE_API_KEY' } }));
  f.deps.env.CLOUDY_CLOUD_PROXY_SECRETS += ',MINE_API_KEY';
  await main(['start', 'boss', '--repo', 'https://github.com/o/r', '--branch', 'main'], f.deps);
  const patch = f.log.fetches.find((x) => x.method === 'PATCH' && x.body.includes('GH_TOKEN'));
  assert.ok(patch.body.includes('MINE_API_KEY') && patch.body.includes('OPENROUTER_API_KEY'));
  assert.ok(!patch.body.includes('STRIPE_API_KEY'));
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
  assert.deepEqual(JSON.parse(f.log.out.join('\n')), { name: 'boss', machine: 'coord-boss', remoteControlName: 'boss', attach: 'npx --yes instabox@latest ssh coord-boss -- tmux attach -t claude', started: true });
});

test('start --json reports a structured error with guidance when the spend limit is hit', async () => {
  const f = fixture();
  f.deps.sdk.Sandbox.create = async () => { throw new Error('You have reached your spend limit'); };
  await assert.rejects(main(['start', 'boss', '--repo', 'https://github.com/o/r', '--json'], f.deps), /Next step: .*cloud_agent_list/s);
  const o = JSON.parse(f.log.out.join('\n')).error;
  assert.equal(o.code, 'spend_limit');
  assert.match(o.tellUser, /spend limit is reached/);
  assert.ok(o.whatHappened && o.likelyCause && o.nextStep);
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
  assert.equal(safeText('a\u202eb\u2066c'), 'abc');
  assert.equal(redact('HTTP 401 ibk_FAKEKEY123 sk-ant-test123'), 'HTTP 401 [redacted] [redacted]');
});

test('the command line never prints a key-shaped value from an error', () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-coord-redact-'));
  const r = spawnSync(process.execPath, [resolve('src/coordinator.mjs'), 'start', 'boss', '--repo', 'https://github.com/o/r', '--task-file', '/nonexistent/GH_TOKEN=supersecret99'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, INSTABOX_API_KEY: IBK } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ENOENT/);
  assert.doesNotMatch(r.stderr, /supersecret99/);
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
  assert.match(coord, /holds placeholders for the Instabox key.*not the real keys/);
  assert.doesNotMatch(coord, /real Instabox key/);
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


test('image and start refuse a provider without snapshots, before creating anything', async () => {
  const provider = createFakeProvider({ FAKE_API_KEY: 'k' }, { hasSnapshots: false });
  const env = { FAKE_API_KEY: 'k', CLOUDY_CLOUD_COORDINATOR_SNAPSHOT: 'sn_1' };
  for (const args of [['image'], ['image', '--save'], ['start', 'boss', '--repo', 'https://github.com/o/r']]) {
    await assert.rejects(main(args, { provider, env, out: () => {} }), /^Error: Provider fake has no snapshots, which coordinators need\.$/, args.join(' '));
  }
  assert.equal(provider.log.create.length, 0);
  assert.equal(provider.log.list.length, 0);
});

test('start asks the provider for a never-suspending machine from the snapshot with a server deadline', async () => {
  const provider = createFakeProvider({ FAKE_API_KEY: 'k' }, { hasProxySecrets: false, hasConsentedSecrets: true }); // no proxy secrets: its key goes by value, so no secrets option
  provider.create = async (o) => {
    provider.log.create.push(o);
    return { id: 'm1', name: 'coord-boss', home: '/h', files: { write: async () => {} }, kill: async () => {},
      commands: { run: async () => ({ stdout: '/h', stderr: '', exitCode: 0 }) } };
  };
  const out = [];
  await main(['start', 'boss', '--repo', 'https://github.com/o/r'], { provider, env: { FAKE_API_KEY: 'k', CLOUDY_CLOUD_COORDINATOR_SNAPSHOT: 'sn_1' }, root: resolve('.'), out: (x) => out.push(x) });
  assert.deepEqual(provider.log.create, [{ image: 'sn_1', name: 'coord-boss', labels: { purpose: 'cloudy-cloud', role: 'coordinator', name: 'boss' }, ttlSeconds: 86400, neverSuspend: true, retry: false }]);
  assert.match(out.join('\n'), /fake ssh coord-boss -- tmux attach -t claude/);
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
  assert.deepEqual(JSON.parse(g.log.out.join('\n')), { name: 'boss', machine: 'coord-boss', remoteControlName: 'boss', attach: 'npx --yes instabox@latest ssh coord-boss -- tmux attach -t claude', started: true });
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

test('a provider that cannot give a coordinator its keys refuses image and start, before creating anything (#41)', async () => {
  const provider = createFakeProvider({ FAKE_API_KEY: 'k' });
  provider.text.coordinatorRefusal = 'Coordinators are not supported on fake yet.';
  for (const args of [['image'], ['start', 'boss', '--repo', 'https://github.com/o/r']]) {
    await assert.rejects(main(args, { provider, env: { FAKE_API_KEY: 'k', CLOUDY_CLOUD_COORDINATOR_SNAPSHOT: 'sn_1' }, out: () => {} }), /^Error: Coordinators are not supported on fake yet\.$/);
  }
  assert.equal(provider.log.create.length, 0);
});

test('the coordinator env file carries the proxy secret names and apt package list', async () => {
  const f = fixture();
  f.deps.env = { ...f.deps.env, CLOUDY_CLOUD_APT_PACKAGES: 'ffmpeg' };
  await main(['start', 'boss', '--repo', 'https://github.com/o/r'], f.deps);
  const w = f.log.writes.find((x) => x.p === '/data/home/.config/cloudy-cloud/env');
  assert.match(w.d, /^CLOUDY_CLOUD_PROXY_SECRETS=CLOUDY_CLOUD_INSTABOX_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,OPENROUTER_API_KEY$/m);
  assert.match(w.d, /^CLOUDY_CLOUD_APT_PACKAGES=ffmpeg$/m);
});

const jsonErr = (f) => { const lines = f.log.out.filter((s) => s.startsWith('{')); assert.equal(lines.length, 1, 'exactly one JSON object'); return JSON.parse(lines[0]).error; };

test('start --json scrubs an exact configured key echoed by the provider, in stdout and the thrown message', async () => {
  const f = fixture();
  const OPAQUE = 'opaqueKEYvalue9f3a77c1d2';
  f.deps.env.INSTABOX_API_KEY = OPAQUE;
  f.deps.sdk.Sandbox.create = async () => { throw new Error(`bad request for key ${OPAQUE}`); };
  await assert.rejects(main(['start', 'boss', '--repo', 'https://github.com/o/r', '--json'], f.deps), (e) => { assert.ok(!e.message.includes(OPAQUE)); return true; });
  assert.ok(!f.log.out.join('\n').includes(OPAQUE));
  assert.ok(jsonErr(f).code);
});

test('start --json prints one error object for argument errors and a missing key', async () => {
  const f = fixture();
  await assert.rejects(main(['start', 'boss', '--repo', 'https://github.com/o/r', '--typo', 'x', '--json'], f.deps), /Unknown argument/);
  const o = jsonErr(f);
  assert.ok(o.code && o.whatHappened && o.likelyCause && o.nextStep && o.tellUser !== undefined || o.whatHappened);
  assert.match(o.whatHappened, /Unknown argument/);
  const g = fixture();
  delete g.deps.env.INSTABOX_API_KEY;
  await assert.rejects(main(['start', 'boss', '--repo', 'https://github.com/o/r', '--json'], g.deps), /setup/);
  assert.match(jsonErr(g).whatHappened, /INSTABOX_API_KEY/);
});

test('start --json prefers a known error code over the message text', async () => {
  for (const code of ['quota_exceeded', 'secret_missing']) {
    const f = fixture();
    f.deps.sdk.Sandbox.create = async () => { throw Object.assign(new Error('plain words'), { code }); };
    await assert.rejects(main(['start', 'boss', '--repo', 'https://github.com/o/r', '--json'], f.deps));
    assert.equal(jsonErr(f).code, code);
  }
});
// ---- #44 and #46 ----
const START = ['start', 'boss', '--repo', 'https://github.com/o/r'];

test('start fails and deletes the machine when the session screen shows a spend limit (#44)', async () => {
  const f = fixture({ pane: "  You've hit your monthly spend limit\n" });
  await assert.rejects(main([...START, '--json'], f.deps), (e) => {
    assert.match(e.message, /monthly spend limit/);
    assert.match(e.message, /Next: /);
    assert.match(e.message, /coordinator stop|coordinator start/);
    return true;
  });
  assert.deepEqual(f.log.killed, ['m_new']);
  assert.equal(f.log.out.length, 1, 'only the error object, no success output');
  assert.ok(JSON.parse(f.log.out[0]).error, 'the one line is the --json error object');
  assert.ok(f.log.cmds.some((c) => /tmux capture-pane/.test(c)));
});

test('start also fails on a login screen or an invalid key', async () => {
  for (const pane of ['Select login method', 'Invalid API key \u00b7 Fix external API key']) {
    const f = fixture({ pane });
    await assert.rejects(main(START, f.deps), /Next: /, pane);
    assert.deepEqual(f.log.killed, ['m_new']);
  }
});

test('start keeps the machine when the screen waits on a trust, MCP or Remote Control prompt, and says how to answer it', async () => {
  for (const pane of ['Do you trust the files in this folder?', 'New MCP server found in this project', 'Enable Remote Control? (y/n)']) {
    const f = fixture({ pane });
    await main(START, f.deps);
    assert.deepEqual(f.log.killed, [], pane);
    const text = f.log.out.join('\n');
    assert.match(text, /waiting on a prompt/);
    assert.ok(text.includes(pane), text);
    assert.match(text, /cloudy-cloud coordinator attach boss/);
    const g = fixture({ pane });
    await main([...START, '--json'], g.deps);
    assert.deepEqual(JSON.parse(g.log.out[0]), { name: 'boss', machine: 'coord-boss', remoteControlName: 'boss', attach: 'npx --yes instabox@latest ssh coord-boss -- tmux attach -t claude', started: true, waiting: pane });
  }
});

test('start fails and deletes the machine when the session exits at once (capture-pane fails)', async () => {
  const f = fixture();
  const orig = f.deps.sdk.Sandbox.create;
  f.deps.sdk.Sandbox.create = async (t, o) => {
    const sbx = await orig(t, o);
    const run = sbx.commands.run;
    sbx.commands.run = async (cmd, ...r) => { if (/capture-pane/.test(cmd)) throw Object.assign(new Error("no server running on /tmp/tmux-0/default"), { exitCode: 1, stdout: '', stderr: 'no server running' }); return run(cmd, ...r); };
    return sbx;
  };
  await assert.rejects(main(START, f.deps), /exited right after[\s\S]*Next: /);
  assert.deepEqual(f.log.killed, ['m_new']);
});

test('start --model puts the model on the tmux command line; a bad model is refused before any machine', async () => {
  const f = fixture();
  await main([...START, '--model', 'claude-opus-5-5'], f.deps);
  assert.match(f.log.cmds.find((c) => /tmux new-session/.test(c)), /--remote-control '\\''boss'\\'' --model '\\''claude-opus-5-5'\\''/);
  const g = fixture();
  await assert.rejects(main([...START, '--model', 'x;rm -rf /'], g.deps), /--model/);
  assert.equal(g.log.create.length, 0);
});

test('the coordinator session has cloudy-cloud on PATH, as one word even when PATH has spaces (#46)', async () => {
  const f = fixture();
  await main(START, f.deps);
  const cmd = f.log.cmds.find((c) => /tmux new-session/.test(c));
  // Run the command with tmux and env stubbed as shell functions: tmux evals its command word, env prints each argument in brackets.
  const sh = spawnSync('sh', ['-c', `tmux() { [ "$1" = new-session ] && eval "$7"; }; env() { printf '[%s]' "$@"; }; ${cmd}`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/my dir/bin' } }).stdout;
  assert.match(sh, /\[PATH=\/data\/home\/cloudy-cloud\/bin:\/usr\/bin:\/bin:\/my dir\/bin\]/);
});

const pane = (text, task) => {
  const f = fixture({ pane: text });
  return { f, run: () => main([...START, ...(task ? ['--task', task] : [])], f.deps) };
};

test('a task line shown on screen does not count as an error (#44 review)', async () => {
  const task = 'Fix the Invalid API key error in our billing form';
  const { f, run } = pane(`> ${task}\n  Fix the Invalid API key error in our billing form`, task);
  await run();
  assert.deepEqual(f.log.killed, []);
  const g = pane('Fix the Invalid API key error in our billing form');
  await g.run();
  assert.deepEqual(g.f.log.killed, [], 'a message must be a whole Claude error, not a substring');
});

test('start fails on the real Claude 2.1.325 session-limit and sign-in messages', async () => {
  for (const text of ["You've hit your session limit \u00b7 resets 3pm", 'Authentication required \u00b7 Sign in again to continue', 'Login expired \u00b7 Please run /login', 'Invalid API key \u00b7 Fix external API key', 'Not logged in \u00b7 Please run /login']) {
    const { f, run } = pane(`  \u23bf  ${text}`);
    await assert.rejects(run(), /Next: /, text);
    assert.deepEqual(f.log.killed, ['m_new'], text);
  }
});

test('a provider error while reading the screen keeps the machine and says the screen was not read', async () => {
  for (const err of [Object.assign(new Error('429'), { code: 'rate_limited' }), Object.assign(new Error('x'), { code: 'transient' }), Object.assign(new Error('t'), { code: 'timeout' })]) {
    const f = fixture();
    const orig = f.deps.sdk.Sandbox.create;
    f.deps.sdk.Sandbox.create = async (t, o) => { const sbx = await orig(t, o); const run = sbx.commands.run; sbx.commands.run = async (cmd, ...r) => { if (/capture-pane/.test(cmd)) throw err; return run(cmd, ...r); }; return sbx; };
    await main([...START, '--json'], f.deps);
    assert.deepEqual(f.log.killed, [], err.code);
    const j = JSON.parse(f.log.out[0]);
    assert.equal(j.started, true);
    assert.equal(j.screenRead, false);
    assert.match(j.attach, /tmux attach/);
  }
});

test('toolRepoUrl in a checkout with no origin prints nothing on stderr (#44)', () => {
  const d = mkdtempSync(join(tmpdir(), 'cc-noorigin-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  const r = spawnSync(process.execPath, ['-e', `import('${resolve('src/coordinator.mjs')}').then((m) => process.stdout.write(JSON.stringify(m.toolRepoUrl(${JSON.stringify(d)}))))`], { encoding: 'utf8' });
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, '""');
  assert.equal(toolRepoUrl(d), '');
});

test('start attaches the Instabox key, the Claude token and provider keys as secrets, and the env file holds names only', async () => {
  const f = fixture();
  await main(['start', 'boss', '--repo', 'https://github.com/o/r'], f.deps);
  const patch = f.log.fetches.find((x) => x.method === 'PATCH' && x.body.includes('GH_TOKEN'));
  for (const n of ['CLOUDY_CLOUD_INSTABOX_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENROUTER_API_KEY']) assert.ok(patch.body.includes(n), n);
  const w = f.log.writes.find((x) => x.p === '/data/home/.config/cloudy-cloud/env');
  assert.match(w.d, /^CLOUDY_CLOUD_PROXY_SECRETS=CLOUDY_CLOUD_INSTABOX_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,OPENROUTER_API_KEY$/m);
  assert.ok(!w.d.includes(IBK), 'no Instabox key value');
  assert.doesNotMatch(w.d, /^(INSTABOX_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|OPENROUTER_API_KEY)=/m);
});

test('a coordinator key that is not a proxy secret is refused with the setup text, before any machine is created', async () => {
  for (const [name, proxied] of [['INSTABOX_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN,OPENROUTER_API_KEY'], ['CLAUDE_CODE_OAUTH_TOKEN', 'CLOUDY_CLOUD_INSTABOX_API_KEY,OPENROUTER_API_KEY']]) {
    const f = fixture();
    f.deps.env.CLOUDY_CLOUD_PROXY_SECRETS = proxied;
    f.deps.env.CLAUDE_CODE_OAUTH_TOKEN = TOK;
    await assert.rejects(main(['start', 'boss', '--repo', 'https://github.com/o/r'], f.deps), (e) => { assert.match(e.message, /keeps keys off machines/); assert.match(e.message, /cloudy-cloud setup/); assert.ok(!e.message.includes(TOK) && !e.message.includes(IBK)); return true; });
    assert.equal(f.log.create.length, 0);
  }
});

test('launcher: a coordinator with only the CLOUDY_CLOUD_INSTABOX_API_KEY placeholder is set up, and the server gets it as INSTABOX_API_KEY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-coord-p-'));
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\nprintf '%s' "$INSTABOX_API_KEY" > "${dir}/seen"\n`);
  chmodSync(join(dir, 'claude'), 0o755);
  writeFileSync(join(dir, 'env'), 'CLOUDY_CLOUD_PROXY_SECRETS=CLOUDY_CLOUD_INSTABOX_API_KEY,CLAUDE_CODE_OAUTH_TOKEN\n');
  const r = spawnSync('/bin/sh', [resolve('bin/cloudy-cloud')], { cwd: dir, env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, CLOUDY_CLOUD_CONFIG: join(dir, 'env'), CLOUDY_CLOUD_INSTABOX_API_KEY: 'ibsec_placeholder' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, 'seen'), 'utf8'), 'ibsec_placeholder');
});

test('an optional profile key set only as a plain value is skipped with a plain line, and the start continues (#67 #68)', async () => {
  const f = fixture();
  f.deps.env.CLOUDY_CLOUD_PROXY_SECRETS = 'CLOUDY_CLOUD_INSTABOX_API_KEY,CLAUDE_CODE_OAUTH_TOKEN';
  f.deps.env.CLAUDE_CODE_OAUTH_TOKEN = TOK;
  f.deps.env.OPENROUTER_API_KEY = PROV;
  await main(['start', 'boss', '--repo', 'https://github.com/o/r'], f.deps);
  assert.equal(f.log.create.length, 1);
  const all = JSON.stringify([f.log.create.map((x) => x.opts.envs), f.log.writes, f.log.cmds, f.log.fetches.map((x) => x.body)]);
  for (const v of [PROV, IBK, TOK]) assert.ok(!all.includes(v), `value ${v.slice(0, 6)} reaches the machine: ${all.slice(Math.max(0, all.indexOf(v) - 80), all.indexOf(v) + 20)}`);
  assert.doesNotMatch(f.log.writes.find((x) => x.p === '/data/home/.config/cloudy-cloud/env').d, /OPENROUTER_API_KEY/);
  const out = f.log.out.join('\n');
  assert.match(out, /Not sent to the coordinator[^\n]*OPENROUTER_API_KEY/);
  assert.match(out, /cloudy-cloud setup/);
  assert.ok(!out.includes(PROV));
});

test('the Instabox key not being a proxy secret still refuses, with the guidance once and its own code in --json', async () => {
  const f = fixture();
  f.deps.env.CLOUDY_CLOUD_PROXY_SECRETS = 'CLAUDE_CODE_OAUTH_TOKEN,PARTICLE_API_KEY';
  f.deps.env.CLAUDE_CODE_OAUTH_TOKEN = TOK;
  f.deps.env.OPENROUTER_API_KEY = PROV;
  await assert.rejects(main(['start', 'rtprobe', '--repo', 'https://github.com/o/r', '--json'], f.deps), (e) => {
    assert.equal(e.code, 'key_on_machine_refused');
    assert.doesNotMatch(e.message, /Something failed/);
    assert.equal(e.message.split('What happened:').length, 2, 'guidance appears once');
    return true;
  });
  assert.equal(f.log.create.length, 0);
  const j = JSON.parse(f.log.out.at(-1)).error;
  assert.equal(j.code, 'key_on_machine_refused');
  assert.match(j.whatHappened, /^A real key/);
  assert.match(j.nextStep, /^Run `cloudy-cloud setup`/);
});

test('an error that already carries guidance but no known code keeps its own fields in --json', async () => {
  const f = fixture();
  f.deps.sdk = { get Sandbox() { throw Object.assign(new Error('boom\nWhat happened: X broke.\nLikely cause: Y.\nNext step: Do Z.'), {}); } };
  await assert.rejects(main(['start', 'b', '--repo', 'https://github.com/o/r', '--json'], f.deps));
  const j = JSON.parse(f.log.out.at(-1)).error;
  assert.equal(j.whatHappened, 'X broke.');
  assert.equal(j.nextStep, 'Do Z.');
});

test('a custom skipped key: the recovery text has the proxy-list step and never a host with shell characters', async () => {
  const f = fixture();
  writeFileSync(f.deps.env.CLOUDY_CLOUD_PROFILES, JSON.stringify({ evil: { harness: 'claude', format: 'anthropic', baseUrl: 'https://example.com;id/v1', keyName: 'EVIL_API_KEY', model: 'm1' } }));
  f.deps.env.CLOUDY_CLOUD_PROXY_SECRETS = 'CLOUDY_CLOUD_INSTABOX_API_KEY,CLAUDE_CODE_OAUTH_TOKEN';
  f.deps.env.EVIL_API_KEY = 'evil-real-value-12345';
  await main(['start', 'boss', '--repo', 'https://github.com/o/r'], f.deps);
  const out = f.log.out.join('\n');
  assert.match(out, /EVIL_API_KEY/);
  assert.match(out, /--host <host>/);
  assert.doesNotMatch(out, /;id/);
  assert.match(out, /CLOUDY_CLOUD_PROXY_SECRETS/);
  assert.match(out, /delete the plain EVIL_API_KEY=/);
});

test('guidance labels mid-line are not treated as guidance; multiline fields keep their continuation lines', async () => {
  for (const [msg, check] of [
    ['Provider error: What happened: storage unavailable. Next step: retry later.', (j) => { assert.equal(j.code, 'unknown'); assert.match(j.whatHappened, /Provider error: What happened: storage unavailable/); }],
    ['What happened: first line\nsecond line\nNext step: do A\nthen B', (j) => { assert.equal(j.whatHappened, 'first line\nsecond line'); assert.equal(j.nextStep, 'do A\nthen B'); }],
  ]) {
    const f = fixture();
    f.deps.sdk = { get Sandbox() { throw new Error(msg); } };
    await assert.rejects(main(['start', 'b', '--repo', 'https://github.com/o/r', '--json'], f.deps));
    check(JSON.parse(f.log.out.at(-1)).error);
  }
});
