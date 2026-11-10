#!/usr/bin/env node
// `cloudy-cloud mcp add|ls|rm`: choose which of your Claude Code MCP servers cloud subagents get.
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { redact } from './events.mjs';
import { checkServer, isLiteralSecret, mcpConfigText, mcpFile } from './mcpsync.mjs';

const REF_RE = /\$\{(MCP_[A-Z0-9_]+_TOKEN)\}/g;
const ALLOW = 'cloudyCloudAllowLiteral'; // set only by --allow-literal; read by run-subagent
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

const tilde = (p, env) => { const h = env.HOME || homedir(); return p.startsWith(h + '/') ? `~${p.slice(h.length)}` : p; };
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`Could not read ${f}: ${e.message}`); } };
// The loader's rule, so what is masked and rewritten here is exactly what the loader would reject.
const isSecret = (key, value, isHeader) => typeof value === 'string' && isLiteralSecret(key, value, isHeader);
const mask = (v) => { const m = /^Bearer /.exec(v)?.[0] ?? ''; const t = v.slice(m.length); const pre = /^[A-Za-z]{2,5}_/.exec(t)?.[0] ?? ''; return t.length < 16 ? `${m}…` : `${m}${pre}…${t.slice(-4)}`; };
// Shown before validation, so a url query or an argument holding a key must not be printed as is.
const showUrl = (u) => (u.includes('?') ? `${u.split('?')[0]}?…` : u);
const refsIn = (e) => [...new Set(Object.values({ ...e.env, ...e.headers }).flatMap((v) => [...String(v).matchAll(REF_RE)].map((m) => m[1])))];
const hostOf = (e) => { try { return new URL(e.url).hostname; } catch { return e.url ?? ''; } };
const target = (e) => (e.type === 'http' || e.type === 'sse' ? hostOf(e) : `${e.command} ${(e.args || []).find((a) => !String(a).startsWith('-')) ?? ''}`.trim());

function findSource(name, env, cwd) {
  const home = env.CLOUDY_CLOUD_CLAUDE_JSON || join(env.HOME || homedir(), '.claude.json');
  let top = cwd;
  try { top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd; } catch { /* not a repo */ }
  const claude = readJson(home);
  const project = readJson(join(top, '.mcp.json'));
  const tries = [
    [(claude?.projects?.[cwd] ?? claude?.projects?.[top])?.mcpServers?.[name], home, 'local'],
    [project?.mcpServers?.[name], join(top, '.mcp.json'), 'project'],
    [claude?.mcpServers?.[name], home, 'user'],
  ];
  const hit = tries.find(([e]) => e && typeof e === 'object');
  return hit && { entry: hit[0], file: hit[1], scope: hit[2] };
}

async function add(name, ctx, allowLiteral = false) {
  const { env, out, err } = ctx;
  if (!name) { err('Usage: cloudy-cloud mcp add <name>'); return 1; }
  const src = findSource(name, env, ctx.cwd);
  if (!src) { err(`No MCP server named ${name} in your Claude Code config. See: claude mcp list`); return 1; }
  const e = JSON.parse(JSON.stringify(src.entry));
  const orig = JSON.parse(JSON.stringify(src.entry));
  out(`Found ${name} in ${tilde(src.file, env)} (${src.scope} scope):`);
  const rows = [['type', e.type || 'stdio']];
  if (e.url) rows.push(['url', showUrl(String(e.url))]);
  if (e.command) rows.push(['command', redact([e.command, ...(e.args || [])].join(' '))]);
  const base = `MCP_${name.toUpperCase().replace(/-/g, '_')}`;
  let n = 0;
  const refs = [];
  for (const [field, label] of [['env', 'env'], ['headers', 'headers']]) {
    const lines = [];
    for (const [k, v] of Object.entries(e[field] || {})) {
      const secret = isSecret(k, v, field === 'headers');
      lines.push(`${k}${field === 'env' ? '=' : ': '}${secret ? mask(v) : v}`);
      if (secret) {
        const ref = `${base}${n++ ? `_${n}` : ''}_TOKEN`;
        e[field][k] = `${/^Bearer /.test(v) ? 'Bearer ' : ''}\${${ref}}`;
        refs.push(ref);
      } else refs.push(...[...String(v).matchAll(REF_RE)].map((m) => m[1]));
    }
    lines.forEach((l, i) => rows.push([i ? '' : label, l]));
  }
  for (const [k, v] of rows) out(`  ${k.padEnd(8)} ${v}`);

  // Consent path (off unless --allow-literal): keep the real value and put it on the machines.
  let literal = false;
  if (allowLiteral && refs.length) {
    out('WARNING: with --allow-literal the real token is copied onto every cloud machine (in a mode-600 file) instead of staying in Instabox.');
    out('Cloud machines run Claude with permission checks off, so a prompt injection in a web page or file could make the agent send that token anywhere.');
    if (!ctx.isTTY) { err('Not added: --allow-literal needs a terminal so you can confirm.'); return 1; }
    const yes = /^y(es)?$/i.test((await ctx.ask(`Copy the real ${name} token onto cloud machines? [y/N] `)).trim());
    if (!yes) { err('Not added. Run without --allow-literal to keep the token in Instabox.'); return 1; }
    literal = true;
  }

  let hosts = [];
  if (refs.length && !literal) {
    if (e.url) hosts = [hostOf(e)];
    else {
      if (!ctx.isTTY) { err('Not added: a secret without a host list would be sent to any host the subagent reaches.'); err('Run this in a terminal.'); return 1; }
      const answer = await ctx.ask('Which HTTPS hosts does this server send the token to? (comma-separated, exact hostnames, required) ');
      hosts = answer.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
      if (!hosts.length) { err('Not added: a secret without a host list would be sent to any host the subagent reaches.'); return 1; }
      const bad = hosts.find((h) => !HOST_RE.test(h));
      if (bad) { err(`Not added: "${bad}" is not a hostname.`); return 1; }
    }
  }
  const check = checkServer(name, e);
  if (literal && check.ok) check.entry = { ...orig, [ALLOW]: true }, check.secrets = [];
  if (!check.ok) { err(`Not added: ${check.reason}`); return 1; }

  const file = mcpFile(env);
  const doc = readJson(file) ?? {};
  const servers = { ...(doc.mcpServers || {}) };
  // my-srv and my_srv both map to MCP_MY_SRV_TOKEN; one Instabox secret cannot hold two values.
  for (const [other, oe] of Object.entries(servers)) {
    const clash = other !== name && refsIn(oe).find((r) => check.secrets.includes(r));
    if (clash) { err(`Not added: ${other} already uses ${clash}. Rename one of the two servers in Claude Code first.`); return 1; }
  }
  if (name in servers) out(`Replacing the existing ${name} entry.`);
  servers[name] = check.entry;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, mcpConfigText(servers) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);

  const uniq = literal ? [] : [...new Set(refs)];
  if (literal) out(`${name} will carry its real token on cloud machines because you allowed it. Remove it with: cloudy-cloud mcp rm ${name}`);
  if (uniq.length) {
    const h = hosts.map((x) => `--host ${x}`).join(' ');
    out('This server sends a secret. Cloud machines run Claude with permission checks off, so the value is not copied.');
    out(`It is written as ${uniq.map((r) => `\${${r}}`).join(', ')}; Instabox adds the real value to requests to ${hosts.join(', ')} only.`);
    for (const r of uniq) out(`  Store it once:  printf %s "$TOKEN" | npx --yes instabox@latest secrets set ${r} ${h}`);
  }
  out(`Added ${name} to ${tilde(file, env)}. Every cloud subagent you start from now on gets it.`);
  return 0;
}

function ls(ctx) {
  const doc = readJson(mcpFile(ctx.env));
  const names = Object.keys(doc?.mcpServers || {});
  if (!names.length) { ctx.out('No MCP servers are shared with cloud subagents. Add one with: cloudy-cloud mcp add <name>'); return 0; }
  for (const n of names) {
    const e = doc.mcpServers[n], r = refsIn(e);
    ctx.out(`${n}  ${e.type || 'stdio'}  ${target(e)}${r.length ? `  needs ${r.join(', ')}` : ''}`);
  }
  return 0;
}

function rm(name, ctx) {
  const file = mcpFile(ctx.env);
  const doc = readJson(file);
  if (!name || !doc?.mcpServers || !(name in doc.mcpServers)) { ctx.err(`No server named ${name} in ${tilde(file, ctx.env)}.`); return 1; }
  delete doc.mcpServers[name];
  writeFileSync(file, mcpConfigText(doc.mcpServers) + '\n', { mode: 0o600 });
  ctx.out(`Removed ${name} from ${tilde(file, ctx.env)}.`);
  return 0;
}

// ctx: { env, cwd, out, err, ask, isTTY } can all be replaced in tests.
export async function main(argv, ctx = {}) {
  ctx = {
    env: process.env, cwd: process.cwd(), out: (s) => console.log(s), err: (s) => console.error(s), isTTY: !!process.stdin.isTTY,
    ask: async (q) => { const rl = createInterface({ input: process.stdin, output: process.stderr }); try { return await rl.question(q); } finally { rl.close(); } },
    ...ctx,
  };
  const allow = argv.includes('--allow-literal');
  const [cmd, name] = argv.filter((x) => x !== '--allow-literal');
  try {
    if (cmd === 'add') return await add(name, ctx, allow);
    if (cmd === 'ls') return ls(ctx);
    if (cmd === 'rm') return rm(name, ctx);
  } catch (e) { ctx.err(e.message); return 1; }
  ctx.err('Usage: cloudy-cloud mcp add <name> [--allow-literal] | ls | rm <name>');
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main(process.argv.slice(2)));
