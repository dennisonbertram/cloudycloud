import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflightProfile, resetPreflightCache, resolveProfile, loadProfiles, profileKeyNames, gatewayConfig, ompModels, ompConfig, ompCommand, OMP_VERSION } from '../src/profiles.mjs';
import { loadEnv } from '../src/config.mjs';

const none = join(tmpdir(), 'no-such-profiles.json');
const env = { CLOUDY_CLOUD_PROFILES: none, PARTICLE_API_KEY: 'k1', OPENROUTER_API_KEY: 'k2' };
const file = (obj) => { const f = join(mkdtempSync(join(tmpdir(), 'prof-')), 'profiles.json'); writeFileSync(f, JSON.stringify(obj)); return f; };

test('built-in profiles resolve without a file', () => {
  for (const n of ['glm', 'deepseek', 'particle']) {
    const p = resolveProfile(n, undefined, env).ok;
    assert.equal(p.format, 'openai'); assert.equal(p.baseUrl, 'https://api.particle.ai/v1'); assert.equal(p.keyName, 'PARTICLE_API_KEY');
  }
  assert.equal(resolveProfile('glm', undefined, env).ok.model, 'z-ai/glm-5.3-flash');
  assert.equal(resolveProfile('deepseek', undefined, env).ok.model, 'deepseek-ai/deepseek-v41-flash-1017');
  assert.equal(resolveProfile('particle', undefined, env).ok.model, 'particle-ai/particle-1');
  assert.equal(resolveProfile('openrouter', 'x/y', env).ok.format, 'anthropic');
  assert.match(resolveProfile('openrouter', undefined, env).error, /needs a model/);
});

test('profiles.json overrides and adds profiles', () => {
  const f = file({ glm: { format: 'openai', baseUrl: 'https://example.com/v1', model: 'm1', keyName: 'OTHER_API_KEY' }, mine: { format: 'anthropic', baseUrl: 'https://x.test/api', model: 'mm', keyName: 'PARTICLE_API_KEY' }, openrouter: { format: 'anthropic', baseUrl: 'https://openrouter.ai/api', model: 'a/b', keyName: 'OPENROUTER_API_KEY' } });
  const e = { ...env, CLOUDY_CLOUD_PROFILES: f, OTHER_API_KEY: 'k3' };
  assert.equal(resolveProfile('glm', undefined, e).ok.baseUrl, 'https://example.com/v1');
  assert.equal(resolveProfile('mine', undefined, e).ok.model, 'mm');
  assert.equal(resolveProfile('openrouter', undefined, e).ok.model, 'a/b');
  assert.ok('deepseek' in loadProfiles(e));
});

test('unknown, invalid, unsafe and keyless profiles are rejected', () => {
  assert.match(resolveProfile('nope', undefined, env).error, /unknown profile/);
  assert.match(resolveProfile('a b', undefined, env).error, /invalid profile/);
  assert.match(resolveProfile('glm', undefined, { CLOUDY_CLOUD_PROFILES: none }).error, /PARTICLE_API_KEY/);
  assert.match(resolveProfile('glm', 'x; rm', env).error, /needs a model/);
  const f = file({ bad: { format: 'openai', baseUrl: 'https://x.test/\nevil: 1', model: 'm', keyName: 'PARTICLE_API_KEY' }, badkey: { format: 'openai', baseUrl: 'https://x.test', model: 'm', keyName: 'PATH' } });
  assert.match(resolveProfile('bad', undefined, { ...env, CLOUDY_CLOUD_PROFILES: f }).error, /baseUrl/);
  assert.match(resolveProfile('badkey', undefined, { ...env, CLOUDY_CLOUD_PROFILES: f }).error, /keyName/);
});

test('gateway config names the key variable and never holds a key', () => {
  const c = gatewayConfig(resolveProfile('glm', undefined, env).ok);
  assert.match(c, /api_key: os\.environ\/PARTICLE_API_KEY/);
  assert.ok(!c.includes('k1'));
});

test('provider keys load from the saved file, other names do not', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'env');
  writeFileSync(f, 'PARTICLE_API_KEY=pk\nOPENROUTER_API_KEY=ok\nPATH=/evil\nlower_API_KEY=x\n');
  const e = loadEnv({ CLOUDY_CLOUD_CONFIG: f });
  assert.equal(e.PARTICLE_API_KEY, 'pk'); assert.equal(e.OPENROUTER_API_KEY, 'ok');
  assert.equal(e.PATH, undefined); assert.equal(e.lower_API_KEY, undefined);
});

test('pi built-ins use the pi harness; others default to claude', () => {
  const m = { 'pi-glm': 'z-ai/glm-5.3-flash', 'pi-deepseek': 'deepseek-ai/deepseek-v41-flash-1017', 'pi-particle': 'particle-ai/particle-1' };
  for (const [n, model] of Object.entries(m)) {
    const p = resolveProfile(n, undefined, env).ok;
    assert.deepEqual([p.harness, p.format, p.baseUrl, p.model, p.keyName], ['pi', 'openai', 'https://api.particle.ai/v1', model, 'PARTICLE_API_KEY']);
  }
  assert.equal(resolveProfile('glm', undefined, env).ok.harness, 'claude');
  const f = file({ mine: { harness: 'pi', format: 'openai', baseUrl: 'https://x.test/v1', model: 'm', keyName: 'PARTICLE_API_KEY' }, bad: { harness: 'vim', format: 'openai', baseUrl: 'https://x.test/v1', model: 'm', keyName: 'PARTICLE_API_KEY' } });
  const e = { ...env, CLOUDY_CLOUD_PROFILES: f };
  assert.equal(resolveProfile('mine', undefined, e).ok.harness, 'pi');
  assert.match(resolveProfile('bad', undefined, e).error, /harness/);
});

test('profileKeyNames lists the keys profiles use, not every *_API_KEY in the environment', () => {
  const none = join(mkdtempSync(join(tmpdir(), 'cc-prof-')), 'missing.json');
  assert.deepEqual(profileKeyNames({ CLOUDY_CLOUD_PROFILES: none, STRIPE_API_KEY: 'x' }).sort(), ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'PARTICLE_API_KEY']);
  const f = file({ mine: { format: 'anthropic', baseUrl: 'https://x.test/api', model: 'mm', keyName: 'OTHER_API_KEY' }, bad: { keyName: 'lower' }, worse: null });
  assert.deepEqual(profileKeyNames({ CLOUDY_CLOUD_PROFILES: f, STRIPE_API_KEY: 'x' }).sort(), ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OTHER_API_KEY', 'PARTICLE_API_KEY']);
  // A coordinator has no profiles.json, so it still needs the key of a built-in profile that the laptop file overrides.
  const over = file({ openrouter: { format: 'anthropic', baseUrl: 'https://openrouter.ai/api', model: 'mm', keyName: 'MINE_API_KEY' } });
  assert.deepEqual(profileKeyNames({ CLOUDY_CLOUD_PROFILES: over }).sort(), ['MINE_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'PARTICLE_API_KEY']);
  const broken = join(mkdtempSync(join(tmpdir(), 'cc-prof-')), 'p.json');
  writeFileSync(broken, '{not json');
  assert.deepEqual(profileKeyNames({ CLOUDY_CLOUD_PROFILES: broken }).sort(), ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'PARTICLE_API_KEY']);
});

test('omp built-ins and profiles.json use the omp harness; other harness names are rejected', () => {
  const p = resolveProfile('omp-glm', undefined, env).ok;
  assert.deepEqual([p.harness, p.format, p.model, p.keyName], ['omp', 'openai', 'z-ai/glm-5.3-flash', 'PARTICLE_API_KEY']);
  assert.equal(resolveProfile('omp-deepseek', undefined, env).ok.harness, 'omp');
  assert.equal(resolveProfile('omp-particle', undefined, env).ok.model, 'particle-ai/particle-1');
  const mk = (h) => ({ ...env, CLOUDY_CLOUD_PROFILES: file({ mine: { harness: h, format: 'openai', baseUrl: 'https://x.test/v1', model: 'm', keyName: 'PARTICLE_API_KEY' } }) });
  assert.equal(resolveProfile('mine', undefined, mk('omp')).ok.harness, 'omp');
  assert.match(resolveProfile('mine', undefined, mk('x')).error, /harness must be "claude", "pi", "omp", "codex" or "opencode"/);
});

test('ompModels names the key variable and never holds a value; ompConfig turns off imports and project MCP', () => {
  const p = resolveProfile('omp-glm', undefined, env).ok;
  const y = ompModels(p);
  assert.match(y, /apiKey: PARTICLE_API_KEY\n/);
  assert.match(y, /- id: "z-ai\/glm-5\.3-flash"/);
  assert.match(y, /baseUrl: https:\/\/api\.particle\.ai\/v1/);
  assert.doesNotMatch(y, /k1/);
  const c = ompConfig();
  assert.match(c, /disabledProviders: \[claude, claude-plugins, codex, gemini, cursor, windsurf, vscode, opencode, agent-plugins, mcp-json\]/);
  assert.match(c, /mcp:\n  enableProjectConfig: false/);
  assert.equal(OMP_VERSION, '18.18.7');
});

test('ompModels quotes the model id so YAML keeps it a string', () => {
  const y = ompModels({ baseUrl: 'https://h.example.com/v1', keyName: 'X_API_KEY', model: '1.5' });
  assert.match(y, /- id: "1\.5"\n/);
  assert.match(ompModels({ baseUrl: 'https://h.example.com/v1', keyName: 'X_API_KEY', model: 'm:' }), /- id: "m:"\n/);
});

test('ompCommand has the verified flags and no key', () => {
  const p = resolveProfile('omp-glm', undefined, env).ok;
  const c = ompCommand(p, { home: '/home/u', sessionId: 'abc', hint: 'hi' });
  assert.equal(c, "PI_CODING_AGENT_DIR=/home/u/omp-agent PATH=/home/u/.local/bin:$PATH omp -p --mode json --config /home/u/omp-agent/overlay.yml --model worker/z-ai/glm-5.3-flash --session abc --append-system-prompt 'hi' < /home/u/prompt.txt");
  assert.match(ompConfig(), /disabledProviders: \[.*mcp-json\]\nmcp:\n  enableProjectConfig: false/); // the overlay file holds the restrictions
  assert.doesNotMatch(ompCommand(p, { home: '/h', hint: 'x' }), /--session|k1/);
});

test('omp rejects format anthropic, since ompModels only writes openai-completions', () => {
  const r = resolveProfile('mine', undefined, { ...env, CLOUDY_CLOUD_PROFILES: file({ mine: { harness: 'omp', format: 'anthropic', baseUrl: 'https://x.test/v1', model: 'm', keyName: 'PARTICLE_API_KEY' } }) });
  assert.match(r.error, /omp harness only supports format "openai"/);
});

test('a baseUrl that URL cannot parse still returns an error, not a throw', () => {
  const r = resolveProfile('mine', undefined, { CLOUDY_CLOUD_PROFILES: file({ mine: { harness: 'claude', format: 'openai', baseUrl: 'https://foo:bar', model: 'm', keyName: 'PARTICLE_API_KEY' } }) });
  assert.match(r.error, /PARTICLE_API_KEY/);
});

test('a custom profile key set as a real value is refused with the exact steps for that key (#68)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  const file = join(dir, 'profiles.json');
  writeFileSync(file, JSON.stringify({ acme: { format: 'openai', baseUrl: 'https://api.acme.example/v1', keyName: 'ACME_API_KEY', model: 'm1' } }));
  const r = resolveProfile('acme', undefined, { CLOUDY_CLOUD_PROFILES: file, ACME_API_KEY: 'plainvalue' }, { proxyOnly: true });
  assert.match(r.error, /secrets set ACME_API_KEY --host api\.acme\.example/);
  assert.match(r.error, /CLOUDY_CLOUD_PROXY_SECRETS/);
  assert.ok(!r.error.includes('plainvalue'));
});


// ---- Astra review fixes ----
test('coordinatorKeys does not forward an ambient OPENAI_API_KEY; it needs the env file or a proxy secret. Claude-only users see no change', async () => {
  const { coordinatorKeys } = await import('../src/profiles.mjs');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'cc-amb-')), 'env');
  writeFileSync(file, 'PARTICLE_API_KEY=pk-saved\n');
  const self = { keyName: 'X_API_KEY', caps: { hasProxySecrets: false } };
  const base = { CLOUDY_CLOUD_CONFIG: file, CLAUDE_CODE_OAUTH_TOKEN: 'oat', PARTICLE_API_KEY: 'pk-saved', CLOUDY_CLOUD_PROFILES: '/nonexistent' };
  const without = coordinatorKeys(base, self);
  const ambient = coordinatorKeys({ ...base, OPENAI_API_KEY: 'sk-ambient-shell-key' }, self);
  assert.deepEqual(ambient, without, 'a shell-only OPENAI_API_KEY changes nothing');
  assert.ok(!JSON.stringify(ambient).includes('sk-ambient'));
  writeFileSync(file, 'PARTICLE_API_KEY=pk-saved\nOPENAI_API_KEY=sk-saved-key\n');
  assert.ok(coordinatorKeys({ ...base, OPENAI_API_KEY: 'sk-saved-key' }, self).lines.includes('OPENAI_API_KEY=sk-saved-key'), 'saved in the env file: chosen');
  const inst = { keyName: 'INSTABOX_API_KEY', caps: { hasProxySecrets: true } };
  assert.ok(coordinatorKeys({ ...base, OPENAI_API_KEY: 'x', CLOUDY_CLOUD_PROXY_SECRETS: 'OPENAI_API_KEY' }, inst).secrets.includes('OPENAI_API_KEY'), 'a proxy secret: chosen');
  writeFileSync(file, 'PARTICLE_API_KEY=pk-saved\\n');
  assert.ok(!coordinatorKeys({ ...base, OPENAI_API_KEY: 'sk-ambient-shell-key' }, inst).skipped.includes('OPENAI_API_KEY'), 'not even reported as skipped');
});

test('profiles.json fallback and maxConcurrent are validated and passed through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prof-'));
  const mk = (extra) => { const f = join(dir, `p${Math.random()}.json`); writeFileSync(f, JSON.stringify({ x: { harness: 'pi', format: 'openai', baseUrl: 'https://e.com/v1', model: 'm', keyName: 'XYZ_API_KEY', ...extra } })); return { CLOUDY_CLOUD_PROFILES: f, XYZ_API_KEY: 'k' }; };
  const ok = resolveProfile('x', undefined, mk({ fallback: ['pi-glm'], maxConcurrent: 3 })).ok;
  assert.deepEqual([ok.fallback, ok.maxConcurrent], [['pi-glm'], 3]);
  assert.match(resolveProfile('x', undefined, mk({ fallback: 'pi-glm' })).error, /fallback must be a list[\s\S]*Next step:/);
  assert.match(resolveProfile('x', undefined, mk({ maxConcurrent: 0 })).error, /maxConcurrent must be[\s\S]*Next step:/);
});

test('preflightProfile: 404 fails with the key removed, 429 and network errors pass, results are cached 60 s, proxied keys are skipped', async () => {
  resetPreflightCache();
  const p = { name: 'pi-a', format: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm', keyName: 'KEY_API_KEY' };
  const env = { KEY_API_KEY: 'sk-secret' };
  let t = 0, calls = 0, status = 404;
  const fetchFn = async () => { calls++; if (status === 0) throw new Error('boom'); return { status, text: async () => 'model_not_found sk-secret' }; };
  const o = { fetchFn, now: () => t };
  const r = await preflightProfile(p, env, o);
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes('sk-secret') && /Next step:/.test(r.error));
  await preflightProfile(p, env, o);
  assert.equal(calls, 1);
  t = 61_000; status = 429;
  assert.equal((await preflightProfile(p, env, o)).ok, true);
  t = 130_000; status = 0;
  assert.equal((await preflightProfile(p, env, o)).ok, true);
  assert.equal((await preflightProfile({ ...p, proxied: true }, env, o)).skipped, true);
  assert.equal(calls, 3);
});

test('preflightProfile skips codex and default-model profiles: the codex harness uses the Responses API, not /chat/completions', async () => {
  resetPreflightCache();
  let calls = 0;
  const fetchFn = async () => { calls++; return { status: 404, text: async () => 'no' }; };
  const e = { OPENAI_API_KEY: 'sk-x', KEY_API_KEY: 'sk-y' };
  assert.equal((await preflightProfile({ name: 'codex', harness: 'codex', format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'default', keyName: 'OPENAI_API_KEY' }, e, { fetchFn })).skipped, true);
  assert.equal((await preflightProfile({ name: 'codex-openrouter', harness: 'codex', format: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'o/m', keyName: 'KEY_API_KEY' }, e, { fetchFn })).skipped, true);
  assert.equal((await preflightProfile({ name: 'd', format: 'openai', baseUrl: 'https://api.example.com/v1', model: 'default', keyName: 'KEY_API_KEY' }, e, { fetchFn })).skipped, true);
  assert.equal(calls, 0);
});

test('preflightProfile does not send the key over plain http, except to loopback', async () => {
  resetPreflightCache();
  let calls = 0;
  const fetchFn = async () => { calls++; return { status: 200, text: async () => '' }; };
  const e = { KEY_API_KEY: 'sk-y' };
  const p = { format: 'openai', model: 'm', keyName: 'KEY_API_KEY' };
  assert.equal((await preflightProfile({ ...p, name: 'h0', baseUrl: 'http://api.example.com/v1' }, e, { fetchFn })).skipped, true);
  assert.equal(calls, 0, 'the key must not be sent in cleartext to a remote http host');
  let n = 1;
  for (const baseUrl of ['http://127.0.0.1:4000/v1', 'http://localhost:4000/v1', 'http://[::1]:4000/v1']) {
    await preflightProfile({ ...p, name: `h${n++}`, baseUrl }, e, { fetchFn });
    assert.equal(calls, n - 1, `loopback ${baseUrl} is still probed`);
  }
});

test('preflightProfile cache is keyed by baseUrl and the key value, without storing the key', async () => {
  resetPreflightCache();
  let calls = 0;
  const fetchFn = async () => { calls++; return { status: 200, text: async () => '' }; };
  const p = { name: 'c', format: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm', keyName: 'KEY_API_KEY' };
  await preflightProfile(p, { KEY_API_KEY: 'k-one' }, { fetchFn });
  await preflightProfile(p, { KEY_API_KEY: 'k-one' }, { fetchFn });
  assert.equal(calls, 1);
  await preflightProfile(p, { KEY_API_KEY: 'k-two' }, { fetchFn });
  assert.equal(calls, 2, 'a changed key is a new cache entry');
  await preflightProfile({ ...p, baseUrl: 'https://other.example.com/v1' }, { KEY_API_KEY: 'k-two' }, { fetchFn });
  assert.equal(calls, 3, 'a changed baseUrl is a new cache entry');
});

test('a chatgpt profile validates and keeps fallback and maxConcurrent on the logged-in and missing-login paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prof-'));
  const auth = join(dir, 'auth.json');
  writeFileSync(auth, JSON.stringify({ tokens: { access_token: 'a'.repeat(32), refresh_token: 'r'.repeat(32) } }));
  chmodSync(auth, 0o600);
  const mk = (extra) => file({ cg: { harness: 'codex', format: 'openai', baseUrl: 'https://chatgpt.com/backend-api/codex', model: 'default', auth: 'chatgpt', ...extra } });
  const e = (a) => ({ CLOUDY_CLOUD_PROFILES: mk({ fallback: ['glm'], maxConcurrent: 2 }), CLOUDY_CLOUD_CODEX_AUTH: a });
  const ok = resolveProfile('cg', undefined, e(auth)).ok;
  assert.deepEqual([ok.fallback, ok.maxConcurrent], [['glm'], 2]);
  const miss = resolveProfile('cg', undefined, e(join(dir, 'missing.json')));
  assert.match(miss.error, /not found/);
  assert.deepEqual(miss.fallback, ['glm'], 'a missing login still reports the fallback list so the caller can move on');
  const bad = { ...e(auth), CLOUDY_CLOUD_PROFILES: mk({ fallback: 'glm' }) };
  assert.match(resolveProfile('cg', undefined, bad).error, /fallback must be a list/);
});
