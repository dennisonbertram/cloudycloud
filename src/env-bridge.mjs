// Env bridge: decides, per variable (for example from a repo's .env), how it reaches a coordinator machine.
// A variable is proxied only when its name is already one of the user's proxy secrets (CLOUDY_CLOUD_PROXY_SECRETS,
// a secret the user stored themselves): it is attached to the machine by name and the bridge never stores a
// secret. Anything else needs the real value on the machine, which requires per-repo consent. Values never
// appear in plans, errors or the consent file — only names are reported (the caller shows the actual prompt
// and handles values).
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_PROVIDER_KEY, proxySecrets } from './config.mjs';
import { COORDINATOR_KEY_SECRET, profileKeyNames } from './profiles.mjs';

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A NAME=value line: the name cannot contain = or whitespace, and = may have spaces around it.
const LINE = /^([^\s=]+)\s*=\s*(.*)$/;

// Parses a dotenv-style file into a Map of NAME -> value. Supports `export KEY=value`, single and double
// quotes (stripped, contents verbatim — no variable or escape expansion), # comments and blank lines.
// Lines that are not assignments or have an invalid name are skipped and reported as { line, reason } in the
// returned map's `skipped` list — never with the line's text or a name from it, which could be credential
// material. An unterminated quote is different: everything after it may be inside the string (a later
// "NAME=value" line could be quoted text, not a variable), so parsing stops there; the entry reports the
// line number only and nothing from that line onward is sent.
export function parseEnvFile(text) {
  const vars = new Map();
  vars.skipped = [];
  for (const [i, raw] of String(text).split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = LINE.exec(line.replace(/^export\s+/, ''));
    if (!m) { vars.skipped.push({ line: i + 1, reason: 'not a NAME=value line' }); continue; }
    const [, name, rest] = m;
    if (!NAME_RE.test(name)) { vars.skipped.push({ line: i + 1, reason: 'not a valid variable name' }); continue; }
    const v = rest.trim(), q = v[0];
    if (q === '"' || q === "'") {
      if (v.length < 2 || v[v.length - 1] !== q) { vars.skipped.push({ line: i + 1, reason: 'unterminated quote; the rest of the file is ignored' }); break; }
      vars.set(name, v.slice(1, -1));
      continue;
    }
    vars.set(name, v.replace(/\s+#.*$/, '')); // an unquoted value ends at whitespace + #
  }
  return vars;
}

// Names a coordinator's machine gets through cloudy-cloud itself (coordinatorKeys in profiles.mjs): the
// provider and Claude keys, the attached GitHub token, and the key of every profile. Those variables in a
// local .env are left out — the built-in mechanism already owns them. OPENAI_API_KEY is the one opt-in name
// (OPT_IN_KEYS): coordinatorKeys only sends it when the user actually configured it, so it counts as sent
// only when a value or proxy-secret name exists here.
const OWN_KEYS = [DEFAULT_PROVIDER_KEY, COORDINATOR_KEY_SECRET, 'GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
const sentByCloudyCloud = (env) => new Set([...OWN_KEYS, ...profileKeyNames(env).filter((k) => k !== 'OPENAI_API_KEY' || env[k] || proxySecrets(env).has(k))]);

// Names a bridged variable may never take: the machine's shell and tooling read them, so a dotenv file could
// change how Claude and its launcher run. PATH picks executables; XDG_* changes where git, npm and friends
// load configuration (XDG_CONFIG_HOME can point git's global config — credential helpers included — at repo
// content); INSTABOX_* repoints the SDK's API endpoint; npm_config_*/NPM_CONFIG_* and NODE_* reach every node
// or npm process; PYTHON*/RUBY*/PERL5* and JAVA_TOOL_OPTIONS/_JAVA_OPTIONS preload code; the proxy variables
// redirect HTTPS traffic (any case); CURL_*/SSL_CERT_*/REQUESTS_CA_BUNDLE weaken TLS checks; EDITOR/VISUAL/
// PAGER/BROWSER and PROMPT_COMMAND run commands; TERM* changes terminal behaviour; TMPDIR relocates temp
// files. LANG and the LC_* family stay allowed: they only localise output.
// The built-in names above are checked first, so they keep their "sent by cloudy-cloud already" reason.
const DENIED_EXACT = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'IFS', 'ENV', 'BASH_ENV', 'CDPATH', 'PS1', 'PS2', 'PS4', 'PROMPT_COMMAND', 'NODE_OPTIONS', 'NODE_PATH',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'REQUESTS_CA_BUNDLE', 'EDITOR', 'VISUAL', 'PAGER', 'BROWSER', 'TMPDIR']);
const DENIED_PREFIX = ['TMUX', 'LD_', 'DYLD_', 'NODE_', 'GIT_', 'SSH_', 'CLOUDY_CLOUD_', 'CLAUDE_', 'ANTHROPIC_',
  'XDG_', 'INSTABOX_', 'npm_config_', 'NPM_CONFIG_', 'PYTHON', 'RUBY', 'PERL5', 'CURL_', 'SSL_CERT_', 'TERM'];
// The proxy variables in any letter case: HTTP_PROXY, http_proxy, Https_Proxy, ...
const DENIED_CASELESS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']);
const deniedName = (name) => DENIED_EXACT.has(name) || DENIED_CASELESS.has(name.toUpperCase()) || DENIED_PREFIX.some((p) => name.startsWith(p));

// The consent file: { origins: { <origin url>: { NAME: <sha256 of the consented value> } } } — a name is
// remembered together with a hash of the value it was consented for, never the value itself; a changed
// value asks again. Files written before hashes existed keep the old shape ([NAME, ...]) — their entries
// carry no hash, so they are asked about once more rather than trusted blindly.
export const consentFile = (env = process.env) => env.CLOUDY_CLOUD_ENV_CONSENT || join(dirname(env.CLOUDY_CLOUD_CONFIG || join(homedir(), '.config/cloudy-cloud/env')), 'env-consent.json');

// Missing, unreadable or corrupt files all mean "nothing consented yet" — never a crash. Each origin's
// value is returned as { NAME: hash | null } — null marks a legacy (hash-less) entry: it needs consent again.
export function readConsent(path) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const origins = j && typeof j === 'object' && j.origins && typeof j.origins === 'object' ? j.origins : {};
    return { origins: Object.fromEntries(Object.entries(origins).map(([o, n]) => [o, Array.isArray(n)
      ? Object.fromEntries(n.filter((x) => typeof x === 'string').map((x) => [x, null]))
      : Object.fromEntries(Object.entries(n && typeof n === 'object' ? n : {}).filter(([, v]) => typeof v === 'string' || v === null))])) };
  } catch { return { origins: {} }; }
}

// Atomic: write a temp file mode 600, then rename. The parent is created mode 700.
export function writeConsent(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

// Decides per variable: proxied (the name is in CLOUDY_CLOUD_PROXY_SECRETS, so the machine attaches the
// existing secret by name), literal (the real value may be copied onto the machine) or skipped (with a
// reason). `vars` is a Map from parseEnvFile (its own `skipped` reports merge in). `ask(name)` returns
// 'y' | 'n' | 'a' and is only called for a variable that cannot be proxied and has no stored consent; pass
// null when there is no terminal — an unconsented variable is then skipped, never sent. 'a' is remembered
// per repo (origin URL) in the mode-600 consent file: the file stores the name with a SHA-256 of the value
// it was consented for — a same-named variable whose value changed is asked about again (and a legacy
// hash-less entry once more), since a silent value change would smuggle a new secret past consent.
// `proxy` is false on a provider without proxy secrets: a proxy-secret name then needs consent like any
// other variable. The result names variables only: a value is never in the report or in an error.
export async function planEnv({ vars, env = process.env, origin, consentPath, ask, proxy = true }) {
  const sent = sentByCloudyCloud(env);
  const proxiedNames = proxySecrets(env);
  const consent = consentPath && origin ? readConsent(consentPath) : { origins: {} };
  const consented = new Map(Object.entries(consent.origins[origin] ?? {})); // NAME -> sha256 hex | null
  const hash = (v) => createHash('sha256').update(String(v)).digest('hex');
  const proxied = [], literal = [], skipped = [...(vars.skipped ?? [])];
  let dirty = false;
  for (const name of vars.keys()) {
    if (!NAME_RE.test(name)) { skipped.push({ reason: 'not a valid variable name' }); continue; }
    if (sent.has(name)) { skipped.push({ name, reason: 'sent by cloudy-cloud already' }); continue; }
    if (deniedName(name)) { skipped.push({ name, reason: 'a reserved variable name' }); continue; }
    if (proxy && proxiedNames.has(name)) { proxied.push({ name }); continue; }
    if (consented.has(name) && consented.get(name) === hash(vars.get(name))) { literal.push(name); continue; }
    if (!ask) { skipped.push({ name, reason: 'needs consent; no terminal to ask' }); continue; }
    const a = String(await ask(name)).trim().toLowerCase();
    if (a === 'a' || a === 'always') {
      literal.push(name);
      if (origin && consentPath) { consented.set(name, hash(vars.get(name))); dirty = true; }
    } else if (a === 'y' || a === 'yes') literal.push(name);
    else skipped.push({ name, reason: 'declined' });
  }
  if (dirty) {
    consent.origins[origin] = Object.fromEntries(consented);
    writeConsent(consentPath, consent);
  }
  return { proxied, literal, skipped };
}
