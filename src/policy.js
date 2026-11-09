/**
 * Deterministic policy rules. These are the hard guarantees: no model can
 * talk its way past a limit, an allowlist or a budget.
 */

export const DEFAULT_POLICY = Object.freeze({
  currency: 'USD',
  perTransactionLimit: 100, // anything above is blocked
  approvalThreshold: 50, // anything above waits for a human
  dailyBudget: 250, // total executed spend per UTC day
  maxRequestsPerMinute: 6, // per agent
  payoutsEnabled: true,
  allowedMerchants: ['giftshop.example', 'bookstore.example', 'coffee.example'],
  allowedRecipients: ['team@tollgate.example'],
  paused: false, // kill switch: blocks every payment while true
  requireAgentKey: false, // when true, anonymous agents are refused
  webhookUrl: '', // optional https URL that receives held/blocked alerts
  alertOnHeld: true,
  alertOnBlocked: true,
});

/** One-click rule sets. They only change limits and the payout switch, never allowlists. */
export const PRESETS = Object.freeze({
  strict: {
    label: 'Strict',
    blurb: 'Small amounts only, payouts off, slow request rate.',
    values: { perTransactionLimit: 50, approvalThreshold: 20, dailyBudget: 100, maxRequestsPerMinute: 3, payoutsEnabled: false },
  },
  balanced: {
    label: 'Balanced',
    blurb: 'The default: ask a human above $50, block above $100.',
    values: { perTransactionLimit: 100, approvalThreshold: 50, dailyBudget: 250, maxRequestsPerMinute: 6, payoutsEnabled: true },
  },
  relaxed: {
    label: 'Relaxed',
    blurb: 'Higher limits for trusted agents. Risky requests still wait for you.',
    values: { perTransactionLimit: 250, approvalThreshold: 150, dailyBudget: 1000, maxRequestsPerMinute: 20, payoutsEnabled: true },
  },
});

/** Webhooks must be https and must not point at this machine or a private network. */
export function validateWebhookUrl(raw) {
  if (raw === '' || raw === null) return { ok: true, url: '' };
  if (typeof raw !== 'string' || raw.length > 500) return { ok: false, error: 'webhookUrl must be a URL of at most 500 characters' };
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: 'webhookUrl is not a valid URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'webhookUrl must start with https://' };
  if (u.username || u.password) return { ok: false, error: 'webhookUrl must not contain a username or password' };
  const host = u.hostname.toLowerCase();
  const privateHost =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.startsWith('[') ||
    !host.includes('.') ||
    /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  if (privateHost) return { ok: false, error: 'webhookUrl must point to a public host' };
  return { ok: true, url: u.toString() };
}

const ACTIONS = ['order', 'payout'];

function cleanList(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const v = item.trim().toLowerCase();
    if (v && v.length <= 254 && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 200);
}

/** Validate and normalise a policy object (partial updates are merged onto `base`). */
export function validatePolicy(input, base = DEFAULT_POLICY) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['policy must be an object'] };
  }
  const next = { ...base };

  for (const key of ['perTransactionLimit', 'approvalThreshold', 'dailyBudget']) {
    if (input[key] === undefined) continue;
    const n = Number(input[key]);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) errors.push(`${key} must be a number between 0 and 1000000`);
    else next[key] = Math.round(n * 100) / 100;
  }
  if (input.maxRequestsPerMinute !== undefined) {
    const n = Number(input.maxRequestsPerMinute);
    if (!Number.isInteger(n) || n < 1 || n > 1000) errors.push('maxRequestsPerMinute must be an integer from 1 to 1000');
    else next.maxRequestsPerMinute = n;
  }
  if (input.payoutsEnabled !== undefined) {
    if (typeof input.payoutsEnabled !== 'boolean') errors.push('payoutsEnabled must be true or false');
    else next.payoutsEnabled = input.payoutsEnabled;
  }
  for (const key of ['paused', 'requireAgentKey', 'alertOnHeld', 'alertOnBlocked']) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') errors.push(`${key} must be true or false`);
    else next[key] = input[key];
  }
  if (input.webhookUrl !== undefined) {
    const w = validateWebhookUrl(input.webhookUrl);
    if (!w.ok) errors.push(w.error);
    else next.webhookUrl = w.url;
  }
  if (input.currency !== undefined) {
    if (typeof input.currency !== 'string' || !/^[A-Za-z]{3}$/.test(input.currency)) errors.push('currency must be a 3-letter code');
    else next.currency = input.currency.toUpperCase();
  }
  for (const key of ['allowedMerchants', 'allowedRecipients']) {
    if (input[key] === undefined) continue;
    const list = cleanList(input[key]);
    if (!list) errors.push(`${key} must be a list of strings`);
    else next[key] = list;
  }
  if (next.approvalThreshold > next.perTransactionLimit) {
    errors.push('approvalThreshold cannot be higher than perTransactionLimit');
  }
  return errors.length ? { ok: false, errors } : { ok: true, policy: next };
}

const MAX_TEXT = { description: 500, userIntent: 500, context: 4000 };

/** Validate and normalise an incoming agent request. */
export function normalizeRequest(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['request body must be a JSON object'] };
  }
  const action = typeof raw.action === 'string' ? raw.action.toLowerCase() : '';
  if (!ACTIONS.includes(action)) errors.push(`action must be one of: ${ACTIONS.join(', ')}`);

  const amount = Number(raw.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    errors.push('amount must be a positive number');
  }

  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const request = {
    agentId: str(raw.agentId, 64) || 'agent',
    action,
    amount: Math.round(amount * 100) / 100,
    currency: (str(raw.currency, 3) || 'USD').toUpperCase(),
    merchant: str(raw.merchant, 254).toLowerCase(),
    recipient: str(raw.recipient, 254).toLowerCase(),
    description: str(raw.description, MAX_TEXT.description),
    userIntent: str(raw.userIntent, MAX_TEXT.userIntent),
    context: str(raw.context, MAX_TEXT.context),
  };
  if (action === 'order' && !request.merchant) errors.push('merchant is required for orders');
  if (action === 'payout' && !request.recipient) errors.push('recipient is required for payouts');
  return errors.length ? { ok: false, errors } : { ok: true, request };
}

/**
 * Apply the rules.
 * - violations: hard stops (request is blocked)
 * - flags: soft stops (request waits for human approval)
 */
export function checkPolicy({ request, policy, spentToday = 0, recentCount = 0, agent = null, agentSpentToday = 0 }) {
  const violations = [];
  const flags = [];
  const add = (list, code, message) => list.push({ code, message });

  // Kill switches come first. A registered agent's own limits can only make things stricter.
  if (policy.paused) add(violations, 'PAUSED', 'All payments are paused by the owner (kill switch).');
  if (agent?.paused) add(violations, 'AGENT_PAUSED', `Agent "${agent.name}" is paused by the owner.`);

  if (request.currency !== policy.currency) {
    add(violations, 'CURRENCY', `Only ${policy.currency} is allowed (request used ${request.currency}).`);
  }
  const agentCap = agent?.limits?.perTransactionLimit;
  if (request.amount > policy.perTransactionLimit) {
    add(violations, 'OVER_LIMIT', `Amount ${request.amount} is above the per-transaction limit of ${policy.perTransactionLimit}.`);
  } else if (agentCap != null && request.amount > agentCap) {
    add(violations, 'AGENT_OVER_LIMIT', `Amount ${request.amount} is above this agent's limit of ${agentCap} per payment.`);
  }
  if (spentToday + request.amount > policy.dailyBudget) {
    add(
      violations,
      'OVER_BUDGET',
      `This would bring today's spend to ${(spentToday + request.amount).toFixed(2)}, above the daily budget of ${policy.dailyBudget}.`,
    );
  }
  const agentBudget = agent?.limits?.dailyBudget;
  if (agentBudget != null && agentSpentToday + request.amount > agentBudget) {
    add(
      violations,
      'AGENT_OVER_BUDGET',
      `This would bring this agent's spend today to ${(agentSpentToday + request.amount).toFixed(2)}, above its daily budget of ${agentBudget}.`,
    );
  }
  if (recentCount >= policy.maxRequestsPerMinute) {
    add(violations, 'RATE_LIMIT', `Too many requests: limit is ${policy.maxRequestsPerMinute} per minute per agent.`);
  }

  if (request.action === 'order') {
    if (!policy.allowedMerchants.includes(request.merchant)) {
      add(violations, 'UNKNOWN_MERCHANT', `Merchant "${request.merchant}" is not on the allowlist.`);
    }
  } else if (request.action === 'payout') {
    if (!policy.payoutsEnabled) {
      add(violations, 'PAYOUTS_DISABLED', 'Payouts are switched off in the policy.');
    }
    if (!policy.allowedRecipients.includes(request.recipient)) {
      add(violations, 'UNKNOWN_RECIPIENT', `Recipient "${request.recipient}" is not on the allowlist.`);
    }
    add(flags, 'PAYOUT_APPROVAL', 'Payouts always need human approval.');
  }

  if (request.amount > policy.approvalThreshold) {
    add(flags, 'APPROVAL_THRESHOLD', `Amount ${request.amount} is above the auto-approve threshold of ${policy.approvalThreshold}.`);
  }
  return { violations, flags };
}
