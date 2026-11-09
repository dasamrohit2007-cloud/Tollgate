import { $, h, s, api, fmt, setCurrency, toast, countTo, mountShell, poll, emptyNote } from './common.js';

await mountShell('analytics');
let sig = null;
const C = { good: '#2cf5a8', bad: '#ff5d6c', warn: '#ffb84d', info: '#58a6ff', grey: '#8794a6' };

function lineChart(series) {
  const W = 760, H = 240, L = 54, R = 14, T = 12, B = 26;
  if (series.length < 2) return emptyNote('Not enough activity for a chart yet. Run a few scenarios on the Dashboard.');
  const raw = Math.max(1, ...series.map((p) => Math.max(p.sent, p.stopped)));
  const mag = 10 ** Math.floor(Math.log10(raw));
  const max = ([1, 2, 4, 8, 10].find((m) => m * mag >= raw) || 10) * mag; // round the top of the axis to a tidy number
  const x = (i) => L + (i / (series.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - v / max) * (H - T - B);
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Cumulative money sent and stopped, by request' });
  for (let i = 0; i <= 4; i += 1) {
    const v = (max / 4) * i;
    svg.append(s('line', { class: 'gridline', x1: L, x2: W - R, y1: y(v), y2: y(v) }), s('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }, fmt(v).replace(/\.00$/, '')));
  }
  svg.append(s('text', { x: L, y: H - 6 }, '1'), s('text', { x: W - R, y: H - 6, 'text-anchor': 'end' }, `request ${series.length}`));
  for (const [key, color, cls] of [['stopped', C.bad, 'line-stop'], ['sent', C.good, 'line-sent']]) {
    const d = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
    const area = s('path', { d: `${d} L${x(series.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`, fill: color, opacity: 0.1 });
    const line = s('path', { d, class: cls, fill: 'none', 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    line.style.strokeDasharray = '2000';
    line.style.strokeDashoffset = '2000';
    line.style.transition = 'stroke-dashoffset 1s ease-out';
    requestAnimationFrame(() => requestAnimationFrame(() => (line.style.strokeDashoffset = '0')));
    svg.append(area, line);
  }
  return svg;
}

function donut(t) {
  const parts = [
    ['Sent', t.executed, C.good], ['Blocked', t.blocked, C.bad], ['Held', t.pending, C.warn], ['Rejected', t.rejected, C.grey], ['Failed', t.failed, C.info],
  ].filter((p) => p[1] > 0);
  const total = parts.reduce((n, p) => n + p[1], 0);
  if (!total) return [emptyNote('No decisions yet.')];
  const r = 62, c = 2 * Math.PI * r;
  const svg = s('svg', { viewBox: '0 0 170 170', role: 'img', 'aria-label': 'Share of decisions' });
  let offset = 0;
  for (const [, n, color] of parts) {
    const len = (n / total) * c;
    const seg = s('circle', { cx: 85, cy: 85, r, fill: 'none', stroke: color, 'stroke-width': 22, 'stroke-dasharray': `${Math.max(0, len - 2)} ${c}`, 'stroke-dashoffset': -offset, transform: 'rotate(-90 85 85)' });
    offset += len;
    svg.append(seg);
  }
  svg.append(s('text', { x: 85, y: 84, 'text-anchor': 'middle', style: 'font-size:26px;font-weight:700;fill:#e8eef5' }, String(total)), s('text', { x: 85, y: 102, 'text-anchor': 'middle' }, 'requests'));
  const legend = h('div', { class: 'legend' }, parts.map(([name, n, color]) => h('span', {}, h('i', { style: `background:${color}` }), `${name}: ${n} (${Math.round((n / total) * 100)}%)`)));
  return [svg, legend];
}

function riskBars(risk) {
  const max = Math.max(1, ...risk.map((b) => b.count));
  const colors = [C.good, C.good, C.warn, C.bad, C.bad];
  const W = 360, H = 180, base = 150, bw = 44, gap = (W - 5 * bw) / 6;
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'How many requests fell in each risk score range' });
  risk.forEach((b, i) => {
    const bh = (b.count / max) * (base - 24);
    const bx = gap + i * (bw + gap);
    const bar = s('rect', { x: bx, y: base - bh, width: bw, height: Math.max(bh, b.count ? 2 : 0), rx: 5, fill: colors[i] });
    bar.style.transformOrigin = `${bx + bw / 2}px ${base}px`;
    bar.style.animation = 'growY 0.8s cubic-bezier(.2,.8,.2,1) both';
    svg.append(bar, s('text', { x: bx + bw / 2, y: base - bh - 6, 'text-anchor': 'middle', style: 'fill:#e8eef5;font-weight:600' }, String(b.count)), s('text', { x: bx + bw / 2, y: base + 18, 'text-anchor': 'middle' }, b.range));
  });
  return svg;
}

function threats(list) {
  if (!list.length) return emptyNote('Nothing has been stopped or held yet.');
  const max = list[0].count;
  return list.map((t) => {
    const fill = h('i');
    fill.style.width = `${(t.count / max) * 100}%`;
    return h('div', { class: 'hbar' }, h('span', { text: t.label }), h('span', { class: 'bar' }, fill), h('b', { text: String(t.count) }));
  });
}

function agentTable(rows) {
  const t = $('#t-agents');
  t.replaceChildren(
    h('thead', {}, h('tr', {}, ['Agent', 'Requests', 'Sent', 'Blocked', 'Held', 'Money sent', 'Money stopped', 'Avg risk'].map((c, i) => h('th', { class: i ? 'num' : '', text: c })))),
    h('tbody', {}, rows.length ? rows.map((a) => h('tr', {}, h('td', { text: a.registered ? a.name : `${a.agentId} (unregistered)` }), ...[a.requests, a.executed, a.blocked, a.pending, fmt(a.sentAmount), fmt(a.stoppedAmount), a.avgRisk].map((v) => h('td', { class: 'num', text: String(v) })))) : [h('tr', {}, h('td', { colspan: 8 }, emptyNote('No agent activity yet.')))]),
  );
}

async function load() {
  let a;
  try {
    a = await api('/api/analytics');
    const pol = await api('/api/policy');
    setCurrency(pol.policy.currency);
  } catch (err) {
    toast(`Cannot reach the server: ${err.message}`);
    return;
  }
  const next = JSON.stringify(a);
  if (next === sig) return;
  sig = next;
  const t = a.totals;
  countTo($('#a-req'), t.requests);
  $('#a-req-s').textContent = `${t.executed} sent · ${t.blocked} blocked · ${t.pending} held`;
  countTo($('#a-sent'), t.sentAmount, fmt);
  $('#a-sent-n').textContent = `${t.executed} payment${t.executed === 1 ? '' : 's'}`;
  countTo($('#a-stop'), t.stoppedAmount, fmt);
  $('#a-stop-n').textContent = `${t.blocked + t.rejected} stopped`;
  countTo($('#a-held'), t.heldAmount, fmt);
  $('#a-held-n').textContent = `${t.pending} waiting`;
  $('#c-line').replaceChildren(lineChart(a.series));
  $('#c-donut').replaceChildren(...donut(t));
  $('#c-risk').replaceChildren(t.requests ? riskBars(a.risk) : emptyNote('No requests yet.'));
  $('#c-threats').replaceChildren(...[].concat(threats(a.threats)));
  agentTable(a.agents);
}

poll(load, 4000);
