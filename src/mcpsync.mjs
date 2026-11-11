import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redact } from './events.mjs';

export const mcpFile = (env = process.env) => env.CLOUDY_CLOUD_MCP || join(homedir(), '.config/cloudy-cloud/mcp.json');
export const SECRET_REF = /^\$\{(MCP_[A-Z0-9_]+_TOKEN)\}$/;

const NAME = /^[A-Za-z0-9_-]+$/;
const SENSITIVE = /(KEY|TOKEN|SECRET|PASSWORD)$/i;
const PRIVATE_V4 = /^(127|10|192\.168|172\.(1[6-9]|2\d|3[01]))(\.\d{1,3}){2,3}$/;
const REFS = /\$\{[^}]*\}/g;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strMap = (v) => isObj(v) && Object.values(v).every((x) => typeof x === 'string');
const CRED_NAME = /pass(word)?|secret|token|key|auth|credential/i;
const LITERAL = 'contains a secret value; run cloudy-cloud mcp add to store it as an Instabox secret instead';

function privateHost(host) {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.local') || h === '0.0.0.0' || h === '::1' || PRIVATE_V4.test(h);
}

// The one "is this a literal secret" rule; mcp-cli.mjs uses it to decide what to mask and rewrite.
// `key` is the env var or header name (undefined for args and url parts); `header` enables the Authorization/Bearer rule.
export function isLiteralSecret(key, value, header = false) {
  const plain = value.replace(REFS, '');
  if (redact(plain) !== plain) return true;
  if (key === undefined && /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/i.test(plain)) return true; // user:password@host
  if (key === undefined) return false;
  const bare = header ? value.replace(/^Bearer /, '') : value;
  const sensitive = SENSITIVE.test(key) || (header && (/^authorization$/i.test(key) || bare !== value));
  return sensitive && !SECRET_REF.test(bare);
}

// Indexes of arguments that hold a credential: `--password=x`, or the value after `--api-key`. References are fine.
// A plain DNS hostname: letters, digits, dots and hyphens only (shared with the CLI).
export const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

export function secretArgs(args) {
  const out = [];
  args.forEach((a, i) => {
    const eq = /^--?([\w.-]+)=(.*)$/s.exec(a);
    const flag = /^--?([\w.-]+)$/.exec(args[i - 1] ?? '');
    const bare = (v) => v !== '' && !SECRET_REF.test(v) && !/^\$\{[^}]*\}$/.test(v);
    if ((eq && CRED_NAME.test(eq[1]) && bare(eq[2])) || (flag && CRED_NAME.test(flag[1]) && !a.startsWith('-') && bare(a)) || isLiteralSecret(undefined, a)) out.push(i);
  });
  return out;
}

// The entry reduced to the fields its type uses: anything else is never validated, so it is never delivered.
export function cleanEntry(entry) {
  const pick = (keys) => Object.fromEntries(keys.filter((k) => entry[k] !== undefined).map((k) => [k, entry[k]]));
  return entry.type === 'http' || entry.type === 'sse' ? pick(['type', 'url', 'headers']) : pick(['type', 'command', 'args', 'env']);
}

// One value: returns { reason } or { secrets }.
function checkValue(value, key, header) {
  const secrets = [];
  for (const ref of value.match(REFS) ?? []) {
    const m = SECRET_REF.exec(ref);
    if (!m) return { reason: 'references a variable; cloud machines only expand MCP_<NAME>_TOKEN secrets' };
    secrets.push(m[1]);
  }
  if (key !== undefined && isLiteralSecret(key, value, header)) return { reason: LITERAL };
  return { secrets };
}

export function checkServer(name, entry) {
  const no = (reason) => ({ ok: false, reason });
  if (!NAME.test(name)) return no('the name may only contain letters, digits, _ and -');
  if (!isObj(entry)) return no('the entry is not an object');
  if ('headersHelper' in entry) return no('uses headersHelper, a local script the machine does not have');
  if ('oauth' in entry) return no('uses OAuth sign-in, which a headless subagent cannot complete');
  const type = entry.type ?? 'stdio';
  const secrets = new Set();
  const take = (value, key, header) => {
    const r = checkValue(value, key, header);
    if (r.reason) return r.reason;
    r.secrets.forEach((s) => secrets.add(s));
  };
  const maps = [];
  if (type === 'http' || type === 'sse') {
    if (typeof entry.url !== 'string') return no('url is missing');
    let u;
    try { u = new URL(entry.url.replace(REFS, 'x')); } catch { return no('url is not valid'); }
    if (u.protocol !== 'https:') return no(u.protocol === 'http:' && privateHost(u.hostname) ? 'url points at localhost, which does not exist on the machine' : 'url must be https');
    if (u.username || u.password) return no('url carries a secret value; send it in a header instead, which cloudy-cloud mcp add stores as an Instabox secret');
    if (privateHost(u.hostname)) return no('url points at localhost, which does not exist on the machine');
    if (!HOST_RE.test(u.hostname)) return no('url host is not a plain hostname');
    const bad = take(entry.url);
    if (bad) return no(bad);
    // Instabox only swaps secrets into request headers, so a key in the url would sit on the machine as plain text.
    if (isLiteralSecret(undefined, entry.url) || [...u.searchParams].some(([k, v]) => isLiteralSecret(k, v)))
      return no('url carries a secret value; send it in a header instead, which cloudy-cloud mcp add stores as an Instabox secret');
  } else if (type === 'stdio') {
    if (entry.command !== 'npx' && entry.command !== 'uvx') return no('the command is not npx or uvx; only npx and uvx servers can run on a cloud machine');
    const args = entry.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return no('args must be a list of strings');
    const secret = secretArgs(args);
    for (const [i, a] of args.entries()) {
      if (a.startsWith('/') || a.includes('~') || a.split(/[/\\]/).includes('..')) return no(`argument ${i + 1} is a local path, which does not exist on the machine`);
      const bad = take(a);
      if (bad) return no(bad);
      if (secret.includes(i)) return no(`argument ${i + 1} carries a secret value; pass it in env instead, which cloudy-cloud mcp add stores as an Instabox secret`);
    }
  } else return no('this server type is not supported on a cloud machine');
  // Only the fields of this type are kept (cleanEntry), so everything delivered was checked here.
  if (entry.headers !== undefined) { if (!strMap(entry.headers)) return no('headers must be an object of strings'); maps.push([entry.headers, true]); }
  if (entry.env !== undefined) { if (!strMap(entry.env)) return no('env must be an object of strings'); maps.push([entry.env, false]); }
  for (const [map, header] of maps) {
    for (const [k, v] of Object.entries(map)) {
      const bad = take(v, k, header);
      if (bad) return no(bad);
    }
  }
  return { ok: true, entry: cleanEntry(entry), secrets: [...secrets].sort() };
}

// Mirrors loadProfiles: a missing file is fine, anything else unreadable throws with the path.
export function loadMcp(env = process.env) {
  const file = mcpFile(env);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { servers: {}, skipped: [], secrets: [] };
    throw new Error(`Could not read ${file}: ${e.message}`);
  }
  let list;
  try {
    const j = JSON.parse(raw);
    if (!isObj(j) || !isObj(j.mcpServers)) throw new Error('expected an object with an "mcpServers" object');
    list = Object.entries(j.mcpServers);
  } catch (e) {
    throw new Error(`Could not read ${file}: ${e.message}`);
  }
  const servers = {}, skipped = [], secrets = new Set();
  for (const [name, entry] of list) {
    const r = checkServer(name, entry);
    if (r.ok) { servers[name] = r.entry; r.secrets.forEach((s) => secrets.add(s)); } else skipped.push({ name, reason: r.reason });
  }
  return { servers, skipped, secrets: [...secrets].sort() };
}

export const mcpConfigText = (servers) => JSON.stringify({ mcpServers: servers }, null, 2);

// The servers a harness can use: pi has no SSE transport, so those entries move to skipped. Claude gets the input as is.
export function forHarness(mcp, harness) {
  if (harness !== 'pi') return mcp;
  const servers = {}, skipped = [...mcp.skipped];
  for (const [name, e] of Object.entries(mcp.servers)) {
    if (e.type === 'sse') skipped.push({ name, reason: 'pi does not support the SSE transport' }); else servers[name] = e;
  }
  // A skipped server's proxy secret is not attached to the machine and its name is not reported as delivered.
  const text = JSON.stringify(servers);
  return { ...mcp, servers, skipped, secrets: mcp.secrets?.filter((s) => text.includes(`\${${s}}`)), literal: mcp.literal?.filter((n) => n in servers) };
}
