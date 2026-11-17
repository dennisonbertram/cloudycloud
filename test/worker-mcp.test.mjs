import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeMcp, MERGE_MCP_SCRIPT } from '../src/worker-mcp.mjs';

const image = { mcpServers: { instabox: { command: 'instabox' }, 'open-computer-use': { command: 'ocu' } } };
const shared = { mcpServers: { notion: { type: 'http', url: 'https://mcp.notion.com' } } };

test('mergeMcp drops instabox and keeps the image servers', () => {
  assert.deepEqual(mergeMcp(image, {}), { mcpServers: { 'open-computer-use': { command: 'ocu' } } });
});
test('mergeMcp adds shared servers and a shared entry wins a clash', () => {
  const r = mergeMcp(image, { mcpServers: { ...shared.mcpServers, 'open-computer-use': { command: 'mine' } } });
  assert.deepEqual(r, { mcpServers: { 'open-computer-use': { command: 'mine' }, ...shared.mcpServers } });
});
test('mergeMcp with no image file or an unparseable one gives the shared servers only', () => {
  assert.deepEqual(mergeMcp({}, shared), shared);
  assert.deepEqual(mergeMcp(undefined, shared), shared);
});
test('mergeMcp with neither is empty', () => assert.deepEqual(mergeMcp({}, {}), { mcpServers: {} }));

// Runs the exact command text through bash -c with a fake HOME, the way the machine does.
const runMerge = (home, shared) => {
  const out = join(home, 'out.json');
  const cmd = `node -e '${MERGE_MCP_SCRIPT.replaceAll("'", "'\\''")}' ${out} ${shared}`;
  execFileSync('bash', ['-c', cmd], { env: { ...process.env, HOME: home } });
  return JSON.parse(readFileSync(out, 'utf8'));
};
test('the merge script works through bash -c: image + shared, a bad image file, and nothing at all', () => {
  const home = mkdtempSync(join(tmpdir(), 'wmcp-'));
  try {
    writeFileSync(join(home, 'shared.json'), JSON.stringify(shared));
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ ...image, other: 1 }));
    assert.deepEqual(runMerge(home, join(home, 'shared.json')), { mcpServers: { 'open-computer-use': { command: 'ocu' }, ...shared.mcpServers } });
    writeFileSync(join(home, '.claude.json'), '{not json');
    assert.deepEqual(runMerge(home, join(home, 'shared.json')), shared);
    rmSync(join(home, '.claude.json'));
    assert.deepEqual(runMerge(home, join(home, 'missing.json')), { mcpServers: {} });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the merge script tightens an existing world-readable file to 0600 and replaces a stale config', () => {
  const t = mkdtempSync(join(tmpdir(), 'cc-mcp-'));
  try {
    const out = join(t, 'mcp.json');
    writeFileSync(out, '{"mcpServers":{"stale":{"command":"old"}}}', { mode: 0o644 });
    execFileSync('node', ['-e', MERGE_MCP_SCRIPT, out, join(t, 'missing.json')], { env: { PATH: process.env.PATH, HOME: t } });
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { mcpServers: {} });
    assert.equal(statSync(out).mode & 0o777, 0o600);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('the merge script exits non-zero when it cannot write, so the shell fallback runs', () => {
  const t = mkdtempSync(join(tmpdir(), 'cc-mcp-'));
  try {
    assert.throws(() => execFileSync('node', ['-e', MERGE_MCP_SCRIPT, join(t, 'no-such-dir', 'mcp.json'), join(t, 'x.json')], { env: { PATH: process.env.PATH, HOME: t }, stdio: 'ignore' }));
  } finally { rmSync(t, { recursive: true, force: true }); }
});
