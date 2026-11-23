// Env bridge: decides, per variable (for example from a repo's .env), how it reaches a coordinator machine.
// A variable is proxied only when its name is already one of the user's proxy secrets (CLOUDY_CLOUD_PROXY_SECRETS,
// a secret the user stored themselves): it is attached to the machine by name and the bridge never stores a
// secret. Anything else needs the real value on the machine, which requires per-repo consent. Values never
// appear in plans, errors or the consent file — only names are reported (the caller shows the actual prompt
// and handles values).
import { randomBytes } from 'node:crypto';
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
// Lines that are not assignments, have an invalid name, or end inside a quote are skipped; each is reported
// in the returned map's `skipped` list as { line, name?, reason } — a name is reported only when it passed
// the name check (for an unterminated quote), since the rest of a bad line could be a secret.
export function parseEnvFile(text) {
  const vars = new Map();
  vars.skipped = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = LINE.exec(line.replace(/^export\s+/, ''));
    if (!m) { vars.skipped.push({ line: i + 1, reason: 'not a NAME=value line' }); return; }
    const [, name, rest] = m;
    if (!NAME_RE.test(name)) { vars.skipped.push({ line: i + 1, reason: 'not a valid variable name' }); return; }
    const v = rest.trim(), q = v[0];
    if (q === '"' || q === "'") {
      if (v.length < 2 || v[v.length - 1] !== q) { vars.skipped.push({ line: i + 1, name, reason: 'unterminated quote' }); return; }
      vars.set(name, v.slice(1, -1));
      return;
    }
    vars.set(name, v.replace(/\s+#.*$/, '')); // an unquoted value ends at whitespace + #
  });
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
// change how Claude and its launcher run (PATH picks executables, NODE_OPTIONS reaches every node process,
// GIT_* the watchdog's save, CLOUDY_CLOUD_* the launcher's own flags, PROMPT_COMMAND runs on each prompt).
// The built-in names above are checked first, so they keep their "sent by cloudy-cloud already" reason.
const DENIED_EXACT = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'IFS', 'ENV', 'BASH_ENV', 'CDPATH', 'PS1', 'PS2', 'PS4', 'PROMPT_COMMAND', 'NODE_OPTIONS', 'NODE_PATH']);
const DENIED_PREFIX = ['TMUX', 'LD_', 'DYLD_', 'NODE_', 'GIT_', 'SSH_', 'CLOUDY_CLOUD_', 'CLAUDE_', 'ANTHROPIC_'];
const deniedName = (name) => DENIED_EXACT.has(name) || DENIED_PREFIX.some((p) => name.startsWith(p));

// The consent file: { origins: { <origin url>: [NAME, ...] } } — names only, never values.
export const consentFile = (env = process.env) => env.CLOUDY_CLOUD_ENV_CONSENT || join(dirname(env.CLOUDY_CLOUD_CONFIG || join(homedir(), '.config/cloudy-cloud/env')), 'env-consent.json');

// Missing, unreadable or corrupt files all mean "nothing consented yet" — never a crash.
export function readConsent(path) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const origins = j && typeof j === 'object' && j.origins && typeof j.origins === 'object' ? j.origins : {};
    return { origins: Object.fromEntries(Object.entries(origins).map(([o, n]) => [o, Array.isArray(n) ? n.filter((x) => typeof x === 'string') : []])) };
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
// per repo (origin URL) in the mode-600 consent file. `proxy` is false on a provider without proxy secrets:
// a proxy-secret name then needs consent like any other variable. The result names variables only: a value
// is never in the report or in an error.
export async function planEnv({ vars, env = process.env, origin, consentPath, ask, proxy = true }) {
  const sent = sentByCloudyCloud(env);
  const proxiedNames = proxySecrets(env);
  const consent = consentPath && origin ? readConsent(consentPath) : { origins: {} };
  const consentNames = new Set(consent.origins[origin] ?? []);
  const proxied = [], literal = [], skipped = [...(vars.skipped ?? [])];
  let dirty = false;
  for (const name of vars.keys()) {
    if (!NAME_RE.test(name)) { skipped.push({ reason: 'not a valid variable name' }); continue; }
    if (sent.has(name)) { skipped.push({ name, reason: 'sent by cloudy-cloud already' }); continue; }
    if (deniedName(name)) { skipped.push({ name, reason: 'a reserved variable name' }); continue; }
    if (proxy && proxiedNames.has(name)) { proxied.push({ name }); continue; }
    if (consentNames.has(name)) { literal.push(name); continue; }
    if (!ask) { skipped.push({ name, reason: 'needs consent; no terminal to ask' }); continue; }
    const a = String(await ask(name)).trim().toLowerCase();
    if (a === 'a' || a === 'always') {
      literal.push(name);
      if (origin && consentPath) { consentNames.add(name); dirty = true; }
    } else if (a === 'y' || a === 'yes') literal.push(name);
    else skipped.push({ name, reason: 'declined' });
  }
  if (dirty) {
    consent.origins[origin] = [...consentNames];
    writeConsent(consentPath, consent);
  }
  return { proxied, literal, skipped };
}
