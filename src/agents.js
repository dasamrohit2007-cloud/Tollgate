import crypto from 'node:crypto';

/**
 * Registered agents. Each gets its own API key and optional limits.
 * Only a SHA-256 hash of the key is stored, so a leaked data file does not leak working keys,
 * and the key itself is shown exactly once, when it is created or rotated.
 *
 * An agent's limits can only make things stricter: the effective limit is the smaller of
 * the agent's limit and the global rule.
 */
export const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');
export const newKey = () => `tg_${crypto.randomBytes(24).toString('base64url')}`;

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'agent';

function cleanLimits(input) {
  if (input === undefined || input === null) return { ok: true, limits: {} };
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'limits must be an object' };
  const limits = {};
  for (const key of ['perTransactionLimit', 'dailyBudget']) {
    const v = input[key];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return { ok: false, error: `${key} must be a number between 0 and 1000000` };
    limits[key] = Math.round(n * 100) / 100;
  }
  return { ok: true, limits };
}

function cleanName(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  return n.length >= 1 && n.length <= 40 ? n : null;
}

export function createAgentRegistry(store, now = () => new Date()) {
  const publicView = (a) => ({
    id: a.id,
    name: a.name,
    keyPrefix: a.keyPrefix,
    createdAt: a.createdAt,
    paused: Boolean(a.paused),
    limits: { ...(a.limits || {}) },
    lastUsedAt: a.lastUsedAt || null,
  });

  function uniqueId(name) {
    const base = slug(name);
    let id = base;
    for (let i = 2; store.getAgent(id); i += 1) id = `${base}-${i}`;
    return id;
  }

  return {
    publicView,
    list: () => store.listAgents().map(publicView),
    get: (id) => store.getAgent(id),

    create({ name, limits } = {}) {
      const n = cleanName(name);
      if (!n) return { ok: false, errors: ['name must be 1 to 40 characters'] };
      if (store.listAgents().length >= 50) return { ok: false, errors: ['too many agents (the maximum is 50)'] };
      const l = cleanLimits(limits);
      if (!l.ok) return { ok: false, errors: [l.error] };
      const key = newKey();
      const agent = {
        id: uniqueId(n),
        name: n,
        keyHash: hashKey(key),
        keyPrefix: `${key.slice(0, 9)}…`,
        createdAt: now().toISOString(),
        paused: false,
        limits: l.limits,
        lastUsedAt: null,
      };
      store.addAgent(agent);
      return { ok: true, agent: publicView(agent), key };
    },

    update(id, patch = {}) {
      const agent = store.getAgent(id);
      if (!agent) return { ok: false, status: 404, errors: ['Agent not found.'] };
      const next = {};
      if (patch.name !== undefined) {
        const n = cleanName(patch.name);
        if (!n) return { ok: false, status: 400, errors: ['name must be 1 to 40 characters'] };
        next.name = n;
      }
      if (patch.paused !== undefined) {
        if (typeof patch.paused !== 'boolean') return { ok: false, status: 400, errors: ['paused must be true or false'] };
        next.paused = patch.paused;
      }
      if (patch.limits !== undefined) {
        const l = cleanLimits(patch.limits);
        if (!l.ok) return { ok: false, status: 400, errors: [l.error] };
        next.limits = l.limits;
      }
      return { ok: true, agent: publicView(store.updateAgent(id, next)) };
    },

    /** Issues a new key and immediately invalidates the old one. */
    rotateKey(id) {
      if (!store.getAgent(id)) return { ok: false, status: 404, errors: ['Agent not found.'] };
      const key = newKey();
      const agent = store.updateAgent(id, { keyHash: hashKey(key), keyPrefix: `${key.slice(0, 9)}…` });
      return { ok: true, agent: publicView(agent), key };
    },

    remove(id) {
      return store.deleteAgent(id) ? { ok: true } : { ok: false, status: 404, errors: ['Agent not found.'] };
    },

    /** Resolves an "Authorization: Bearer <key>" header to an agent, or null. */
    authenticate(header) {
      const m = /^Bearer\s+(\S+)$/i.exec(header || '');
      return m ? store.findAgentByKeyHash(hashKey(m[1])) : null;
    },

    touch(id) {
      store.updateAgent(id, { lastUsedAt: now().toISOString() });
    },
  };
}
