import './tmp-cleanup.mjs';
// The shared provider contract, run against the real Instabox adapter with an in-memory fake SDK and fetch.
import { contractSuite } from './provider-contract.mjs';
import { createProvider } from '../src/providers/instabox.mjs';

const API = 'https://api.instabox.sh/v1/machines';
const applied = { proxy: { revision: 1, appliedRevision: 1 }, guest: { revision: 1, appliedRevision: 1 } };

// One fake Instabox account: the SDK and raw HTTP see the same machines.
function fakeInstabox() {
  const machines = new Map();
  let n = 0;
  const info = (m) => ({ sandboxId: m.id, name: m.name, metadata: { ...m.metadata }, state: m.state, startedAt: new Date(m.createdAt), machine: m });
  const box = (m) => ({
    sandboxId: m.id,
    getInfo: async () => info(m),
    kill: async () => machines.delete(m.id),
    files: { write: async () => true, read: async () => new Uint8Array() },
    commands: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    createSnapshot: async () => ({ id: `snap-${m.id}`, status: 'pending' }),
  });
  const notFound = () => Object.assign(new Error('not found'), { status: 404, code: 'not_found' });
  const sdk = { Sandbox: {
    async create(image, opts) {
      const id = `m-${++n}`;
      const m = { id, name: opts.name ?? `box-${n}`, metadata: { ...opts.metadata }, state: 'running', createdAt: new Date().toISOString() };
      machines.set(id, m);
      return box(m);
    },
    async connect(id) { if (!machines.has(id)) throw notFound(); return box(machines.get(id)); },
    async list({ metadata = {} } = {}) {
      return [...machines.values()].filter((m) => Object.entries(metadata).every(([k, v]) => m.metadata[k] === v)).map(info);
    },
    async kill(id) { return machines.delete(id); },
    async getSnapshot(id) { return { id, status: 'ready' }; },
  } };
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    if (/\/secrets$/.test(u.pathname)) return init.method === 'PATCH' ? new Response('{}') : Response.json(applied);
    if (init.method === 'DELETE') {
      const id = decodeURIComponent(u.pathname.split('/').pop());
      return new Response('{}', { status: machines.delete(id) ? 200 : 404 });
    }
    if (u.href.startsWith(API) && (!init.method || init.method === 'GET')) {
      const want = u.searchParams.getAll('metadata').map((s) => s.split(':'));
      const rows = [...machines.values()].filter((m) => want.every(([k, v]) => m.metadata[k] === v));
      return Response.json({ machines: rows });
    }
    return new Response('{}');
  };
  return { sdk, fetchFn };
}

contractSuite('instabox adapter', ({ withKey }) => {
  const { sdk, fetchFn } = fakeInstabox();
  return createProvider(withKey ? { INSTABOX_API_KEY: 'ibk_test' } : {}, { sdk, fetchFn, timing: { pollMs: 1, timeoutMs: 100 } });
});
