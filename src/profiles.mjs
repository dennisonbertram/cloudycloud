import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_KEY } from './config.mjs';

const PARTICLE = 'https://api.particle.ai/v1';
// Workers on the pi harness talk to the OpenAI-format provider directly, with no LiteLLM gateway.
const pi = (model) => ({ harness: 'pi', format: 'openai', baseUrl: PARTICLE, model, keyName: 'PARTICLE_API_KEY' });
const BUILTIN = {
  glm: { format: 'openai', baseUrl: PARTICLE, model: 'z-ai/glm-5.3-flash', keyName: 'PARTICLE_API_KEY' },
  deepseek: { format: 'openai', baseUrl: PARTICLE, model: 'deepseek-ai/deepseek-v41-flash-1017', keyName: 'PARTICLE_API_KEY' },
  particle: { format: 'openai', baseUrl: PARTICLE, model: 'particle-ai/particle-1', keyName: 'PARTICLE_API_KEY' },
  'pi-glm': pi('z-ai/glm-5.3-flash'),
  'pi-deepseek': pi('deepseek-ai/deepseek-v41-flash-1017'),
  'pi-particle': pi('particle-ai/particle-1'),
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

// Returns { ok: profile } or { error: text }. `model` is the optional per-call model.
export function resolveProfile(name, model, env = process.env) {
  if (typeof name !== 'string' || !NAME.test(name)) return { error: `invalid profile: must match ${NAME}` };
  let profiles;
  try { profiles = loadProfiles(env); } catch (e) { return { error: e.message }; }
  const p = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
  if (!p || typeof p !== 'object') return { error: `unknown profile "${name}". Known profiles: ${Object.keys(profiles).join(', ')}` };
  const m = model ?? p.model;
  const harness = p.harness ?? 'claude';
  if (!['claude', 'pi'].includes(harness)) return { error: `profile ${name}: harness must be "claude" or "pi"` };
  if (!['anthropic', 'openai'].includes(p.format)) return { error: `profile ${name}: format must be "anthropic" or "openai"` };
  if (typeof p.baseUrl !== 'string' || !URL_OK.test(p.baseUrl)) return { error: `profile ${name}: baseUrl is missing or has unsafe characters` };
  if (typeof p.keyName !== 'string' || !PROVIDER_KEY.test(p.keyName)) return { error: `profile ${name}: keyName must match ${PROVIDER_KEY}` };
  if (typeof m !== 'string' || !MODEL.test(m)) return { error: `profile ${name} needs a model: pass model to cloud_agent or set it in profiles.json` };
  if (!env[p.keyName]) return { error: `profile ${name} needs ${p.keyName}, which is not set. Add it with cloudy-cloud setup (the Particle.ai or OpenRouter step), or put ${p.keyName}=... in ~/.config/cloudy-cloud/env.` };
  return { ok: { name, harness, format: p.format, baseUrl: p.baseUrl, model: m, keyName: p.keyName } };
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

export const profileHost = (p) => new URL(p.baseUrl).host;
// Added to a profile worker's instructions. No apostrophes: it sits inside single quotes in a shell command.
export const profileHint = (p) => `You are running model ${p.model} through ${profileHost(p)} (profile ${p.name}). Your tool settings may show the alias worker; that is expected.`;
