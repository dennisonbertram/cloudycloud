import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { saveCheckpoint, readCheckpoint, recoverFromCheckpoint, verifyOriginCheckpoint } from '../src/recovery.mjs';
import { recoverAgent, runSubagent, waitAgents } from '../src/run-subagent.mjs';
import { createFakeProvider, setGithub } from './fake-provider.mjs';

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-recovery-'));
  const env = { CLOUDY_CLOUD_CONFIG: join(dir, 'config', 'env'), CLOUDY_CLOUD_RECOVERY: join(dir, 'recovery') };
  mkdirSync(join(dir, 'config'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const record = {
    version: 1, id: 'deadbeef', branch: 'cloudy-cloud/deadbeef', workspace: resolve(dir), user: String(process.getuid?.() ?? userInfo().username),
    originRepo: 'owner/repo', harness: 'claude', profile: null, model: '', machineKind: 'linux', size: null, egress: [], checkpointSha: 'a'.repeat(40),
    provider: 'old-provider', machine: 'machine-old', owner: 'owner-old',
  };
  return { dir, env, record };
};

test('checkpoint persistence keeps only validated recovery metadata', async () => {
  const f = fixture();
  await saveCheckpoint(f.env, f.record);
  const saved = await readCheckpoint(f.env, f.record.id);
  assert.deepEqual(saved, f.record);
  assert.doesNotMatch(JSON.stringify(saved), /prompt|secret|token/i);
});

test('recovery confirms the old machine is gone and starts a fresh message on the selected provider', async () => {
  const f = fixture();
  await saveCheckpoint(f.env, f.record);
  const old = {
    name: 'old-provider',
    list: async () => [{ id: 'machine-old', state: 'running', labels: { agent: 'deadbeef', parent: 'owner-old' } }],
    connect: async () => { throw Object.assign(new Error('gone'), { code: 'not_found' }); },
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
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'ignore' });
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.invalid');
  git('remote', 'add', 'origin', bare);
  writeFileSync(join(repo, 'a.txt'), 'original');
  git('add', 'a.txt');
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
  const deps = { env: { ...f.env, CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth', GH_TOKEN: 'synthetic-github', FAKE_API_KEY: 'fake-key' }, cwd: repo, owner: 'owner-old', providers: [old, alternate], provider: old, open: new Map(), tasks: new Map(), count: { started: 0 }, fetchFn: async () => ({ status: 200, text: async () => '{}' }) };
  try {
    const initial = await runSubagent({ description: 'original task', prompt: 'EDIT-OLD-PROMPT' }, deps);
    const id = /agent_id: ([0-9a-f]{8})/.exec(initial.content[0].text)?.[1];
    assert.ok(id);
    await waitAgents({ agent_ids: [id], timeout_seconds: 3 }, deps);
    const original = deps.open.get(id);
    const saved = await readCheckpoint(f.env, id);
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
  } finally {
    for (const [k, v] of Object.entries(prevGit)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
