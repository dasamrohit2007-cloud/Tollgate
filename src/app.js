import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { listScenarios, runScenario } from './scenarios.js';
import { PRESETS } from './policy.js';
import { createAgentRegistry } from './agents.js';
import { computeAnalytics } from './analytics.js';
import { recordsToCsv } from './export.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
const agGridFile = path.join(here, '..', 'node_modules', 'ag-grid-community', 'dist', 'ag-grid-community.min.js');

/** What an agent is allowed to see about a decision (no internal details). */
export function publicRecord(r) {
  const message =
    r.status === 'blocked'
      ? 'Blocked by Tollgate. Do not retry this payment or reword it; tell the user what happened.'
      : r.status === 'pending'
        ? 'Waiting for the owner to approve. Do not retry; check this request id later.'
        : r.status === 'executed'
          ? 'Approved and sent to the PayPal sandbox.'
          : r.status === 'rejected'
            ? 'The owner rejected this payment. Do not retry.'
            : r.status === 'failed'
              ? 'Approved, but PayPal returned an error.'
              : '';
  return {
    id: r.id,
    status: r.status,
    decision: r.decision,
    riskScore: r.risk?.score,
    riskLevel: r.risk?.level,
    reasons: (r.reasons || []).map((x) => x.message),
    message,
    paypal: r.paypal
      ? { id: r.paypal.id, status: r.paypal.status, approveUrl: r.paypal.approveUrl, simulated: r.paypal.simulated }
      : undefined,
    error: r.error,
  };
}

/** The webhook URL is a secret (Slack/Discord URLs carry a token), so public responses only show where it points. */
export function publicPolicy(p) {
  let shown = '';
  if (p.webhookUrl) {
    try {
      shown = `${new URL(p.webhookUrl).origin}/\u2026`;
    } catch {
      shown = 'set';
    }
  }
  return { ...p, webhookUrl: shown, webhookSet: Boolean(p.webhookUrl) };
}

export function createApp({ config, store, paypal, risk, guard, alerts = null, agents = createAgentRegistry(store) }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const isAdmin = (req) => {
    if (!config.adminToken) return true;
    return crypto.timingSafeEqual(digest(req.get('x-admin-token') || ''), digest(config.adminToken));
  };
  const requireAdmin = (req, res, next) =>
    isAdmin(req) ? next() : res.status(401).json({ error: 'Admin token required.' });

  const meta = () => ({
    paypalMode: paypal.simulated ? 'simulation' : 'sandbox',
    aiReview: risk.aiEnabled,
    adminRequired: Boolean(config.adminToken),
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, ...meta() }));

  // ---- Read endpoints (dashboard + agents) ----
  app.get('/api/state', (_req, res) => {
    res.json({
      meta: meta(),
      policy: publicPolicy(store.getPolicy()),
      stats: store.stats(),
      spentToday: store.spentToday(),
      records: store.list().slice(0, 300),
    });
  });
  app.get('/api/policy', (_req, res) => {
    const p = store.getPolicy();
    res.json({ policy: publicPolicy(p), spentToday: store.spentToday(), remainingToday: Math.max(0, p.dailyBudget - store.spentToday()) });
  });
  app.get('/api/requests/:id', (req, res) => {
    const r = store.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Request not found.' });
    res.json(publicRecord(r));
  });
  app.get('/api/scenarios', (_req, res) => res.json({ scenarios: listScenarios() }));
  app.get('/api/presets', (_req, res) => res.json({ presets: PRESETS }));

  app.get('/api/agents', (_req, res) => {
    const list = agents.list().map((a) => ({
      ...a,
      spentToday: store.spentToday(new Date(), a.id),
    }));
    res.json({ agents: list });
  });
  app.get('/api/analytics', (_req, res) => res.json(computeAnalytics(store.list(), agents.list())));

  // ---- Agent entry point: every payment attempt goes through here ----
  // A valid key pins the request to that agent. Without a key, a request may not claim to be a
  // registered agent (that would let anyone spend that agent's budget), and may not be anonymous
  // at all when the owner switched on "require agent keys".
  const resolveAgent = (req, res, next) => {
    const header = req.get('authorization');
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (header) {
      const agent = agents.authenticate(header);
      if (!agent) return res.status(401).json({ error: 'Invalid agent key.' });
      req.agent = agent;
      if (body) body.agentId = agent.id;
      return next();
    }
    if (store.getPolicy().requireAgentKey) return res.status(401).json({ error: 'An agent key is required (Authorization: Bearer tg_...).' });
    if (body && typeof body.agentId === 'string' && store.getAgent(body.agentId.trim())) {
      return res.status(401).json({ error: 'That agent id is registered; send its key.' });
    }
    next();
  };

  app.post('/api/requests', resolveAgent, async (req, res, next) => {
    try {
      const out = await guard.submit(req.body, { agent: req.agent || null });
      if (!out.ok) return res.status(400).json({ errors: out.errors });
      res.json(publicRecord(out.record));
    } catch (err) {
      next(err);
    }
  });

  // ---- Owner actions (need ADMIN_TOKEN when one is configured) ----
  const decision = (approve) => async (req, res, next) => {
    try {
      const out = await guard.decide(req.params.id, approve, 'owner');
      if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
      res.json(publicRecord(out.record));
    } catch (err) {
      next(err);
    }
  };
  app.post('/api/requests/:id/approve', requireAdmin, decision(true));
  app.post('/api/requests/:id/reject', requireAdmin, decision(false));

  app.put('/api/policy', requireAdmin, async (req, res, next) => {
    try {
      const input = req.body && typeof req.body === 'object' ? { ...req.body } : req.body;
      // The form only ever sees a masked webhook URL; sending that back must not overwrite the real one.
      if (input && typeof input.webhookUrl === 'string' && input.webhookUrl.includes('\u2026')) delete input.webhookUrl;
      const out = await guard.updatePolicy(input);
      if (!out.ok) return res.status(400).json({ errors: out.errors });
      res.json({ policy: publicPolicy(out.policy) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/demo/:id', requireAdmin, async (req, res, next) => {
    try {
      const out = await runScenario(guard, req.params.id);
      if (!out) return res.status(404).json({ error: 'Unknown scenario.' });
      res.json({ scenario: out.scenario, result: out.result.ok ? publicRecord(out.result.record) : { errors: out.result.errors } });
    } catch (err) {
      next(err);
    }
  });

  // Kill switch: while paused, every payment is blocked, including approvals of requests already waiting.
  app.post('/api/pause', requireAdmin, async (req, res, next) => {
    try {
      if (typeof req.body?.paused !== 'boolean') return res.status(400).json({ errors: ['paused must be true or false'] });
      const out = await guard.updatePolicy({ paused: req.body.paused });
      if (!out.ok) return res.status(400).json({ errors: out.errors });
      res.json({ paused: out.policy.paused });
    } catch (err) {
      next(err);
    }
  });

  // ---- Agents (admin): create, limits, pause, rotate key, delete ----
  const agentReply = (res, out, code = 200) =>
    out.ok ? res.status(code).json({ agent: out.agent, key: out.key }) : res.status(out.status || 400).json({ errors: out.errors });
  app.post('/api/agents', requireAdmin, (req, res) => agentReply(res, agents.create(req.body || {}), 201));
  app.patch('/api/agents/:id', requireAdmin, (req, res) => agentReply(res, agents.update(req.params.id, req.body || {})));
  app.post('/api/agents/:id/rotate-key', requireAdmin, (req, res) => agentReply(res, agents.rotateKey(req.params.id)));
  app.delete('/api/agents/:id', requireAdmin, (req, res) => {
    const out = agents.remove(req.params.id);
    res.status(out.ok ? 200 : out.status).json(out.ok ? { ok: true } : { errors: out.errors });
  });

  // ---- Playground: try a payment against the live rules. Dry run by default (nothing logged or sent). ----
  app.post('/api/playground', requireAdmin, async (req, res, next) => {
    try {
      const { dryRun = true, ...raw } = req.body && typeof req.body === 'object' ? req.body : {};
      const agent = typeof raw.agentId === 'string' ? store.getAgent(raw.agentId.trim()) : null;
      if (dryRun !== false) {
        const out = await guard.preview(raw, { agent });
        if (!out.ok) return res.status(400).json({ errors: out.errors });
        return res.json({ dryRun: true, ...out.preview, reasons: out.preview.reasons.map(({ type, message }) => ({ type, message })) });
      }
      const out = await guard.submit(raw, { agent });
      if (!out.ok) return res.status(400).json({ errors: out.errors });
      res.json({ dryRun: false, ...publicRecord(out.record) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/export.csv', requireAdmin, (_req, res) => {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tollgate-audit.csv"' });
    res.send(recordsToCsv(store.list()));
  });

  app.post('/api/webhook/test', requireAdmin, async (_req, res, next) => {
    try {
      res.json(alerts ? await alerts.sendTest() : { ok: false, error: 'Alerts are not available.' });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/reset', requireAdmin, (_req, res) => {
    store.reset();
    res.json({ ok: true });
  });

  // ---- Static dashboard ----
  app.get('/vendor/ag-grid.js', (_req, res) => res.sendFile(agGridFile));
  app.use(express.static(publicDir, { extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
    console.error(err);
    res.status(500).json({ error: 'Internal error.' });
  });

  return app;
}
