import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from '../src/coordinator.mjs';
import { createInstaboxSandbox } from '../src/instabox.mjs';

const KEY = 'ibk_KEY';
const applied = { proxy: { revision: 2, appliedRevision: 2 }, guest: { revision: 2, appliedRevision: 2 } };

// A fake SDK whose create() calls opts.fetch the way the real SDK does for POST /v1/machines.
function sdkFor(log) {
  const sandbox = { sandboxId: 'm_new', getInfo: async () => ({ name: 'coord-boss' }), kill: async () => true,
    files: { write: async () => {} }, commands: { run: async () => ({ stdout: '/data/home', stderr: '', exitCode: 0 }) } };
  return { Sandbox: {
    async create(template, opts) {
      await opts.fetch?.('https://api.instabox.sh/v1/machines', { method: 'POST', body: JSON.stringify({ name: 'x' }) });
      log.create.push({ template, opts });
      return sandbox;
    },
    async list() { return []; },
  } };
}
function baseFetch(log) {
  return async (url, init = {}) => {
    if (init.method === 'POST' && /\/v1\/machines$/.test(url)) { log.posts.push(JSON.parse(init.body)); return Response.json({}); }
    return init.method === 'PATCH' ? new Response('{}') : Response.json(applied);
  };
}
const fx = () => {
  const log = { create: [], posts: [], cmds: [], writes: [], out: [] };
  const sdk = sdkFor(log);
  return { log, sdk };
};

test('a worker machine is created with a 6 hour delete deadline; CLAUDE_CLOUD_WORKER_HOURS changes it', async () => {
  const { log, sdk } = fx();
  await createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, baseFetch(log), undefined, 'o1')({}, { deleteAfterSeconds: 6 * 3600 });
  assert.equal(log.posts[0].deleteAfterSeconds, 21600);
  assert.equal(log.posts[0].name, 'x');
});

test('coordinator start: default 24 h deadline, --max-hours applied, over 24 refused, deadline told to the agent', async () => {
  const mk = () => {
    const { log, sdk } = fx();
    const cfg = join(mkdtempSync(join(tmpdir(), 'cc-ad-')), 'env');
    const env = { INSTABOX_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CLOUD_CONFIG: cfg, CLAUDE_CLOUD_COORDINATOR_SNAPSHOT: 'sn_1' };
    sdk.Sandbox.create = async (template, opts) => {
      await opts.fetch('https://api.instabox.sh/v1/machines', { method: 'POST', body: '{}' });
      return { sandboxId: 'm', getInfo: async () => ({ name: 'coord-boss' }), kill: async () => {},
        files: { write: async (p, d) => { log.writes.push({ p, d: String(d) }); } },
        commands: { run: async (c) => { log.cmds.push(c); return { stdout: '/data/home', stderr: '', exitCode: 0 }; } } };
    };
    return { log, deps: { sdk, env, fetchFn: baseFetch(log), root: resolve('.'), sleep: async () => {}, out: (s) => log.out.push(s) } };
  };
  const a = mk();
  await main(['start', 'boss', '--repo', 'https://github.com/o/r', '--task', 'do it'], a.deps);
  assert.equal(a.log.posts[0].deleteAfterSeconds, 86400);
  assert.match(a.log.writes.find((w) => w.p.endsWith('task.md')).d, /^Your machine is deleted by the server at \d{4}-\d\d-\d\dT[\d:.]+Z; push your work well before then\./);
  assert.match(a.log.cmds.find((c) => /tmux new-session/.test(c)), /CLAUDE_CLOUD_DELETE_AT=/);
  const b = mk();
  await main(['start', 'boss', '--repo', 'https://github.com/o/r', '--max-hours', '2'], b.deps);
  assert.equal(b.log.posts[0].deleteAfterSeconds, 7200);
  const c = mk();
  await assert.rejects(main(['start', 'boss', '--repo', 'https://github.com/o/r', '--max-hours', '25'], c.deps), /24/);
  assert.equal(c.log.posts.length, 0);
});

test('ls shows the delete time', async () => {
  const { log, sdk } = fx();
  sdk.Sandbox.list = async () => [{ sandboxId: 'm1', name: 'coord-boss', state: 'running', startedAt: new Date('2026-01-02T03:04:05Z'),
    metadata: { role: 'coordinator', name: 'boss' }, machine: { deleteAt: '2026-01-03T03:04:05Z' } }];
  await main(['ls'], { sdk, env: { INSTABOX_API_KEY: KEY }, out: (s) => log.out.push(s) });
  assert.match(log.out.join('\n'), /2026-01-03T03:04:05/);
});

// finish: a real git repo with a bare "origin".
function repoFixture({ dirty = false, unpushed = false, fleetUnpushed = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-fin-'));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(dir, 'clone', '-q', 'origin.git', 'repo');
  const repo = join(dir, 'repo');
  writeFileSync(join(repo, 'a'), '1');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init'); git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'fleet/x'); git(repo, 'push', '-q', '-u', 'origin', 'fleet/x');
  if (fleetUnpushed) { writeFileSync(join(repo, 'b'), '2'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'b'); git(repo, 'checkout', '-q', 'main'); }
  if (unpushed) { git(repo, 'checkout', '-q', 'main'); writeFileSync(join(repo, 'c'), '3'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'c'); }
  if (dirty) writeFileSync(join(repo, 'dirty'), 'x');
  return repo;
}
function finishFx({ hostname = 'instabox-coord-boss', workers = [], machines, ...repoOpts } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-own-'));
  const ownerFile = join(dir, 'owner');
  writeFileSync(ownerFile, 'own1\n');
  const log = { calls: [], out: [] };
  const all = machines ?? [{ id: 'm_me', name: 'coord-boss', metadata: { role: 'coordinator', name: 'boss' } }];
  const fetchFn = async (url, init = {}) => {
    log.calls.push({ url, ...init });
    if (init.method === 'DELETE') return new Response('{}');
    if (url.includes('owner%3Aown1')) return Response.json({ machines: workers });
    if (url.includes('role%3Acoordinator')) return Response.json({ machines: all });
    return Response.json({ machines: [] });
  };
  const deps = { env: { INSTABOX_API_KEY: KEY }, fetchFn, hostname, repoDir: repoFixture(repoOpts), ownerFile, out: (s) => log.out.push(s) };
  return { log, deps };
}
const deleted = (log) => log.calls.filter((c) => c.method === 'DELETE');

test('finish deletes its own machine with the confirm header when everything is clean', async () => {
  const f = finishFx();
  await main(['finish'], f.deps);
  const [d] = deleted(f.log);
  assert.match(d.url, /\/v1\/machines\/m_me$/);
  assert.equal(d.headers['X-Confirm-Delete'], 'm_me');
  assert.ok(d.headers['Idempotency-Key']);
  assert.equal(d.headers['X-API-Key'], KEY);
  assert.match(f.log.out.join('\n'), /clean.*pushed|pushed/i);
});

test('finish refuses a dirty tree, unpushed commits, and unpushed fleet branches', async () => {
  for (const [opts, re] of [[{ dirty: true }, /uncommitted/i], [{ unpushed: true }, /unpushed|not pushed/i], [{ fleetUnpushed: true }, /fleet\/x/]]) {
    const f = finishFx(opts);
    await assert.rejects(main(['finish'], f.deps), re);
    assert.equal(deleted(f.log).length, 0);
  }
});

test('finish refuses while workers it owns are running; names cloud_agent_stop', async () => {
  const f = finishFx({ workers: [{ id: 'm_w', name: 'sbx-w', metadata: { owner: 'own1' } }] });
  await assert.rejects(main(['finish'], f.deps), /cloud_agent_stop/);
  assert.equal(deleted(f.log).length, 0);
});

test('finish refuses off a coordinator machine', async () => {
  const laptop = finishFx({ hostname: 'macbook.local' });
  await assert.rejects(main(['finish'], laptop.deps), /coordinator machine/i);
  const nomatch = finishFx({ machines: [{ id: 'm_o', name: 'coord-other', metadata: { role: 'coordinator' } }] });
  await assert.rejects(main(['finish', '--force'], nomatch.deps), /coordinator machine/i);
  assert.equal(deleted(laptop.log).length + deleted(nomatch.log).length, 0);
});

test('finish --force skips the git and worker checks but still needs a coordinator machine', async () => {
  const f = finishFx({ dirty: true, unpushed: true, workers: [{ id: 'm_w', metadata: { owner: 'own1' } }] });
  await main(['finish', '--force'], f.deps);
  assert.equal(deleted(f.log).length, 1);
  assert.match(f.log.out.join('\n'), /force/i);
});
