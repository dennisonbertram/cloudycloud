import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';

const root = resolve('.');
const siteDir = join(root, 'site');
const skillsDir = join(root, 'skills');
const agentSkillsDir = join(siteDir, '.well-known', 'agent-skills');

const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;
const skillNames = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const index = JSON.parse(readFileSync(join(agentSkillsDir, 'index.json'), 'utf8'));

// Files under a directory, as { relativePath: bytes }.
function tree(dir, base = dir) {
  const out = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, tree(p, base));
    else out[relative(base, p)] = readFileSync(p);
  }
  return out;
}

test('index.json has the v0.2.0 $schema and one entry per skills/ directory', () => {
  assert.equal(index.$schema, 'https://schemas.agentskills.io/discovery/0.2.0/schema.json');
  assert.deepEqual(index.skills.map((s) => s.name).sort(), skillNames);
});

test('every skill url maps to a file under site/ and its digest is the sha256 of that file', () => {
  for (const skill of index.skills) {
    assert.match(skill.digest, /^sha256:[0-9a-f]{64}$/, skill.name);
    assert.ok(skill.url.startsWith('/'), skill.url);
    const file = join(siteDir, skill.url);
    assert.ok(existsSync(file), `${skill.url} is not a file under site/`);
    assert.equal(skill.digest, sha256(readFileSync(file)), skill.url);
  }
});

test('a skill-md artifact is byte-equal to skills/<name>/SKILL.md', () => {
  for (const skill of index.skills.filter((s) => s.type === 'skill-md')) {
    const artifact = readFileSync(join(siteDir, skill.url));
    assert.deepEqual(artifact, readFileSync(join(skillsDir, skill.name, 'SKILL.md')), skill.name);
  }
});

test('an archive extracts to the same file set and bytes as skills/<name>/, with SKILL.md at the root', () => {
  for (const skill of index.skills.filter((s) => s.type === 'archive')) {
    const dir = mkdtempSync(join(tmpdir(), 'cc-skill-'));
    execFileSync('tar', ['-xzf', join(siteDir, skill.url), '-C', dir]);
    const want = tree(join(skillsDir, skill.name));
    const got = tree(dir);
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), skill.name);
    assert.ok('SKILL.md' in got, `${skill.name}: SKILL.md is not at the archive root`);
    for (const [name, bytes] of Object.entries(want)) assert.deepEqual(got[name], bytes, `${skill.name}/${name}`);
  }
});

test('server-card.json names this package and a transport that ends in the mcp-server subcommand', () => {
  const card = JSON.parse(readFileSync(join(siteDir, '.well-known', 'mcp', 'server-card.json'), 'utf8'));
  assert.equal(card.serverInfo.version, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
  assert.equal(card.transport.args.at(-1), 'mcp-server');
});

test('cloudy-cloud mcp-server answers initialize and tools/list on stdio with nothing else on stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-mcp-server-'));
  writeFileSync(join(dir, 'env'), '');
  const child = spawn(join(root, 'bin/cloudy-cloud'), ['mcp-server'], {
    env: { PATH: process.env.PATH, HOME: dir, CLOUDY_CLOUD_CONFIG: join(dir, 'env'), CLOUDY_CLOUD_NO_UPDATE_CHECK: '1' },
  });
  try {
    const lines = [];
    let buf = '', stderr = '';
    const gotLines = new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timed out; lines so far: ${JSON.stringify(lines)}; stderr: ${stderr}`)), 20000);
      child.stdout.on('data', (d) => {
        buf += d;
        for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
          lines.push(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (lines.length === 2) { clearTimeout(timer); res(); }
        }
      });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('exit', (code) => rej(new Error(`mcp-server exited ${code} before answering; stdout: ${JSON.stringify(lines)}; stderr: ${stderr}`)));
    });
    for (const msg of [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'site-well-known-test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]) child.stdin.write(JSON.stringify(msg) + '\n');
    await gotLines;
    const init = JSON.parse(lines[0]);
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.id, 1);
    assert.ok(init.result.serverInfo, 'first stdout line is not an initialize result');
    const list = JSON.parse(lines[1]);
    assert.equal(list.id, 2);
    assert.ok(list.result.tools.some((t) => t.name === 'cloud_agent'), `no cloud_agent in ${list.result.tools.map((t) => t.name)}`);
  } finally {
    child.kill('SIGKILL');
  }
});
