import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProfile, loadProfiles, gatewayConfig, ompModels, ompConfig, ompCommand, OMP_VERSION } from '../src/profiles.mjs';
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

test('omp built-ins and profiles.json use the omp harness; other harness names are rejected', () => {
  const p = resolveProfile('omp-glm', undefined, env).ok;
  assert.deepEqual([p.harness, p.format, p.model, p.keyName], ['omp', 'openai', 'z-ai/glm-5.3-flash', 'PARTICLE_API_KEY']);
  assert.equal(resolveProfile('omp-deepseek', undefined, env).ok.harness, 'omp');
  assert.equal(resolveProfile('omp-particle', undefined, env).ok.model, 'particle-ai/particle-1');
  const mk = (h) => ({ ...env, CLOUDY_CLOUD_PROFILES: file({ mine: { harness: h, format: 'openai', baseUrl: 'https://x.test/v1', model: 'm', keyName: 'PARTICLE_API_KEY' } }) });
  assert.equal(resolveProfile('mine', undefined, mk('omp')).ok.harness, 'omp');
  assert.match(resolveProfile('mine', undefined, mk('x')).error, /harness must be "claude", "pi" or "omp"/);
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
