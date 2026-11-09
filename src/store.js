import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_POLICY } from './policy.js';

/**
 * Small JSON-file store for the policy, the registered agents and the audit log.
 * Writes are atomic (temp file + rename). Pass file=null for in-memory only.
 */
export function createStore(file = null) {
  let state = { policy: { ...DEFAULT_POLICY }, records: [], agents: [], seq: 0 };

  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved && Array.isArray(saved.records)) {
        state = {
          policy: { ...DEFAULT_POLICY, ...(saved.policy || {}) },
          records: saved.records,
          agents: Array.isArray(saved.agents) ? saved.agents : [],
          seq: Number(saved.seq) || saved.records.length,
        };
      }
    } catch {
      /* first run or unreadable file: start fresh */
    }
  }

  function persist() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error('could not save audit log:', err.message);
    }
  }

  const dayKey = (iso) => iso.slice(0, 10);
  const forAgent = (agentId) => (r) => agentId === undefined || r.request.agentId === agentId;

  return {
    getPolicy: () => ({ ...state.policy }),
    setPolicy(policy) {
      state.policy = { ...policy };
      persist();
    },

    // ---- registered agents (key hashes only, never the keys) ----
    listAgents: () => state.agents.map((a) => ({ ...a, limits: { ...(a.limits || {}) } })),
    getAgent: (id) => state.agents.find((a) => a.id === id) || null,
    findAgentByKeyHash: (hash) => state.agents.find((a) => a.keyHash === hash) || null,
    addAgent(agent) {
      state.agents.push(agent);
      persist();
      return agent;
    },
    updateAgent(id, patch) {
      const a = state.agents.find((x) => x.id === id);
      if (!a) return null;
      Object.assign(a, patch);
      persist();
      return a;
    },
    deleteAgent(id) {
      const before = state.agents.length;
      state.agents = state.agents.filter((a) => a.id !== id);
      if (state.agents.length !== before) persist();
      return state.agents.length !== before;
    },

    // ---- audit log ----
    add(record) {
      state.seq += 1;
      const full = { ...record, seq: state.seq };
      state.records.push(full);
      // Keep the log bounded.
      if (state.records.length > 2000) state.records.splice(0, state.records.length - 2000);
      persist();
      return full;
    },
    update(id, patch) {
      const rec = state.records.find((r) => r.id === id);
      if (!rec) return null;
      Object.assign(rec, patch);
      persist();
      return rec;
    },
    get: (id) => state.records.find((r) => r.id === id) || null,
    list: () => [...state.records].reverse(),

    /** Money that actually moved (executed) today, UTC, optionally for one agent. Pending requests do not count. */
    spentToday(now = new Date(), agentId) {
      const today = dayKey(now.toISOString());
      return state.records
        .filter((r) => r.status === 'executed' && r.executedAt && dayKey(r.executedAt) === today && forAgent(agentId)(r))
        .reduce((sum, r) => sum + r.request.amount, 0);
    },
    /** Pending requests count toward the budget check so approvals cannot be stacked past it. */
    reservedToday(now = new Date(), agentId) {
      const today = dayKey(now.toISOString());
      return state.records
        .filter((r) => r.status === 'pending' && dayKey(r.createdAt) === today && forAgent(agentId)(r))
        .reduce((sum, r) => sum + r.request.amount, 0);
    },
    recentCount(agentId, windowMs = 60_000, now = Date.now()) {
      return state.records.filter(
        (r) => r.request.agentId === agentId && now - Date.parse(r.createdAt) < windowMs,
      ).length;
    },

    stats() {
      const s = { total: state.records.length, approved: 0, blocked: 0, pending: 0, rejected: 0, executed: 0, failed: 0, blockedAmount: 0, executedAmount: 0 };
      for (const r of state.records) {
        if (r.status === 'blocked') {
          s.blocked += 1;
          s.blockedAmount += r.request.amount;
        } else if (r.status === 'pending') s.pending += 1;
        else if (r.status === 'rejected') s.rejected += 1;
        else if (r.status === 'executed') {
          s.executed += 1;
          s.executedAmount += r.request.amount;
        } else if (r.status === 'failed') s.failed += 1;
      }
      s.approved = s.executed;
      s.blockedAmount = Math.round(s.blockedAmount * 100) / 100;
      s.executedAmount = Math.round(s.executedAmount * 100) / 100;
      return s;
    },
    /** Clears the log and puts the rules back to defaults. Registered agents are kept. */
    reset() {
      state = { policy: { ...DEFAULT_POLICY }, records: [], agents: state.agents, seq: 0 };
      persist();
    },
  };
}
