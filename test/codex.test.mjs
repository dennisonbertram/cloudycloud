import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseCodexStream, createCodexProgress } from '../src/progress-codex.mjs';
import { modelLine, totalLine } from '../src/progress.mjs';
import { resolveProfile, loadProfiles } from '../src/profiles.mjs';
import { consentedLiterals } from '../src/mcpsync.mjs';
import { redactText } from '../src/events.mjs';
import { CODEX_VERSION, codexConfig, codexCommand, codexAuth, codexNextStep, codexMcp } from '../src/harness-codex.mjs';
import { codexHostArgs, codexPrompt } from '../src/host-codex.mjs';
import { forHarness } from '../src/mcpsync.mjs';
import { fakeSandbox, setGithub, getGithub, createFakeProvider } from './fake-provider.mjs';
import { runSubagent, messageAgent, waitAgents, listAgents } from '../src/run-subagent.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const SID = '01a1ec3c-b453-7fc1-9285-7b6d7c3dadd8'; // the thread id in the recorded fixtures
const KEY = 'sk-openai-secret-4242';
const TOKEN = 'eyJ.chatgpt-access-token-aaaaaaaaaaaa';
const REFRESH = 'rt_chatgpt-refresh-token-bbbbbbbbbbbb';

// ---- progress parser (fixtures recorded from codex-cli 0.166.0, `codex exec --json`) ----
test('codex fixtures: session id, tool uses, tokens and the final text', () => {
  const p = parseCodexStream(fx('codex-json-sample.jsonl'));
  assert.equal(p.tools, 1);
  assert.equal(p.step, 'Bash /bin/zsh -lc \'echo hello > a.txt\'');
  assert.deepEqual(p.totals(), { tools: 1, in: 52351, out: 50 });
  assert.deepEqual(p.final, { subtype: 'success', is_error: false, session_id: SID, result: 'done' });
  assert.match(totalLine(p, { cost: false }), /^Total: 1 tool use, 52.4k in \/ 50 out tokens/);
  // codex does not report the model, so it stays unconfirmed
  assert.match(modelLine(p, { model: 'default', host: 'chatgpt.com', name: 'codex-chatgpt' }), /requested via chatgpt\.com .*not confirmed/);
});

test('a resumed codex turn is parsed the same way and keeps the same thread id', () => {
  const p = parseCodexStream(fx('codex-json-resume.jsonl'));
  assert.equal(p.final.session_id, SID);
  assert.equal(p.final.result, 'hello');
  assert.equal(p.tools, 1);
});

test('a turn.failed event makes an error result with codex\'s own message', () => {
  const p = parseCodexStream(fx('codex-json-error.jsonl'));
  assert.equal(p.final.is_error, true);
  assert.match(p.final.result, /'gpt-5\.5' model is not supported when using Codex with a ChatGPT account/);
  assert.equal(p.tools, 0);
});

test('feeding chunks that split a line works, and mcp tool calls, file changes and a truncated stream are handled', () => {
  const p = createCodexProgress();
  const text = fx('codex-json-sample.jsonl');
  p.feed(text.slice(0, 100));
  p.feed(text.slice(100));
  p.end();
  assert.equal(p.final.result, 'done');
  const q = createCodexProgress();
  q.feed('{"type":"thread.started","thread_id":"x"}\n{"type":"item.started","item":{"id":"i1","type":"mcp_tool_call","server":"ctx","tool":"query","status":"in_progress"}}\n{"type":"item.completed","item":{"id":"i2","type":"file_change","changes":[{"path":"src/a.js","kind":"update"}],"status":"completed"}}\nnot json\n');
  q.end();
  assert.equal(q.tools, 2);
  assert.equal(q.step, 'Edit src/a.js');
  assert.equal(q.final, undefined, 'no turn.completed: no final, the caller shows the raw output');
});

// ---- profiles ----
const mk = (profiles) => { const d = mkdtempSync(join(tmpdir(), 'cx-prof-')); const f = join(d, 'p.json'); writeFileSync(f, JSON.stringify(profiles)); return { CLOUDY_CLOUD_PROFILES: f }; };
const authFile = (body = { auth_mode: 'chatgpt', tokens: { access_token: TOKEN, refresh_token: REFRESH, account_id: 'acct' } }, mode = 0o600) => {
  const f = join(mkdtempSync(join(tmpdir(), 'cx-auth-')), 'codex-auth.json');
  writeFileSync(f, JSON.stringify(body));
  chmodSync(f, mode);
  return f;
};

test('codex built-in profiles: the OpenAI key, the ChatGPT login and OpenRouter', () => {
  const env = { OPENAI_API_KEY: KEY, OPENROUTER_API_KEY: 'or', CLOUDY_CLOUD_PROFILES: '/nonexistent', CLOUDY_CLOUD_CODEX_AUTH: authFile() };
  const k = resolveProfile('codex', undefined, env).ok;
  assert.deepEqual([k.harness, k.keyName, k.baseUrl, k.model], ['codex', 'OPENAI_API_KEY', 'https://api.openai.com/v1', 'default']);
  const c = resolveProfile('codex-chatgpt', undefined, env).ok;
  assert.deepEqual([c.harness, c.auth, c.keyName], ['codex', 'chatgpt', undefined]);
  const o = resolveProfile('codex-openrouter', 'z-ai/glm-5.2', env).ok;
  assert.deepEqual([o.harness, o.keyName, o.baseUrl, o.model], ['codex', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1', 'z-ai/glm-5.2']);
  assert.match(resolveProfile('codex-openrouter', undefined, env).error, /needs a model/);
  assert.ok(!('codex-glm' in loadProfiles(env)), 'Particle has no /v1/responses, which codex requires, so there is no codex-glm');
});

test('codex-chatgpt without the login file tells the user the exact command; a loose file mode is refused', () => {
  const missing = resolveProfile('codex-chatgpt', undefined, { CLOUDY_CLOUD_PROFILES: '/nonexistent', CLOUDY_CLOUD_CODEX_AUTH: '/nonexistent/codex-auth.json' }).error;
  assert.match(missing, /codex login/);
  assert.match(missing, /install -m 600 ~\/\.codex\/auth\.json ~\/\.config\/cloudy-cloud\/codex-auth\.json/);
  const loose = resolveProfile('codex-chatgpt', undefined, { CLOUDY_CLOUD_PROFILES: '/nonexistent', CLOUDY_CLOUD_CODEX_AUTH: authFile(undefined, 0o644) }).error;
  assert.match(loose, /chmod 600/);
});

test('codex-chatgpt is allowed on a provider with proxy secrets (a file, not a key), and the key profile is still proxy-only', () => {
  const env = { CLOUDY_CLOUD_PROFILES: '/nonexistent', CLOUDY_CLOUD_CODEX_AUTH: authFile(), OPENAI_API_KEY: KEY };
  assert.ok(resolveProfile('codex-chatgpt', undefined, env, { proxyOnly: true }).ok);
  assert.match(resolveProfile('codex', undefined, env, { proxyOnly: true }).error, /not as a proxy secret/);
});

test('"harness": "codex" in profiles.json works for a key profile; a bad harness name still lists codex', () => {
  const env = { MYKEY_API_KEY: 'k', ...mk({ mine: { harness: 'codex', format: 'openai', baseUrl: 'https://example.com/v1', model: 'm1', keyName: 'MYKEY_API_KEY' }, bad: { harness: 'x', format: 'openai', baseUrl: 'https://example.com/v1', model: 'm1', keyName: 'MYKEY_API_KEY' } }) };
  assert.equal(resolveProfile('mine', undefined, env).ok.harness, 'codex');
  assert.match(resolveProfile('bad', undefined, env).error, /"claude", "pi", "omp" or "codex"|"codex"/);
});

// ---- config, command, auth ----
test('codexConfig names the key variable and never holds a value; ChatGPT login needs no provider block', () => {
  const p = resolveProfile('codex-openrouter', 'z-ai/glm-5.2', { OPENROUTER_API_KEY: 'or-secret', CLOUDY_CLOUD_PROFILES: '/nonexistent' }).ok;
  const t = codexConfig(p, {});
  assert.match(t, /^model = "z-ai\/glm-5\.2"$/m);
  assert.match(t, /^model_provider = "worker"$/m);
  assert.match(t, /\[model_providers\.worker\]\nname = "worker"\nbase_url = "https:\/\/openrouter\.ai\/api\/v1"\nenv_key = "OPENROUTER_API_KEY"\nwire_api = "responses"/);
  assert.ok(!t.includes('or-secret'));
  const c = codexConfig({ auth: 'chatgpt', model: 'default', baseUrl: 'https://chatgpt.com/backend-api/codex' }, {});
  assert.ok(!c.includes('model_providers') && !/^model = /m.test(c));
  assert.match(c, /^cli_auth_credentials_store = "file"$/m);
});

test('codexCommand: first turn, resume, model flag only for a real model, key-free', () => {
  const home = '/home/user';
  const first = codexCommand({ model: 'default' }, { home, hint: 'HINT' });
  assert.equal(first, `CODEX_HOME=${home}/codex-home PATH=${home}/.local/bin:$PATH codex exec --json --dangerously-bypass-approvals-and-sandbox -c 'developer_instructions="HINT"' - < ${home}/prompt.txt`);
  const next = codexCommand({ model: 'z-ai/glm-5.2' }, { home, hint: 'HINT', sessionId: SID });
  assert.match(next, new RegExp(`codex exec resume ${SID} --json --dangerously-bypass-approvals-and-sandbox -m z-ai/glm-5\\.2 -c`));
  assert.throws(() => codexCommand({ model: 'default' }, { home, hint: 'x', sessionId: 'x; rm -rf /' }), /session/);
  assert.throws(() => codexCommand({ model: 'a b' }, { home, hint: 'x' }), /model/);
});

test('codexAuth reads the login file, lists its tokens for scrubbing, and rejects bad content', () => {
  const a = codexAuth({ CLOUDY_CLOUD_CODEX_AUTH: authFile() });
  assert.ok(a.text.includes(TOKEN));
  assert.deepEqual(a.values.sort(), [REFRESH, TOKEN].sort());
  assert.match(codexAuth({ CLOUDY_CLOUD_CODEX_AUTH: authFile('not an object') }).error, /not a Codex login file/);
  assert.match(codexAuth({ CLOUDY_CLOUD_CODEX_AUTH: '/nonexistent/x.json' }).error, /codex login/);
});

test('codexNextStep gives an exact next step for known failures and nothing for unknown ones', () => {
  assert.match(codexNextStep("The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account."), /omit the model|model argument/i);
  assert.match(codexNextStep('401 Unauthorized: token_expired'), /codex login[\s\S]*install -m 600/);
  assert.match(codexNextStep('Incorrect API key provided'), /OPENAI_API_KEY|provider key/);
  assert.equal(codexNextStep('something else'), '');
});

// ---- MCP servers for the worker's config.toml ----
test('codexMcp: http headers and bearer tokens use env var names; stdio refs go through a tiny sh wrapper; sse is skipped', () => {
  const mcp = { servers: {
    plain: { command: 'npx', args: ['-y', 'ctx7'] },
    keyed: { command: 'npx', args: ['-y', 'x'], env: { X_KEY: '${MCP_KEYED_TOKEN}', MODE: 'fast' } },
    web: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${MCP_WEB_TOKEN}', 'X-Key': '${MCP_WEB2_TOKEN}', 'X-Team': 'blue' } },
    live: { type: 'sse', url: 'https://mcp.example.com/sse' },
  }, skipped: [], secrets: ['MCP_KEYED_TOKEN', 'MCP_WEB_TOKEN', 'MCP_WEB2_TOKEN'], literal: [] };
  const r = forHarness(mcp, 'codex');
  assert.deepEqual(Object.keys(r.servers), ['plain', 'keyed', 'web']);
  assert.match(r.skipped.find((s) => s.name === 'live').reason, /SSE/);
  const t = codexMcp(r.servers);
  assert.match(t, /\[mcp_servers\.plain\]\ncommand = "npx"\nargs = \["-y","ctx7"\]/);
  assert.match(t, /\[mcp_servers\.keyed\]\ncommand = "sh"\nargs = \["-c","export X_KEY=\\"\$MCP_KEYED_TOKEN\\"; exec \\"\$0\\" \\"\$@\\"","npx","-y","x"\]\nenv = \{ MODE = "fast" \}\nenv_vars = \["MCP_KEYED_TOKEN"\]/);
  assert.match(t, /\[mcp_servers\.web\]\nurl = "https:\/\/mcp\.example\.com\/mcp"\nbearer_token_env_var = "MCP_WEB_TOKEN"\nhttp_headers = \{ X-Team = "blue" \}\nenv_http_headers = \{ X-Key = "MCP_WEB2_TOKEN" \}/);
});

// ---- host launcher ----
test('codexHostArgs wires the cloud server through -c flags, forwards key names (never values) and carries the instructions', () => {
  const args = codexHostArgs({ root: '/opt/cc', config: '/home/u/.config/cloudy-cloud/env', env: { INSTABOX_API_KEY: 'ibk_secret_value', OPENAI_API_KEY: KEY } });
  const all = args.join('\n');
  assert.ok(args.every((a, i) => a === '-c' || args[i - 1] === '-c'), 'only -c pairs');
  assert.match(all, /mcp_servers\.cloud\.command="node"/);
  assert.match(all, /mcp_servers\.cloud\.args=\["\/opt\/cc\/src\/server\.mjs"\]/);
  assert.match(all, /mcp_servers\.cloud\.env=\{ CLOUDY_CLOUD_CONFIG = "\/home\/u\/\.config\/cloudy-cloud\/env" \}/);
  assert.match(all, /mcp_servers\.cloud\.env_vars=\[[^\]]*"INSTABOX_API_KEY"[^\]]*"OPENAI_API_KEY"/);
  assert.match(all, /mcp_servers\.cloud\.default_tools_approval_mode="approve"/);
  assert.match(all, /mcp_servers\.cloud\.tool_timeout_sec=1800/);
  assert.ok(!all.includes('ibk_secret_value') && !all.includes(KEY));
  const instr = JSON.parse(args.find((a) => a.startsWith('developer_instructions=')).slice('developer_instructions='.length));
  assert.equal(instr, codexPrompt());
  assert.match(instr, /cloud_agent/);
  assert.match(instr, /cloud_agent_wait/);
  assert.match(instr, /never print/i);
});

const run = promisify(execFile);
test('bin/cloudy-cloud codex --help passes the argument to codex (no Claude token is demanded for a codex host)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cx-home-'));
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'codex'), '#!/bin/sh\necho "CODEX $*"\n');
  await chmod(join(bin, 'codex'), 0o755);
  const cfgDir = join(home, '.config/cloudy-cloud');
  await mkdir(cfgDir, { recursive: true });
  await writeFile(join(cfgDir, 'env'), 'INSTABOX_API_KEY=ibk_x\n');
  const { stdout } = await run(join(import.meta.dirname, '../bin/cloudy-cloud'), ['codex', '--version'], { cwd: join(import.meta.dirname, '..'), env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, CLOUDY_CLOUD_CONFIG: join(cfgDir, 'env') } });
  assert.match(stdout, /^CODEX -c mcp_servers\.cloud\.command="node" .*--version/);
});

// ---- the worker, end to end on the fake sandbox ----
const FAKE_CODEX = (fixtures) => `#!/bin/sh
p=$(cat)
echo "ARGS $* HOME=$CODEX_HOME KEY=$OPENAI_API_KEY PROMPT=$p" >> ../codex.log
case "$p" in CODEXLEAK*) printf '%s\\n' '{"type":"thread.started","thread_id":"01a1ec3c-b453-7fc1-9285-7b6d7c3dadd8"}' '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"refreshed eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4In0.c2lnbmF0dXJl and rt_RefreshedTokenValue1234567890abcdef"}}' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}' ;; CODEXERR*) cat ${fixtures}codex-json-error.jsonl; exit 1 ;; *) case "$*" in *resume*) cat ${fixtures}codex-json-resume.jsonl ;; *) cat ${fixtures}codex-json-sample.jsonl ;; esac ;; esac
`;
const FIX = new URL('./fixtures/', import.meta.url).pathname;

async function world(envOver = {}, provOpts = { hasProxySecrets: false, hasConsentedSecrets: true }) {
  const repo = await mkdtemp(join(tmpdir(), 'cc-repo-'));
  const sh = (cwd, cmd) => run('sh', ['-c', cmd], { cwd }).then((r) => r.stdout.trim());
  await sh(repo, 'git init -q -b main && git config user.name t && git config user.email t@t && echo orig > a.txt && git add -A && git commit -qm init && git remote add origin https://github.com/test/repo.git');
  const github = await mkdtemp(join(tmpdir(), 'cc-github-'));
  await mkdir(join(github, 'test'));
  await sh(github, `git init -q --bare -b main ${join(github, 'test', 'repo.git')}`);
  setGithub(github);
  const sandboxes = [];
  const secretHook = {}; // a test sets secretHook.fn to give every sandbox a writeSecret (the upload-only call of a provider that has one)
  const env = { GH_TOKEN: 'ghp_secret', OPENAI_API_KEY: KEY, OPENROUTER_API_KEY: 'or-secret-1', CLOUDY_CLOUD_PROFILES: '/nonexistent/profiles.json', CLOUDY_CLOUD_CODEX_AUTH: authFile(), ...envOver };
  const deps = {
    env, cwd: repo, open: new Map(), provider: createFakeProvider({ FAKE_API_KEY: 'k' }, provOpts),
    createSandbox: async (envs, opts) => {
      const sbx = await fakeSandbox(getGithub());
      sbx.envs = envs;
      sbx.opts = opts;
      await writeFile(join(sbx.dir, 'bin', 'codex'), FAKE_CODEX(FIX));
      await chmod(join(sbx.dir, 'bin', 'codex'), 0o755);
      sbx.written = {};
      const w = sbx.files.write;
      sbx.files.write = (p, d) => { sbx.written[p] = String(d); return w(p, d); };
      if (secretHook.fn) sbx.files.writeSecret = async (p, d) => { await secretHook.fn(p, d, sbx); sbx.secretWritten = { ...sbx.secretWritten, [p]: String(d) }; return w(p, d); };
      sandboxes.push(sbx);
      return sbx;
    },
  };
  const text = (r) => r.content[0].text;
  const start = async (args = {}) => text(await runSubagent({ description: 'd', prompt: 'hi', ...args }, deps)).match(/agent_id: ([0-9a-f]{8})/)?.[1];
  const wait = (ids) => waitAgents({ agent_ids: ids, timeout_seconds: 120 }, deps).then(text);
  return { deps, sandboxes, text, start, wait, env, secretHook };
}
const codexLog = (sbx) => readFile(join(sbx.dir, 'home', 'codex.log'), 'utf8');

test('a codex key profile installs pinned codex, writes a key-free config.toml, sends only the key as env, and runs codex with the prompt from stdin', async () => {
  const { start, wait, sandboxes, text, deps } = await world();
  const id = await start({ profile: 'codex', prompt: 'do the thing' });
  const r = await wait([id]);
  assert.match(r, /status: idle[\s\S]*done/);
  assert.match(r, /Total: 1 tool use, 52.4k in \/ 50 out tokens, /);
  assert.ok(!/\$\d/.test(r), 'no cost in the result');
  const sbx = sandboxes[0], all = sbx.cmds.join('\n'), home = '/home/user';
  assert.ok(sbx.cmds.some((c) => c.includes(`npm install -g --ignore-scripts --prefix ${home}/.local @openai/codex@${CODEX_VERSION}`)));
  const cfg = sbx.written[`${home}/codex-home/config.toml`];
  assert.match(cfg, /env_key = "OPENAI_API_KEY"/);
  assert.ok(!JSON.stringify(sbx.written).includes(KEY) && !all.includes(KEY));
  assert.deepEqual(Object.keys(sbx.envs), ['OPENAI_API_KEY']);
  assert.equal(sbx.written[`${home}/codex-home/auth.json`], undefined, 'a key profile does not send the ChatGPT login');
  const log = await codexLog(sbx);
  assert.match(log, /ARGS exec --json --dangerously-bypass-approvals-and-sandbox -c developer_instructions=.*git push.*foreground.* - HOME=\S+codex-home KEY=\S* PROMPT=do the thing/);
  assert.ok(!log.includes('resume'));
  assert.match(text(await listAgents({}, deps)), /profile codex/);
});

test('a codex follow-up resumes the same session by id', async () => {
  const { start, wait, sandboxes, deps } = await world();
  const id = await start({ profile: 'codex' });
  await wait([id]);
  await messageAgent({ agent_id: id, message: 'again' }, deps);
  assert.match(await wait([id]), /status: idle[\s\S]*hello/);
  const lines = (await codexLog(sandboxes[0])).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], new RegExp(`ARGS exec resume ${SID} --json `));
  assert.match(lines[1], /PROMPT=again/);
});

test('codex-chatgpt writes the login to a mode-600 file by file write, sends no env key, and scrubs the tokens from replies', async () => {
  const { start, wait, sandboxes, env } = await world();
  const id = await start({ profile: 'codex-chatgpt' });
  const r = await wait([id]);
  assert.match(r, /status: idle/);
  const sbx = sandboxes[0], all = sbx.cmds.join('\n'), home = '/home/user';
  assert.deepEqual(Object.keys(sbx.envs), []);
  assert.equal(JSON.parse(sbx.written[`${home}/codex-home/auth.json`]).tokens.access_token, TOKEN);
  assert.ok(!all.includes(TOKEN) && !all.includes(REFRESH), 'tokens are never in a command');
  assert.ok(sbx.cmds.some((c) => /umask 077 && mkdir -p \S+codex-home && chmod 700 \S+codex-home && : > \S+codex-home\/auth\.json/.test(c)));
  assert.ok(sbx.cmds.some((c) => /chmod 600 \S+codex-home\/auth\.json/.test(c)));
  assert.ok(!sbx.written[`${home}/codex-home/config.toml`].includes(TOKEN));
  assert.ok(!r.includes(TOKEN) && !r.includes(REFRESH) && !r.includes(KEY));
  assert.ok(env.CLOUDY_CLOUD_CODEX_AUTH);
  assert.ok(!/ -m /.test(await codexLog(sbx)), 'the default model: no -m');
});

test('a codex-chatgpt reply that echoes a token is redacted', async () => {
  const { deps, sandboxes, start, wait } = await world();
  const id = await start({ profile: 'codex-chatgpt' });
  await wait([id]);
  assert.ok(deps.literals.has(TOKEN) && deps.literals.has(REFRESH));
  assert.equal(sandboxes.length, 1);
});

test('a failing codex turn shows codex\'s own error and an exact next step', async () => {
  const { start, wait } = await world();
  const id = await start({ profile: 'codex-chatgpt', prompt: 'CODEXERR now' });
  const r = await wait([id]);
  assert.match(r, /status: failed/);
  assert.match(r, /exit code 1/);
  assert.match(r, /not supported when using Codex with a ChatGPT account/);
  assert.match(r, /Next step:/);
});

test('MCP servers go to config.toml in the codex home, and skipped ones are named in the reply', async () => {
  const f = join(mkdtempSync(join(tmpdir(), 'cx-mcp-')), 'mcp.json');
  writeFileSync(f, JSON.stringify({ mcpServers: { ctx: { command: 'npx', args: ['-y', 'ctx7'] }, live: { type: 'sse', url: 'https://mcp.example.com/sse' } } }));
  const { start, wait, sandboxes } = await world({ CLOUDY_CLOUD_MCP: f });
  const r = await wait([await start({ profile: 'codex' })]);
  const cfg = sandboxes[0].written['/home/user/codex-home/config.toml'];
  assert.match(cfg, /\[mcp_servers\.ctx\]\ncommand = "npx"/);
  assert.ok(!cfg.includes('mcp_servers.live'));
  assert.match(r, /MCP servers skipped: live \(.*SSE/);
});

test('a codex worker cannot be a coordinator', async () => {
  const { deps } = await world();
  const r = await runSubagent({ description: 'd', prompt: 'hi', profile: 'codex', role: 'coordinator' }, deps);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /coordinator.*codex/);
});

test('on a provider with proxy secrets the OpenAI key is delivered as a proxy secret name, and the ChatGPT login is still a file', async () => {
  const { start, wait, sandboxes } = await world({ CLOUDY_CLOUD_PROXY_SECRETS: 'OPENAI_API_KEY' }, {});
  const id = await start({ profile: 'codex' });
  await wait([id]);
  assert.deepEqual(sandboxes[0].opts.secrets, ['OPENAI_API_KEY']);
  assert.deepEqual(Object.keys(sandboxes[0].envs), []);
});


// ---- Astra review fixes ----
test('codexAuth accepts only a real ChatGPT token record: a file with an OPENAI_API_KEY is refused with the next step', () => {
  const key = codexAuth({ CLOUDY_CLOUD_CODEX_AUTH: authFile({ OPENAI_API_KEY: 'sk-proj-abcdefghijklmnop1234' }) });
  assert.match(key.error, /OPENAI_API_KEY/);
  assert.match(key.error, /Next step:.*profile codex|Next step:.*codex login/s);
  const both = codexAuth({ CLOUDY_CLOUD_CODEX_AUTH: authFile({ auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-proj-abcdefghijklmnop1234', tokens: { access_token: TOKEN, refresh_token: REFRESH } }) });
  assert.match(both.error, /OPENAI_API_KEY/);
  assert.match(codexAuth({ CLOUDY_CLOUD_CODEX_AUTH: authFile({ tokens: { access_token: TOKEN } }) }).error, /not a Codex login file/);
  assert.ok(codexAuth({ CLOUDY_CLOUD_CODEX_AUTH: authFile({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: TOKEN, refresh_token: REFRESH } }) }).text, 'the null OPENAI_API_KEY that codex login writes is fine');
});

test('codexAuth sends only the fields codex needs, not the whole file', () => {
  const a = codexAuth({ CLOUDY_CLOUD_CODEX_AUTH: authFile({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: '2026-01-01T00:00:00Z', unrelated: 'EXTRA-SECRET-FIELD', tokens: { id_token: 'idt', access_token: TOKEN, refresh_token: REFRESH, account_id: 'acct', other: 'EXTRA-TOKEN-FIELD' } }) });
  assert.deepEqual(Object.keys(JSON.parse(a.text)).sort(), ['auth_mode', 'last_refresh', 'tokens']);
  assert.deepEqual(Object.keys(JSON.parse(a.text).tokens).sort(), ['access_token', 'account_id', 'id_token', 'refresh_token']);
  assert.ok(!a.text.includes('EXTRA'));
});

test('secret files go through writeSecret when the provider has one, and a refusal fails the worker with a next step', async () => {
  const w = await world();
  w.secretHook.fn = () => {};
  await w.wait([await w.start({ profile: 'codex-chatgpt' })]);
  assert.equal(JSON.parse(w.sandboxes[0].secretWritten['/home/user/codex-home/auth.json']).tokens.access_token, TOKEN);
  const bad = await world();
  bad.secretHook.fn = () => { throw Object.assign(new Error('The upload route is not available, so a secret file cannot be written safely.\nNext step: retry in a minute.'), { code: 'secret_write_unsupported' }); };
  const r = await bad.wait([await bad.start({ profile: 'codex-chatgpt' })]);
  assert.match(r, /status: failed/);
  assert.match(r, /cannot be written safely/);
  assert.ok(!JSON.stringify(bad.sandboxes[0].cmds).includes(TOKEN));
});

test('an MCP server that carries an allowed literal token is written with writeSecret; a config without one is not', async () => {
  const f = join(mkdtempSync(join(tmpdir(), 'cx-lit-')), 'mcp.json');
  writeFileSync(f, JSON.stringify({ mcpServers: { lit: { command: 'npx', args: ['-y', 'x'], env: { X_API_KEY: 'literal-token-value-123456' }, cloudyCloudAllowLiteral: true } } }));
  const w = await world({ CLOUDY_CLOUD_MCP: f });
  w.secretHook.fn = () => {};
  await w.wait([await w.start({ profile: 'codex' })]);
  assert.ok(w.sandboxes[0].secretWritten['/home/user/codex-home/config.toml'].includes('literal-token-value-123456'));
  const plain = await world();
  plain.secretHook.fn = () => {};
  await plain.wait([await plain.start({ profile: 'codex' })]);
  assert.equal(plain.sandboxes[0].secretWritten?.['/home/user/codex-home/config.toml'], undefined);
});

test('config.toml is created and left mode 600, like auth.json', async () => {
  const { start, wait, sandboxes } = await world();
  await wait([await start({ profile: 'codex' })]);
  const cmds = sandboxes[0].cmds;
  assert.ok(cmds.some((c) => /: > \S+codex-home\/config\.toml/.test(c)), 'an empty mode-600 file exists before the write');
  assert.ok(cmds.some((c) => /chmod 600 \S+codex-home\/config\.toml/.test(c)));
});

test('a codex reply that echoes a refreshed token the laptop never saw is redacted by pattern, and the login tokens are known literals', async () => {
  const { start, wait } = await world();
  const r = await wait([await start({ profile: 'codex-chatgpt', prompt: 'CODEXLEAK now' })]);
  assert.match(r, /refreshed \[redacted\] and \[redacted\]/);
  assert.ok(!r.includes('eyJhbGciOiJSUzI1NiJ9') && !r.includes('RefreshedTokenValue'));
  assert.deepEqual(consentedLiterals({ CLOUDY_CLOUD_CODEX_AUTH: authFile(), CLOUDY_CLOUD_MCP: '/nonexistent' }).sort(), [REFRESH, TOKEN].sort(), 'the dashboard scrubs the login tokens too');
  assert.equal(redactText('x rt_RefreshedTokenValue1234567890abcdef y'), 'x [redacted] y');
});

test('a Bearer reference in a header other than Authorization is skipped with a reason, not written as literal text', () => {
  const r = forHarness({ servers: { w: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Api': 'Bearer ${MCP_W_TOKEN}' } } }, skipped: [], secrets: ['MCP_W_TOKEN'], literal: [] }, 'codex');
  assert.deepEqual(Object.keys(r.servers), []);
  assert.match(r.skipped[0].reason, /Authorization/);
});
