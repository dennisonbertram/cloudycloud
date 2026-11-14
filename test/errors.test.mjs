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
