// Machine kinds: the one `machine` string (cloud_agent argument, `--machine` flag) parsed once for every caller.
// Forms: linux | android | omarchy | gpu[:TYPE[:COUNT]] | macos[:MODEL]. `gpu` is Instabox's `--gpu TYPE[:COUNT]` value.
export const KINDS = ['linux', 'android', 'omarchy', 'gpu', 'macos'];
export const EXPENSIVE = ['gpu', 'macos']; // refused until CLOUDY_CLOUD_ALLOW_MACHINE_KINDS names them

// Price lines shown when asking for consent. Source: https://instabox.sh/docs/account/pricing.md
export const PRICE = {
  gpu: 'GPU machines cost $0.765 per GPU-hour (NVIDIA L4, up to 4 per machine)',
  macos: 'Mac machines cost $0.45 to $1.25 per hour by model, with a 24-hour minimum lease',
};

export const FORMS = 'linux, android, omarchy, gpu[:TYPE[:COUNT]] (COUNT 1-4 for an L4), macos[:MODEL]';
const WORD = /^[a-z0-9-]+$/;

/** @returns {{ name: string, gpu?: string, model?: string, label: string } | { error: string }} */
export function parseMachine(str) {
  const s = String(str ?? '').trim().toLowerCase() || 'linux';
  const [name, a, b, ...rest] = s.split(':');
  const bad = { error: `Unknown machine "${str}". Accepted forms: ${FORMS}.` };
  if (!KINDS.includes(name) || rest.length) return bad;
  if (name === 'gpu') {
    if (a === undefined) return { name, label: s };
    if (!WORD.test(a) || (b !== undefined && !/^[1-4]$/.test(b))) return bad;
    return { name, gpu: b ? `${a}:${b}` : a, label: s };
  }
  if (name === 'macos') {
    if (a === undefined) return { name, label: s };
    return WORD.test(a) && b === undefined ? { name, model: a, label: s } : bad;
  }
  return a === undefined ? { name, label: s } : bad;
}

// Machine size (cloud_agent `size`): VCPUSxGIB, for example 8x16. The plan's own list decides what is allowed.
export const SIZE_FORMS = 'VCPUSxGIB, for example 4x8 (default), 2x4 or 8x16';
/** @returns {{ vcpus: number, memMiB: number, label: string } | { error: string } | undefined} */
export function parseSize(str) {
  const s = String(str ?? '').trim().toLowerCase();
  if (!s) return undefined;
  const m = /^(\d+)x(\d+)$/.exec(s);
  if (!m || !+m[1] || !+m[2]) return { error: `Unknown size "${String(str).slice(0, 40)}". Use ${SIZE_FORMS}.` };
  return { vcpus: +m[1], memMiB: +m[2] * 1024, label: `${+m[1]}x${+m[2]}` };
}
export const sizeLabel = ({ vcpus, memMiB }) => `${vcpus}x${memMiB / 1024}`;
// Unit prices: https://instabox.sh/docs/account/pricing.md
export const SIZE_PRICE = (vcpus, gib) => `${vcpus}x${gib} costs about $${(vcpus * 0.004 + gib * 0.00225).toFixed(3)} an hour while running (vCPU $0.004/h, memory $0.00225/GiB-h).`;
// The smallest plan whose largest size (maxVCPUs from GET /v1/me plans[]) holds this many vCPUs.
export const planFor = (vcpus) => [['pro', 8], ['builder', 16], ['team', 32]].find(([, max]) => vcpus <= max)?.[0];
