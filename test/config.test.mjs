import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, readFileSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { envRefresher, loadEnv, defaultWorkerNote, egressAllow } from '../src/config.mjs';
import * as config from '../src/config.mjs';

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

test('CLOUDY_CLOUD_ENV_FILES is a saved key, and the removed CLOUDY_CLOUD_ENV_HOSTS no longer loads', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'env');
  writeFileSync(file, 'CLOUDY_CLOUD_ENV_FILES=/tmp/a.env, /tmp/b.env\nCLOUDY_CLOUD_ENV_HOSTS=MY_TOKEN=api.example.com\n');
  const env = loadEnv({ CLOUDY_CLOUD_CONFIG: file });
  assert.equal(env.CLOUDY_CLOUD_ENV_FILES, '/tmp/a.env, /tmp/b.env');
  assert.equal(env.CLOUDY_CLOUD_ENV_HOSTS, undefined, 'the env-host binding setting is gone');
  assert.equal(loadEnv({ CLOUDY_CLOUD_CONFIG: file, CLOUDY_CLOUD_ENV_FILES: 'inline.env' }).CLOUDY_CLOUD_ENV_FILES, 'inline.env', 'the environment still wins');
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

test('the ordered provider list loads from the env file and selects the first provider for legacy readers', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'env');
  writeFileSync(file, 'CLOUDY_CLOUD_PROVIDERS=boat, e2b\nCLOUDY_CLOUD_PROVIDER=instabox\n');
  const env = loadEnv({ CLOUDY_CLOUD_CONFIG: file });
  assert.equal(env.CLOUDY_CLOUD_PROVIDERS, 'boat, e2b');
  assert.equal(env.CLOUDY_CLOUD_PROVIDER, 'boat');
});

test('the configured default worker profile loads from the env file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'env');
  writeFileSync(file, 'CLOUDY_CLOUD_DEFAULT_PROFILE=codex\n');
  assert.equal(loadEnv({ CLOUDY_CLOUD_CONFIG: file }).CLOUDY_CLOUD_DEFAULT_PROFILE, 'codex');
  assert.equal(loadEnv({ CLOUDY_CLOUD_CONFIG: file, CLOUDY_CLOUD_DEFAULT_PROFILE: 'pi-glm' }).CLOUDY_CLOUD_DEFAULT_PROFILE, 'pi-glm');
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

test('egressAllow rejects entries that are not plain host names, naming the position not the content', () => {
  for (const bad of ['*.com', 'http://x', 'a.com:443', 'a/b', 'localhost', '-bad.example.com', 'bad-.example.com', '-.example.com']) {
    const r = egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: `ok.example.com ${bad}` });
    assert.ok(r.error && r.error.includes('entry 2 is not a host name') && !r.error.includes(bad), `${bad}: ${r.error ?? r.list}`);
    assert.match(r.error, /~\/\.config\/cloudy-cloud\/env/);
  }
  // A pasted URL can carry a token; the error must not echo the entry.
  const leak = egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: 'ok.example.com https://u:SECRET-PASSWORD-123@h.example.com/p' });
  assert.ok(leak.error && !leak.error.includes('SECRET-PASSWORD-123') && !leak.error.includes('https://'), leak.error);
  assert.match(leak.error, /entry 2 is not a host name/);
  const overlong = `a${'b'.repeat(63)}.example.com`; // a 64-char label
  const r = egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: overlong });
  assert.ok(r.error && r.error.includes('entry 1 is not a host name') && !r.error.includes('bbb'), r.error ?? 'accepted');
  assert.deepEqual(egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: `a${'b'.repeat(62)}.example.com` }), { list: [`a${'b'.repeat(62)}.example.com`] }, 'a 63-character label is fine');
});

test('egressAllow lowercases the list so case folds into the built-in hosts', () => {
  assert.deepEqual(egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: 'GITHUB.COM Example.COM' }), { list: ['github.com', 'example.com'] });
});

test('egressAllow: off and none are an explicit opt-out with no policy; blank still errors', () => {
  for (const off of ['off', 'none', 'OFF', 'None']) assert.deepEqual(egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: off }), { list: [] }, off);
  assert.match(egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: 'offs' }).error ?? '', /entry 1 is not a host name/, 'offs');
  assert.match(egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: 'off api.example.com' }).error ?? '', /entry 1 is not a host name/, 'off is not a host when mixed into a list');
  assert.match(egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: ' ' }).error ?? '', /lists no hosts/);
});

test('egressAllow errors keep the one-paragraph script text; the fix lives in the terminal fields', () => {
  for (const v of ['', '  ', 'bad..host', 'a.com:443']) {
    const r = egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: v });
    assert.ok(r.error, `"${v}"`);
    assert.doesNotMatch(r.error, /\n/, `"${v}": ${r.error}`); // piped and --json output is the origin/main paragraph
    assert.match(r.error, /CLOUDY_CLOUD_EGRESS_ALLOW (is set but lists no hosts|entry \d+ is not a host name)\. Use host names such as api\.example\.com or \*\.example\.com, separated by commas or spaces\. Fix the value in ~\/\.config\/cloudy-cloud\/env/);
    // the same fix names the env setting in the trusted fields a terminal renders
    assert.match(r.next, /CLOUDY_CLOUD_EGRESS_ALLOW in ~\/\.config\/cloudy-cloud\/env/);
    assert.doesNotMatch(r.next, /bad\.\.host|a\.com:443/, 'the next step still names no entry content');
    assert.ok(r.local === true && r.short && Array.isArray(r.details) && r.details.length, 'terminal fields');
  }
});

test('the egress and microsandbox keys load from the env file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'env');
  writeFileSync(file, 'CLOUDY_CLOUD_EGRESS_ALLOW=api.example.com,*.example.org\nCLOUDY_CLOUD_MSB_BIN=/opt/msb/bin\nCLOUDY_CLOUD_MSB_SLOTS=4\n');
  const env = loadEnv({ CLOUDY_CLOUD_CONFIG: file });
  assert.equal(env.CLOUDY_CLOUD_EGRESS_ALLOW, 'api.example.com,*.example.org');
  assert.equal(env.CLOUDY_CLOUD_MSB_BIN, '/opt/msb/bin');
  assert.equal(env.CLOUDY_CLOUD_MSB_SLOTS, '4');
});

test('an explicitly empty CLOUDY_CLOUD_EGRESS_ALLOW reaches egressAllow as a policy that lists no hosts, not as unset', () => {
  // Every other empty env value still reads as unset; this one alone is kept.
  const env = loadEnv({ CLOUDY_CLOUD_EGRESS_ALLOW: '', CLOUDY_CLOUD_MSB_SLOTS: '' });
  assert.ok('CLOUDY_CLOUD_EGRESS_ALLOW' in env && env.CLOUDY_CLOUD_EGRESS_ALLOW === '');
  assert.ok(!('CLOUDY_CLOUD_MSB_SLOTS' in env));
  assert.match(egressAllow(env).error ?? '', /lists no hosts/);
  // and a file line `CLOUDY_CLOUD_EGRESS_ALLOW=` reaches it the same way
  const file = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'env');
  writeFileSync(file, 'CLOUDY_CLOUD_EGRESS_ALLOW=\n');
  assert.match(egressAllow(loadEnv({ CLOUDY_CLOUD_CONFIG: file })).error ?? '', /lists no hosts/);
});

test('envLine builds one KEY=value line and refuses CR, LF and NUL in the value, naming the key not the value', () => {
  assert.equal(config.envLine('GH_TOKEN', 'abc123'), 'GH_TOKEN=abc123');
  for (const bad of ['first\nsecond=yes', 'a\rb', 'a\0b']) {
    let e;
    try { config.envLine('SOME_SECRET_KEY', bad); } catch (err) { e = err; }
    assert.ok(e, 'envLine accepted a bad value');
    assert.match(e.message, /SOME_SECRET_KEY/);
    for (const part of ['first', 'second', 'a\rb', 'a\0b']) assert.ok(!e.message.includes(part), e.message);
  }
});

test('installId creates a private 16-hex id beside the env file once, and never rewrites it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const env = { CLOUDY_CLOUD_CONFIG: join(dir, 'env') };
  const id = config.installId(env);
  assert.match(id, /^[0-9a-f]{16}$/);
  const file = join(dir, 'install-id');
  assert.equal(readFileSync(file, 'utf8'), `${id}\n`, 'the id is stored in <config dir>/install-id');
  assert.equal(dirname(config.ownerFile(env)), dir, 'the install id lives in the same dir as the owner file');
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the install-id file is private');
  assert.equal(statSync(dir).mode & 0o777, 0o700, 'the config dir is private');
  assert.ok(readdirSync(dir).every((n) => !n.includes('.tmp.')), 'no temp file is left behind');
  assert.equal(config.installId(env), id, 'the same id every call');
  writeFileSync(file, 'abcdabcdabcdabcd\n');
  assert.equal(config.installId(env), 'abcdabcdabcdabcd', 'an existing id is returned, never rewritten');
});

test('installId refuses rather than return an id it could not store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-ro-'));
  chmodSync(dir, 0o500); // the config dir exists but cannot take the file
  try {
    assert.throws(() => config.installId({ CLOUDY_CLOUD_CONFIG: join(dir, 'env') }), (e) => e.code === 'install_id_unwritable');
  } finally { chmodSync(dir, 0o700); }
});

test('installId answers different ids for different config dirs', () => {
  const a = mkdtempSync(join(tmpdir(), 'cfg-a-'));
  const b = mkdtempSync(join(tmpdir(), 'cfg-b-'));
  assert.notEqual(config.installId({ CLOUDY_CLOUD_CONFIG: join(a, 'env') }), config.installId({ CLOUDY_CLOUD_CONFIG: join(b, 'env') }));
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
  // microsandbox substitutes local values into matching requests, so the plain key is usable there too
  assert.match(defaultWorkerNote({ ...base, CLOUDY_CLOUD_PROVIDER: 'microsandbox', OPENAI_API_KEY: 'sk-real-value-123456' }), /profile: codex\b/);
  assert.equal(defaultWorkerNote({ ...base, CLAUDE_CODE_OAUTH_TOKEN: 'x' }), '');
});
