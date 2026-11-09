// Shared helpers for every Tollgate page. All text that comes from agents or web pages is
// inserted with textContent only (never innerHTML): that text is what an attacker controls.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

export function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
}

// SVG helper (same idea as h, but in the SVG namespace)
export function s(tag, props = {}, ...kids) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(props)) if (v != null && v !== false) node.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
}

export const LABEL = { executed: 'Sent', blocked: 'Blocked', pending: 'Waiting', rejected: 'Rejected', failed: 'Failed', allowed: 'Allowed' };

export const VERDICT = {
  executed: { cls: 'allow', icon: '✓', title: 'Allowed', final: ['res-allow', 'Allowed', 'sent to PayPal'] },
  allowed: { cls: 'allow', icon: '✓', title: 'Would be allowed', final: ['res-allow', 'Allowed', 'would be sent'] },
  pending: { cls: 'ask', icon: '!', title: 'Held for your approval', final: ['res-ask', 'Held', 'waiting for you'] },
  blocked: { cls: 'block', icon: '✕', title: 'Blocked', final: ['res-block', 'Blocked', 'nothing was sent'] },
  rejected: { cls: 'block', icon: '✕', title: 'Rejected by you', final: ['res-block', 'Rejected', 'you said no'] },
  failed: { cls: 'block', icon: '✕', title: 'PayPal returned an error', final: ['res-block', 'Failed', 'PayPal error'] },
};

// ---------- token + api ----------
export const tokenStore = {
  get() {
    try {
      return sessionStorage.getItem('tg_token') || '';
    } catch {
      return '';
    }
  },
  set(v) {
    try {
      sessionStorage.setItem('tg_token', v);
    } catch {
      /* storage unavailable: the token just is not remembered */
    }
  },
};

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  const token = tokenStore.get();
  if (token) headers['x-admin-token'] = token;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || (data.errors || []).join(' ') || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const explain = (err) => (err.status === 401 ? 'Enter the admin token (top right) to do that.' : err.message);

// ---------- money ----------
let money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const setCurrency = (c) => {
  try {
    money = new Intl.NumberFormat('en-US', { style: 'currency', currency: c || 'USD' });
  } catch {
    /* keep USD */
  }
};
export const fmt = (n) => money.format(Number(n) || 0);
export const timeAgo = (iso) => {
  if (!iso) return 'never';
  const sec = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  return `${Math.floor(sec / 86400)} d ago`;
};

// ---------- toast / verdict / count-up ----------
export function toast(message) {
  let t = $('#toast');
  if (!t) {
    t = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(t);
  }
  t.hidden = true;
  void t.offsetWidth; // restart the entrance animation
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

export function countTo(el, to, format = (n) => String(Math.round(n))) {
  const from = el._v ?? 0;
  el._v = to;
  cancelAnimationFrame(el._raf);
  if (reduceMotion || from === to) {
    el.textContent = format(to);
    return;
  }
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / 750);
    el.textContent = format(from + (to - from) * (1 - Math.pow(1 - t, 3)));
    if (t < 1) el._raf = requestAnimationFrame(tick);
  };
  el._raf = requestAnimationFrame(tick);
}

let verdictTimer;
export function showVerdict(r) {
  let v = $('#verdict');
  if (!v) {
    v = h('div', { id: 'verdict', class: 'verdict', role: 'status', 'aria-live': 'assertive' }, h('span', { class: 'v-icon', id: 'v-icon' }), h('div', { class: 'v-text' }, h('b', { id: 'v-title' }), h('span', { id: 'v-sub' })));
    document.body.append(v);
  }
  const info = VERDICT[r.status] || VERDICT.blocked;
  v.hidden = true;
  void v.offsetWidth;
  v.className = `verdict ${info.cls}`;
  $('#v-icon').textContent = info.icon;
  $('#v-title').textContent = info.title;
  const reason = typeof r.reasons?.[0] === 'string' ? r.reasons[0] : r.reasons?.[0]?.message;
  $('#v-sub').textContent = r.status === 'executed' && r.paypal ? `PayPal ${r.paypal.simulated ? '(simulated) ' : ''}${r.paypal.id}` : reason || r.message || '';
  v.hidden = false;
  clearTimeout(verdictTimer);
  verdictTimer = setTimeout(() => {
    v.classList.add('out');
    setTimeout(() => (v.hidden = true), 300);
  }, 3400);
}

export function reasonList(reasons) {
  return h(
    'ul',
    { class: 'reasons' },
    (reasons || []).map((r, i) => {
      const item = typeof r === 'string' ? { type: 'risk', message: r } : r;
      const li = h('li', {}, h('span', { class: `tag tag-${item.type}`, text: item.type }), h('span', { text: item.message }));
      li.style.setProperty('--i', String(i));
      return li;
    }),
  );
}

// ---------- shell: header, nav, kill switch ----------
export const PAGES = [
  ['dashboard', 'Dashboard'],
  ['activity', 'Activity'],
  ['playground', 'Playground'],
  ['agents', 'Agents'],
  ['analytics', 'Analytics'],
  ['rules', 'Rules'],
  ['docs', 'Docs'],
];

const shieldSvg = () => {
  const svg = s('svg', { viewBox: '0 0 24 24', width: 28, height: 28, 'aria-hidden': 'true' });
  svg.append(
    s('path', { d: 'M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linejoin': 'round' }),
    s('path', { d: 'm8.5 12 2.5 2.5 4.5-5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
  );
  return svg;
};
export const brandMark = shieldSvg;

export const shell = { meta: null, policy: null };

/** Builds the header for an app page and returns the current meta/policy. */
export async function mountShell(active) {
  const bar = h('div', { class: 'progress', 'aria-hidden': 'true' });
  const live = h('span', { class: 'live', id: 'live-pill' }, h('i'), h('span', { id: 'live-text', text: 'Guarding' }));
  const pause = h('button', { class: 'pause-btn', id: 'pause-btn', type: 'button', text: 'Pause all payments' });
  const tokenInput = h('input', { id: 'token', type: 'password', autocomplete: 'off', placeholder: 'required to approve' });
  tokenInput.value = tokenStore.get();
  tokenInput.addEventListener('input', (e) => tokenStore.set(e.target.value));
  const tokenWrap = h('label', { class: 'token', id: 'token-wrap', hidden: true }, h('span', { text: 'Admin token' }), tokenInput);

  const nav = h(
    'nav',
    { class: 'nav', 'aria-label': 'Pages' },
    PAGES.map(([id, label]) => h('a', { href: `/${id}`, class: id === active ? 'on' : '', 'aria-current': id === active ? 'page' : false, text: label })),
  );
  const header = h(
    'header',
    { class: 'top' },
    h('a', { class: 'brand', href: '/', title: 'Back to the home page' }, h('span', { class: 'shield' }, shieldSvg()), h('div', {}, h('h1', { text: 'Tollgate' }), h('p', { text: 'Safety layer for AI agent payments' }))),
    nav,
    h('div', { class: 'chips' }, live, h('span', { class: 'chip', id: 'chip-paypal', text: 'PayPal: …' }), h('span', { class: 'chip', id: 'chip-ai', text: 'AI review: …' }), pause, tokenWrap),
  );
  const banner = h('div', { class: 'paused-banner', id: 'paused-banner', hidden: true, role: 'alert' }, h('b', { text: 'Kill switch is on.' }), h('span', { text: ' Every payment is being blocked until you resume.' }));
  document.body.prepend(bar, header, banner);

  pause.addEventListener('click', async () => {
    const next = !shell.policy?.paused;
    pause.disabled = true;
    try {
      await api('/api/pause', { method: 'POST', body: { paused: next } });
      toast(next ? 'All payments are paused.' : 'Payments resumed.');
      await refreshShell();
    } catch (err) {
      toast(explain(err));
    } finally {
      pause.disabled = false;
    }
  });
  await refreshShell();
  return shell;
}

export async function refreshShell() {
  const health = await fetch('/api/health').then((r) => r.json()).catch(() => null);
  const pol = await fetch('/api/policy').then((r) => r.json()).catch(() => null);
  if (!health || !pol) return shell;
  shell.meta = health;
  shell.policy = pol.policy;
  setCurrency(pol.policy.currency);
  const paused = Boolean(pol.policy.paused);
  $('#chip-paypal').textContent = health.paypalMode === 'sandbox' ? 'PayPal: sandbox API' : 'PayPal: simulation';
  $('#chip-ai').textContent = health.aiReview ? 'AI review: on' : 'AI review: rules only';
  $('#token-wrap').hidden = !health.adminRequired;
  $('#live-pill').classList.toggle('paused', paused);
  $('#live-text').textContent = paused ? 'Paused' : 'Guarding';
  $('#pause-btn').textContent = paused ? 'Resume payments' : 'Pause all payments';
  $('#pause-btn').classList.toggle('on', paused);
  $('#paused-banner').hidden = !paused;
  document.body.classList.toggle('is-paused', paused);
  return shell;
}

/** Calls fn now and then every `ms` while the tab is visible. */
export function poll(fn, ms = 2500) {
  fn();
  setInterval(() => {
    if (!document.hidden) fn();
  }, ms);
}

export async function download(path, filename) {
  const res = await api(path, { raw: true });
  const blob = await res.blob();
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const emptyNote = (text) => h('p', { class: 'empty', text });
