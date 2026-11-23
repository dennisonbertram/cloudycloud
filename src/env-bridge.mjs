// Env bridge: decides, per variable (for example from a repo's .env), how it reaches a coordinator machine.
// A variable with a known host goes as an Instabox proxy secret (the machine sees a placeholder); anything else
// needs the real value on the machine, which requires per-repo consent. Values never appear in plans, errors
// or the consent file — only names are reported (the caller shows the actual prompt and handles values).
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_PROVIDER_KEY, egressAllow, proxySecrets } from './config.mjs';
import { SECRET_HOSTS } from './errors.mjs';
import { COORDINATOR_KEY_SECRET, profileKeyNames } from './profiles.mjs';

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A NAME=value line: the name cannot contain = or whitespace, and = may have spaces around it.
const LINE = /^([^\s=]+)\s*=\s*(.*)$/;

// Parses a dotenv-style file into a Map of NAME -> value. Supports `export KEY=value`, single and double
// quotes (stripped, contents verbatim — no variable or escape expansion), # comments and blank lines.
// Lines that are not assignments, have an invalid name, or end inside a quote are skipped; each is reported
// in the returned map's `skipped` list as { line, name?, reason } — a name is only reported when the line
// had one, since the rest of a bad line could be a secret.
export function parseEnvFile(text) {
  const vars = new Map();
  vars.skipped = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = LINE.exec(line.replace(/^export\s+/, ''));
    if (!m) { vars.skipped.push({ line: i + 1, reason: 'not a NAME=value line' }); return; }
    const [, name, rest] = m;
    if (!NAME_RE.test(name)) { vars.skipped.push({ line: i + 1, name, reason: 'not a valid variable name' }); return; }
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

// User host bindings for proxy secrets: CLOUDY_CLOUD_ENV_HOSTS="NAME=host,NAME2=host2" in
// ~/.config/cloudy-cloud/env. Hosts are validated exactly like CLOUDY_CLOUD_EGRESS_ALLOW entries — through
// egressAllow, so the wildcard and label rules (and the "name the position, never the content" errors) match.
// Returns { map } (lowercased hosts) or { error }.
export function envHosts(env = process.env) {
  const raw = env.CLOUDY_CLOUD_ENV_HOSTS;
  if (raw === undefined || raw === null) return { map: new Map() };
  const value = String(raw).trim().replace(/^(["'])(.*)\1$/, '$2');
  if (!value) return { map: new Map() }; // an empty setting is unset (loadEnv already drops empties)
  const parts = value.split(/[\s,]+/).filter(Boolean);
  const how = 'Use entries such as MY_KEY=api.example.com or MY_KEY=*.example.com, separated by commas or spaces. Fix the value in ~/.config/cloudy-cloud/env.';
  if (!parts.length) return { error: `CLOUDY_CLOUD_ENV_HOSTS is set but lists no NAME=host pairs. ${how}` };
  const map = new Map();
  for (const [i, part] of parts.entries()) {
    const eq = part.indexOf('='), name = eq > 0 ? part.slice(0, eq) : '', host = eq > 0 ? part.slice(eq + 1) : '';
    if (!NAME_RE.test(name)) return { error: `CLOUDY_CLOUD_ENV_HOSTS entry ${i + 1} is not NAME=host. ${how}` };
    const check = egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: host });
    if (check.error) return { error: `CLOUDY_CLOUD_ENV_HOSTS entry ${i + 1} (${name}) is not a host name. ${how}` };
    map.set(name, check.list[0]);
  }
  return { map };
}

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

// Decides per variable: proxied (sent as an Instabox proxy secret bound to a host), literal (the real value
// may be copied onto the machine) or skipped (with a reason). `vars` is a Map from parseEnvFile (its own
// `skipped` reports merge in). `ask(name)` returns 'y' | 'n' | 'a' and is only called for a variable that
// cannot be proxied and has no stored consent; pass null when there is no terminal — an unconsented variable
// is then skipped, never sent. 'a' is remembered per repo (origin URL) in the mode-600 consent file.
// The result names variables and hosts only: a value is never in the report or in an error.
export async function planEnv({ vars, env = process.env, origin, consentPath, ask }) {
  const hosts = envHosts(env);
  if (hosts.error) throw new Error(hosts.error);
  const sent = sentByCloudyCloud(env);
  const consent = consentPath && origin ? readConsent(consentPath) : { origins: {} };
  const consentNames = new Set(consent.origins[origin] ?? []);
  const proxied = [], literal = [], skipped = [...(vars.skipped ?? [])];
  let dirty = false;
  for (const name of vars.keys()) {
    if (!NAME_RE.test(name)) { skipped.push({ name, reason: 'not a valid variable name' }); continue; }
    if (sent.has(name)) { skipped.push({ name, reason: 'sent by cloudy-cloud already' }); continue; }
    const host = hosts.map.get(name) ?? SECRET_HOSTS[name];
    if (host) { proxied.push({ name, host }); continue; }
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
