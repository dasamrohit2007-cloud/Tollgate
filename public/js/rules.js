import { $, h, api, toast, explain, mountShell, refreshShell, shell } from './common.js';

await mountShell('rules');
const pf = $('#policy-form');
const af = $('#alert-form');
const lines = (t) => t.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

function fill(policy) {
  for (const k of ['perTransactionLimit', 'approvalThreshold', 'dailyBudget', 'maxRequestsPerMinute']) pf.elements[k].value = policy[k];
  pf.elements.payoutsEnabled.checked = policy.payoutsEnabled;
  pf.elements.requireAgentKey.checked = policy.requireAgentKey;
  pf.elements.allowedMerchants.value = policy.allowedMerchants.join('\n');
  pf.elements.allowedRecipients.value = policy.allowedRecipients.join('\n');
  af.elements.webhookUrl.value = policy.webhookUrl || ''; // masked; saving it back leaves the real URL alone
  af.elements.alertOnHeld.checked = policy.alertOnHeld;
  af.elements.alertOnBlocked.checked = policy.alertOnBlocked;
  const paused = Boolean(policy.paused);
  $('#kill-btn').textContent = paused ? 'Resume payments' : 'Pause all payments';
  $('#kill-btn').className = paused ? 'primary' : 'reject';
  $('#kill-state').textContent = paused ? 'Paused' : 'Running';
  $('#kill-state').className = `pill ${paused ? 'red' : 'green'}`;
}

const say = (el, text, kind) => {
  el.textContent = text;
  el.className = `msg wide ${kind}`;
};

async function save(body, msgEl, okText) {
  try {
    const { policy } = await api('/api/policy', { method: 'PUT', body });
    fill(policy);
    say(msgEl, okText, 'ok');
    refreshShell();
    return policy;
  } catch (err) {
    say(msgEl, explain(err), 'err');
    return null;
  }
}

pf.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = pf.elements;
  save({
    perTransactionLimit: Number(f.perTransactionLimit.value),
    approvalThreshold: Number(f.approvalThreshold.value),
    dailyBudget: Number(f.dailyBudget.value),
    maxRequestsPerMinute: Number(f.maxRequestsPerMinute.value),
    payoutsEnabled: f.payoutsEnabled.checked,
    requireAgentKey: f.requireAgentKey.checked,
    allowedMerchants: lines(f.allowedMerchants.value),
    allowedRecipients: lines(f.allowedRecipients.value),
  }, $('#policy-msg'), 'Saved. New requests use these rules.');
});

af.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = af.elements;
  save({ webhookUrl: f.webhookUrl.value.trim(), alertOnHeld: f.alertOnHeld.checked, alertOnBlocked: f.alertOnBlocked.checked }, $('#alert-msg'), 'Alert settings saved.');
});
$('#alert-clear').addEventListener('click', () => save({ webhookUrl: '' }, $('#alert-msg'), 'Webhook removed.'));
$('#alert-test').addEventListener('click', async () => {
  const msg = $('#alert-msg');
  try {
    const r = await api('/api/webhook/test', { method: 'POST' });
    say(msg, r.ok ? `Test alert delivered (HTTP ${r.status}).` : r.error || `The webhook answered HTTP ${r.status}.`, r.ok ? 'ok' : 'err');
  } catch (err) {
    say(msg, explain(err), 'err');
  }
});

$('#kill-btn').addEventListener('click', async () => {
  const next = !shell.policy?.paused;
  try {
    await api('/api/pause', { method: 'POST', body: { paused: next } });
    toast(next ? 'All payments are paused.' : 'Payments resumed.');
    await refreshShell();
    fill(shell.policy);
  } catch (err) {
    toast(explain(err));
  }
});

$('#reset').addEventListener('click', async () => {
  if (!confirm('Clear the audit log and reset all rules to defaults?')) return;
  try {
    await api('/api/reset', { method: 'POST' });
    toast('Log cleared and rules reset.');
    const { policy } = await api('/api/policy');
    fill(policy);
    refreshShell();
  } catch (err) {
    toast(explain(err));
  }
});

const { presets } = await api('/api/presets');
for (const [id, p] of Object.entries(presets)) {
  $('#presets').append(h('button', { type: 'button', title: p.blurb, 'data-preset': id, onclick: () => {
    const v = p.values;
    for (const k of ['perTransactionLimit', 'approvalThreshold', 'dailyBudget', 'maxRequestsPerMinute']) if (k in v) pf.elements[k].value = v[k];
    if ('payoutsEnabled' in v) pf.elements.payoutsEnabled.checked = v.payoutsEnabled;
    say($('#policy-msg'), `${p.label} filled in. Press Save rules to apply it.`, '');
  } }, h('b', { text: p.label }), ` · ${p.blurb}`));
}

const { policy } = await api('/api/policy');
fill(policy);
