import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseEnvFile, planEnv, readConsent, writeConsent, consentFile } from '../src/env-bridge.mjs';

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
  // A malformed line reports only its line number: the raw text before = could be credential material.
  for (const [i, line] of [[0, 3], [1, 4], [2, 5]]) {
    assert.equal(m.skipped[i].line, line);
    assert.equal(m.skipped[i].name, undefined, `no name echoed for skipped line ${line}`);
  }
  assert.match(m.skipped[0].reason, /not a valid variable name/);
  assert.match(m.skipped[2].reason, /not a NAME=value line/);
  // An unterminated quote reports only its line number — even the name could be part of the secret.
  assert.equal(m.skipped[3].name, undefined);
  assert.equal(m.skipped[3].line, 6);
  assert.match(m.skipped[3].reason, /unterminated quote/);
  assert.ok(m.skipped.every((s) => typeof s.line === 'number' && s.reason));
});

test('an unterminated quote stops the parse: nothing from that line onward is read or reported', () => {
  // Lines after the quote may be inside the string, so a fake "NAME=..." there is never seen, and a
  // valid-looking line is never reached either. The skipped entry carries the line number only.
  const m = parseEnvFile(`GOOD=ok\nSECRET_AKIAIOSFODNN7EXAMPLE="not closed\nBASE64LOOKINGNAME=Zm9vYmFy\nGOOD2=also\n`);
  assert.deepEqual([...m.keys()], ['GOOD'], 'parsing stopped at the quote');
  assert.deepEqual(m.skipped, [{ line: 2, reason: 'unterminated quote; the rest of the file is ignored' }]);
  assert.doesNotMatch(JSON.stringify(m.skipped), /SECRET_AKIA|BASE64LOOKINGNAME|GOOD2|not closed|Zm9v/, 'no text from the bad line onward is reported');
});

test('built-in keys cloudy-cloud sends itself are skipped, never asked and never proxied, even as proxy secrets', async () => {
  const names = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'INSTABOX_API_KEY', 'CLOUDY_CLOUD_INSTABOX_API_KEY', 'PARTICLE_API_KEY', 'OPENROUTER_API_KEY'];
  const vars = parseEnvFile(names.map((k) => `${k}=x`).join('\n'));
  const asks = [];
  const plan = await planEnv({
    vars, env: env({ CLOUDY_CLOUD_PROXY_SECRETS: names.join(',') }), origin: ORIGIN, consentPath: consentAt(),
    ask: async (n) => { asks.push(n); return 'y'; },
  });
  assert.deepEqual(plan.proxied, []);
  assert.deepEqual(plan.literal, []);
  assert.deepEqual(plan.skipped.map((s) => s.name), [...vars.keys()]);
  assert.ok(plan.skipped.every((s) => s.reason === 'sent by cloudy-cloud already'));
  assert.deepEqual(asks, [], 'a sent-by-cloudy-cloud key is never asked about');
});

test('a variable named in CLOUDY_CLOUD_PROXY_SECRETS is proxied by name; everything else needs consent', async () => {
  const vars = parseEnvFile(`STRIPE_KEY=s\nOTHER=o\nWILDCARD=w\n`);
  const plan = await planEnv({ vars, env: env({ CLOUDY_CLOUD_PROXY_SECRETS: 'STRIPE_KEY, WILDCARD' }), origin: ORIGIN, consentPath: consentAt(), ask: null });
  assert.deepEqual(plan.proxied, [{ name: 'STRIPE_KEY' }, { name: 'WILDCARD' }], 'attached by name only');
  assert.deepEqual(plan.literal, []);
  assert.deepEqual(plan.skipped, [{ name: 'OTHER', reason: 'needs consent; no terminal to ask' }]);
});

test('the bridge never stores a secret: a value is proxied only when the user stored it themselves', async () => {
  const vars = parseEnvFile(`MY_TOKEN=${SENTINEL}\n`);
  // Not in CLOUDY_CLOUD_PROXY_SECRETS and no terminal: skipped, never written anywhere.
  const plan = await planEnv({ vars, env: env(), origin: ORIGIN, consentPath: consentAt(), ask: null });
  assert.deepEqual(plan.proxied, []);
  assert.deepEqual(plan.literal, []);
  assert.deepEqual(plan.skipped.map((s) => s.name), ['MY_TOKEN']);
});

test('proxy:false treats a proxy-secret name as literal, needing consent like any other', async () => {
  const vars = parseEnvFile(`STRIPE_KEY=s\nMYSTERY=m\n`);
  const asks = [];
  const plan = await planEnv({ vars, env: env({ CLOUDY_CLOUD_PROXY_SECRETS: 'STRIPE_KEY' }), origin: ORIGIN, consentPath: consentAt(), proxy: false, ask: async (n) => { asks.push(n); return 'y'; } });
  assert.deepEqual(plan.proxied, []);
  assert.deepEqual(plan.literal.sort(), ['MYSTERY', 'STRIPE_KEY']);
  assert.deepEqual(asks.sort(), ['MYSTERY', 'STRIPE_KEY']);
  assert.deepEqual(plan.skipped, []);
});

test('dangerous names are rejected with a reason, never asked, never proxied', async () => {
  const denied = [
    'PATH', 'HOME', 'USER', 'SHELL', 'IFS', 'ENV', 'BASH_ENV', 'CDPATH', 'PS4', 'PROMPT_COMMAND',
    'TMUX', 'TMUX_PANE', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
    'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
    'GIT_DIR', 'GIT_SSH_COMMAND', 'SSH_AUTH_SOCK', 'SSH_ASKPASS',
    'CLOUDY_CLOUD_EXTRA_PROMPT', 'CLOUDY_CLOUD_DELETE_AT', 'CLAUDE_CODE_FOO', 'ANTHROPIC_BASE_URL',
    // Names that retarget trusted tooling or preload code (#P1-4).
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'INSTABOX_API_URL', 'INSTABOX_ANYTHING',
    'npm_config_registry', 'NPM_CONFIG_REGISTRY', 'npm_config_cache',
    'PYTHONPATH', 'PYTHONSTARTUP', 'RUBYOPT', 'RUBYLIB', 'PERL5LIB', 'PERL5OPT',
    'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'HTTP_PROXY', 'http_proxy', 'Https_Proxy', 'ALL_PROXY', 'no_proxy',
    'CURL_CA_BUNDLE', 'CURL_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
    'EDITOR', 'VISUAL', 'PAGER', 'BROWSER', 'TERM', 'TERMINFO', 'TMPDIR',
  ];
  for (const name of denied) {
    const vars = parseEnvFile(`${name}=x\n`);
    const asks = [];
    const plan = await planEnv({ vars, env: env({ CLOUDY_CLOUD_PROXY_SECRETS: name }), origin: ORIGIN, consentPath: consentAt(), ask: async (n) => { asks.push(n); return 'y'; } });
    assert.deepEqual(plan.proxied, [], name);
    assert.deepEqual(plan.literal, [], name);
    assert.equal(plan.skipped.length, 1, name);
    assert.equal(plan.skipped[0].name, name);
    assert.match(plan.skipped[0].reason, /reserved/, name);
    assert.deepEqual(asks, [], `${name} is never asked about`);
  }
});

test('LANG and the LC_* family stay allowed: they only localise output', async () => {
  const vars = parseEnvFile('LANG=en_US.UTF-8\nLC_ALL=en_US.UTF-8\nLC_TIME=de_DE.UTF-8\n');
  const asks = [];
  const plan = await planEnv({ vars, env: env(), origin: ORIGIN, consentPath: consentAt(), ask: async (n) => { asks.push(n); return 'y'; } });
  assert.deepEqual(plan.literal.sort(), ['LANG', 'LC_ALL', 'LC_TIME']);
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
    vars, env: env({ CLOUDY_CLOUD_PROXY_SECRETS: 'PROXIED' }), origin: ORIGIN, consentPath,
    ask: async (n) => { asks.push(n); return answers[n]; },
  });
  assert.deepEqual(asks.sort(), ['ALSO_YES', 'NO_KEY', 'YES_KEY']);
  assert.deepEqual(plan.literal.sort(), ['ALSO_YES', 'YES_KEY']);
  assert.deepEqual(plan.proxied, [{ name: 'PROXIED' }]);
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
  // Consent file: mode 600 in a mode-700 directory, no temp files, and only names + origins + hashes inside.
  assert.equal(statSync(consentPath).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(consentPath)).mode & 0o777, 0o700);
  assert.ok(readdirSync(dirname(consentPath)).every((n) => !n.includes('.tmp')), 'no temp file left behind');
  const stored = JSON.parse(readFileSync(consentPath, 'utf8'));
  assert.deepEqual(Object.keys(stored.origins[ORIGIN]), ['STRIPE_KEY']);
  assert.match(stored.origins[ORIGIN].STRIPE_KEY, /^[0-9a-f]{64}$/, 'the name is stored with a sha256 of the value, never the value');
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

test('a changed value is asked about again even though the name was consented before', async () => {
  const consentPath = consentAt();
  await planEnv({ vars: parseEnvFile('STRIPE_KEY=old-value\n'), env: env(), origin: ORIGIN, consentPath, ask: async () => 'a' });
  const asks = [];
  const plan = await planEnv({ vars: parseEnvFile('STRIPE_KEY=new-value\n'), env: env(), origin: ORIGIN, consentPath, ask: async (n) => { asks.push(n); return 'n'; } });
  assert.deepEqual(asks, ['STRIPE_KEY'], 'the same name with a different value is not covered by the old consent');
  assert.deepEqual(plan.literal, []);
  // The same value again is still covered.
  const asks2 = [];
  await planEnv({ vars: parseEnvFile('STRIPE_KEY=old-value\n'), env: env(), origin: ORIGIN, consentPath, ask: async (n) => { asks2.push(n); return 'n'; } });
  assert.deepEqual(asks2, [], 'the originally consented value stays remembered');
  // A legacy consent file (names only) is asked about once, then upgraded to a hash.
  writeFileSync(consentPath, JSON.stringify({ origins: { [ORIGIN]: ['STRIPE_KEY'] } }));
  const asks3 = [];
  await planEnv({ vars: parseEnvFile('STRIPE_KEY=old-value\n'), env: env(), origin: ORIGIN, consentPath, ask: async (n) => { asks3.push(n); return 'a'; } });
  assert.deepEqual(asks3, ['STRIPE_KEY'], 'a hash-less legacy entry is not trusted');
  const asks4 = [];
  await planEnv({ vars: parseEnvFile('STRIPE_KEY=old-value\n'), env: env(), origin: ORIGIN, consentPath, ask: async (n) => { asks4.push(n); return 'n'; } });
  assert.deepEqual(asks4, [], 'after re-consent the name is remembered with its hash');
});

test('a corrupt or missing consent file means no consent, not a crash', async () => {
  const consentPath = consentAt();
  writeFileSync(consentPath, 'not json {{{');
  const vars = parseEnvFile('MYSTERY=x\n');
  const plan = await planEnv({ vars, env: env(), origin: ORIGIN, consentPath, ask: async () => 'a' });
  assert.deepEqual(plan.literal, ['MYSTERY']);
  const stored = JSON.parse(readFileSync(consentPath, 'utf8')); // recovered: a fresh file was written
  assert.deepEqual(Object.keys(stored.origins[ORIGIN]), ['MYSTERY']);
  for (const junk of ['[1,2]', '"x"', '{"origins":{"o":"notalist"}}']) {
    writeFileSync(consentPath, junk);
    const p = await planEnv({ vars: parseEnvFile('MYSTERY=x\n'), env: env(), origin: ORIGIN, consentPath, ask: null });
    assert.deepEqual(p.skipped.map((s) => s.name), ['MYSTERY'], junk);
  }
});

test('no value ever appears in the plan or the consent file', async () => {
  const consentPath = consentAt();
  const vars = parseEnvFile(`MYSTERY=${SENTINEL}\nPROXIED=${SENTINEL}-2\nLITERAL=${SENTINEL}-3\n`);
  const clean = await planEnv({ vars, env: env({ CLOUDY_CLOUD_PROXY_SECRETS: 'PROXIED' }), origin: ORIGIN, consentPath, ask: async () => 'a' });
  assert.doesNotMatch(JSON.stringify(clean), new RegExp(SENTINEL));
  assert.doesNotMatch(readFileSync(consentPath, 'utf8'), new RegExp(SENTINEL));
});

test('parse-level skips merge into the plan report; an invalid name in a plain map is skipped without its text', async () => {
  const vars = parseEnvFile('1BAD=x\nGOOD=y\n');
  const plan = await planEnv({ vars, env: env(), origin: ORIGIN, consentPath: consentAt(), ask: null });
  assert.equal(plan.skipped.length, 2);
  assert.equal(plan.skipped[0].name, undefined, 'the raw text of a bad line is not reported');
  assert.equal(plan.skipped[0].line, 1);
  assert.match(plan.skipped[0].reason, /not a valid variable name/);
  const manual = new Map([['not a name', 'v'], ['OK', 'v']]);
  const plan2 = await planEnv({ vars: manual, env: env(), origin: ORIGIN, consentPath: consentAt(), ask: null });
  assert.equal(plan2.skipped[0].name, undefined, 'an invalid map key is not echoed either');
  assert.match(plan2.skipped[0].reason, /not a valid variable name/);
});

test('readConsent and writeConsent round-trip through an atomic mode-600 file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consent-'));
  const path = join(dir, 'sub', 'env-consent.json'); // parent does not exist yet
  assert.deepEqual(readConsent(path), { origins: {} });
  writeConsent(path, { origins: { [ORIGIN]: { A: 'ab12', B: 'cd34' } } });
  assert.deepEqual(readConsent(path), { origins: { [ORIGIN]: { A: 'ab12', B: 'cd34' } } });
  // The legacy names-only shape is read as hash-less entries (they will be asked about once more).
  writeConsent(path, { origins: { [ORIGIN]: ['A', 'B'] } });
  assert.deepEqual(readConsent(path), { origins: { [ORIGIN]: { A: null, B: null } } });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assert.ok(readdirSync(dirname(path)).every((n) => !n.includes('.tmp')));
});

test('consentFile lives beside the env file and honors an explicit override', () => {
  assert.equal(consentFile({ CLOUDY_CLOUD_CONFIG: '/tmp/cc/env' }), '/tmp/cc/env-consent.json');
  assert.equal(consentFile({ CLOUDY_CLOUD_CONFIG: '/tmp/cc/env', CLOUDY_CLOUD_ENV_CONSENT: '/tmp/other.json' }), '/tmp/other.json');
});
