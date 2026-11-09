import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, goodOrder } from './helpers.js';
import { PRESETS, validatePolicy, validateWebhookUrl, DEFAULT_POLICY } from '../src/policy.js';
import { recordsToCsv } from '../src/export.js';

const j = (url, path, method = 'GET', body, headers = {}) =>
  fetch(url + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})), res: r }));

test('kill switch blocks new payments and blocks approval of waiting ones', async () => {
  const s = await startServer();
  try {
    const held = (await j(s.url, '/api/requests', 'POST', goodOrder({ amount: 75 }))).data;
    assert.equal(held.status, 'pending');
    assert.equal((await j(s.url, '/api/pause', 'POST', { paused: true })).data.paused, true);
    const blocked = (await j(s.url, '/api/requests', 'POST', goodOrder())).data;
    assert.equal(blocked.status, 'blocked');
    const approve = (await j(s.url, `/api/requests/${held.id}/approve`, 'POST')).data;
    assert.equal(approve.status, 'blocked');
    await j(s.url, '/api/pause', 'POST', { paused: false });
    assert.equal((await j(s.url, '/api/requests', 'POST', goodOrder())).data.status, 'executed');
  } finally { await s.close(); }
});

test('pause requires admin token when one is set', async () => {
  const s = await startServer({ adminToken: 'secret' });
  try {
    assert.equal((await j(s.url, '/api/pause', 'POST', { paused: true })).status, 401);
    assert.equal((await j(s.url, '/api/pause', 'POST', { paused: true }, { 'x-admin-token': 'secret' })).status, 200);
  } finally { await s.close(); }
});

test('agent keys: shown once, hashed at rest, pin identity, reject bad keys and spoofing', async () => {
  const s = await startServer();
  try {
    const created = (await j(s.url, '/api/agents', 'POST', { name: 'Shopper Bot' })).data;
    assert.match(created.key, /^tg_/);
    assert.equal(created.agent.id, 'shopper-bot');
    const stored = s.store.getAgent('shopper-bot');
    assert.notEqual(stored.keyHash, created.key);
    assert.ok(!JSON.stringify(s.store.listAgents()).includes(created.key));
    assert.ok(!JSON.stringify((await j(s.url, '/api/agents')).data).includes(created.key));

    const auth = { authorization: `Bearer ${created.key}` };
    const ok = await j(s.url, '/api/requests', 'POST', goodOrder({ agentId: 'someone-else' }), auth);
    assert.equal(ok.data.status, 'executed');
    assert.equal(s.store.list()[0].request.agentId, 'shopper-bot');
    assert.ok(s.store.getAgent('shopper-bot').lastUsedAt);

    assert.equal((await j(s.url, '/api/requests', 'POST', goodOrder(), { authorization: 'Bearer tg_nope' })).status, 401);
    assert.equal((await j(s.url, '/api/requests', 'POST', goodOrder({ agentId: 'shopper-bot' }))).status, 401);

    const rotated = (await j(s.url, '/api/agents/shopper-bot/rotate-key', 'POST')).data;
    assert.equal((await j(s.url, '/api/requests', 'POST', goodOrder(), auth)).status, 401);
    assert.equal((await j(s.url, '/api/requests', 'POST', goodOrder(), { authorization: `Bearer ${rotated.key}` })).status, 200);
  } finally { await s.close(); }
});

test('requireAgentKey rejects anonymous requests', async () => {
  const s = await startServer();
  try {
    await j(s.url, '/api/policy', 'PUT', { requireAgentKey: true });
    assert.equal((await j(s.url, '/api/requests', 'POST', goodOrder())).status, 401);
  } finally { await s.close(); }
});

test('per-agent limits only tighten, and a paused agent is blocked', async () => {
  const s = await startServer();
  try {
    const a = (await j(s.url, '/api/agents', 'POST', { name: 'Tight', limits: { perTransactionLimit: 10, dailyBudget: 30 } })).data;
    const h = { authorization: `Bearer ${a.key}` };
    assert.equal((await j(s.url, '/api/requests', 'POST', goodOrder({ amount: 20 }), h)).data.status, 'blocked');
    assert.equal((await j(s.url, '/api/requests', 'POST', goodOrder({ amount: 9 }), h)).data.status, 'executed');
    // a loose agent limit cannot beat the global one
    const loose = (await j(s.url, '/api/agents', 'POST', { name: 'Loose', limits: { perTransactionLimit: 9999 } })).data;
    assert.equal((await j(s.url, '/api/requests', 'POST', goodOrder({ amount: 150 }), { authorization: `Bearer ${loose.key}` })).data.status, 'blocked');
    await j(s.url, `/api/agents/${a.agent.id}`, 'PATCH', { paused: true });
    assert.equal((await j(s.url, '/api/requests', 'POST', goodOrder({ amount: 5 }), h)).data.status, 'blocked');
    assert.equal((await j(s.url, `/api/agents/${a.agent.id}`, 'DELETE')).status, 200);
    assert.equal((await j(s.url, `/api/agents/${a.agent.id}`, 'DELETE')).status, 404);
  } finally { await s.close(); }
});

test('agent validation', async () => {
  const s = await startServer();
  try {
    assert.equal((await j(s.url, '/api/agents', 'POST', { name: '' })).status, 400);
    assert.equal((await j(s.url, '/api/agents', 'POST', { name: 'x', limits: { dailyBudget: -1 } })).status, 400);
    assert.equal((await j(s.url, '/api/agents/none', 'PATCH', { paused: true })).status, 404);
  } finally { await s.close(); }
});

test('every preset is a valid policy', () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    const v = validatePolicy(p.values, DEFAULT_POLICY);
    assert.ok(v.ok, `${name}: ${v.errors}`);
  }
});

test('webhook URL validation', () => {
  assert.ok(validateWebhookUrl('').ok);
  assert.ok(validateWebhookUrl('https://hooks.slack.com/services/T/B/x').ok);
  for (const bad of ['http://example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://192.168.1.1/x', 'https://169.254.169.254/x', 'https://user:pw@example.com/x', 'https://intranet/x', 'https://[::1]/x', 'ftp://example.com', 'nonsense']) {
    assert.equal(validateWebhookUrl(bad).ok, false, bad);
  }
});

test('webhook alerts: sent for held and blocked, not for allowed, no page text, URL masked publicly', async () => {
  const calls = [];
  const s = await startServer({ alertFetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { status: 200 }; } });
  try {
    await j(s.url, '/api/policy', 'PUT', { webhookUrl: 'https://hooks.example.com/secret-token' });
    const pub = (await j(s.url, '/api/policy')).data.policy;
    assert.ok(!JSON.stringify(pub).includes('secret-token'));
    assert.equal(pub.webhookSet, true);
    assert.ok(!JSON.stringify((await j(s.url, '/api/state')).data).includes('secret-token'));
    // saving the masked value back must not wipe the real URL
    await j(s.url, '/api/policy', 'PUT', { webhookUrl: pub.webhookUrl, dailyBudget: 300 });
    assert.equal(s.store.getPolicy().webhookUrl, 'https://hooks.example.com/secret-token');

    await j(s.url, '/api/requests', 'POST', goodOrder());
    await j(s.url, '/api/requests', 'POST', goodOrder({ amount: 75, context: 'SECRET-PAGE-TEXT' }));
    await j(s.url, '/api/requests', 'POST', goodOrder({ amount: 5000 }));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(calls.map((c) => c.body.event).sort(), ['tollgate.blocked', 'tollgate.held']);
    assert.ok(calls.every((c) => c.body.text && c.body.content));
    assert.ok(!JSON.stringify(calls).includes('SECRET-PAGE-TEXT'));

    const t = (await j(s.url, '/api/webhook/test', 'POST')).data;
    assert.equal(t.ok, true);
  } finally { await s.close(); }
});

test('a failing webhook never breaks a decision', async () => {
  const s = await startServer({ alertFetch: async () => { throw new Error('boom'); } });
  try {
    await j(s.url, '/api/policy', 'PUT', { webhookUrl: 'https://hooks.example.com/x' });
    const r = await j(s.url, '/api/requests', 'POST', goodOrder({ amount: 5000 }));
    assert.equal(r.data.status, 'blocked');
    assert.equal((await j(s.url, '/api/webhook/test', 'POST')).data.ok, false);
  } finally { await s.close(); }
});

test('analytics adds up', async () => {
  const s = await startServer();
  try {
    await j(s.url, '/api/requests', 'POST', goodOrder({ amount: 20 }));
    await j(s.url, '/api/requests', 'POST', goodOrder({ amount: 5000 }));
    await j(s.url, '/api/requests', 'POST', goodOrder({ amount: 75 }));
    const a = (await j(s.url, '/api/analytics')).data;
    assert.equal(a.totals.requests, 3);
    assert.equal(a.totals.executed, 1);
    assert.equal(a.totals.sentAmount, 20);
    assert.equal(a.totals.stoppedAmount, 5000);
    assert.equal(a.totals.heldAmount, 75);
    assert.equal(a.series.length, 3);
    assert.ok(a.threats.some((t) => t.label === 'Over the per-payment limit'));
    assert.equal(a.risk.reduce((n, x) => n + x.count, 0), 3);
  } finally { await s.close(); }
});

test('CSV export is admin-gated and neutralises formulas', async () => {
  const s = await startServer({ adminToken: 'tok' });
  try {
    await s.guard.submit(goodOrder({ description: '=HYPERLINK("http://evil","x")', merchant: 'bookstore.example' }));
    assert.equal((await fetch(s.url + '/api/export.csv')).status, 401);
    const res = await fetch(s.url + '/api/export.csv', { headers: { 'x-admin-token': 'tok' } });
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const text = await res.text();
    assert.ok(text.startsWith('time,id,agent'));
    assert.ok(text.includes(`"'=HYPERLINK(""http://evil"",""x"")"`));
  } finally { await s.close(); }
});

test('csv cell escaping', () => {
  const csv = recordsToCsv([{ createdAt: 't', id: 'i', request: { agentId: 'a', action: 'order', merchant: '+1', amount: 1, currency: 'USD', description: 'a,b\n"c"', userIntent: '' }, status: 'blocked', reasons: [] }]);
  assert.ok(csv.includes("'+1"));
  assert.ok(csv.includes('"a,b\n""c"""'));
});

test('playground: dry run logs nothing, live run does', async () => {
  const s = await startServer();
  try {
    const dry = (await j(s.url, '/api/playground', 'POST', goodOrder({ amount: 75 }))).data;
    assert.equal(dry.dryRun, true);
    assert.equal(dry.status, 'pending');
    assert.ok(Array.isArray(dry.reasons) && typeof dry.reasons[0].message === 'string' && dry.reasons[0].type);
    assert.equal(s.store.list().length, 0);
    const allowed = (await j(s.url, '/api/playground', 'POST', goodOrder())).data;
    assert.equal(allowed.status, 'allowed');
    assert.equal(s.store.list().length, 0);
    const live = (await j(s.url, '/api/playground', 'POST', { ...goodOrder(), dryRun: false })).data;
    assert.equal(live.status, 'executed');
    assert.equal(s.store.list().length, 1);
    assert.equal((await j(s.url, '/api/playground', 'POST', { amount: 'x' })).status, 400);
  } finally { await s.close(); }
});

test('playground is admin-gated', async () => {
  const s = await startServer({ adminToken: 'tok' });
  try {
    assert.equal((await j(s.url, '/api/playground', 'POST', goodOrder())).status, 401);
  } finally { await s.close(); }
});

test('reset keeps agents', async () => {
  const s = await startServer();
  try {
    await j(s.url, '/api/agents', 'POST', { name: 'Keeper' });
    await j(s.url, '/api/reset', 'POST');
    assert.equal(s.store.listAgents().length, 1);
  } finally { await s.close(); }
});
