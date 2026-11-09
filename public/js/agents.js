import { $, h, api, fmt, toast, explain, mountShell, poll, timeAgo, emptyNote } from './common.js';

await mountShell('agents');
let sig = null;
let busy = false;

function showKey(agent, key, verb) {
  const copy = h('button', { type: 'button', text: 'Copy key', onclick: async () => {
    try {
      await navigator.clipboard.writeText(key);
      toast('Key copied.');
    } catch {
      toast('Select the key and copy it by hand.');
    }
  } });
  const box = $('#keybox');
  box.replaceChildren(
    h('b', { text: `Key for ${agent.name} ${verb}` }),
    h('p', { class: 'small muted', text: 'Copy it now. Tollgate only stores a hash, so it cannot be shown again.' }),
    h('code', { text: key }),
    h('div', { class: 'row', style: 'margin-top:0' }, copy, h('button', { class: 'ghost', type: 'button', text: 'I saved it', onclick: () => (box.hidden = true) })),
  );
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

const num = (v) => (v === '' || v == null ? undefined : Number(v));

function card(a) {
  const perTx = h('input', { type: 'number', min: 0, step: 1, placeholder: 'global', value: a.limits.perTransactionLimit ?? '' });
  const daily = h('input', { type: 'number', min: 0, step: 1, placeholder: 'global', value: a.limits.dailyBudget ?? '' });
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (err) {
      toast(explain(err));
    }
    load(true);
  };
  const save = h('button', { type: 'button', text: 'Save limits', onclick: run(async () => {
    await api(`/api/agents/${encodeURIComponent(a.id)}`, { method: 'PATCH', body: { limits: { perTransactionLimit: num(perTx.value) ?? null, dailyBudget: num(daily.value) ?? null } } });
    toast('Limits saved.');
  }) });
  const pause = h('button', { type: 'button', class: a.paused ? '' : 'reject', text: a.paused ? 'Resume agent' : 'Pause agent', onclick: run(async () => {
    await api(`/api/agents/${encodeURIComponent(a.id)}`, { method: 'PATCH', body: { paused: !a.paused } });
  }) });
  const rotate = h('button', { type: 'button', class: 'ghost', text: 'Rotate key', onclick: run(async () => {
    if (!confirm(`Rotate the key for ${a.name}? The old key stops working immediately.`)) return;
    const out = await api(`/api/agents/${encodeURIComponent(a.id)}/rotate-key`, { method: 'POST' });
    showKey(out.agent, out.key, 'rotated');
  }) });
  const del = h('button', { type: 'button', class: 'ghost', text: 'Delete', onclick: run(async () => {
    if (!confirm(`Delete ${a.name}? Its key stops working. Past activity stays in the log.`)) return;
    await api(`/api/agents/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
    toast('Agent deleted.');
  }) });
  return h('section', { class: `panel agent${a.paused ? ' is-paused' : ''}` },
    h('div', { class: 'head' },
      h('div', {}, h('h3', { text: a.name }), h('code', { text: `${a.id} · key ${a.keyPrefix}` })),
      h('span', { class: `pill ${a.paused ? 'red' : 'green'}`, text: a.paused ? 'Paused' : 'Active' }),
    ),
    h('div', { class: 'kv' },
      h('div', {}, h('small', { text: 'Spent today' }), h('b', { text: fmt(a.spentToday) })),
      h('div', {}, h('small', { text: 'Last used' }), h('b', { text: timeAgo(a.lastUsedAt) })),
      h('div', {}, h('small', { text: 'Created' }), h('b', { text: new Date(a.createdAt).toLocaleDateString() })),
    ),
    h('div', { class: 'lim' },
      h('label', { class: 'field' }, 'Max per payment', perTx),
      h('label', { class: 'field' }, 'Daily budget', daily),
      save,
    ),
    h('div', { class: 'foot' }, pause, rotate, del),
  );
}

async function load(force = false) {
  if (busy) return;
  let agents;
  try {
    ({ agents } = await api('/api/agents'));
  } catch (err) {
    toast(`Cannot reach the server: ${err.message}`);
    return;
  }
  const s = JSON.stringify(agents.map((a) => [a.id, a.paused, a.limits, a.keyPrefix, Math.round(a.spentToday), a.lastUsedAt]));
  if (!force && s === sig) return;
  // Do not redraw while the owner is typing in a limit box.
  if (!force && document.activeElement?.closest('#agents')) return;
  sig = s;
  const box = $('#agents');
  box.replaceChildren();
  if (!agents.length) box.append(h('div', { class: 'panel' }, emptyNote('No agents yet. Create one above to get a key. Until then any agent can call Tollgate anonymously (change that on the Rules page).')));
  for (const a of agents) box.append(card(a));
}

$('#new-agent').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  busy = true;
  try {
    const out = await api('/api/agents', { method: 'POST', body: { name: f.name.value, limits: { perTransactionLimit: num(f.perTransactionLimit.value), dailyBudget: num(f.dailyBudget.value) } } });
    showKey(out.agent, out.key, 'created');
    e.target.reset();
  } catch (err) {
    toast(explain(err));
  } finally {
    busy = false;
  }
  load(true);
});

poll(load, 4000);
