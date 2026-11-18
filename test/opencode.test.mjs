import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseOpencodeStream } from '../src/progress-opencode.mjs';
import { OPENCODE_VERSION, opencodeConfig, opencodeCommand, opencodeMcp, OPENCODE_SESSION } from '../src/harness-opencode.mjs';
import { hostConfig, HOST_PROMPT } from '../src/host-opencode.mjs';
import { resolveProfile } from '../src/profiles.mjs';
import { forHarness } from '../src/mcpsync.mjs';
import { fakeSandbox, setGithub, createFakeProvider } from './fake-provider.mjs';
import { runSubagent, messageAgent, waitAgents, listAgents } from '../src/run-subagent.mjs';

const exec = promisify(execFile);
const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const P = { name: 'opencode-glm', harness: 'opencode', format: 'openai', baseUrl: 'https://api.particle.ai/v1', model: 'z-ai/glm-5.3-flash', keyName: 'PARTICLE_API_KEY' };

// ---- progress, from real `opencode run --format json` output (opencode 1.18.31) ----
test('the parser reads a real run: tools, tokens, session id and the final text', () => {
  const p = parseOpencodeStream(fx('opencode-json-sample.jsonl'));
  assert.equal(p.tools, 1);
  assert.equal(p.step, 'bash echo hi > a.txt');
  assert.deepEqual(p.totals(), { tools: 1, in: 31739 + 56 + 31712, out: 24 });
  assert.equal(p.final.result, 'Done.');
  assert.equal(p.final.is_error, false);
  assert.match(p.final.session_id, OPENCODE_SESSION);
});

test('an error event becomes a failed final result that keeps the session id', () => {
  const p = parseOpencodeStream(fx('opencode-json-error.jsonl'));
  assert.equal(p.final.is_error, true);
  assert.match(p.final.result, /Unexpected server error.*err_4db7101c/);
  assert.match(p.final.session_id, OPENCODE_SESSION);
});

test('a tool step that continues (reason tool-calls) is not the final answer; chunked input works', () => {
  const lines = fx('opencode-json-sample.jsonl').split('\n').filter(Boolean).slice(0, 3).join('\n');
  const p = parseOpencodeStream(lines);
  assert.equal(p.final, undefined);
  assert.equal(p.tools, 1);
});

// ---- config and command ----
test('the worker config names the key by reference, never by value, and ships the instructions file', () => {
  const c = JSON.parse(opencodeConfig(P, { home: '/home/user', servers: {} }));
  assert.equal(c.autoupdate, false);
  assert.equal(c.share, 'disabled');
  assert.deepEqual(c.instructions, ['/home/user/opencode-agent/instructions.md']);
  assert.deepEqual(c.permission, { '*': 'allow' });
  const prov = c.provider.worker;
  assert.equal(prov.npm, '@ai-sdk/openai-compatible');
  assert.deepEqual([prov.options.baseURL, prov.options.apiKey], ['https://api.particle.ai/v1', '{env:PARTICLE_API_KEY}']);
  assert.deepEqual(Object.keys(prov.models), ['z-ai/glm-5.3-flash']);
  assert.ok(c.experimental.mcp_timeout >= 600000);
});

test('the command reads the prompt and the config from files, resumes by session id, and leaks no value', () => {
  const first = opencodeCommand(P, { home: '/home/user' });
  assert.equal(first, 'OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_CONFIG_CONTENT="$(cat /home/user/opencode-agent/opencode.json)" PATH=/home/user/.local/bin:$PATH opencode run --format json --model worker/z-ai/glm-5.3-flash < /home/user/prompt.txt');
  assert.match(opencodeCommand(P, { home: '/home/user', sessionId: 'ses_e13c38fd9ffejvQOtGfP3pbJkf' }), /--model worker\/z-ai\/glm-5\.3-flash --session ses_e13c38fd9ffejvQOtGfP3pbJkf </);
});

test('MCP servers are converted to opencode entries with {env:NAME} references; unsafe values are skipped', () => {
  const servers = {
    a: { type: 'stdio', command: 'npx', args: ['-y', 'x', '--tok=${MCP_A_TOKEN}'], env: { T: '${MCP_A_TOKEN}' } },
    b: { type: 'http', url: 'https://h.example/mcp', headers: { Authorization: 'Bearer ${MCP_B_TOKEN}' } },
  };
  assert.deepEqual(opencodeMcp(servers), {
    a: { type: 'local', command: ['npx', '-y', 'x', '--tok={env:MCP_A_TOKEN}'], environment: { T: '{env:MCP_A_TOKEN}' }, enabled: true },
    b: { type: 'remote', url: 'https://h.example/mcp', headers: { Authorization: 'Bearer {env:MCP_B_TOKEN}' }, enabled: true },
  });
  const r = forHarness({ servers: { ok: servers.a, bad: { type: 'stdio', command: 'x', env: { Z: '{file:/etc/passwd}' } } }, skipped: [], secrets: ['MCP_A_TOKEN'] }, 'opencode');
  assert.deepEqual(Object.keys(r.servers), ['ok']);
  assert.match(r.skipped[0].reason, /\{env:.*\{file:|opencode/);
});

// ---- profiles ----
const penv = { PARTICLE_API_KEY: 'k', OPENROUTER_API_KEY: 'k', CLOUDY_CLOUD_PROFILES: '/nonexistent' };
test('built-in opencode profiles resolve with the opencode harness', () => {
  for (const [n, m] of [['opencode-glm', 'z-ai/glm-5.3-flash'], ['opencode-deepseek', 'deepseek-ai/deepseek-v41-flash-1017'], ['opencode-particle', 'particle-ai/particle-1']]) {
    const r = resolveProfile(n, undefined, penv);
    assert.deepEqual([r.ok?.harness, r.ok?.model, r.ok?.format, r.ok?.keyName], ['opencode', m, 'openai', 'PARTICLE_API_KEY']);
  }
  const o = resolveProfile('opencode-openrouter', 'z-ai/glm-4.6', penv);
  assert.deepEqual([o.ok.harness, o.ok.baseUrl, o.ok.keyName], ['opencode', 'https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY']);
  assert.match(resolveProfile('opencode-openrouter', undefined, penv).error, /needs a model/);
});

test('an opencode profile must use the openai format', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-prof-'));
  const f = join(dir, 'profiles.json');
  await writeFile(f, JSON.stringify({ mine: { harness: 'opencode', format: 'anthropic', baseUrl: 'https://x.example/v1', keyName: 'X_API_KEY', model: 'm' } }));
  assert.match(resolveProfile('mine', undefined, { X_API_KEY: 'k', CLOUDY_CLOUD_PROFILES: f }).error, /opencode harness only supports format "openai"/);
});

// ---- host ----
test('the host config wires the cloud MCP server by reference and blocks the built-in task tool', () => {
  const c = JSON.parse(hostConfig('/opt/cc', '/tmp/x/instructions.md'));
  assert.deepEqual(c.instructions, ['/tmp/x/instructions.md']);
  assert.deepEqual(c.mcp.cloud.command, ['node', '/opt/cc/src/server.mjs']);
  assert.equal(c.mcp.cloud.type, 'local');
  assert.equal(c.mcp.cloud.environment.INSTABOX_API_KEY, '{env:INSTABOX_API_KEY}');
  assert.equal(c.permission.task, 'deny');
  assert.equal(c.permission['cloud_*'], 'allow');
  assert.ok(c.experimental.mcp_timeout >= 600000);
  assert.match(HOST_PROMPT, /cloud_cloud_agent_wait/);
  assert.match(HOST_PROMPT, /cloudy-cloud\/<id>/);
});

// The launcher with a stub opencode that records its argv, config and the instructions file.
function launch({ config, args = [], gitRepo = true }) {
  const dir = spawnSync('mktemp', ['-d'], { encoding: 'utf8' }).stdout.trim();
  const stub = join(dir, 'opencode');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\nprintf '%s' "$OPENCODE_CONFIG_CONTENT" > "${dir}/cfg"\nc=$(node -e 'console.log(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).instructions[0])')\ncp "$c" "${dir}/instr"\n`);
  chmodSync(stub, 0o755);
  const cfg = join(dir, 'env');
  if (config !== undefined) writeFileSync(cfg, config);
  const env = { PATH: `${dir}:${process.env.PATH}`, HOME: dir, CLOUDY_CLOUD_CONFIG: cfg, CLOUDY_CLOUD_OPENCODE_BIN: stub };
  const r = spawnSync('/bin/sh', [resolve('bin/cloudy-cloud'), 'opencode', ...args], { cwd: dir, env, input: '', encoding: 'utf8' });
  const rd = (n) => { try { return readFileSync(join(dir, n), 'utf8'); } catch { return ''; } };
  return { ...r, argv: rd('argv'), cfg: rd('cfg'), instr: rd('instr') };
}
test('cloudy-cloud opencode starts opencode with the config, the instructions and the user arguments', () => {
  const r = launch({ config: 'INSTABOX_API_KEY=ibk_FAKE\n', args: ['--model', 'openai/gpt-x'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.argv, '--model\nopenai/gpt-x\n');
  assert.ok(JSON.parse(r.cfg).mcp.cloud);
  assert.match(r.instr, /cloud_cloud_agent/);
  assert.ok(!r.cfg.includes('ibk_FAKE'), 'no key value in the config');
});

test('cloudy-cloud opencode without a key stops with the exact next step and does not start opencode', () => {
  const r = launch({ config: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not set up yet/);
  assert.match(r.stderr, /Run: cloudy-cloud setup/);
  assert.equal(r.argv, '');
});

// ---- worker through runSubagent, with a fake opencode on the sandbox PATH ----
const PKEY = 'pk-particle-secret-999';
const FAKE = `#!/bin/sh
p=$(cat)
echo "ARGS $* CFG=$(printf %s "$OPENCODE_CONFIG_CONTENT" | wc -c) PROMPT=$p" >> ../opencode.log
case "$p" in OCUUID*) sed 's/ses_e13c38fd9ffejvQOtGfP3pbJkf/11111111-2222-3333-4444-555555555555/g' ${new URL('./fixtures/', import.meta.url).pathname}opencode-json-sample.jsonl ;; OCERR*) cat ${new URL('./fixtures/', import.meta.url).pathname}opencode-json-error.jsonl; exit 1 ;; *) cat ${new URL('./fixtures/', import.meta.url).pathname}opencode-json-sample.jsonl ;; esac
`;
async function setup() {
  const repo = await mkdtemp(join(tmpdir(), 'oc-repo-'));
  const sh = (cwd, cmd) => exec('sh', ['-c', cmd], { cwd }).then((r) => r.stdout.trim());
  await sh(repo, 'git init -q -b main && git config user.name t && git config user.email t@t && echo x > a.txt && git add -A && git commit -qm init');
  await exec('git', ['remote', 'add', 'origin', 'https://github.com/test/repo.git'], { cwd: repo });
  const github = await mkdtemp(join(tmpdir(), 'oc-github-'));
  await mkdir(join(github, 'test'));
  await sh(github, `git init -q --bare -b main ${join(github, 'test', 'repo.git')}`);
  setGithub(github);
  const sandboxes = [];
  const createSandbox = async (envs) => {
    const sbx = await fakeSandbox(github);
    sbx.envs = envs;
    await writeFile(join(sbx.dir, 'bin', 'opencode'), FAKE);
    await chmod(join(sbx.dir, 'bin', 'opencode'), 0o755);
    sbx.written = {};
    const w = sbx.files.write;
    sbx.files.write = (p, d) => { sbx.written[p] = String(d); return w(p, d); };
    sandboxes.push(sbx);
    return sbx;
  };
  const env = { PARTICLE_API_KEY: PKEY, GH_TOKEN: 'ghp_secret', CLOUDY_CLOUD_PROFILES: '/nonexistent/profiles.json' };
  const deps = { createSandbox, provider: createFakeProvider({ FAKE_API_KEY: 'fake-key' }, { hasProxySecrets: false, hasConsentedSecrets: true }), open: new Map(), cwd: repo, env };
  const text = (r) => r.content[0].text;
  const start = async (args = {}) => text(await runSubagent({ description: 'd', prompt: 'hi', ...args }, deps)).match(/agent_id: ([0-9a-f]{8})/)?.[1];
  const wait = (ids) => waitAgents({ agent_ids: ids, timeout_seconds: 120 }, deps).then(text);
  return { deps, sandboxes, start, wait, text };
}
const log = (sbx) => readFile(join(sbx.dir, 'home', 'opencode.log'), 'utf8');

test('an opencode profile installs pinned opencode, writes a key-free config, and runs it with the prompt from the file', async () => {
  const { start, wait, sandboxes, deps, text } = await setup();
  const id = await start({ profile: 'opencode-glm', prompt: 'do the thing' });
  const r = await wait([id]);
  assert.match(r, /status: idle[\s\S]*Done\./);
  assert.match(r, /Total: 1 tool use, /);
  assert.ok(!/\$\d/.test(r), 'no cost in the result');
  const sbx = sandboxes[0], home = '/home/user', all = sbx.cmds.join('\n');
  assert.ok(sbx.cmds.some((c) => c.includes(`npm install -g --prefix ${home}/.local opencode-ai@${OPENCODE_VERSION}`) && !c.includes('--ignore-scripts')));
  const cfg = JSON.parse(sbx.written[`${home}/opencode-agent/opencode.json`]);
  assert.equal(cfg.provider.worker.options.apiKey, '{env:PARTICLE_API_KEY}');
  assert.match(sbx.written[`${home}/opencode-agent/instructions.md`], /git push/);
  assert.match(sbx.written[`${home}/opencode-agent/instructions.md`], /z-ai\/glm-5\.3-flash/);
  assert.ok(!JSON.stringify(sbx.written).includes(PKEY) && !all.includes(PKEY));
  assert.ok(all.includes('chmod 600'), 'the config file is mode 600');
  assert.deepEqual(Object.keys(sbx.envs), ['PARTICLE_API_KEY']);
  const l = await log(sbx);
  assert.match(l, /ARGS run --format json --model worker\/z-ai\/glm-5\.3-flash CFG=\s*[1-9]\d* PROMPT=do the thing/);
  assert.ok(!l.includes('--session') && !l.includes(PKEY));
  assert.match(text(await listAgents({}, deps)), /profile opencode-glm/);
});

test('an opencode follow-up resumes the session by its ses_ id', async () => {
  const { start, wait, deps, sandboxes } = await setup();
  const id = await start({ profile: 'opencode-deepseek' });
  await wait([id]);
  await messageAgent({ agent_id: id, message: 'again' }, deps);
  assert.match(await wait([id]), /status: idle/);
  const lines = (await log(sandboxes[0])).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /--session ses_e13c38fd9ffejvQOtGfP3pbJkf CFG=\s*[1-9]\d* PROMPT=again/);
});

test('a failed opencode run shows its error text and the exit code', async () => {
  const { start, wait } = await setup();
  const id = await start({ profile: 'opencode-particle', prompt: 'OCERR now' });
  const r = await wait([id]);
  assert.match(r, /status: failed/);
  assert.match(r, /Unexpected server error/);
});

test('an opencode worker cannot be a coordinator', async () => {
  const { deps } = await setup();
  const r = await runSubagent({ description: 'd', prompt: 'hi', profile: 'opencode-glm', role: 'coordinator' }, deps);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /coordinator.*opencode/);
});


// ---- Astra review fixes ----
test('a worker run turns off project config, so a checked-out repository cannot add MCP servers or plugins', () => {
  assert.match(opencodeCommand(P, { home: '/home/user' }), /^OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_CONFIG_CONTENT=/);
});

test('an opencode session id must look like ses_..., not a UUID', async () => {
  const { start, wait } = await setup();
  const r = await wait([await start({ profile: 'opencode-glm', prompt: 'OCUUID now' })]);
  assert.match(r, /invalid session_id/);
});

test('the opencode launcher forwards SIGTERM to opencode and exits when it exits', async () => {
  const dir = (await mkdtemp(join(tmpdir(), 'oc-sig-')));
  const stub = join(dir, 'opencode');
  writeFileSync(stub, `#!/bin/sh\ntrap 'echo TERM > "${dir}/got"; exit 0' TERM\necho up > "${dir}/ready"\nwhile :; do sleep 0.1; done\n`);
  chmodSync(stub, 0o755);
  writeFileSync(join(dir, 'env'), 'INSTABOX_API_KEY=ibk_FAKE\n');
  const p = spawn('node', [resolve('src/host-opencode.mjs')], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, CLOUDY_CLOUD_CONFIG: join(dir, 'env'), CLOUDY_CLOUD_OPENCODE_BIN: stub }, stdio: 'ignore' });
  const closed = new Promise((r) => p.on('close', (code, sig) => r({ code, sig })));
  for (let i = 0; i < 100 && !existsSync(join(dir, 'ready')); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(join(dir, 'ready')), 'the stub started');
  p.kill('SIGTERM');
  const res = await Promise.race([closed, new Promise((r) => setTimeout(() => { p.kill('SIGKILL'); r('hung'); }, 5000))]);
  assert.notEqual(res, 'hung', 'the launcher exits after SIGTERM');
  assert.equal(readFileSync(join(dir, 'got'), 'utf8').trim(), 'TERM');
});
