#!/usr/bin/env node
// `cloudy-cloud mcp add|ls|rm`: choose which of your Claude Code MCP servers cloud subagents get.
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { redact } from './events.mjs';

const KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD)$/i;
const REF_RE = /\$\{(MCP_[A-Z0-9_]+_TOKEN)\}/g;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

const tilde = (p, env) => { const h = env.HOME || homedir(); return p.startsWith(h + '/') ? `~${p.slice(h.length)}` : p; };
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`Could not read ${f}: ${e.message}`); } };
const isRef = (v) => /^(Bearer )?\$\{MCP_[A-Z0-9_]+_TOKEN\}$/.test(v);
const isSecret = (key, value, isHeader) =>
  typeof value === 'string' && !isRef(value) && (KEY_RE.test(key) || (isHeader && value.startsWith('Bearer ')) || redact(value) !== value);
const mask = (v) => { const m = /^Bearer /.exec(v)?.[0] ?? ''; const t = v.slice(m.length); const pre = /^[A-Za-z]{2,5}_/.exec(t)?.[0] ?? ''; return `${m}${pre}…${t.slice(-4)}`; };
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
    [claude?.projects?.[top]?.mcpServers?.[name], home, 'local'],
    [project?.mcpServers?.[name], join(top, '.mcp.json'), 'project'],
    [claude?.mcpServers?.[name], home, 'user'],
  ];
  const hit = tries.find(([e]) => e && typeof e === 'object');
  return hit && { entry: hit[0], file: hit[1], scope: hit[2] };
}

async function add(name, ctx) {
  const { env, out, err, sync } = ctx;
  if (!name) { err('Usage: cloudy-cloud mcp add <name>'); return 1; }
  const src = findSource(name, env, ctx.cwd);
  if (!src) { err(`No MCP server named ${name} in your Claude Code config. See: claude mcp list`); return 1; }
  const e = JSON.parse(JSON.stringify(src.entry));
  out(`Found ${name} in ${tilde(src.file, env)} (${src.scope} scope):`);
  const rows = [['type', e.type || 'stdio']];
  if (e.url) rows.push(['url', e.url]);
  if (e.command) rows.push(['command', [e.command, ...(e.args || [])].join(' ')]);
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
      } else if (isRef(v)) refs.push(...[...v.matchAll(REF_RE)].map((m) => m[1]));
    }
    lines.forEach((l, i) => rows.push([i ? '' : label, l]));
  }
  for (const [k, v] of rows) out(`  ${k.padEnd(8)} ${v}`);

  let hosts = [];
  if (refs.length) {
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
  const check = sync.checkServer(name, e);
  if (!check.ok) { err(`Not added: ${check.reason}`); return 1; }

  const file = sync.mcpFile(env);
  const doc = readJson(file) ?? {};
  const servers = { ...(doc.mcpServers || {}) };
  if (name in servers) out(`Replacing the existing ${name} entry.`);
  servers[name] = check.entry;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, sync.mcpConfigText(servers) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);

  const uniq = [...new Set(refs)];
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
  const doc = readJson(ctx.sync.mcpFile(ctx.env));
  const names = Object.keys(doc?.mcpServers || {});
  if (!names.length) { ctx.out('No MCP servers are shared with cloud subagents. Add one with: cloudy-cloud mcp add <name>'); return 0; }
  for (const n of names) {
    const e = doc.mcpServers[n], r = refsIn(e);
    ctx.out(`${n}  ${e.type || 'stdio'}  ${target(e)}${r.length ? `  needs ${r.join(', ')}` : ''}`);
  }
  return 0;
}

function rm(name, ctx) {
  const file = ctx.sync.mcpFile(ctx.env);
  const doc = readJson(file);
  if (!name || !doc?.mcpServers || !(name in doc.mcpServers)) { ctx.err(`No server named ${name} in ${tilde(file, ctx.env)}.`); return 1; }
  delete doc.mcpServers[name];
  writeFileSync(file, ctx.sync.mcpConfigText(doc.mcpServers) + '\n', { mode: 0o600 });
  ctx.out(`Removed ${name} from ${tilde(file, ctx.env)}.`);
  return 0;
}

// ctx: { env, cwd, out, err, ask, isTTY, sync } can all be replaced in tests.
export async function main(argv, ctx = {}) {
  ctx = {
    env: process.env, cwd: process.cwd(), out: (s) => console.log(s), err: (s) => console.error(s), isTTY: !!process.stdin.isTTY,
    ask: async (q) => { const rl = createInterface({ input: process.stdin, output: process.stderr }); try { return await rl.question(q); } finally { rl.close(); } },
    ...ctx,
  };
  ctx.sync ??= await import('./mcpsync.mjs'); // issue #10: exports checkServer, mcpFile, mcpConfigText
  const [cmd, name] = argv;
  try {
    if (cmd === 'add') return await add(name, ctx);
    if (cmd === 'ls') return ls(ctx);
    if (cmd === 'rm') return rm(name, ctx);
  } catch (e) { ctx.err(e.message); return 1; }
  ctx.err('Usage: cloudy-cloud mcp add <name> | ls | rm <name>');
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main(process.argv.slice(2)));
