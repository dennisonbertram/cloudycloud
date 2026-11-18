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

test('setup guidance says --more only for the keys setup --more asks for', () => {
  for (const k of ['PARTICLE_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'CLOUDY_CLOUD_INSTABOX_API_KEY']) {
    assert.match(guide('secret_missing', { secret: k }), /cloudy-cloud setup --more/, k);
    assert.match(guide('key_on_machine_refused', { secret: k, host: 'h.io' }), /cloudy-cloud setup --more/, k);
  }
  for (const k of ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'INSTABOX_API_KEY']) {
    const m = guide('secret_missing', { secret: k });
    assert.match(m, /cloudy-cloud setup/, k);
    assert.doesNotMatch(m, /setup --more/, k);
    assert.doesNotMatch(guide('key_on_machine_refused', { secret: k, host: 'h.io' }), /setup --more/, k);
  }
});

test('secret_missing tellUser names the real step for secrets setup never asks to paste', () => {
  // The coordinator copy of the Instabox key is stored by setup itself.
  const coord = guideObj('secret_missing', { secret: 'CLOUDY_CLOUD_INSTABOX_API_KEY' });
  assert.doesNotMatch(coord.tellUser, /paste/i);
  assert.match(coord.tellUser, /cloudy-cloud setup --more/);
  // A custom profile key is created with the secrets set command, not a setup prompt.
  const custom = guideObj('secret_missing', { secret: 'MY_VENDOR_KEY', host: 'api.vendor.io' });
  assert.doesNotMatch(custom.tellUser, /paste/i);
  assert.match(custom.tellUser, /command above/);
  // Keys setup asks for keep the paste instruction.
  assert.match(guideObj('secret_missing', { secret: 'OPENAI_API_KEY' }).tellUser, /paste the key when `cloudy-cloud setup --more` asks/);
  assert.match(guideObj('secret_missing', { secret: 'INSTABOX_API_KEY' }).tellUser, /paste the key when `cloudy-cloud setup` asks/);
  // A refused coordinator key names setup --more, which stores the copy itself.
  const refused = guide('key_on_machine_refused', { secret: 'CLOUDY_CLOUD_INSTABOX_API_KEY' });
  assert.match(refused, /cloudy-cloud setup --more/);
  assert.doesNotMatch(refused, /secrets set CLOUDY_CLOUD_INSTABOX_API_KEY/);
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
  assert.match(t, /one of: 2x4 4x8 8x16/);
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
  const up = /workspace plan <workspace> builder/;
  const q = guide('quota_exceeded', { plan });
  assert.match(q, /pro plan/); assert.match(q, /500 machines/); assert.match(q, up);
  const r = guide('rate_limited', { plan });
  assert.match(r, /pro plan/); assert.match(r, /30 starts a minute/); assert.match(r, up);
  const c = guide('concurrency_limit', { plan });
  assert.match(c, /pro plan/); assert.match(c, /100 machines running/); assert.match(c, up);
  assert.match(guide('machine_not_on_plan', { plan, kind: 'gpu' }), /pro plan[\s\S]*workspace plan <workspace> builder/);
  for (const code of ['quota_exceeded', 'rate_limited', 'concurrency_limit', 'machine_not_on_plan']) assert.doesNotMatch(guide(code, {}), /plan \(|\bpro\b|undefined/);
  assert.match(guide('quota_exceeded', {}), /upgrade the plan or wait/);
  assert.equal(classify('x concurrency_limit y'), 'concurrency_limit');
});

test('#135 a size no plan offers does not suggest an upgrade; a size a higher plan lists does, naming that plan', () => {
  const none = guide('size_not_allowed', { size: '3x5', tier: 'pro', sizes: '2x4 4x8 8x16', notOffered: true });
  assert.match(none, /3x5 is not an Instabox size/);
  assert.match(none, /2x4 4x8 8x16 \(pro\), 16x32 \(builder\), 32x64 \(team\)/);
  assert.doesNotMatch(none, /upgrade|workspace plan/i);
  const up = guide('size_not_allowed', { size: '16x32', tier: 'pro', sizes: '2x4 4x8 8x16', plan: 'builder' });
  assert.match(up, /Likely cause: The pro plan doesn't include 16x32/);
  assert.doesNotMatch(up, /Likely cause:[^\n]*2x4 4x8/);
  assert.match(up, /Next step:[^\n]*2x4 4x8 8x16/);
});

test('#136 limit errors say how long Cloudy Cloud already retried and do not say to retry at once', () => {
  const plan = { tier: 'pro', maxRunning: 100, maxMachines: 500, startsPerMinute: 30 };
  for (const code of ['quota_exceeded', 'concurrency_limit']) assert.match(guide(code, { plan, waited: 30 }), /already retried for 30 minutes[^]*do not (call cloud_agent again|retry)/i);
  const r = guide('rate_limited', { plan, waited: 10 });
  assert.match(r, /already retried for about 10 minutes/);
  assert.doesNotMatch(r, /Wait 60 seconds/);
  assert.match(r, /Do not retry at once/);
});

test('#126 one upgrade instruction names the next tier, where to find the workspace and the billing page', () => {
  for (const [tier, next] of [['free', 'pro'], ['pro', 'builder'], ['builder', 'team']]) {
    const t = guide('quota_exceeded', { plan: { tier, maxMachines: 5 }, waited: 30 });
    assert.match(t, new RegExp(`npx --yes instabox@latest workspace plan <workspace> ${next}`));
    assert.match(t, /npx --yes instabox@latest workspace ls/);
    assert.match(t, /billing page/);
    assert.doesNotMatch(t, /pro\|builder\|team/);
  }
});

test('#135 a size no plan offers never mentions upgrading, even when the plan could not be read; a size the plan lists is not called larger-than-any-plan', () => {
  const none = guide('size_not_allowed', { size: '3x5', notOffered: true });
  assert.doesNotMatch(none, /upgrade/i);
  const on = guide('size_not_allowed', { size: '16x32', tier: 'builder', sizes: '2x4 16x32', onPlan: true });
  assert.doesNotMatch(on, /upgrade|larger plan than any/i);
  assert.match(on, /lists 16x32[\s\S]*refused it/);
  assert.match(on, /smaller size or without size/);
  assert.match(on, /https:\/\/instabox\.sh\/pricing/);
});
