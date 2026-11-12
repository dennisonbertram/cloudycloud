import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadProvider } from '../src/providers/index.mjs';
import { contractSuite } from './provider-contract.mjs';
import { createFakeProvider } from './fake-provider.mjs';

contractSuite('fake', ({ withKey }) => createFakeProvider(withKey ? { FAKE_API_KEY: 'k' } : {}));
contractSuite('fake without snapshots', ({ withKey }) => createFakeProvider(withKey ? { FAKE_API_KEY: 'k' } : {}, { hasSnapshots: false }));

test('loadProvider rejects an unknown provider name', async () => {
  await assert.rejects(loadProvider({ CLOUDY_CLOUD_PROVIDER: 'nope' }), { message: 'Unknown CLOUDY_CLOUD_PROVIDER "nope". Known: instabox.' });
  await assert.rejects(loadProvider({ CLOUDY_CLOUD_PROVIDER: 'constructor' }), /Unknown CLOUDY_CLOUD_PROVIDER/);
});

// The adapter lands in a separate change; these run once src/providers/instabox.mjs exists.
const adapter = existsSync(new URL('../src/providers/instabox.mjs', import.meta.url));
test('loadProvider defaults to instabox and accepts it by name', { skip: !adapter && 'adapter not present yet' }, async () => {
  assert.equal((await loadProvider({})).name, 'instabox');
  assert.equal((await loadProvider({ CLOUDY_CLOUD_PROVIDER: 'instabox' })).name, 'instabox');
});
