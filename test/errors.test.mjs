import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guide, guideObj, classify, CODES, HUMAN_CODES, UNCERTAIN_CODES } from '../src/errors.mjs';

const mcp = readFileSync(new URL('../src/mcp.mjs', import.meta.url), 'utf8');
const toolNames = [...mcp.matchAll(/name: '(cloud_agent\w*)'/g)].map((m) => m[1]);
const detail = { id: 'ab12cd34', secret: 'GH_TOKEN', host: 'api.example.com', seconds: 30, profiles: 'glm, deepseek', message: 'boom' };

test('every code has the fixed shape, and the next step names a real tool or command', () => {
  assert.ok(toolNames.includes('cloud_agent_result'));
  for (const code of CODES) {
    const t = guide(code, detail);
    assert.match(t, /^What happened: .+\nLikely cause: .+\nNext step: .+/s, code);
    const next = t.match(/Next step: (.+)/)[1];
    assert.ok(toolNames.some((n) => next.includes(n)) || /cloudy-cloud |npx --yes instabox@latest|git |claude /.test(next), `${code}: ${next}`);
    assert.equal(/Tell the user: /.test(t), HUMAN_CODES.includes(code), code);
    if (UNCERTAIN_CODES.includes(code)) assert.match(t.match(/Likely cause: (.+)/)[1], /likely/i, code);
  }
});

test('no guide output contains a secret passed in the detail', () => {
  const key = 'sk-ant-FAKEKEY123456';
  for (const code of [...CODES, 'unknown_thing']) assert.ok(!guide(code, { ...detail, message: `bad ${key}`, secrets: [key] }).includes(key), code);
});

test('unknown errors get a generic guide with the original message', () => {
  const t = guide('nope', { message: 'weird failure' });
  assert.match(t, /weird failure/);
  assert.match(t, /Next step: .*cloud_agent_list/);
  assert.match(t, /report/i);
});

test('guideObj has the structured fields; classify finds a spend limit', () => {
  const o = guideObj('spend_limit', {});
  assert.deepEqual(Object.keys(o), ['code', 'whatHappened', 'likelyCause', 'nextStep', 'tellUser']);
  assert.equal(classify('You have reached your spend limit'), 'spend_limit');
  assert.equal(classify('whatever'), 'unknown');
});

test('#66 secret codes fill their placeholders and never print a key', () => {
  const m = guide('secret_missing', { secret: 'PARTICLE_API_KEY', host: 'api.particle.ai' });
  assert.match(m, /PARTICLE_API_KEY/);
  assert.match(m, /secrets set PARTICLE_API_KEY --host api\.particle\.ai/);
  assert.match(guide('secret_not_applied', { id: 'm1' }), /secrets show m1/);
  assert.match(guide('secret_host_mismatch', { secret: 'X', host: 'h.io' }), /secrets set X --host/);
  assert.match(guide('key_on_machine_refused', {}), /cloudy-cloud setup/);
  assert.match(guide('secret_set_needs_login', {}), /instabox@latest login/);
});

test('#92 machine codes exist; consent names the price and the env line; each names a command', () => {
  const NEW = ['machine_kind_unknown', 'machine_kind_unsupported', 'machine_needs_consent', 'machine_not_on_plan', 'machine_no_capacity', 'machine_gpu_limit', 'machine_missing_tools', 'machine_not_running', 'shell_unsupported', 'display_unsupported', 'display_forbidden', 'desktop_unavailable'];
  for (const c of NEW) assert.ok(CODES.includes(c), c);
  for (const c of ['machine_needs_consent', 'machine_not_on_plan', 'machine_gpu_limit', 'display_forbidden']) assert.ok(HUMAN_CODES.includes(c), c);
  const t = guide('machine_needs_consent', { kind: 'gpu:l4', price: '$0.765 per GPU-hour' });
  assert.match(t, /\$0\.765 per GPU-hour/);
  assert.match(t, /CLOUDY_CLOUD_ALLOW_MACHINE_KINDS=gpu,macos/);
  assert.match(t, /~\/\.config\/cloudy-cloud\/env/);
  assert.match(guide('machine_kind_unsupported', { provider: 'self-hosted', kinds: 'linux' }), /self-hosted.*linux/s);
});
