import { $, $$, h, api, fmt, setCurrency, toast, explain, reasonList, mountShell, poll, download, LABEL } from './common.js';

await mountShell('activity');
const app = { records: [], filter: 'all', query: '', selectedId: null, detailSig: '', seen: null, fresh: new Set() };

const gridApi = agGrid.createGrid($('#grid'), {
  theme: agGrid.themeQuartz.withPart(agGrid.colorSchemeDark).withParams({
    backgroundColor: '#0a0e14', foregroundColor: '#e8eef5', headerBackgroundColor: '#0f151d', headerTextColor: '#8794a6',
    borderColor: 'rgba(255,255,255,0.07)', accentColor: '#2cf5a8', rowHoverColor: 'rgba(44,245,168,0.07)',
    selectedRowBackgroundColor: 'rgba(44,245,168,0.13)', headerFontWeight: 600, wrapperBorderRadius: 10, fontFamily: 'inherit',
  }),
  getRowId: (p) => p.data.id,
  getRowClass: (p) => (app.fresh.has(p.data.id) ? `row-new-${p.data.status}` : undefined),
  rowSelection: { mode: 'singleRow', checkboxes: false, enableClickSelection: true },
  suppressCellFocus: true,
  overlayNoRowsTemplate: 'Nothing matches. Run a scenario on the Dashboard, or clear the filter.',
  defaultColDef: { sortable: true, resizable: true },
  columnDefs: [
    { headerName: 'Time', field: 'createdAt', width: 100, valueFormatter: (p) => new Date(p.value).toLocaleTimeString([], { hour12: false }), sort: 'desc' },
    { headerName: 'Agent', field: 'request.agentId', width: 130 },
    { headerName: 'Payment', valueGetter: (p) => `${p.data.request.action} → ${p.data.request.merchant || p.data.request.recipient}`, width: 215 },
    { headerName: 'Amount', field: 'request.amount', width: 100, type: 'rightAligned', valueFormatter: (p) => fmt(p.value) },
    { headerName: 'Decision', field: 'status', width: 110, cellRenderer: (p) => h('span', { class: `badge badge-${p.value}`, text: LABEL[p.value] || p.value }) },
    { headerName: 'Risk', field: 'risk.score', width: 75, type: 'rightAligned' },
    { headerName: 'Why', valueGetter: (p) => p.data.reasons?.[0]?.message || '', flex: 1, minWidth: 220 },
  ],
  onRowClicked: (e) => {
    app.selectedId = e.data.id;
    app.detailSig = '';
    renderDetail();
  },
});

const matches = (r) => {
  if (app.filter !== 'all' && r.status !== app.filter) return false;
  if (!app.query) return true;
  const hay = [r.request.agentId, r.request.merchant, r.request.recipient, r.request.description, ...(r.reasons || []).map((x) => x.message)].join(' ').toLowerCase();
  return hay.includes(app.query);
};

function renderGrid() {
  const rows = app.records.filter(matches);
  gridApi.setGridOption('rowData', rows);
  $('#count').textContent = `${rows.length} of ${app.records.length}`;
}

function renderDetail() {
  const r = app.records.find((x) => x.id === app.selectedId);
  if (!r) return;
  const sig = `${r.id}:${r.status}:${r.decidedAt || ''}`;
  if (sig === app.detailSig) return;
  app.detailSig = sig;
  const row = (k, v) => [h('dt', { text: k }), h('dd', {}, v)];
  const q = r.request;
  $('#detail').replaceChildren(
    h('dl', {},
      row('Decision', h('span', { class: `badge badge-${r.status}`, text: LABEL[r.status] || r.status })),
      row('Risk score', `${r.risk.score}/100 (${r.risk.level}) via ${r.risk.source}`),
      row('Agent', q.agentId),
      row('Action', `${q.action} of ${fmt(q.amount)} ${q.currency}`),
      row(q.action === 'order' ? 'Merchant' : 'Recipient', q.merchant || q.recipient),
      row('Description', q.description || '(none)'),
      row('What the user asked', q.userIntent || '(not provided)'),
      r.paypal ? row('PayPal result', `${r.paypal.id} (${r.paypal.status})${r.paypal.simulated ? ', simulated' : ''}`) : [],
      r.error ? row('Error', r.error) : [],
      r.decidedBy ? row('Decided by', r.decidedBy) : [],
    ),
    h('h3', { text: 'Why' }),
    reasonList(r.reasons),
    h('h3', { text: 'Text the agent read (untrusted)' }),
    h('pre', { class: 'read', text: q.context || '(nothing provided)' }),
  );
}

async function refresh() {
  try {
    const data = await api('/api/state');
    setCurrency(data.policy.currency);
    app.records = data.records;
  } catch (err) {
    toast(`Cannot reach the server: ${err.message}`);
    return;
  }
  const ids = app.records.map((r) => r.id);
  if (app.seen === null) app.seen = new Set(ids);
  else {
    const fresh = ids.filter((id) => !app.seen.has(id));
    fresh.forEach((id) => app.seen.add(id));
    if (fresh.length) {
      app.fresh = new Set(fresh);
      setTimeout(() => (app.fresh = new Set()), 2000);
    }
  }
  renderGrid();
  renderDetail();
}

$('#seg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  app.filter = b.dataset.f;
  $$('#seg button').forEach((x) => x.classList.toggle('on', x === b));
  renderGrid();
});
$('#q').addEventListener('input', (e) => {
  app.query = e.target.value.trim().toLowerCase();
  renderGrid();
});
$('#export').addEventListener('click', async () => {
  try {
    await download('/api/export.csv', 'tollgate-audit.csv');
  } catch (err) {
    toast(explain(err));
  }
});

poll(refresh, 2500);
