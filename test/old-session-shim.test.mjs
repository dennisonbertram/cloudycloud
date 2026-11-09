import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Pre-rename sessions still run bin/claude-cloud on coordinator machines, with CLAUDE_CLOUD_* settings.
const shim = resolve('bin/claude-cloud');
const HINT = "it's a\nmulti-line hint";

function run(viaSymlink) {
  const home = mkdtempSync(join(tmpdir(), 'cc-shim-'));
  mkdirSync(join(home, '.config/claude-cloud'), { recursive: true });
  writeFileSync(join(home, '.config/claude-cloud/env'), 'INSTABOX_API_KEY=ibk_FAKE\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-FAKE\nCLAUDE_CLOUD_DEPTH=1\n', { mode: 0o600 });
  const out = join(home, 'out');
  writeFileSync(join(home, 'claude'), `#!/bin/sh\nprintf '%s\\0' "$@" > "${out}.argv"\nprintf '%s' "$CLOUDY_CLOUD_EXTRA_PROMPT|$CLOUDY_CLOUD_X" > "${out}.env"\n`);
  chmodSync(join(home, 'claude'), 0o755);
  const repo = join(home, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/t/r.git'], { cwd: repo });
  let path = shim;
  if (viaSymlink) { path = join(home, 'linked-claude-cloud'); symlinkSync(shim, path); }
  const env = { PATH: `${home}:${process.env.PATH}`, HOME: home, CLAUDE_CLOUD_EXTRA_PROMPT: HINT, CLOUDY_CLOUD_X: 'keep' };
  const r = spawnSync(path, ['-p', 'hi'], { cwd: repo, env, input: '', encoding: 'utf8' });
  return { r, home, argv: existsSync(out + '.argv') ? readFileSync(out + '.argv', 'utf8').split('\0') : [], env: existsSync(out + '.env') ? readFileSync(out + '.env', 'utf8') : '' };
}

for (const viaSymlink of [false, true]) {
  test(`old claude-cloud command starts cloudy-cloud${viaSymlink ? ' (through a symlink)' : ''}`, () => {
    const { r, home, argv, env } = run(viaSymlink);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(argv.includes('-p') && argv[argv.indexOf('-p') + 1] === 'hi');
    assert.ok(argv[argv.indexOf('--append-system-prompt') + 1].endsWith(' ' + HINT), 'hint reaches the system prompt unchanged');
    assert.equal(env, HINT + '|keep'); // CLOUDY_CLOUD_X was already set, so it is not overwritten
    assert.match(readFileSync(join(home, '.config/cloudy-cloud/env'), 'utf8'), /^CLOUDY_CLOUD_DEPTH=1$/m);
  });
}
