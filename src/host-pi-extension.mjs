// pi extension (loaded with `pi -e`): registers the cloud MCP server for this session only, so no pi config file is edited.
// pi 1.5 has a built-in MCP client; `direct` exposure declares the cloud_agent tools to the model like built-in tools.
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('./server.mjs', import.meta.url));
// Names only: the server reads every key itself from the env file, so no key value is passed to pi.
const PASS = ['CLOUDY_CLOUD_CONFIG', 'CLOUDY_CLOUD_PROVIDER', 'CLOUDY_CLOUD_PROFILES', 'CLOUDY_CLOUD_WORKER_HOURS', 'CLOUDY_CLOUD_STARTS_PER_MIN', 'CLOUDY_CLOUD_MAX_INSTABOX_CALLS', 'CLOUDY_CLOUD_PROXY_SECRETS', 'CLOUDY_CLOUD_APT_PACKAGES'];

export default function (pi) {
  const env = Object.fromEntries(PASS.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  pi.registerMcpServer('cloud', { command: 'node', args: [server], env, exposure: 'direct', timeout: 1800 });
}
