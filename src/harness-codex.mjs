// The codex worker harness (OpenAI Codex CLI, https://github.com/openai/codex). Verified against codex-cli 0.166.0 and its docs:
// `codex exec --json` prints JSONL events, `codex exec resume <thread_id>` continues a thread, `-c key=value` overrides config,
// CODEX_HOME holds config.toml and auth.json, custom providers are [model_providers.<id>] (wire_api "responses" only: Codex removed
// chat completions, so a provider without /v1/responses, such as Particle, cannot be used), MCP servers are [mcp_servers.<name>].
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeSecretFile } from './providers/index.mjs';

export const CODEX_VERSION = '0.166.0';
const PROVIDER = 'worker';
const MODEL = /^[A-Za-z0-9._:/-]{1,100}$/; // same as profiles.mjs; kept here so this file imports nothing from it
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REF = /^\$\{(MCP_[A-Z0-9_]+_TOKEN)\}$/;
const REF_IN = /\$\{[^}]*\}/;
const str = JSON.stringify; // a JSON string is a valid TOML basic string
const key = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : str(k));
const table = (o) => `{ ${Object.entries(o).map(([k, v]) => `${key(k)} = ${str(v)}`).join(', ')} }`;

// "default" means: pass no model, so Codex uses its own default for the login or key.
export const codexModel = (p) => (p.model && p.model !== 'default' ? p.model : undefined);

export const codexHome = (home) => `${home}/codex-home`;

// Why a server cannot go into the worker's config.toml, or undefined. Codex has no SSE transport and does not expand ${...};
// it can only read a secret from a named environment variable, which covers a header that is exactly the secret (or "Bearer "
// plus it) and an env value, so nothing else may carry a reference.
export function codexReason(e) {
  if (e.type === 'sse') return 'codex does not support the SSE transport';
  if (e.type === 'http') {
    if (REF_IN.test(e.url)) return 'the url holds a variable reference, which codex does not expand';
    const bad = Object.entries(e.headers ?? {}).find(([k, v]) => REF_IN.test(v) && !(REF.test(v) || (/^authorization$/i.test(k) && REF.test(v.replace(/^Bearer /, '')))));
    return bad === undefined ? undefined : 'a header mixes text with a secret reference, or has "Bearer " plus a reference outside the Authorization header, which codex cannot expand; use the whole value, or "Bearer " plus the reference in Authorization';
  }
  if ((e.args ?? []).some((a) => REF_IN.test(a))) return 'an argument holds a variable reference, which codex does not expand';
  const bad = Object.entries(e.env ?? {}).find(([k, v]) => REF_IN.test(v) && !(REF.test(v) && VAR.test(k)));
  return bad === undefined ? undefined : 'an env value mixes text with a secret reference, or its name is not a valid variable name';
}

// config.toml text for the servers (already filtered by codexReason). Secrets stay references: the machine's environment holds them.
export function codexMcp(servers) {
  return Object.entries(servers).map(([name, e]) => {
    const l = [`[mcp_servers.${key(name)}]`];
    if (e.type === 'http') {
      const bearer = Object.entries(e.headers ?? {}).find(([k, v]) => /^authorization$/i.test(k) && /^Bearer \$\{/.test(v));
      const fixed = {}, fromEnv = {};
      for (const [k, v] of Object.entries(e.headers ?? {})) {
        if (bearer && k === bearer[0]) continue;
        if (REF.test(v)) fromEnv[k] = v.match(REF)[1]; else fixed[k] = v;
      }
      l.push(`url = ${str(e.url)}`);
      if (bearer) l.push(`bearer_token_env_var = ${str(bearer[1].match(REF_IN)[0].slice(2, -1))}`);
      if (Object.keys(fixed).length) l.push(`http_headers = ${table(fixed)}`);
      if (Object.keys(fromEnv).length) l.push(`env_http_headers = ${table(fromEnv)}`);
    } else {
      const fixed = {}, refs = {};
      for (const [k, v] of Object.entries(e.env ?? {})) { if (REF.test(v)) refs[k] = v.match(REF)[1]; else fixed[k] = v; }
      const names = Object.entries(refs);
      // The sh wrapper copies each secret variable to the name the server expects, then runs the real command.
      if (names.length) l.push(`command = "sh"`, `args = ${str(['-c', `${names.map(([k, n]) => `export ${k}="$${n}"; `).join('')}exec "$0" "$@"`, e.command, ...(e.args ?? [])])}`);
      else l.push(`command = ${str(e.command)}`, `args = ${str(e.args ?? [])}`);
      if (Object.keys(fixed).length) l.push(`env = ${table(fixed)}`);
      if (names.length) l.push(`env_vars = ${str([...new Set(names.map(([, n]) => n))])}`);
    }
    l.push('startup_timeout_sec = 60', 'tool_timeout_sec = 600');
    return l.join('\n');
  }).join('\n\n');
}

// The worker's config.toml. A key profile defines one provider that names the key's environment variable; the ChatGPT login
// uses Codex's built-in provider and the auth.json file. Nothing here is a secret.
export function codexConfig(p, servers) {
  const m = codexModel(p);
  const head = [...(m ? [`model = ${str(m)}`] : []), ...(p.auth === 'chatgpt' ? [] : [`model_provider = ${str(PROVIDER)}`]), 'cli_auth_credentials_store = "file"', 'check_for_update_on_startup = false'];
  const provider = p.auth === 'chatgpt' ? '' : `\n[model_providers.${PROVIDER}]\nname = ${str(PROVIDER)}\nbase_url = ${str(p.baseUrl)}\nenv_key = ${str(p.keyName)}\nwire_api = "responses"\n`;
  const mcp = Object.keys(servers ?? {}).length ? `\n${codexMcp(servers)}\n` : '';
  return `${head.join('\n')}\n${provider}${mcp}`;
}

// The hint goes inside single quotes in the shell command; the other values are validated here.
export function codexCommand(p, { home, sessionId, hint }) {
  if (sessionId !== undefined && !SESSION.test(sessionId)) throw new Error('codex: the session id is not a valid thread id');
  const m = codexModel(p);
  if (m !== undefined && !MODEL.test(m)) throw new Error('codex: the model contains characters that are not allowed');
  if (hint.includes("'")) throw new Error('codex: the instructions must not contain an apostrophe');
  return `CODEX_HOME=${codexHome(home)} PATH=${home}/.local/bin:$PATH codex exec ${sessionId ? `resume ${sessionId} ` : ''}--json --dangerously-bypass-approvals-and-sandbox ${m ? `-m ${m} ` : ''}-c 'developer_instructions=${str(hint)}' - < ${home}/prompt.txt`;
}

// The ChatGPT login: a mode-600 file the user placed on purpose (like cloudyCloudAllowLiteral for MCP tokens). It is the one
// real credential that reaches a worker as a file: it goes through files.write into a mode-700 folder, never into a command string.
// Returns { text, values } (values: the secrets to scrub from every reply) or { error }.
export const AUTH_INSTALL = 'install -m 600 ~/.codex/auth.json ~/.config/cloudy-cloud/codex-auth.json';
export function codexAuth(env = process.env) {
  const file = env.CLOUDY_CLOUD_CODEX_AUTH || join(homedir(), '.config/cloudy-cloud/codex-auth.json');
  let st, text;
  try { st = statSync(file); text = readFileSync(file, 'utf8'); } catch {
    return { error: `The Codex ChatGPT login file ${file} was not found.\nNext step: sign in on this computer with: codex login (choose "Sign in with ChatGPT"), then run: ${AUTH_INSTALL}` };
  }
  if (st.mode & 0o077) return { error: `The Codex login file ${file} can be read by other users.\nNext step: run: chmod 600 ${file}` };
  let j;
  try { j = JSON.parse(text); } catch { /* checked below */ }
  if (j && typeof j === 'object' && typeof j.OPENAI_API_KEY === 'string' && j.OPENAI_API_KEY) return { error: `${file} holds an OPENAI_API_KEY, which is an API key, not a ChatGPT login. A key must never be sent to a worker as a file.\nNext step: store the key as a proxy secret with cloudy-cloud setup and use profile codex, or sign in with ChatGPT (codex logout, then codex login and choose "Sign in with ChatGPT"), then run: ${AUTH_INSTALL}` };
  const t = j?.tokens;
  if (!j || typeof j !== 'object' || !t || typeof t !== 'object' || typeof t.access_token !== 'string' || typeof t.refresh_token !== 'string') return { error: `${file} is not a Codex login file (expected the JSON that codex login writes to ~/.codex/auth.json after signing in with ChatGPT).\nNext step: run: codex login, then: ${AUTH_INSTALL}` };
  // Only what codex reads leaves this computer; any other field of the file stays here.
  const send = { auth_mode: 'chatgpt', tokens: Object.fromEntries(['id_token', 'access_token', 'refresh_token', 'account_id'].filter((k) => typeof t[k] === 'string').map((k) => [k, t[k]])), ...(typeof j.last_refresh === 'string' && { last_refresh: j.last_refresh }) };
  const values = Object.values(send.tokens).filter((v) => v.length >= 16);
  return { text: JSON.stringify(send), values };
}

// An exact next step for failures we know; '' otherwise.
export function codexNextStep(text) {
  const t = String(text);
  if (/model is not supported when using Codex with a ChatGPT account/i.test(t)) return 'Next step: start the worker without a model argument (the default model of your ChatGPT plan), or use a model that plan supports.';
  if (/401|unauthorized|token_expired|refresh token|sign in again|log ?in again/i.test(t) && !/api key/i.test(t)) return `Next step: refresh the login on this computer with codex login, then run: ${AUTH_INSTALL}`;
  if (/incorrect api key|invalid api key|invalid_api_key/i.test(t)) return 'Next step: check the provider key (OPENAI_API_KEY or the profile\'s key) in ~/.config/cloudy-cloud/env, then start the worker again.';
  return '';
}

// Installs pinned codex under ~/.local (no sudo, whatever the global npm prefix is) and writes its config and, for a ChatGPT
// profile, the login. `tail` shortens error text; the scrub of every reply is ctx.scrub (the login tokens are added to ctx.literals first).
export async function setupCodex(a, ctx, { tail, installMs, setupMs }) {
  const sh = (cmd, timeoutMs) => a.sandbox.commands.run(cmd, { cwd: a.home, timeoutMs });
  const dir = codexHome(a.home);
  const prep = `umask 077 && mkdir -p ${dir} && chmod 700 ${dir}`;
  let auth;
  if (a.profile.auth === 'chatgpt') {
    auth = codexAuth(ctx.env);
    if (auth.error) throw new Error(auth.error);
    auth.values.forEach((v) => ctx.literals.add(v));
  }
  await sh(`npm install -g --ignore-scripts --prefix ${a.home}/.local @openai/codex@${CODEX_VERSION}`, installMs)
    .catch((e) => { throw new Error(`Could not install codex in the sandbox: ${ctx.scrub(tail(e?.stderr ?? e?.message))}`); });
  await sh(auth ? `${prep} && : > ${dir}/auth.json` : prep, setupMs);
  await sh(`umask 077 && : > ${dir}/config.toml`, setupMs);
  // The config may hold an MCP token the user allowed; the login always is a secret. Neither may travel inside a command.
  const write = a.mcp?.literal?.length ? writeSecretFile : (sbx, path, data) => sbx.files.write(path, data);
  await write(a.sandbox, `${dir}/config.toml`, codexConfig(a.profile, a.mcp?.servers));
  await sh(`chmod 600 ${dir}/config.toml`, setupMs);
  if (auth) {
    await writeSecretFile(a.sandbox, `${dir}/auth.json`, auth.text);
    await sh(`chmod 600 ${dir}/auth.json`, setupMs);
  }
}
