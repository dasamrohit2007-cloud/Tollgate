import { $, $$, h, sleep, reduceMotion, api, fmt, setCurrency, toast, explain, countTo, showVerdict, reasonList, mountShell, poll, VERDICT, LABEL } from './common.js';

const ATTACKS = new Set(['injection-payout', 'gift-card-scam']);
const app = { data: null, approvalsSig: null, recentSig: null, running: false };

await mountShell('dashboard');

const nodes = $$('#pipeline .node');
const links = $$('#pipeline .link');
const resetNodes = () => nodes.forEach((n) => (n.className = n.classList.contains('node-final') ? 'node node-final' : 'node'));

function setFinal(status) {
  const box = $('#node-final');
  box.className = 'node node-final';
  if (!status) {
    $('#final-title').textContent = 'Decision';
    $('#final-sub').textContent = 'allow · ask · block';
    return;
  }
  const [cls, title, sub] = (VERDICT[status] || VERDICT.blocked).final;
  void box.offsetWidth;
  box.classList.add(cls);
  $('#final-title').textContent = title;
  $('#final-sub').textContent = sub;
}

async function playPipeline() {
  resetNodes();
  setFinal(null);
  for (let i = 0; i < 3; i += 1) {
    nodes[i].classList.add('active');
    await sleep(reduceMotion ? 0 : 330);
    nodes[i].classList.remove('active');
    nodes[i].classList.add('done');
    links[i].classList.remove('flow');
    void links[i].offsetWidth;
    links[i].classList.add('flow');
  }
}

function renderStats() {
  const { stats, policy, spentToday } = app.data;
  countTo($('#s-exec'), stats.executedAmount, fmt);
  $('#s-exec-n').textContent = `${stats.executed} payment${stats.executed === 1 ? '' : 's'}`;
  countTo($('#s-block'), stats.blockedAmount, fmt);
  $('#s-block-n').textContent = `${stats.blocked} blocked`;
  countTo($('#s-pend'), stats.pending);
  countTo($('#s-left'), Math.max(0, policy.dailyBudget - spentToday), fmt);
  $('#s-left-of').textContent = `of ${fmt(policy.dailyBudget)} per day`;
}

function renderApprovals() {
  const pending = app.data.records.filter((r) => r.status === 'pending');
  const sig = pending.map((r) => r.id).join(',');
  if (sig === app.approvalsSig) return;
  app.approvalsSig = sig;
  const box = $('#approvals');
  box.replaceChildren();
  if (!pending.length) {
    box.append(h('p', { class: 'empty', text: 'Nothing is waiting. Risky or large payments will appear here before any money moves.' }));
    return;
  }
  for (const r of pending) {
    const approve = h('button', { class: 'approve', text: 'Approve & send' });
    const reject = h('button', { class: 'reject', text: 'Reject' });
    const act = (kind) => async () => {
      approve.disabled = reject.disabled = true;
      try {
        const out = await api(`/api/requests/${encodeURIComponent(r.id)}/${kind}`, { method: 'POST' });
        showVerdict(out);
        setFinal(out.status);
      } catch (err) {
        toast(explain(err));
      } finally {
        approve.disabled = reject.disabled = false; // the card stays if the call failed, so allow a retry
      }
      refresh();
    };
    approve.addEventListener('click', act('approve'));
    reject.addEventListener('click', act('reject'));
    box.append(
      h('div', { class: 'approval' },
        h('div', { class: 'what' },
          h('div', {}, h('b', { text: fmt(r.request.amount) }), ` to ${r.request.merchant || r.request.recipient}`),
          h('div', { class: 'muted small', text: `${r.request.agentId} · ${r.request.description || ''}` }),
          reasonList(r.reasons.slice(0, 3)),
        ),
        h('div', { class: 'btns' }, approve, reject),
      ),
    );
  }
}

function renderRecent() {
  const recs = app.data.records.slice(0, 7);
  const sig = recs.map((r) => `${r.id}:${r.status}`).join(',');
  if (sig === app.recentSig) return;
  const first = app.recentSig === null;
  app.recentSig = sig;
  const box = $('#recent');
  box.classList.toggle('fresh', !first);
  box.replaceChildren();
  if (!recs.length) return box.append(h('p', { class: 'empty', text: 'No requests yet. Run a scenario to see the first decision.' }));
  for (const r of recs) {
    box.append(
      h('a', { href: '/activity' },
        h('span', { class: 't', text: new Date(r.createdAt).toLocaleTimeString([], { hour12: false }) }),
        h('span', { class: 'who', text: `${r.request.action} → ${r.request.merchant || r.request.recipient}` }),
        h('span', { class: 'amt', text: fmt(r.request.amount) }),
        h('span', { class: `badge badge-${r.status}`, text: LABEL[r.status] || r.status }),
      ),
    );
  }
}

async function refresh() {
  try {
    app.data = await api('/api/state');
  } catch (err) {
    toast(`Cannot reach the server: ${err.message}`);
    return;
  }
  setCurrency(app.data.policy.currency);
  renderStats();
  renderApprovals();
  renderRecent();
}

function setRunning(on) {
  app.running = on;
  document.body.classList.toggle('busy', on);
  for (const b of $$('.scenario, #run-all')) b.disabled = on;
}

async function runScenario(id) {
  const call = api(`/api/demo/${encodeURIComponent(id)}`, { method: 'POST' }).then((o) => o.result, (err) => ({ error: err }));
  await playPipeline();
  const r = await call;
  if (r.error) {
    toast(explain(r.error));
    return null;
  }
  setFinal(r.status);
  showVerdict(r);
  await refresh();
  return r;
}

const { scenarios } = await api('/api/scenarios');
for (const sc of scenarios) {
  $('#scenarios').append(
    h('button', { class: `scenario${ATTACKS.has(sc.id) ? ' attack' : ''}`, 'data-expect': sc.expect, title: sc.blurb, onclick: async () => {
      if (app.running) return;
      setRunning(true);
      try { await runScenario(sc.id); } finally { setRunning(false); }
    } }, h('b', { text: sc.title }), h('span', { text: sc.blurb })),
  );
}
$('#run-all').addEventListener('click', async () => {
  if (app.running) return;
  setRunning(true);
  try {
    for (const sc of scenarios) {
      if (!(await runScenario(sc.id))) break;
      await sleep(reduceMotion ? 0 : 1100);
    }
  } finally {
    setRunning(false);
  }
});
$('#reset').addEventListener('click', async () => {
  try {
    await api('/api/reset', { method: 'POST' });
    app.approvalsSig = app.recentSig = null;
    setFinal(null);
    resetNodes();
    toast('Log cleared and rules reset to defaults.');
    refresh();
  } catch (err) {
    toast(explain(err));
  }
});

poll(refresh, 2000);
