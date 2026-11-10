import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProfile, loadProfiles, gatewayConfig } from '../src/profiles.mjs';
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
