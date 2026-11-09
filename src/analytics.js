/**
 * Numbers behind the Analytics page, computed from the audit log.
 */
const POLICY_LABELS = {
  OVER_LIMIT: 'Over the per-payment limit',
  OVER_BUDGET: 'Over the daily budget',
  UNKNOWN_MERCHANT: 'Unknown merchant',
  UNKNOWN_RECIPIENT: 'Unknown payout recipient',
  PAYOUTS_DISABLED: 'Payouts switched off',
  RATE_LIMIT: 'Too many requests',
  CURRENCY: 'Wrong currency',
  PAUSED: 'Paused by the kill switch',
  AGENT_PAUSED: 'Agent paused',
  AGENT_OVER_LIMIT: 'Over the agent’s limit',
  AGENT_OVER_BUDGET: 'Over the agent’s budget',
  APPROVAL_THRESHOLD: 'Above the auto-approve line',
  PAYOUT_APPROVAL: 'Payout needs approval',
};

// Risk reasons are plain sentences, so group them by what they are about.
const RISK_PATTERNS = [
  [/injection/i, 'Prompt injection'],
  [/above the .* the user mentioned/i, 'Above the user’s own budget'],
  [/not seem related/i, 'Does not match what the user asked'],
  [/urgency|pressure/i, 'Urgency or pressure'],
  [/hard-to-reverse/i, 'Gift cards, crypto or wires'],
  [/never approved|is new|not on the allowlist/i, 'New or unknown destination'],
];

export function threatLabel(reason) {
  if (reason.code && POLICY_LABELS[reason.code]) return POLICY_LABELS[reason.code];
  if (reason.type === 'risk' && reason.code === 'RISK') {
    for (const [re, label] of RISK_PATTERNS) if (re.test(reason.message)) return label;
    return 'Other risk signal';
  }
  return null; // summary reasons such as HIGH_RISK / MEDIUM_RISK are not threats on their own
}

const round2 = (n) => Math.round(n * 100) / 100;

export function computeAnalytics(recordsNewestFirst, agents = []) {
  const records = [...recordsNewestFirst].reverse(); // oldest first
  const totals = { requests: records.length, executed: 0, blocked: 0, pending: 0, rejected: 0, failed: 0, sentAmount: 0, stoppedAmount: 0, heldAmount: 0 };
  const byAgent = new Map();
  const threats = new Map();
  const risk = [0, 0, 0, 0, 0]; // 0-19, 20-39, 40-59, 60-79, 80-100
  const series = [];
  let sent = 0;
  let stopped = 0;

  for (const r of records) {
    const amt = r.request.amount;
    const a = byAgent.get(r.request.agentId) || { agentId: r.request.agentId, requests: 0, executed: 0, blocked: 0, pending: 0, sentAmount: 0, stoppedAmount: 0, riskTotal: 0 };
    a.requests += 1;
    a.riskTotal += r.risk?.score || 0;

    if (r.status === 'executed') {
      totals.executed += 1;
      totals.sentAmount += amt;
      sent += amt;
      a.executed += 1;
      a.sentAmount += amt;
    } else if (r.status === 'blocked') {
      totals.blocked += 1;
      totals.stoppedAmount += amt;
      stopped += amt;
      a.blocked += 1;
      a.stoppedAmount += amt;
    } else if (r.status === 'pending') {
      totals.pending += 1;
      totals.heldAmount += amt;
      a.pending += 1;
    } else if (r.status === 'rejected') {
      totals.rejected += 1;
      totals.stoppedAmount += amt;
      stopped += amt;
    } else if (r.status === 'failed') totals.failed += 1;
    byAgent.set(a.agentId, a);

    risk[Math.min(4, Math.floor((r.risk?.score || 0) / 20))] += 1;

    if (['blocked', 'pending', 'rejected'].includes(r.status)) {
      const seen = new Set();
      for (const reason of r.reasons || []) {
        const label = threatLabel(reason);
        if (label && !seen.has(label)) {
          seen.add(label);
          threats.set(label, (threats.get(label) || 0) + 1);
        }
      }
    }
    series.push({ n: series.length + 1, at: r.createdAt, sent: round2(sent), stopped: round2(stopped) });
  }

  const names = new Map(agents.map((a) => [a.id, a.name]));
  return {
    totals: { ...totals, sentAmount: round2(totals.sentAmount), stoppedAmount: round2(totals.stoppedAmount), heldAmount: round2(totals.heldAmount) },
    series: series.slice(-100),
    threats: [...threats.entries()].map(([label, count]) => ({ label, count })).sort((x, y) => y.count - x.count).slice(0, 8),
    risk: [
      { range: '0–19', count: risk[0] },
      { range: '20–39', count: risk[1] },
      { range: '40–59', count: risk[2] },
      { range: '60–79', count: risk[3] },
      { range: '80–100', count: risk[4] },
    ],
    agents: [...byAgent.values()]
      .map((a) => ({
        agentId: a.agentId,
        name: names.get(a.agentId) || a.agentId,
        registered: names.has(a.agentId),
        requests: a.requests,
        executed: a.executed,
        blocked: a.blocked,
        pending: a.pending,
        sentAmount: round2(a.sentAmount),
        stoppedAmount: round2(a.stoppedAmount),
        avgRisk: a.requests ? Math.round(a.riskTotal / a.requests) : 0,
      }))
      .sort((x, y) => y.requests - x.requests),
  };
}
