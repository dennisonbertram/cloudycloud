import { createFakeProvider, setGithub } from '../test/fake-provider.mjs';

export function createProvider(env = process.env) {
  setGithub(env.CLOUDY_CLOUD_TEST_GITHUB);
  return createFakeProvider({ FAKE_API_KEY: 'offline-test-key' }, { deleteFailures: Number(env.CLOUDY_CLOUD_TEST_DELETE_FAILURES) || 0, hangKill: env.CLOUDY_CLOUD_TEST_HANG_KILL === '1' });
}
