/**
 * CSV export of the audit log. Cells that start with = + - @ are prefixed with an apostrophe
 * so that opening the file in Excel or Sheets can never run an attacker's formula
 * (agent text and page text are untrusted).
 */
function cell(value) {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const COLUMNS = ['time', 'id', 'agent', 'action', 'to', 'amount', 'currency', 'decision', 'risk_score', 'reasons', 'description', 'user_intent', 'paypal_id', 'decided_by'];

export function recordsToCsv(records) {
  const rows = records.map((r) => [
    r.createdAt,
    r.id,
    r.request.agentId,
    r.request.action,
    r.request.merchant || r.request.recipient,
    r.request.amount,
    r.request.currency,
    r.status,
    r.risk?.score ?? '',
    (r.reasons || []).map((x) => x.message).join(' | '),
    r.request.description,
    r.request.userIntent,
    r.paypal?.id || '',
    r.decidedBy || '',
  ]);
  return [COLUMNS, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
