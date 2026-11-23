import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseEnvFile, planEnv, envHosts, readConsent, writeConsent, consentFile } from '../src/env-bridge.mjs';

const ORIGIN = 'https://github.com/owner/repo.git';
// Never read the real profiles.json or env file: every test points the loaders at a missing path.
const env = (extra = {}) => ({ CLOUDY_CLOUD_PROFILES: '/nonexistent/cloudy-cloud-profiles.json', CLOUDY_CLOUD_CONFIG: '/nonexistent/cloudy-cloud/env', ...extra });
const consentAt = () => join(mkdtempSync(join(tmpdir(), 'consent-')), 'env-consent.json');
const SENTINEL = 'S3NT1NEL-VALUE-that-must-not-leak';

test('parseEnvFile reads KEY=value, export, quotes, comments and blank lines', () => {
  const m = parseEnvFile(`
# a comment
FOO=bar
export BAZ=qux
SQUOTED='single quoted'
DQUOTED="double # not a comment"
EMPTY=
SPACED = spaced value
INLINE=value # trailing comment
HASH=keep#this
EQ_IN_QUOTES="a=b"
`);
  assert.ok(m instanceof Map);
  for (const [k, v] of [['FOO', 'bar'], ['BAZ', 'qux'], ['SQUOTED', 'single quoted'], ['DQUOTED', 'double # not a comment'], ['EMPTY', ''], ['SPACED', 'spaced value'], ['INLINE', 'value'], ['HASH', 'keep#this'], ['EQ_IN_QUOTES', 'a=b']]) {
    assert.equal(m.get(k), v, k);
  }
  assert.equal(m.size, 9);
  assert.deepEqual(m.skipped, []);
});

test('parseEnvFile does not expand variables and reports invalid names, non-assignments and unterminated quotes', () => {
  const m = parseEnvFile('GOOD=ok\nREF=$GOOD\n1BAD=x\n-ALSO_BAD=y\nno equals here\nUNTERMINATED="abc\n');
  assert.deepEqual([...m.keys()], ['GOOD', 'REF']);
  assert.equal(m.get('REF'), '$GOOD', 'no variable expansion');
  assert.equal(m.skipped.length, 4);
  assert.equal(m.skipped[0].name, '1BAD');
  assert.match(m.skipped[0].reason, /not a valid variable name/);
  assert.equal(m.skipped[1].name, '-ALSO_BAD');
  assert.equal(m.skipped[2].name, undefined, 'a line without = reports no name (its text could be a secret)');
  assert.match(m.skipped[2].reason, /not a NAME=value line/);
  assert.equal(m.skipped[3].name, 'UNTERMINATED');
  assert.match(m.skipped[3].reason, /unterminated quote/);
  assert.ok(m.skipped.every((s) => typeof s.line === 'number' && s.reason));
});

test('built-in keys cloudy-cloud sends itself are skipped, never asked and never proxied, even with a configured host', async () => {
  const vars = parseEnvFile(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'INSTABOX_API_KEY', 'CLOUDY_CLOUD_INSTABOX_API_KEY', 'PARTICLE_API_KEY', 'OPENROUTER_API_KEY'].map((k) => `${k}=x`).join('\n'));
  const asks = [];
  const plan = await planEnv({
    vars, env: env({ CLOUDY_CLOUD_ENV_HOSTS: 'ANTHROPIC_API_KEY=api.evil.example,GH_TOKEN=git.example.com' }), origin: ORIGIN, consentPath: consentAt(),
    ask: async (n) => { asks.push(n); return 'y'; },
  });
  assert.deepEqual(plan.proxied, []);
  assert.deepEqual(plan.literal, []);
  assert.deepEqual(plan.skipped.map((s) => s.name), [...vars.keys()]);
  assert.ok(plan.skipped.every((s) => s.reason === 'sent by cloudy-cloud already'));
  assert.deepEqual(asks, [], 'a sent-by-cloudy-cloud key is never asked about');
});

test('a variable with a configured host is proxied; everything else needs consent', async () => {
  const consentPath = consentAt();
  const vars = parseEnvFile(`STRIPE_KEY=s\nOTHER=o\nWILDCARD=w\n`);
  const plan = await planEnv({ vars, env: env({ CLOUDY_CLOUD_ENV_HOSTS: 'STRIPE_KEY=API.STRIPE.COM, WILDCARD=svc.example.com' }), origin: ORIGIN, consentPath, ask: null });
  assert.deepEqual(plan.proxied, [{ name: 'STRIPE_KEY', host: 'api.stripe.com' }, { name: 'WILDCARD', host: 'svc.example.com' }], 'hosts are lowercased');
  assert.deepEqual(plan.literal, []);
  assert.deepEqual(plan.skipped, [{ name: 'OTHER', reason: 'needs consent; no terminal to ask' }]);
});

test('a wildcard host is rejected: instabox secrets set --host is not confirmed to take one', async () => {
  for (const bad of ['WILDCARD=*.svc.example.com', 'WILDCARD=*', 'WILDCARD=x*y.example.com']) {
    const r = envHosts(env({ CLOUDY_CLOUD_ENV_HOSTS: bad }));
    assert.ok(r.error, bad);
    assert.match(r.error, /entry 1 \(WILDCARD\) is not an exact host name/);
  }
  const vars = parseEnvFile('WILDCARD=w\n');
  await assert.rejects(planEnv({ vars, env: env({ CLOUDY_CLOUD_ENV_HOSTS: 'WILDCARD=*.svc.example.com' }), origin: ORIGIN, consentPath: consentAt(), ask: null }), /not an exact host name/);
});

test('proxy:false treats host-bound variables as literal, needing consent like any other', async () => {
  const consentPath = consentAt();
  const vars = parseEnvFile(`STRIPE_KEY=s\nMYSTERY=m\n`);
  const asks = [];
  const plan = await planEnv({ vars, env: env({ CLOUDY_CLOUD_ENV_HOSTS: 'STRIPE_KEY=api.stripe.com' }), origin: ORIGIN, consentPath, proxy: false, ask: async (n) => { asks.push(n); return 'y'; } });
  assert.deepEqual(plan.proxied, []);
  assert.deepEqual(plan.literal.sort(), ['MYSTERY', 'STRIPE_KEY']);
  assert.deepEqual(asks.sort(), ['MYSTERY', 'STRIPE_KEY']);
  assert.deepEqual(plan.skipped, []);
});

test('non-interactive never sends an unconsented literal and never calls ask', async () => {
  const vars = parseEnvFile(`MYSTERY=${SENTINEL}\n`);
  const plan = await planEnv({ vars, env: env(), origin: ORIGIN, consentPath: consentAt(), ask: null });
  assert.deepEqual(plan.literal, []);
  assert.deepEqual(plan.proxied, []);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].name, 'MYSTERY');
});

test('ask y sends the value once, n declines, and a proxied variable is never asked about', async () => {
  const consentPath = consentAt();
  const answers = { YES_KEY: 'y', NO_KEY: 'n', ALSO_YES: 'yes' };
  const asks = [];
  const vars = parseEnvFile(`YES_KEY=a\nNO_KEY=b\nALSO_YES=c\nPROXIED=d\n`);
  const plan = await planEnv({
    vars, env: env({ CLOUDY_CLOUD_ENV_HOSTS: 'PROXIED=api.example.com' }), origin: ORIGIN, consentPath,
    ask: async (n) => { asks.push(n); return answers[n]; },
  });
  assert.deepEqual(asks.sort(), ['ALSO_YES', 'NO_KEY', 'YES_KEY']);
  assert.deepEqual(plan.literal.sort(), ['ALSO_YES', 'YES_KEY']);
  assert.deepEqual(plan.proxied, [{ name: 'PROXIED', host: 'api.example.com' }]);
  assert.deepEqual(plan.skipped, [{ name: 'NO_KEY', reason: 'declined' }]);
  // 'y' is once only: nothing was stored.
  assert.throws(() => readFileSync(consentPath, 'utf8'), /ENOENT/);
});

test("'a' persists consent for the origin and reuses it; another origin still asks", async () => {
  const consentPath = consentAt();
  const vars = () => parseEnvFile('STRIPE_KEY=s\nDB_PASS=p\n');
  const plan = await planEnv({ vars: vars(), env: env(), origin: ORIGIN, consentPath, ask: async (n) => (n === 'STRIPE_KEY' ? 'a' : 'n') });
  assert.deepEqual(plan.literal, ['STRIPE_KEY']);
  assert.deepEqual(plan.skipped, [{ name: 'DB_PASS', reason: 'declined' }]);
  // Consent file: mode 600 in a mode-700 directory, no temp files, and only names + origins inside.
  assert.equal(statSync(consentPath).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(consentPath)).mode & 0o777, 0o700);
  assert.ok(readdirSync(dirname(consentPath)).every((n) => !n.includes('.tmp')), 'no temp file left behind');
  const stored = JSON.parse(readFileSync(consentPath, 'utf8'));
  assert.deepEqual(stored.origins[ORIGIN], ['STRIPE_KEY']);
  // Same origin: reused without asking. Declined names are asked again (still no consent for DB_PASS).
  const asks = [];
  const plan2 = await planEnv({ vars: vars(), env: env(), origin: ORIGIN, consentPath, ask: async (n) => { asks.push(n); return 'n'; } });
  assert.deepEqual(asks, ['DB_PASS'], 'STRIPE_KEY consent is remembered');
  assert.deepEqual(plan2.literal, ['STRIPE_KEY']);
  // Another origin: no consent carries over.
  const plan3 = await planEnv({ vars: vars(), env: env(), origin: 'https://github.com/other/repo.git', consentPath, ask: null });
  assert.deepEqual(plan3.literal, []);
  assert.deepEqual(plan3.skipped.map((s) => s.name), ['STRIPE_KEY', 'DB_PASS']);
});

test('a corrupt or missing consent file means no consent, not a crash', async () => {
  const consentPath = consentAt();
  writeFileSync(consentPath, 'not json {{{');
  const vars = parseEnvFile('MYSTERY=x\n');
  const plan = await planEnv({ vars, env: env(), origin: ORIGIN, consentPath, ask: async () => 'a' });
  assert.deepEqual(plan.literal, ['MYSTERY']);
  const stored = JSON.parse(readFileSync(consentPath, 'utf8')); // recovered: a fresh file was written
  assert.deepEqual(stored.origins[ORIGIN], ['MYSTERY']);
  for (const junk of ['[1,2]', '"x"', '{"origins":{"o":"notalist"}}']) {
    writeFileSync(consentPath, junk);
    const p = await planEnv({ vars: parseEnvFile('MYSTERY=x\n'), env: env(), origin: ORIGIN, consentPath, ask: null });
    assert.deepEqual(p.skipped.map((s) => s.name), ['MYSTERY'], junk);
  }
});

test('no value ever appears in the plan, the consent file or thrown errors', async () => {
  const consentPath = consentAt();
  const vars = parseEnvFile(`MYSTERY=${SENTINEL}\nPROXIED=${SENTINEL}-2\nLITERAL=${SENTINEL}-3\n`);
  const plan = await planEnv({
    vars, env: env({ CLOUDY_CLOUD_ENV_HOSTS: `PROXIED=api.example.com,BAD=https://u:${SENTINEL}@h.example.com` }),
    origin: ORIGIN, consentPath, ask: async () => 'a',
  }).then((p) => ({ plan: p }), (e) => ({ err: e }));
  // The malformed entry aborts the whole plan; its message names the setting and position, never the content.
  assert.ok(plan.err, 'a malformed CLOUDY_CLOUD_ENV_HOSTS entry is an error');
  assert.doesNotMatch(plan.err.message, new RegExp(SENTINEL));
  assert.match(plan.err.message, /CLOUDY_CLOUD_ENV_HOSTS entry 2/);
  const clean = await planEnv({ vars, env: env({ CLOUDY_CLOUD_ENV_HOSTS: 'PROXIED=api.example.com' }), origin: ORIGIN, consentPath, ask: async () => 'a' });
  assert.doesNotMatch(JSON.stringify(clean), new RegExp(SENTINEL));
  assert.doesNotMatch(readFileSync(consentPath, 'utf8'), new RegExp(SENTINEL));
});

test('parse-level skips merge into the plan report; an invalid name in a plain map is skipped too', async () => {
  const vars = parseEnvFile('1BAD=x\nGOOD=y\n');
  const plan = await planEnv({ vars, env: env(), origin: ORIGIN, consentPath: consentAt(), ask: null });
  assert.deepEqual(plan.skipped.map((s) => s.name), ['1BAD', 'GOOD']);
  assert.match(plan.skipped[0].reason, /not a valid variable name/);
  const manual = new Map([['not a name', 'v'], ['OK', 'v']]);
  const plan2 = await planEnv({ vars: manual, env: env(), origin: ORIGIN, consentPath: consentAt(), ask: null });
  assert.deepEqual(plan2.skipped[0].name, 'not a name');
  assert.match(plan2.skipped[0].reason, /not a valid variable name/);
});

test('envHosts parses NAME=host pairs, reuses egress host rules and reports position not content', () => {
  assert.deepEqual([...envHosts(env()).map.entries()], []);
  assert.deepEqual(envHosts(env({ CLOUDY_CLOUD_ENV_HOSTS: 'A=api.example.com, B=svc.example.org C=h.example.net' })).map, new Map([['A', 'api.example.com'], ['B', 'svc.example.org'], ['C', 'h.example.net']]));
  for (const [bad, msg] of [
    [`A=https://u:${SENTINEL}@h.example.com/p`, /entry 1 \(A\) is not an exact host name/],
    ['1X=h.example.com', /entry 1 is not NAME=host/],
    ['A', /entry 1 is not NAME=host/],
    [' , , ', /lists no NAME=host pairs/],
    [`A=ok.example.com,B=${SENTINEL}`, /entry 2 \(B\) is not an exact host name/],
  ]) {
    const r = envHosts(env({ CLOUDY_CLOUD_ENV_HOSTS: bad }));
    assert.ok(r.error, bad);
    assert.match(r.error, msg);
    assert.match(r.error, /~\/\.config\/cloudy-cloud\/env/);
    assert.doesNotMatch(r.error, new RegExp(SENTINEL.replace(/[$]/g, '\\$')), `no content echoed: ${r.error}`);
  }
});

test('readConsent and writeConsent round-trip through an atomic mode-600 file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consent-'));
  const path = join(dir, 'sub', 'env-consent.json'); // parent does not exist yet
  assert.deepEqual(readConsent(path), { origins: {} });
  writeConsent(path, { origins: { [ORIGIN]: ['A', 'B'] } });
  assert.deepEqual(readConsent(path), { origins: { [ORIGIN]: ['A', 'B'] } });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assert.ok(readdirSync(dirname(path)).every((n) => !n.includes('.tmp')));
});

test('consentFile lives beside the env file and honors an explicit override', () => {
  assert.equal(consentFile({ CLOUDY_CLOUD_CONFIG: '/tmp/cc/env' }), '/tmp/cc/env-consent.json');
  assert.equal(consentFile({ CLOUDY_CLOUD_CONFIG: '/tmp/cc/env', CLOUDY_CLOUD_ENV_CONSENT: '/tmp/other.json' }), '/tmp/other.json');
});
