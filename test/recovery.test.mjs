import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { saveCheckpoint, readCheckpoint, recoverFromCheckpoint, verifyOriginCheckpoint } from '../src/recovery.mjs';
import { cancelTask, recoverAgent, runSubagent, waitAgents, withLatestCheckpoint } from '../src/run-subagent.mjs';
import { createFakeProvider, setGithub } from './fake-provider.mjs';

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-recovery-'));
  const env = { CLOUDY_CLOUD_CONFIG: join(dir, 'config', 'env'), CLOUDY_CLOUD_RECOVERY: join(dir, 'recovery') };
  mkdirSync(join(dir, 'config'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const record = {
    version: 1, id: 'deadbeef', branch: 'cloudy-cloud/deadbeef', workspace: resolve(dir), workspaceRel: 'packages/api', turnSequence: 1, user: String(process.getuid?.() ?? userInfo().username),
    originRepo: 'owner/repo', harness: 'claude', profile: null, model: '', machineKind: 'linux', size: null, egress: [], checkpointSha: 'a'.repeat(40),
    provider: 'old-provider', machine: 'machine-old', owner: 'owner-old',
  };
  mkdirSync(join(dir, 'packages', 'api'), { recursive: true });
  return { dir, env, record };
};

test('checkpoint persistence keeps only validated recovery metadata', async () => {
  const f = fixture();
  await saveCheckpoint(f.env, f.record);
  const saved = await readCheckpoint(f.env, f.record.id);
  assert.deepEqual(saved, f.record);
  assert.doesNotMatch(JSON.stringify(saved), /prompt|secret|token/i);
});

test('legacy checkpoints recover at repo root and reject unsafe saved workspace paths', async () => {
  const f = fixture();
  const legacy = { ...f.record };
  delete legacy.workspaceRel;
  delete legacy.turnSequence;
  mkdirSync(f.env.CLOUDY_CLOUD_RECOVERY, { recursive: true });
  writeFileSync(join(f.env.CLOUDY_CLOUD_RECOVERY, `${legacy.id}.json`), JSON.stringify(legacy));
  assert.equal((await readCheckpoint(f.env, legacy.id)).workspaceRel, '');
  assert.equal((await readCheckpoint(f.env, legacy.id)).turnSequence, 1);
  await assert.rejects(saveCheckpoint(f.env, { ...f.record, workspaceRel: '../outside' }), /invalid recovery workspace/i);
  let args;
  await recoverFromCheckpoint({ agent_id: legacy.id, provider: 'alternate', message: 'legacy root task' }, {
    env: f.env, cwd: f.dir,
    providers: [
      { name: 'old-provider', list: async () => [], connect: async () => { throw Object.assign(new Error('gone'), { code: 'not_found' }); } },
      { name: 'alternate' },
    ],
    verifyCheckpoint: async () => ({ ok: true, sha: legacy.checkpointSha }),
    startRecovery: async (recovery) => { args = recovery; return { content: [{ type: 'text', text: 'started' }] }; },
  });
  assert.equal(args.workspace, '', 'a legacy record must target the repo root');
});

test('recovery refuses a saved workspace directory that disappeared', async () => {
  const f = fixture();
  await saveCheckpoint(f.env, { ...f.record, workspaceRel: 'packages/removed' });
  let starts = 0;
  const r = await recoverFromCheckpoint({ agent_id: f.record.id, provider: 'alternate', message: 'new task' }, {
    env: f.env, cwd: f.dir, providers: [], startRecovery: async () => { starts++; },
  });
  assert.equal(starts, 0);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /saved workspace no longer exists/i);
});

test('autofix checkpoint propagation keeps the latest verified commit', () => {
  assert.equal(withLatestCheckpoint({ checkpointSha: 'a'.repeat(40) }, { checkpointSha: 'b'.repeat(40) }).checkpointSha, 'b'.repeat(40));
  assert.equal(withLatestCheckpoint({ checkpointSha: 'a'.repeat(40) }, { text: 'no fix push' }).checkpointSha, 'a'.repeat(40));
});

test('recovery confirms the old machine is gone and starts a fresh message on the selected provider', async () => {
  const f = fixture();
  await saveCheckpoint(f.env, f.record);
  let connects = 0;
  const old = {
    name: 'old-provider',
    list: async () => [],
    connect: async () => { connects++; throw Object.assign(new Error('gone'), { code: 'not_found' }); },
  };
  const alternate = { name: 'alternate', list: async () => [], connect: async () => { throw new Error('unused'); } };
  let started;
  const r = await recoverFromCheckpoint({ agent_id: f.record.id, provider: 'alternate', message: 'Continue by inspecting the pushed file.' }, {
    env: f.env, cwd: f.dir, providers: [old, alternate], verifyCheckpoint: async () => ({ ok: true, sha: f.record.checkpointSha }),
    startRecovery: async (args, provider, lock) => { started = { args, provider }; await lock.release(); return { content: [{ type: 'text', text: 'started' }] }; },
  });
  assert.equal(started.provider, alternate);
  assert.equal(started.args.id, f.record.id);
  assert.equal(started.args.branch, f.record.branch);
  assert.equal(started.args.base, f.record.checkpointSha);
  assert.equal(started.args.prompt, 'Continue by inspecting the pushed file.');
  assert.equal(started.args.machine, 'linux');
  assert.equal(started.args.workspace, 'packages/api');
  assert.equal(started.args.turnSequence, 1);
  assert.equal(connects, 1, 'a listed absence requires an explicit provider not-found result');
  assert.deepEqual(started.args.egress, []);
  assert.notEqual(started.args.prompt, f.record.prompt);
  assert.match(r.content[0].text, /fresh.*conversation/i);
  assert.equal(r.structuredContent.status, 'starting');
  assert.equal(r.structuredContent.error, false);
  assert.equal(r.structuredContent.agent_id, f.record.id);
  assert.equal(r.structuredContent.branch, f.record.branch);
  assert.equal(r.structuredContent.requested_provider, 'alternate');
  assert.equal(r.structuredContent.checkpoint_sha, f.record.checkpointSha);
  assert.match(r.structuredContent.message, /Recovery start requested/);
});

test('recovery refuses an origin branch that moved past its checkpoint', async () => {
  const f = fixture();
  await saveCheckpoint(f.env, f.record);
  let starts = 0;
  const old = { name: 'old-provider', list: async () => [], connect: async () => { throw Object.assign(new Error('gone'), { code: 'not_found' }); } };
  const alternate = { name: 'alternate' };
  const r = await recoverFromCheckpoint({ agent_id: f.record.id, provider: 'alternate', message: 'new message' }, {
    env: f.env, cwd: f.dir, providers: [old, alternate], verifyCheckpoint: async () => ({ ok: false, reason: 'origin branch moved' }),
    startRecovery: async () => { starts++; },
  });
  assert.equal(starts, 0);
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error, true);
  assert.match(r.content[0].text, /origin branch moved/i);
});

test('recovery reports an unreachable origin separately from a moved checkpoint', async () => {
  const f = fixture();
  await saveCheckpoint(f.env, f.record);
  const old = { name: 'old-provider', list: async () => [], connect: async () => { throw Object.assign(new Error('gone'), { code: 'not_found' }); } };
  const alternate = { name: 'alternate' };
  const disconnected = await verifyOriginCheckpoint(f.dir, f.record, { git: async (_cwd, ...args) => {
    if (args[0] === 'rev-parse') return f.dir;
    if (args[0] === 'config') return 'https://github.com/owner/repo.git';
    throw new Error('network unavailable');
  } });
  assert.match(disconnected.reason, /origin is unreachable/i);
  const r = await recoverFromCheckpoint({ agent_id: f.record.id, provider: 'alternate', message: 'new message' }, {
    env: f.env, cwd: f.dir, providers: [old, alternate], verifyCheckpoint: async () => disconnected,
    startRecovery: async () => assert.fail('must not start with a disconnected origin'),
  });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error, true);
  assert.match(r.content[0].text, /origin is unreachable/i);
  assert.doesNotMatch(r.content[0].text, /branch changed|moved/i);
});

test('recovery refuses an unknown original machine state instead of assuming absence', async () => {
  const f = fixture();
  await saveCheckpoint(f.env, f.record);
  let starts = 0;
  const old = { name: 'old-provider', list: async () => { throw Object.assign(new Error('offline'), { code: 'transient' }); }, connect: async () => { throw Object.assign(new Error('offline'), { code: 'transient' }); } };
  const alternate = { name: 'alternate' };
  const r = await recoverFromCheckpoint({ agent_id: f.record.id, provider: 'alternate', message: 'new message' }, {
    env: f.env, cwd: f.dir, providers: [old, alternate], verifyCheckpoint: async () => ({ ok: true, sha: f.record.checkpointSha }),
    startRecovery: async () => { starts++; },
  });
  assert.equal(starts, 0);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /could not confirm|unknown/i);
});

test('recovery refuses an incomplete original-provider list even when it returns no rows', async () => {
  const f = fixture();
  await saveCheckpoint(f.env, f.record);
  let starts = 0;
  const old = { name: 'old-provider', list: async (_labels, { onError }) => { onError(Object.assign(new Error('later page failed'), { code: 'transient' })); return []; } };
  const r = await recoverFromCheckpoint({ agent_id: f.record.id, provider: 'alternate', message: 'new message' }, {
    env: f.env, cwd: f.dir, providers: [old, { name: 'alternate' }], verifyCheckpoint: async () => ({ ok: true, sha: f.record.checkpointSha }),
    startRecovery: async () => { starts++; return { content: [{ type: 'text', text: 'unexpected start' }] }; },
  });
  assert.equal(starts, 0);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /incomplete machine list|unknown/i);
});

test('recovery refuses an unlisted original ID unless connect explicitly reports not found', async () => {
  for (const [label, connect, expected] of [
    ['reachable', async () => ({ id: 'machine-old' }), /still reachable|still present/i],
    ['transient', async () => { throw Object.assign(new Error('offline'), { code: 'transient' }); }, /state is unknown|could not confirm/i],
    ['foreign', async () => { throw Object.assign(new Error('not owned here'), { code: 'not_found', foreign: true }); }, /state is unknown|could not confirm/i],
    ['extant', async () => { throw Object.assign(new Error('not ready'), { code: 'not_found', exists: true }); }, /state is unknown|could not confirm/i],
  ]) {
    const f = fixture();
    await saveCheckpoint(f.env, f.record);
    let starts = 0;
    const old = { name: 'old-provider', list: async () => [], connect };
    const r = await recoverFromCheckpoint({ agent_id: f.record.id, provider: 'alternate', message: 'new message' }, {
      env: f.env, cwd: f.dir, providers: [old, { name: 'alternate' }], verifyCheckpoint: async () => ({ ok: true, sha: f.record.checkpointSha }),
      startRecovery: async () => { starts++; return { content: [{ type: 'text', text: 'unexpected start' }] }; },
    });
    assert.equal(starts, 0, label);
    assert.equal(r.isError, true, label);
    assert.match(r.content[0].text, expected, label);
  }
});

test('recovery refuses a listed paused machine even when its normalized status says stopped', async () => {
  const f = fixture();
  await saveCheckpoint(f.env, f.record);
  let connects = 0, starts = 0;
  const old = { name: 'old-provider', list: async () => [{ id: f.record.machine, state: 'paused', status: 'stopped', labels: { purpose: 'cloudy-cloud', agent: f.record.id, parent: f.record.owner } }], connect: async () => { connects++; throw Object.assign(new Error('not found'), { code: 'not_found' }); } };
  const r = await recoverFromCheckpoint({ agent_id: f.record.id, provider: 'alternate', message: 'new message' }, {
    env: f.env, cwd: f.dir, providers: [old, { name: 'alternate' }], verifyCheckpoint: async () => ({ ok: true, sha: f.record.checkpointSha }),
    startRecovery: async () => { starts++; return { content: [{ type: 'text', text: 'unexpected start' }] }; },
  });
  assert.equal(starts, 0);
  assert.equal(connects, 0, 'checking a listed machine must not wake it');
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /still listed|machine is still/i);
});

test('recovery refuses duplicate old-provider rows carrying the same agent label', async () => {
  const f = fixture();
  await saveCheckpoint(f.env, f.record);
  let starts = 0;
  const old = { name: 'old-provider', list: async () => [
    { id: f.record.machine, status: 'stopped', labels: { purpose: 'cloudy-cloud', agent: f.record.id, parent: f.record.owner } },
    { id: 'machine-copy', status: 'stopped', labels: { purpose: 'cloudy-cloud', agent: f.record.id, parent: f.record.owner } },
  ], connect: async () => assert.fail('recovery must not connect to listed machines') };
  const r = await recoverFromCheckpoint({ agent_id: f.record.id, provider: 'alternate', message: 'new message' }, {
    env: f.env, cwd: f.dir, providers: [old, { name: 'alternate' }], verifyCheckpoint: async () => ({ ok: true, sha: f.record.checkpointSha }),
    startRecovery: async () => { starts++; return { content: [{ type: 'text', text: 'unexpected start' }] }; },
  });
  assert.equal(starts, 0);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /duplicate|more than one/i);
});

test('recovery leaves stale locks intact and gives a verified cleanup step', async () => {
  const f = fixture();
  await saveCheckpoint(f.env, f.record);
  const lock = join(f.env.CLOUDY_CLOUD_RECOVERY, `${f.record.id}.lock`);
  mkdirSync(f.env.CLOUDY_CLOUD_RECOVERY, { recursive: true });
  writeFileSync(lock, '2147483647 old-owner\n', { mode: 0o600 });
  const r = await recoverFromCheckpoint({ agent_id: f.record.id, provider: 'alternate', message: 'new message' }, {
    env: f.env, cwd: f.dir, providers: [], startRecovery: async () => assert.fail('must not start while a lock exists'),
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /confirming no recovery process is running.*target provider has no replacement machine/i);
  assert.equal(readFileSync(lock, 'utf8'), '2147483647 old-owner\n');
});

test('the MCP recovery entry restores the confirmed commit under the same id and starts only the new message', async () => {
  const f = fixture();
  const github = join(f.dir, 'github'), repo = join(f.dir, 'repo'), bare = join(github, 'owner', 'repo.git');
  mkdirSync(join(github, 'owner'), { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  mkdirSync(join(repo, 'packages', 'api'), { recursive: true });
  writeFileSync(join(repo, 'packages', 'api', 'README.md'), 'selected workspace');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'ignore' });
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.invalid');
  git('remote', 'add', 'origin', bare);
  writeFileSync(join(repo, 'a.txt'), 'original');
  git('add', 'a.txt');
  git('add', 'packages/api/README.md');
  git('commit', '-m', 'main');
  git('push', '-u', 'origin', 'main');
  git('remote', 'set-url', 'origin', 'https://github.com/owner/repo.git');
  setGithub(github);
  const old = createFakeProvider({ FAKE_API_KEY: 'fake-key' }, { hasProxySecrets: false, hasConsentedSecrets: true });
  old.name = 'old-provider';
  const alternate = createFakeProvider({ FAKE_API_KEY: 'fake-key' }, { hasProxySecrets: false, hasConsentedSecrets: true });
  alternate.name = 'alternate';
  const prevGit = Object.fromEntries(['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${github}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/' });
  const deps = { env: { ...f.env, CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth', GH_TOKEN: 'synthetic-github', FAKE_API_KEY: 'fake-key', CLOUDY_CLOUD_DEFAULT_PROFILE: 'codex' }, cwd: repo, owner: 'owner-old', providers: [old, alternate], provider: old, open: new Map(), tasks: new Map(), count: { started: 0 }, fetchFn: async () => ({ status: 200, text: async () => '{}' }) };
  try {
    const initial = await runSubagent({ description: 'original task', prompt: 'EDIT-OLD-PROMPT', profile: 'claude', workspace: 'packages/api' }, deps);
    const id = /agent_id: ([0-9a-f]{8})/.exec(initial.content[0].text)?.[1];
    assert.ok(id);
    await waitAgents({ agent_ids: [id], timeout_seconds: 3 }, deps);
    const originalTask = [...deps.tasks.values()].find((task) => task.agent.id === id);
    assert.equal(originalTask.id, `cc-${id}-t1`, 'ordinary worker task IDs retain their established format');
    const original = deps.open.get(id);
    const saved = await readCheckpoint(f.env, id);
    assert.equal(saved.harness, 'claude');
    assert.equal(saved.profile, null);
    assert.equal(saved.workspaceRel, 'packages/api');
    assert.equal(saved.branch, `cloudy-cloud/${id}`);
    assert.equal(saved.checkpointSha, execFileSync('git', ['--git-dir', bare, 'rev-parse', `refs/heads/${saved.branch}`], { encoding: 'utf8' }).trim());
    await old.delete(original.sandbox.id);
    old.connect = async () => { throw Object.assign(new Error('gone'), { code: 'not_found' }); };
    deps.owner = 'owner-new';
    const started = await recoverAgent({ agent_id: id, provider: 'alternate', message: 'SHOW-NEW: inspect the restored file.' }, deps);
    assert.match(started.content[0].text, new RegExp(`agent_id: ${id}`));
    assert.match(started.content[0].text, /fresh claude conversation/i);
    const result = await waitAgents({ agent_ids: [id], timeout_seconds: 3 }, deps);
    assert.match(result.content[0].text, /a=changed/);
    assert.doesNotMatch(result.content[0].text, /EDIT-OLD-PROMPT/);
    assert.equal(deps.open.get(id).branch, saved.branch);
    assert.equal(deps.open.get(id).provider, alternate);
    assert.equal(alternate.log.create.length, 1);
    assert.equal(alternate.log.writes.find((w) => w.p.endsWith('/prompt.txt'))?.d, 'SHOW-NEW: inspect the restored file.');
    const updated = await readCheckpoint(f.env, id);
    assert.equal(updated.provider, 'alternate');
    assert.equal(updated.machine, deps.open.get(id).sandbox.id);
    const replacementTask = deps.open.get(id).turn;
    assert.ok(originalTask);
    assert.match(replacementTask.id, new RegExp(`^cc-${id}-t2-[0-9a-f-]{36}$`));
    assert.notEqual(replacementTask.id, originalTask.id, 'recovery must use a task id distinct from the old turn');
    assert.equal(deps.tasks.get(originalTask.id), originalTask, 'recovery must not overwrite the old task result');
    assert.equal(deps.open.get(id).turns, 2);
    await cancelTask(originalTask.id, deps);
    assert.equal(deps.open.get(id).turn, replacementTask, 'cancelling a recovered old task id must not cancel its new turn');
    assert.equal(deps.open.get(id).workspaceRel, 'packages/api');
    assert.equal(updated.workspaceRel, 'packages/api');

    await alternate.delete(deps.open.get(id).sandbox.id);
    alternate.connect = async () => { throw Object.assign(new Error('gone'), { code: 'not_found' }); };
    const secondSession = { ...deps, owner: 'owner-session-2', provider: old, open: new Map(), tasks: new Map(), count: { started: 0 } };
    const secondStart = await recoverAgent({ agent_id: id, provider: 'old-provider', message: 'Continue in a second session.' }, secondSession);
    assert.equal(secondStart.isError, undefined);
    await waitAgents({ agent_ids: [id], timeout_seconds: 3 }, secondSession);
    const secondTask = secondSession.open.get(id).turn;
    assert.equal(secondTask.n, 3);
    assert.match(secondTask.id, new RegExp(`^cc-${id}-t3-[0-9a-f-]{36}$`));
    assert.notEqual(secondTask.id, replacementTask.id, 'a different session must not reuse the previous session task id');
    assert.equal(deps.tasks.get(replacementTask.id), replacementTask, 'starting in a second session must leave the first session result addressable');
  } finally {
    for (const [k, v] of Object.entries(prevGit)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
