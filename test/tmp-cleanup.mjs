// Import first in every test file. Points os.tmpdir() at a private directory that is removed when the test process exits,
// so the temp dirs the tests (and the code they run) create never pile up. Child processes inherit TMPDIR.
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(realpathSync(tmpdir()), 'cc-test-'));
process.env.TMPDIR = dir;
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
process.env.CLOUDY_CLOUD_STREAMS = join(dir, 'streams'); // stream copies of fake agents never reach the real home folder
