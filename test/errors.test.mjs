import { PRICE } from '../src/machine.mjs';
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
  const t = guide('machine_needs_consent', { kind: 'gpu', price: '$0.765 per GPU-hour' });
  assert.equal(t.split('$0.765').length - 1, 1, 'price once');
  assert.match(t.match(/What happened: (.+)/)[1], /\$0\.765/);
  assert.match(t, /CLOUDY_CLOUD_ALLOW_MACHINE_KINDS=gpu\b(?!,)/);
  assert.doesNotMatch(t, /macos/);
  assert.match(t, /~\/\.config\/cloudy-cloud\/env/);
  const mt = guide('machine_missing_tools', { kind: 'android', tools: 'tmux' });
  assert.match(mt.match(/Next step: (.+)/)[1], /machine "linux".*CLOUDY_CLOUD_APT_PACKAGES/);
  assert.doesNotMatch(mt, /cloudy-cloud shell|only the linux image/i);
  for (const k of ['omarchy', 'macos']) assert.doesNotMatch(guide('machine_missing_tools', { kind: k, tools: 'gh' }), /APT_PACKAGES/);
  assert.match(guide('machine_missing_tools', { kind: 'omarchy', tools: 'gh' }), /machine "linux"/);
  assert.match(guide('desktop_unavailable', { kind: 'omarchy' }), /linux, android and gpu/);
  assert.doesNotMatch(PRICE.macos, /2026/);
  assert.match(guide('machine_kind_unsupported', { provider: 'self-hosted', kinds: 'linux' }), /self-hosted.*linux/s);
});

test('#116 metrics codes exist, name a command, and metrics_unsupported names the provider', () => {
  for (const c of ['metrics_unavailable', 'metrics_forbidden', 'metrics_unsupported']) assert.ok(CODES.includes(c), c);
  for (const c of ['metrics_unavailable', 'metrics_forbidden']) assert.ok(HUMAN_CODES.includes(c), c);
  assert.match(guide('metrics_forbidden', {}), /machines:read.*cloudy-cloud setup/s);
  assert.match(guide('metrics_unsupported', { provider: 'self-hosted', id: 'm1' }), /self-hosted[\s\S]*cloudy-cloud shell m1 -- top -bn1/);
});

test('#128 size_not_allowed names the tier, the sizes, the plan and the upgrade command, and keeps secrets out', () => {
  assert.ok(CODES.includes('size_not_allowed') && HUMAN_CODES.includes('size_not_allowed'));
  const t = guide('size_not_allowed', { size: '16x32', tier: 'pro', sizes: '2x4 4x8 8x16', plan: 'builder', largest: '8x16', secrets: ['ib-secret'], message: 'ib-secret' });
  assert.match(t, /16x32 is not on your Instabox plan \(pro\)/);
  assert.match(t, /allows: 2x4 4x8 8x16/);
  assert.match(t, /builder plan or higher/);
  assert.match(t, /npx --yes instabox@latest workspace plan <workspace> builder/);
  assert.match(t, /use 8x16/);
  assert.ok(!t.includes('ib-secret'));
  assert.match(guide('size_not_allowed', { size: '16x32' }), /Likely the plan does not include it/);
});

test('#128 size_not_allowed names the monthly fee and the pricing link; no plan says larger than any plan', () => {
  const t = guide('size_not_allowed', { size: '16x32', plan: 'builder', fee: 100 });
  assert.match(t, /builder plan \(\$100\/month, which includes usage equal to the fee\)/);
  assert.match(t, /instabox\.sh\/pricing/);
  assert.match(guide('size_not_allowed', { size: '64x128' }), /larger plan than any listed/);
});

test('plan-limit guidance names the tier, the number hit and the upgrade path; no plan keeps the old wording', () => {
  const plan = { tier: 'pro', startsPerMinute: 30, maxRunning: 100, maxMachines: 500 };
  const up = /instabox workspace plan <workspace> (pro\|)?builder\|team|billing/;
  const q = guide('quota_exceeded', { plan });
  assert.match(q, /pro plan/); assert.match(q, /500 machines/); assert.match(q, up);
  const r = guide('rate_limited', { plan });
  assert.match(r, /pro plan/); assert.match(r, /30 starts a minute/); assert.match(r, up);
  const c = guide('concurrency_limit', { plan });
  assert.match(c, /pro plan/); assert.match(c, /100 machines running/); assert.match(c, up);
  assert.match(guide('machine_not_on_plan', { plan, kind: 'gpu' }), /pro plan[\s\S]*instabox workspace plan/);
  for (const code of ['quota_exceeded', 'rate_limited', 'concurrency_limit', 'machine_not_on_plan']) assert.doesNotMatch(guide(code, {}), /plan \(|\bpro\b|undefined/);
  assert.match(guide('quota_exceeded', {}), /upgrade the plan or wait/);
  assert.equal(classify('x concurrency_limit y'), 'concurrency_limit');
});
