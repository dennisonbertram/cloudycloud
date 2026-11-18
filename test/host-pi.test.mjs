import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostPlan, missingSetup, onPath, HOST_PROMPT } from '../src/host-pi.mjs';
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

test('free-pi host: registers the MCP server with free-pi-cli (direct tools, no secret), then runs it', () => {
  const p = hostPlan('free-pi', { root, env: { CLOUDY_CLOUD_CONFIG: cfg, INSTABOX_API_KEY: 'ibk_SECRET' }, args: ['--continue'], onPath: () => true });
  assert.equal(p.setup.cmd, 'free-pi-cli');
  assert.deepEqual(p.setup.args.slice(0, 3), ['mcp', 'add', 'cloud']);
  assert.ok(p.setup.args.includes('--exposure') && p.setup.args.includes('direct'));
  assert.deepEqual(p.setup.args.slice(-3), ['--', 'node', `${root}/src/server.mjs`]);
  assert.ok(!JSON.stringify(p).includes('ibk_SECRET'));
  assert.deepEqual(p.run, { cmd: 'free-pi-cli', args: ['--continue'] });
});

test('missingSetup: Instabox key or self-hosted machine is needed, a Claude token is not', () => {
  assert.match(missingSetup({}), /Instabox API key/);
  assert.equal(missingSetup({ INSTABOX_API_KEY: 'x' }), '');
  assert.match(missingSetup({ CLOUDY_CLOUD_PROVIDER: 'self-hosted' }), /CLOUDY_CLOUD_SSH_HOST/);
  assert.equal(missingSetup({ CLOUDY_CLOUD_PROVIDER: 'self-hosted', CLOUDY_CLOUD_SSH_HOST: 'h' }), '');
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
