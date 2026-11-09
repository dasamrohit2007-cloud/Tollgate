/**
 * Webhook alerts. When a payment is held for approval or blocked, Tollgate can POST a short
 * JSON message to a URL the owner chose (Slack, Discord and Zapier style webhooks all work:
 * the body carries both a "text" and a "content" field).
 *
 * The message never includes the text the agent read, since that text may be attacker-controlled.
 * Alerts are best effort: a failing webhook never delays or breaks a payment decision.
 */
const money = (r) => `${r.request.amount.toFixed(2)} ${r.request.currency}`;
const target = (r) => r.request.merchant || r.request.recipient;

export function buildPayload(record, event) {
  const verb = event === 'tollgate.held' ? 'held for your approval' : event === 'tollgate.blocked' ? 'blocked' : 'test';
  const text = `Tollgate: ${money(record)} ${record.request.action} to ${target(record)} was ${verb}. ${record.reasons?.[0]?.message || ''}`.trim();
  return {
    event,
    text,
    content: text,
    record: {
      id: record.id,
      status: record.status,
      agentId: record.request.agentId,
      action: record.request.action,
      target: target(record),
      amount: record.request.amount,
      currency: record.request.currency,
      riskScore: record.risk?.score ?? 0,
      reasons: (record.reasons || []).slice(0, 3).map((x) => x.message),
    },
  };
}

export function createAlerter({ store, fetchImpl = globalThis.fetch, timeoutMs = 5000 }) {
  async function post(url, payload) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'manual', // never follow a redirect to somewhere unexpected
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { ok: res.status >= 200 && res.status < 300, status: res.status };
    } catch (err) {
      return { ok: false, error: err.name === 'TimeoutError' ? 'The webhook timed out.' : `Could not reach the webhook: ${err.message}` };
    }
  }

  return {
    /** Fire and forget. Returns the promise only so tests can await it. */
    notify(record) {
      const policy = store.getPolicy();
      if (!policy.webhookUrl) return Promise.resolve(null);
      const event =
        record.status === 'pending' && policy.alertOnHeld
          ? 'tollgate.held'
          : record.status === 'blocked' && policy.alertOnBlocked
            ? 'tollgate.blocked'
            : null;
      if (!event) return Promise.resolve(null);
      return post(policy.webhookUrl, buildPayload(record, event));
    },

    async sendTest() {
      const { webhookUrl } = store.getPolicy();
      if (!webhookUrl) return { ok: false, error: 'No webhook URL is set yet. Save one first.' };
      const sample = {
        id: 'test',
        status: 'pending',
        request: { agentId: 'test-agent', action: 'order', merchant: 'bookstore.example', amount: 75, currency: 'USD' },
        risk: { score: 0 },
        reasons: [{ message: 'This is a test alert from Tollgate.' }],
      };
      return post(webhookUrl, buildPayload(sample, 'tollgate.test'));
    },
  };
}
