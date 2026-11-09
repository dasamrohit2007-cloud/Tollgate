import { randomUUID } from 'node:crypto';
import { checkPolicy, normalizeRequest, validatePolicy } from './policy.js';

/**
 * The guard: every agent payment request goes through here.
 *
 *   request -> validate -> policy rules -> AI risk check -> decision
 *   decision = blocked | pending (human approval) | executed
 *
 * Money only moves in `execute`, which runs either for a clean request or
 * after a human approves a pending one.
 */
export function createGuard({ store, paypal, risk, alerts = null, now = () => new Date() }) {
  // Serialise decisions so two parallel requests cannot both slip under the budget.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  async function execute(record) {
    const { request } = record;
    try {
      const result =
        request.action === 'order'
          ? await paypal.createOrder({
              requestId: record.id,
              amount: request.amount,
              currency: request.currency,
              description: request.description,
              merchant: request.merchant,
            })
          : await paypal.createPayout({
              requestId: record.id,
              amount: request.amount,
              currency: request.currency,
              recipient: request.recipient,
              note: request.description,
            });
      return store.update(record.id, {
        status: 'executed',
        executedAt: now().toISOString(),
        paypal: result,
      });
    } catch (err) {
      return store.update(record.id, { status: 'failed', error: err.message });
    }
  }

  /** Runs the whole pipeline without touching the log or PayPal. Used by submit() and by the playground preview. */
  async function evaluate(raw, agent = null) {
    const parsed = normalizeRequest(raw);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };

    const { request } = parsed;
    const policy = store.getPolicy();

    const { violations, flags } = checkPolicy({
      request,
      policy,
      spentToday: store.spentToday(now()) + store.reservedToday(now()),
      recentCount: store.recentCount(request.agentId, 60_000, now().getTime()),
      agent,
      agentSpentToday: agent ? store.spentToday(now(), agent.id) + store.reservedToday(now(), agent.id) : 0,
    });
    const assessment = await risk.assess(request, policy);

    const reasons = [
      ...violations.map((v) => ({ type: 'policy', code: v.code, message: v.message })),
      ...flags.map((f) => ({ type: 'approval', code: f.code, message: f.message })),
      ...assessment.reasons.map((m) => ({ type: 'risk', code: 'RISK', message: m })),
    ];

    // When the risk check is alarmed, lead with its reasons (e.g. the injection text) so the owner sees why first.
    if (assessment.score >= 70) reasons.sort((a, b) => (b.type === 'risk') - (a.type === 'risk'));

    let status;
    if (violations.length) status = 'blocked';
    else if (assessment.score >= 70) {
      status = 'blocked';
      reasons.unshift({ type: 'risk', code: 'HIGH_RISK', message: `Risk score ${assessment.score}/100 is too high to allow.` });
    } else if (flags.length || assessment.score >= 40) {
      status = 'pending';
      if (!flags.length) {
        reasons.unshift({ type: 'approval', code: 'MEDIUM_RISK', message: `Risk score ${assessment.score}/100 needs a human decision.` });
      }
    } else status = 'executed'; // placeholder, replaced after execute()

    return { ok: true, request, status, assessment, reasons };
  }

  function alert(record) {
    if (!alerts || !record || (record.status !== 'pending' && record.status !== 'blocked')) return;
    Promise.resolve(alerts.notify(record)).catch(() => {});
  }

  function submit(raw, { agent = null } = {}) {
    return serial(async () => {
      const ev = await evaluate(raw, agent);
      if (!ev.ok) return ev;
      const { request, status, assessment, reasons } = ev;

      const record = store.add({
        id: randomUUID(),
        createdAt: now().toISOString(),
        request,
        status: status === 'executed' ? 'approved' : status,
        decision: status === 'executed' ? 'allow' : status === 'blocked' ? 'block' : 'ask',
        risk: assessment,
        reasons,
      });
      if (agent) store.updateAgent(agent.id, { lastUsedAt: now().toISOString() });

      const final = status === 'executed' ? await execute(record) : record;
      alert(final);
      return { ok: true, record: final };
    });
  }

  /** Dry run: what would Tollgate do? Nothing is logged, nothing is sent. */
  async function preview(raw, { agent = null } = {}) {
    const ev = await evaluate(raw, agent);
    if (!ev.ok) return ev;
    return {
      ok: true,
      preview: {
        status: ev.status === 'executed' ? 'allowed' : ev.status,
        riskScore: ev.assessment.score,
        riskLevel: ev.assessment.level,
        riskSource: ev.assessment.source,
        reasons: ev.reasons,
      },
    };
  }

  function decide(id, approve, reviewer = 'owner') {
    return serial(async () => {
      const record = store.get(id);
      if (!record) return { ok: false, status: 404, error: 'Request not found.' };
      if (record.status !== 'pending') {
        return { ok: false, status: 409, error: `Request is already ${record.status}.` };
      }
      if (!approve) {
        const updated = store.update(id, { status: 'rejected', decidedAt: now().toISOString(), decidedBy: reviewer });
        return { ok: true, record: updated };
      }
      // Re-check hard rules at approval time: the policy, the kill switch or the agent may have changed since the request.
      const policy = store.getPolicy();
      const agent = store.getAgent(record.request.agentId);
      const { violations } = checkPolicy({
        request: record.request,
        policy,
        spentToday: store.spentToday(now()),
        recentCount: 0,
        agent,
        agentSpentToday: agent ? store.spentToday(now(), agent.id) : 0,
      });
      if (violations.length) {
        const updated = store.update(id, {
          status: 'blocked',
          decision: 'block',
          decidedAt: now().toISOString(),
          decidedBy: 'policy',
          reasons: [
            ...violations.map((v) => ({ type: 'policy', code: v.code, message: `${v.message} (re-checked at approval)` })),
            ...record.reasons,
          ],
        });
        return { ok: true, record: updated };
      }
      store.update(id, { decidedAt: now().toISOString(), decidedBy: reviewer, decision: 'allow-by-human' });
      const executed = await execute(store.get(id));
      return { ok: true, record: executed };
    });
  }

  function updatePolicy(input) {
    return serial(async () => {
      const v = validatePolicy(input, store.getPolicy());
      if (!v.ok) return { ok: false, errors: v.errors };
      store.setPolicy(v.policy);
      return { ok: true, policy: v.policy };
    });
  }

  return { submit, preview, decide, updatePolicy };
}
