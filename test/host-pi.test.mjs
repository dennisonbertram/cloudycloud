import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostPlan, registerFreePi, missingSetup, onPath, HOST_PROMPT } from '../src/host-pi.mjs';
import piExtension from '../src/host-pi-extension.mjs';
import { PI_VERSION } from '../src/profiles.mjs';

const root = '/opt/cc';
const cfg = '/h/.config/cloudy-cloud/env';

test('pi host: extension, prompt and user args go to pi as an argv array', () => {
  const p = hostPlan('pi', { root, env: { CLOUDY_CLOUD_CONFIG: cfg }, args: ['-p', 'hi there'], onPath: () => true });
  assert.equal(p.run.cmd, 'pi');
  assert.deepEqual(p.run.args.slice(0, 2), ['-e', `${root}/src/host-pi-extension.mjs`]);
  assert.equal(p.run.args[p.run.args.indexOf('--append-system-prompt') + 1], HOST_PROMPT);
  assert.deepEqual(p.run.args.slice(-2), ['-p', 'hi there']);
  assert.equal(p.setup, undefined);
});

test('pi host: without pi on PATH it runs the pinned npm package', () => {
  const p = hostPlan('pi', { root, env: {}, args: [], onPath: () => false });
  assert.equal(p.run.cmd, 'npx');
  assert.deepEqual(p.run.args.slice(0, 2), ['--yes', `@earendil-works/pi-coding-agent@${PI_VERSION}`]);
});

test('free-pi host: registers a cloudy-cloud entry (not cloud) with direct tools, a long timeout and no secret, then runs it', () => {
  const p = hostPlan('free-pi', { root, env: { CLOUDY_CLOUD_CONFIG: cfg, INSTABOX_API_KEY: 'ibk_SECRET' }, args: ['--continue'], onPath: () => true, note: 'No Claude token is saved.\nNext step: pass profile: codex.' });
  assert.equal(p.register.name, 'cloudy-cloud');
  assert.deepEqual([p.register.entry.command, p.register.entry.args, p.register.entry.exposure], ['node', [`${root}/src/server.mjs`], 'direct']);
  assert.ok(p.register.entry.timeout >= 1560, 'cloud_agent_wait can block for 1,560 s');
  assert.deepEqual(p.register.entry.env, { CLOUDY_CLOUD_CONFIG: cfg });
  assert.match(p.register.entry.description, /Next step: pass profile: codex/, 'the same profile hint the other hosts carry');
  assert.ok(!JSON.stringify(p).includes('ibk_SECRET'));
  assert.deepEqual(p.run, { cmd: 'free-pi-cli', args: ['--continue'] });
});

test('registerFreePi keeps the user\'s other servers (including their own "cloud"), updates our entry, and refuses a different cloudy-cloud entry', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cc-fp-')), 'agent', 'mcp.json');
  const entry = { command: 'node', args: [`${root}/src/server.mjs`], env: { CLOUDY_CLOUD_CONFIG: cfg }, exposure: 'direct', timeout: 1800, description: 'one' };
  assert.deepEqual(registerFreePi(file, 'cloudy-cloud', entry), {});
  const mine = { command: 'other', args: [] };
  const j = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ mcpServers: { ...j.mcpServers, cloud: mine } }));
  assert.deepEqual(registerFreePi(file, 'cloudy-cloud', { ...entry, description: 'two' }), {}, 'same entry, new description: updated');
  const after = JSON.parse(readFileSync(file, 'utf8')).mcpServers;
  assert.deepEqual(after.cloud, mine, 'the user\'s own cloud server is untouched');
  assert.equal(after['cloudy-cloud'].description, 'two');
  writeFileSync(file, JSON.stringify({ mcpServers: { 'cloudy-cloud': { command: 'node', args: ['/somewhere/else.mjs'] } } }));
  const r = registerFreePi(file, 'cloudy-cloud', entry);
  assert.match(r.error, /free-pi-cli mcp remove cloudy-cloud/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).mcpServers['cloudy-cloud'].args[0], '/somewhere/else.mjs', 'not replaced');
});

test('missingSetup: Instabox key or self-hosted machine is needed, a Claude token is not', () => {
  assert.match(missingSetup({}), /Instabox API key/);
  assert.equal(missingSetup({ INSTABOX_API_KEY: 'x' }), '');
  assert.match(missingSetup({ CLOUDY_CLOUD_PROVIDER: 'self-hosted' }), /CLOUDY_CLOUD_SSH_HOST/);
  assert.equal(missingSetup({ CLOUDY_CLOUD_PROVIDER: 'self-hosted', CLOUDY_CLOUD_SSH_HOST: 'h' }), '');
  // msb counts when the variable is set, and also when it is auto-discovered at ~/.local/bin/msb or on PATH.
  const noMsb = mkdtempSync(join(tmpdir(), 'pi-nomsb-'));
  assert.match(missingSetup({ CLOUDY_CLOUD_PROVIDER: 'microsandbox', HOME: noMsb, PATH: '' }), /CLOUDY_CLOUD_MSB_BIN/);
  assert.equal(missingSetup({ CLOUDY_CLOUD_PROVIDER: 'microsandbox', CLOUDY_CLOUD_MSB_BIN: '/x/msb' }), '');
  const home = mkdtempSync(join(tmpdir(), 'pi-msbhome-'));
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'msb'), '#!/bin/sh\n'); chmodSync(join(home, '.local', 'bin', 'msb'), 0o755);
  assert.equal(missingSetup({ CLOUDY_CLOUD_PROVIDER: 'microsandbox', HOME: home, PATH: '' }), '');
  const onPathDir = mkdtempSync(join(tmpdir(), 'pi-msbpath-'));
  writeFileSync(join(onPathDir, 'msb'), '#!/bin/sh\n'); chmodSync(join(onPathDir, 'msb'), 0o755);
  assert.equal(missingSetup({ CLOUDY_CLOUD_PROVIDER: 'microsandbox', HOME: noMsb, PATH: onPathDir }), '');
});

test('prompt tells the model to delegate through the cloud_agent tools and keep keys private', () => {
  assert.match(HOST_PROMPT, /cloud_agent_wait/);
  assert.match(HOST_PROMPT, /pi-glm/);
  assert.match(HOST_PROMPT, /never print|Never print/);
  assert.ok(!HOST_PROMPT.includes('Agent tool is disabled'));
});

test('extension registers the cloud server with direct exposure and only named env', () => {
  const calls = [];
  const old = { ...process.env };
  process.env.CLOUDY_CLOUD_CONFIG = cfg; process.env.UNRELATED_API_KEY = 'nope';
  try { piExtension({ registerMcpServer: (n, c) => calls.push([n, c]) }); } finally { process.env = old; }
  const [name, c] = calls[0];
  assert.equal(name, 'cloud');
  assert.equal(c.command, 'node');
  assert.match(c.args[0], /src\/server\.mjs$/);
  assert.equal(c.exposure, 'direct');
  assert.equal(c.env.CLOUDY_CLOUD_CONFIG, cfg);
  assert.ok(!('UNRELATED_API_KEY' in c.env));
});

test('cli: not set up stops with the exact next step and starts nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-hostpi-'));
  const stub = join(dir, 'pi'); writeFileSync(stub, '#!/bin/sh\ntouch started\n'); chmodSync(stub, 0o755);
  writeFileSync(join(dir, 'env'), '');
  const r = spawnSync('node', [resolve('src/host-pi.mjs'), 'pi'], { cwd: dir, env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, CLOUDY_CLOUD_CONFIG: join(dir, 'env') }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cloudy-cloud setup/);
  assert.equal(spawnSync('test', ['-e', join(dir, 'started')]).status, 1);
});

test('onPath finds an executable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-hostpi-'));
  writeFileSync(join(dir, 'tool'), '#!/bin/sh\n'); chmodSync(join(dir, 'tool'), 0o755);
  assert.equal(onPath('tool', { PATH: dir }), true);
  assert.equal(onPath('nothere', { PATH: dir }), false);
});
