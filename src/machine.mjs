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
// The smallest plan whose largest size holds both the vCPUs and the memory. Sizes: https://instabox.sh/docs/account/limits.md; fees (USD a month): pricing.md
const PLANS = [['pro', 8, 16384, 20], ['builder', 16, 32768, 100], ['team', 32, 65536, 500]];
export const planFor = (vcpus, memMiB = 0) => PLANS.find(([, v, m]) => vcpus <= v && memMiB <= m)?.[0];
// Sizes each plan adds (limits.md): a plan offers its own and every lower plan's. offeredBy gives the lowest plan that lists exactly this size.
const ADDS = { pro: ['2x4', '4x8', '8x16'], builder: ['16x32'], team: ['32x64'] };
export const TIERS = ['free', 'pro', 'builder', 'team'];
export const ALL_SIZES = Object.values(ADDS).flat();
export const offeredBy = (label) => Object.keys(ADDS).find((p) => ADDS[p].includes(label));
export const SIZES_BY_PLAN = `${ADDS.pro.join(' ')} (pro), ${ADDS.builder} (builder), ${ADDS.team} (team)`;
const hourly = (label) => { const [v, g] = label.split('x').map(Number); return (v * 0.004 + g * 0.00225).toFixed(3); };
export const SIZE_COSTS = ALL_SIZES.map((l) => `${l} $${hourly(l)}/h`).join(', ');
// SIZE_PRICE plus the default for comparison (for a size other than the default 4x8).
export const sizeCostLine = (vcpus, gib) => `${SIZE_PRICE(vcpus, gib)}${vcpus === 4 && gib === 8 ? '' : ` The default 4x8 costs about $${hourly('4x8')} an hour.`}`;
export const planFee = (plan) => PLANS.find(([n]) => n === plan)?.[3];
