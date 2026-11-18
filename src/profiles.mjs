import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_KEY, DEFAULT_PROVIDER_KEY, proxySecrets, savedEnv } from './config.mjs';
import { guide } from './errors.mjs';
import { codexAuth } from './harness-codex.mjs';

const PARTICLE = 'https://api.particle.ai/v1';
// Workers on the pi harness talk to the OpenAI-format provider directly, with no LiteLLM gateway.
const pi = (model) => ({ harness: 'pi', format: 'openai', baseUrl: PARTICLE, model, keyName: 'PARTICLE_API_KEY' });
const omp = (model) => ({ ...pi(model), harness: 'omp' });
const opencode = (model, p = pi(model)) => ({ ...p, harness: 'opencode' });
const BUILTIN = {
  glm: { format: 'openai', baseUrl: PARTICLE, model: 'z-ai/glm-5.3-flash', keyName: 'PARTICLE_API_KEY' },
  deepseek: { format: 'openai', baseUrl: PARTICLE, model: 'deepseek-ai/deepseek-v41-flash-1017', keyName: 'PARTICLE_API_KEY' },
  particle: { format: 'openai', baseUrl: PARTICLE, model: 'particle-ai/particle-1', keyName: 'PARTICLE_API_KEY' },
  'pi-glm': pi('z-ai/glm-5.3-flash'),
  'pi-deepseek': pi('deepseek-ai/deepseek-v41-flash-1017'),
  'pi-particle': pi('particle-ai/particle-1'),
  'omp-glm': omp('z-ai/glm-5.3-flash'),
  'omp-deepseek': omp('deepseek-ai/deepseek-v41-flash-1017'),
  'omp-particle': omp('particle-ai/particle-1'),
  // codex harness: Codex needs the Responses API, which Particle does not offer, so there is no codex-glm. model 'default' passes no -m.
  codex: { harness: 'codex', format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'default', keyName: 'OPENAI_API_KEY' },
  'codex-chatgpt': { harness: 'codex', format: 'openai', baseUrl: 'https://chatgpt.com/backend-api/codex', model: 'default', auth: 'chatgpt' },
  'codex-openrouter': { harness: 'codex', format: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyName: 'OPENROUTER_API_KEY' }, // model: per call
  'opencode-glm': opencode('z-ai/glm-5.3-flash'),
  'opencode-deepseek': opencode('deepseek-ai/deepseek-v41-flash-1017'),
  'opencode-particle': opencode('particle-ai/particle-1'),
  'opencode-openrouter': { harness: 'opencode', format: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyName: 'OPENROUTER_API_KEY' }, // model: per call or in profiles.json
  openrouter: { format: 'anthropic', baseUrl: 'https://openrouter.ai/api', keyName: 'OPENROUTER_API_KEY' }, // model: per call or in profiles.json
};
export const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
export const MODEL = /^[A-Za-z0-9._:/-]{1,100}$/; // also safe inside the shell command and the YAML file
const URL_OK = /^https?:\/\/[A-Za-z0-9._:/-]+$/;

// Built-ins, overridden or extended by profiles.json (CLOUDY_CLOUD_PROFILES, else ~/.config/cloudy-cloud/profiles.json).
export function loadProfiles(env = process.env) {
  const file = env.CLOUDY_CLOUD_PROFILES || join(homedir(), '.config/cloudy-cloud/profiles.json');
  let user = {};
  try {
    user = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Could not read ${file}: ${e.message}`);
  }
  return { ...BUILTIN, ...user };
}

// Names of the provider keys that profiles use (built-in and profiles.json). Only these go to a coordinator's machine,
// never every *_API_KEY that happens to be set in the shell. An unreadable profiles.json leaves the built-in names.
// The built-in names are always included: a coordinator has no profiles.json, so a built-in profile that the laptop
// file overrides is the built-in one again on its machine.
export function profileKeyNames(env = process.env) {
  let user = {};
  try { user = loadProfiles(env); } catch { /* resolveProfile reports the broken file when a profile is used */ }
  return [...new Set([...Object.values(BUILTIN), ...Object.values(user)].map((p) => p?.keyName).filter((k) => typeof k === 'string' && PROVIDER_KEY.test(k)))];
}

// Instabox reserves names starting with INSTABOX_, so a coordinator's copy of the Instabox key is the secret
// CLOUDY_CLOUD_INSTABOX_API_KEY; the instabox provider reads it when INSTABOX_API_KEY is unset.
export const COORDINATOR_KEY_SECRET = 'CLOUDY_CLOUD_INSTABOX_API_KEY';

// What a coordinator's machine gets: { secrets: names attached as proxy secrets, lines: env-file lines (settings and, on a
// provider without proxy secrets, key values), legacy: REQUIRED keys (the Instabox key; the Claude credential when no Claude secret
// exists) that would go as real values on a provider with proxy secrets, skipped: OPTIONAL keys held only as plain values, not sent }. `single`: only one Claude credential (a nested coordinator), else both are kept (coordinator start).
// Keys that older versions never forwarded. A shell-only value (neither in the env file nor a proxy secret) was not chosen, so it stays home.
const OPT_IN_KEYS = ['OPENAI_API_KEY'];
export function coordinatorKeys(env, provider, { single = false } = {}) {
  const own = provider.coordinatorEnv?.(env);
  const proxied = provider.caps.hasProxySecrets ? proxySecrets(env) : new Set();
  const claude = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'].filter((k) => env[k] || proxied.has(k));
  let saved;
  const chosen = (k) => !OPT_IN_KEYS.includes(k) || proxied.has(k) || (saved ??= savedEnv(env))[k];
  const keys = [...new Set([...(own ? [] : [provider.keyName, DEFAULT_PROVIDER_KEY]), ...(single ? claude.slice(0, 1) : ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']), ...profileKeyNames(env).filter((k) => (!single || k !== 'ANTHROPIC_API_KEY') && chosen(k))])];
  const secrets = [], lines = [...(own?.fixed ?? [])], legacy = [], skipped = [];
  const required = new Set([...(own ? [] : [provider.keyName, DEFAULT_PROVIDER_KEY]), ...(claude.some((k) => proxied.has(k)) ? [] : claude)]);
  if (!own && proxied.has(COORDINATOR_KEY_SECRET)) secrets.push(COORDINATOR_KEY_SECRET);
  for (const k of [...(own?.names ?? []), ...keys, 'CLOUDY_CLOUD_PROXY_SECRETS', 'CLOUDY_CLOUD_APT_PACKAGES', 'CLOUDY_CLOUD_ALLOW_MACHINE_KINDS']) { // the last: a nested cloud_agent sees the same consent
    const isKey = keys.includes(k);
    if (isKey && proxied.has(COORDINATOR_KEY_SECRET) && k === DEFAULT_PROVIDER_KEY) continue; // the secret stands in for it
    if (isKey && proxied.has(k)) secrets.push(k);
    else if (env[k] && isKey && provider.caps.hasProxySecrets) (required.has(k) ? legacy : skipped).push(k); // never as a value
    else if (env[k]) lines.push(`${k}=${env[k]}`);
  }
  return { secrets: [...new Set(secrets)], lines, legacy, skipped };
}

// Returns { ok: profile } or { error: text }. `model` is the optional per-call model.
// proxyOnly (a provider with proxy secrets): the key must be a proxy secret, a real value would be copied to the machine.
export function resolveProfile(name, model, env = process.env, { proxyOnly = false } = {}) {
  if (typeof name !== 'string' || !NAME.test(name)) return { error: `invalid profile: must match ${NAME}` };
  let profiles;
  try { profiles = loadProfiles(env); } catch (e) { return { error: e.message }; }
  const p = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
  if (!p || typeof p !== 'object') return { error: `unknown profile "${name}". Known profiles: ${Object.keys(profiles).join(', ')}` };
  const m = model ?? p.model;
  const harness = p.harness ?? 'claude';
  if (!['claude', 'pi', 'omp', 'codex', 'opencode'].includes(harness)) return { error: `profile ${name}: harness must be "claude", "pi", "omp", "codex" or "opencode"` };
  const chatgpt = harness === 'codex' && p.auth === 'chatgpt'; // the ChatGPT login file instead of a provider key
  if (!['anthropic', 'openai'].includes(p.format)) return { error: `profile ${name}: format must be "anthropic" or "openai"` };
  if (harness === 'codex' && p.format !== 'openai') return { error: `profile ${name}: the codex harness only supports format "openai" (a provider with the Responses API)` };
  if (harness === 'omp' && p.format !== 'openai') return { error: `profile ${name}: the omp harness only supports format "openai" (omp models are written as openai-completions)` };
  if (harness === 'opencode' && p.format !== 'openai') return { error: `profile ${name}: the opencode harness only supports format "openai" (the provider is written as openai-compatible)` };
  if (typeof p.baseUrl !== 'string' || !URL_OK.test(p.baseUrl)) return { error: `profile ${name}: baseUrl is missing or has unsafe characters` };
  if (!chatgpt && (typeof p.keyName !== 'string' || !PROVIDER_KEY.test(p.keyName))) return { error: `profile ${name}: keyName must match ${PROVIDER_KEY}` };
  if (typeof m !== 'string' || !MODEL.test(m)) return { error: `profile ${name} needs a model: pass model to cloud_agent or set it in profiles.json` };
  if (p.fallback !== undefined && !(Array.isArray(p.fallback) && p.fallback.every((n) => typeof n === 'string' && NAME.test(n)))) return { error: `profile ${name}: fallback must be a list of profile names.\nNext step: edit profiles.json so "fallback" looks like ["pi-glm", "pi-particle"].` };
  if (p.maxConcurrent !== undefined && !(Number.isInteger(p.maxConcurrent) && p.maxConcurrent > 0)) return { error: `profile ${name}: maxConcurrent must be a positive whole number.\nNext step: edit profiles.json so "maxConcurrent" is a number such as 6, or remove it.` };
  const extra = { ...(p.fallback && { fallback: p.fallback }), ...(p.maxConcurrent && { maxConcurrent: p.maxConcurrent }) };
  if (chatgpt) {
    const a = codexAuth(env);
    return a.error ? { fallback: Array.isArray(p.fallback) ? p.fallback : undefined, error: `Profile ${name}: ${a.error}` } : { ok: { name, harness, format: p.format, baseUrl: p.baseUrl, model: m, auth: 'chatgpt', proxied: false, ...extra } };
  }
  const proxied = proxySecrets(env).has(p.keyName); // an Instabox secret holds the value; env has at most its name
  if (!env[p.keyName] && !proxied) return { fallback: Array.isArray(p.fallback) ? p.fallback : undefined, missingKey: true, error: `Profile ${name} needs ${p.keyName}, which is not set.\n${guide('secret_missing', { secret: p.keyName, host: URL.canParse(p.baseUrl) ? new URL(p.baseUrl).host : undefined })}` };
  if (proxyOnly && !proxied) return { error: `Profile ${name}: ${p.keyName} is set as a real value, not as a proxy secret.\n${guide('key_on_machine_refused', { secret: p.keyName, host: URL.canParse(p.baseUrl) ? new URL(p.baseUrl).host : undefined })}` };
  return { ok: { name, harness, format: p.format, baseUrl: p.baseUrl, model: m, keyName: p.keyName, proxied, ...extra } };
}

// Preflight (#55): one one-token request from this machine before any machine is created, so a dead profile fails in seconds.
// Only a real key in the environment can be used (a proxy secret's value never reaches this machine). 404, 401 and 403 fail;
// 429, 5xx, timeouts and network errors pass, because those are transient and the turn retry handles them. Cached for 60 s.
const preflightCache = new Map();
export const resetPreflightCache = () => preflightCache.clear();
export async function preflightProfile(p, env = process.env, { fetchFn = fetch, now = Date.now, timeoutMs = 5000 } = {}) {
  const key = p.keyName && env[p.keyName];
  // Codex profiles are skipped: they call the Responses API, not /chat/completions, and "default" passes no model.
  // A plain-http probe would send the key in cleartext, so only a loopback http target is probed.
  const u = URL.canParse(p.baseUrl) ? new URL(p.baseUrl) : undefined;
  const cleartext = u?.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (p.format !== 'openai' || p.auth === 'chatgpt' || p.proxied || !key || p.harness === 'codex' || p.model === 'default' || cleartext) return { ok: true, skipped: true };
  const ck = `${p.name}|${p.model}|${p.baseUrl}|${createHash('sha256').update(key).digest('hex')}`, hit = preflightCache.get(ck);
  if (hit && now() - hit.at < 60_000) return hit.r;
  let r = { ok: true };
  try {
    const res = await fetchFn(`${p.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }), signal: AbortSignal.timeout(timeoutMs) });
    if ([404, 401, 403].includes(res.status)) {
      const body = String(await res.text().catch(() => '')).split(key).join('[redacted]').slice(0, 300);
      r = { ok: false, status: res.status, error: `Profile ${p.name}: ${profileHost(p)} answered ${res.status} for model ${p.model}: ${body}\n${guide('model_not_found', { profiles: p.name })}` };
    }
  } catch { /* timeout or network error: let the machine start; the turn retry reports it */ }
  preflightCache.set(ck, { at: now(), r });
  return r;
}

export const GATEWAY_PORT = 4000;
export const gatewayConfig = (p) => `model_list:
  - model_name: worker
    litellm_params:
      model: openai/${p.model}
      api_base: ${p.baseUrl}
      api_key: os.environ/${p.keyName}
litellm_settings:
  drop_params: true
  use_chat_completions_url_for_anthropic_messages: true
`;

// Environment prefix for the worker's claude command. It holds no secret: the anthropic token is a shell reference.
// Docs (code.claude.com/docs/en/env-vars): ANTHROPIC_BASE_URL "Override the API endpoint to route requests through a proxy or gateway";
// ANTHROPIC_AUTH_TOKEN "Custom value for the `Authorization` header (the value you set here will be prefixed with `Bearer `)";
// ANTHROPIC_MODEL "Name of the model setting to use"; ANTHROPIC_SMALL_FAST_MODEL "[DEPRECATED] Name of Haiku-class model for
// background tasks", so ANTHROPIC_DEFAULT_HAIKU_MODEL ("also used for background functionality") is set as well.
export function claudeEnv(p) {
  if (p.format === 'openai') {
    return `ANTHROPIC_BASE_URL=http://127.0.0.1:${GATEWAY_PORT} ANTHROPIC_AUTH_TOKEN="\$LITELLM_MASTER_KEY" ANTHROPIC_API_KEY= ANTHROPIC_MODEL=worker ANTHROPIC_SMALL_FAST_MODEL=worker ANTHROPIC_DEFAULT_HAIKU_MODEL=worker`;
  }
  return `ANTHROPIC_BASE_URL=${p.baseUrl} ANTHROPIC_AUTH_TOKEN="\$${p.keyName}" ANTHROPIC_API_KEY= ANTHROPIC_MODEL=${p.model}`;
}

// pi harness. Docs (pi.dev/docs/latest/models): models.json "apiKey ... can use $NAME or ${NAME} environment interpolation"; credential
// order is --api-key, then auth.json, then models.json apiKey, so PI_CODING_AGENT_DIR points at a fresh directory that has no auth.json.
export const PI_VERSION = '1.5.0';
export const PI_PROVIDER = 'worker';
export const piModels = (p) => JSON.stringify({ providers: { [PI_PROVIDER]: { baseUrl: p.baseUrl, api: 'openai-completions', apiKey: `$${p.keyName}`, models: [{ id: p.model }] } } }, null, 2);

// omp harness (can1357/oh-my-pi), verified by the spike on #36. models.yml `apiKey` is first read as an environment variable NAME,
// so the file holds the name and never the key. Built by hand: MODEL, URL_OK and PROVIDER_KEY already limit the characters;
// the model id is double-quoted (JSON is valid YAML) so an id like 1.5 or m: stays a string.
export const OMP_VERSION = '18.18.7';
export const OMP_PROVIDER = 'worker';
export const ompModels = (p) => `providers:
  ${OMP_PROVIDER}:
    baseUrl: ${p.baseUrl}
    api: openai-completions
    apiKey: ${p.keyName}
    models:
      - id: ${JSON.stringify(p.model)}
`;
// Also written as overlay.yml and passed with --config: that layer loads after global and project settings, so a repository's
// .omp/config.yml cannot re-enable imports or empty disabledProviders.
// Only the servers in $PI_CODING_AGENT_DIR/mcp.json load: no project MCP config and no imports from other tools.
export const ompConfig = () => `disabledProviders: [claude, claude-plugins, codex, gemini, cursor, windsurf, vscode, opencode, agent-plugins, mcp-json]
mcp:
  enableProjectConfig: false
`;
export const ompCommand = (p, { home, sessionId, hint }) => `PI_CODING_AGENT_DIR=${home}/omp-agent PATH=${home}/.local/bin:$PATH omp -p --mode json --config ${home}/omp-agent/overlay.yml --model ${OMP_PROVIDER}/${p.model} ${sessionId ? `--session ${sessionId} ` : ''}--append-system-prompt '${hint}' < ${home}/prompt.txt`;

export const profileHost = (p) => new URL(p.baseUrl).host;
// Added to a profile worker's instructions. No apostrophes: it sits inside single quotes in a shell command.
export const profileHint = (p) => `You are running model ${p.model} through ${profileHost(p)} (profile ${p.name}). Your tool settings may show the alias worker; that is expected.`;
