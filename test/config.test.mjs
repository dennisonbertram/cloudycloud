import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envRefresher, loadEnv, defaultWorkerNote, egressAllow } from '../src/config.mjs';

test('saved keys load, environment wins, empty means unset, other names ignored', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'env');
  writeFileSync(file, 'INSTABOX_API_KEY=saved=value\nCLAUDE_CODE_OAUTH_TOKEN=saved-token\nPATH=/evil\n');
  const env = loadEnv({ CLOUDY_CLOUD_CONFIG: file, CLAUDE_CODE_OAUTH_TOKEN: 'from-env', INSTABOX_API_KEY: '' });
  assert.equal(env.INSTABOX_API_KEY, 'saved=value');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'from-env');
  assert.equal(env.PATH, undefined);
  assert.equal(loadEnv({ CLOUDY_CLOUD_CONFIG: file + '-missing' }).INSTABOX_API_KEY, undefined);
});

test('envRefresher applies keys added, changed or removed in the env file without a restart', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cc-envr-')), 'env');
  const base = { CLOUDY_CLOUD_CONFIG: file, GH_TOKEN: 'shell' };
  writeFileSync(file, 'INSTABOX_API_KEY=a\n');
  const env = loadEnv(base);
  const refresh = envRefresher(env, base);
  writeFileSync(file, 'INSTABOX_API_KEY=a\nPARTICLE_API_KEY=p\nCLOUDY_CLOUD_PROXY_SECRETS=PARTICLE_API_KEY\n');
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  refresh();
  assert.equal(env.PARTICLE_API_KEY, 'p');
  assert.equal(env.CLOUDY_CLOUD_PROXY_SECRETS, 'PARTICLE_API_KEY');
  writeFileSync(file, 'INSTABOX_API_KEY=b\n');
  utimesSync(file, new Date(), new Date(Date.now() + 9000));
  refresh();
  assert.equal(env.INSTABOX_API_KEY, 'b');
  assert.equal(env.PARTICLE_API_KEY, undefined);
  assert.equal(env.GH_TOKEN, 'shell');
});

test('CLOUDY_CLOUD_ALLOW_MACHINE_KINDS is read from the env file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'env');
  writeFileSync(file, 'CLOUDY_CLOUD_ALLOW_MACHINE_KINDS=gpu\n');
  assert.equal(loadEnv({ CLOUDY_CLOUD_CONFIG: file }).CLOUDY_CLOUD_ALLOW_MACHINE_KINDS, 'gpu');
});

test('the profile cap and provider retry keys load from the env file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'env');
  writeFileSync(file, 'CLOUDY_CLOUD_PROFILE_MAX=3\nCLOUDY_CLOUD_PROVIDER_RETRIES=2\n');
  const env = loadEnv({ CLOUDY_CLOUD_CONFIG: file });
  assert.equal(env.CLOUDY_CLOUD_PROFILE_MAX, '3');
  assert.equal(env.CLOUDY_CLOUD_PROVIDER_RETRIES, '2');
});


test('egressAllow parses a comma- or space-separated host list; unset is no policy, set-but-empty is an error', () => {
  assert.deepEqual(egressAllow({}), { list: [] });
  assert.deepEqual(egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: 'api.example.com, *.example.org other.net ,another.io' }), { list: ['api.example.com', '*.example.org', 'other.net', 'another.io'] });
  for (const blank of ['', '  ', ' , , ']) {
    const r = egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: blank });
    assert.match(r.error ?? '', /CLOUDY_CLOUD_EGRESS_ALLOW is set but lists no hosts/, `"${blank}"`);
    assert.match(r.error, /~\/\.config\/cloudy-cloud\/env/);
  }
});

test('egressAllow rejects entries that are not plain host names', () => {
  for (const bad of ['*.com', 'http://x', 'a.com:443', 'a/b', 'localhost', '-bad.example.com', 'bad-.example.com', '-.example.com']) {
    const r = egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: `ok.example.com ${bad}` });
    assert.ok(r.error && r.error.includes(`invalid host "${bad}"`), `${bad}: ${r.error ?? r.list}`);
    assert.match(r.error, /~\/\.config\/cloudy-cloud\/env/);
  }
  const overlong = `a${'b'.repeat(63)}.example.com`; // 64-char label; the error truncates the entry to 60 chars
  const r = egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: overlong });
  assert.ok(r.error && r.error.includes(`invalid host "${overlong.slice(0, 60)}"`), r.error ?? 'accepted');
  assert.deepEqual(egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: `a${'b'.repeat(62)}.example.com` }), { list: [`a${'b'.repeat(62)}.example.com`] }, 'a 63-character label is fine');
});

test('egressAllow lowercases the list so case folds into the built-in hosts', () => {
  assert.deepEqual(egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: 'GITHUB.COM Example.COM' }), { list: ['github.com', 'example.com'] });
});

test('the egress and microsandbox keys load from the env file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'env');
  writeFileSync(file, 'CLOUDY_CLOUD_EGRESS_ALLOW=api.example.com,*.example.org\nCLOUDY_CLOUD_MSB_BIN=/opt/msb/bin\nCLOUDY_CLOUD_MSB_SLOTS=4\n');
  const env = loadEnv({ CLOUDY_CLOUD_CONFIG: file });
  assert.equal(env.CLOUDY_CLOUD_EGRESS_ALLOW, 'api.example.com,*.example.org');
  assert.equal(env.CLOUDY_CLOUD_MSB_BIN, '/opt/msb/bin');
  assert.equal(env.CLOUDY_CLOUD_MSB_SLOTS, '4');
});

test('defaultWorkerNote recommends only a profile that resolveProfile accepts under the provider\'s rules', () => {
  const base = { CLOUDY_CLOUD_PROFILES: '/nonexistent', CLOUDY_CLOUD_CODEX_AUTH: '/nonexistent/auth.json' };
  // Instabox (the default): a real OPENAI_API_KEY value is refused, so codex is not offered; a proxy secret is.
  assert.doesNotMatch(defaultWorkerNote({ ...base, OPENAI_API_KEY: 'sk-real-value-123456' }), /profile: codex\b/);
  assert.match(defaultWorkerNote({ ...base, OPENAI_API_KEY: 'sk-real-value-123456', PARTICLE_API_KEY: 'pk-real-value-12345', CLOUDY_CLOUD_PROXY_SECRETS: 'PARTICLE_API_KEY' }), /profile: pi-glm/);
  assert.match(defaultWorkerNote({ ...base, CLOUDY_CLOUD_PROXY_SECRETS: 'OPENAI_API_KEY' }), /profile: codex\b/);
  assert.match(defaultWorkerNote({ ...base, OPENAI_API_KEY: 'sk-real-value-123456' }), /cloudy-cloud setup/, 'nothing usable: the exact next step is setup');
  // self-hosted keeps real values on the machine, so the plain key is usable there
  assert.match(defaultWorkerNote({ ...base, CLOUDY_CLOUD_PROVIDER: 'self-hosted', OPENAI_API_KEY: 'sk-real-value-123456' }), /profile: codex\b/);
  assert.equal(defaultWorkerNote({ ...base, CLAUDE_CODE_OAUTH_TOKEN: 'x' }), '');
});
