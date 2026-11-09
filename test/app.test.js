import test from 'node:test';
import assert from 'node:assert/strict';
import { goodOrder, startServer } from './helpers.js';

const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('agent flow over HTTP: executed, pending, blocked, with agent-safe responses', async () => {
  const s = await startServer();
  try {
    const ok = await (await post(`${s.url}/api/requests`, goodOrder())).json();
    assert.equal(ok.status, 'executed');
    assert.match(ok.message, /sent to the PayPal sandbox/i);
    assert.equal(ok.paypal.simulated, true);

    const big = await (await post(`${s.url}/api/requests`, goodOrder({ amount: 75, merchant: 'giftshop.example', description: 'gift set', userIntent: 'gift set around $80' }))).json();
    assert.equal(big.status, 'pending');
    assert.match(big.message, /do not retry/i);

    const bad = await (await post(`${s.url}/api/requests`, goodOrder({ amount: 900 }))).json();
    assert.equal(bad.status, 'blocked');
    assert.match(bad.message, /do not retry/i);
    // Agents get reasons and a status, never the internal request log.
    assert.equal(bad.request, undefined);
    assert.equal(bad.risk, undefined);

    const again = await (await fetch(`${s.url}/api/requests/${big.id}`)).json();
    assert.equal(again.status, 'pending');
  } finally {
    await s.close();
  }
});

test('validation errors are 400, unknown ids 404, bad JSON 400', async () => {
  const s = await startServer();
  try {
    const r = await post(`${s.url}/api/requests`, { action: 'order', amount: -4 });
    assert.equal(r.status, 400);
    assert.ok((await r.json()).errors.length > 0);
    assert.equal((await fetch(`${s.url}/api/requests/does-not-exist`)).status, 404);
    const garbage = await fetch(`${s.url}/api/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    assert.equal(garbage.status, 400);
    const huge = await post(`${s.url}/api/requests`, { action: 'order', amount: 5, merchant: 'x', context: 'a'.repeat(100_000) });
    assert.equal(huge.status, 413);
  } finally {
    await s.close();
  }
});

test('with ADMIN_TOKEN set, an agent cannot approve its own payment or change the rules', async () => {
  const s = await startServer({ adminToken: 'owner-secret' });
  try {
    const pending = await (await post(`${s.url}/api/requests`, goodOrder({ amount: 75, merchant: 'giftshop.example', description: 'gift set', userIntent: 'gift set around $80' }))).json();
    assert.equal(pending.status, 'pending');

    for (const [path, method, body] of [
      [`/api/requests/${pending.id}/approve`, 'POST'],
      [`/api/requests/${pending.id}/reject`, 'POST'],
      ['/api/policy', 'PUT', { dailyBudget: 99999 }],
      ['/api/reset', 'POST'],
      ['/api/demo/safe-purchase', 'POST'],
    ]) {
      const none = await fetch(s.url + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
      assert.equal(none.status, 401, `${path} without token`);
      const wrong = await fetch(s.url + path, { method, headers: { 'content-type': 'application/json', 'x-admin-token': 'guess' }, body: body && JSON.stringify(body) });
      assert.equal(wrong.status, 401, `${path} with wrong token`);
    }
    assert.equal(s.store.get(pending.id).status, 'pending', 'still pending after all attempts');
    assert.equal(s.store.getPolicy().dailyBudget, 250);

    const approved = await post(`${s.url}/api/requests/${pending.id}/approve`, {}, { 'x-admin-token': 'owner-secret' });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).status, 'executed');

    const state = await (await fetch(`${s.url}/api/state`)).json();
    assert.equal(state.meta.adminRequired, true);
    assert.ok(!JSON.stringify(state).includes('owner-secret'), 'token is never sent to the browser');
  } finally {
    await s.close();
  }
});

test('policy endpoint validates and applies', async () => {
  const s = await startServer();
  try {
    const bad = await fetch(`${s.url}/api/policy`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalThreshold: 5000 }) });
    assert.equal(bad.status, 400);
    const good = await fetch(`${s.url}/api/policy`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ perTransactionLimit: 30, approvalThreshold: 10 }) });
    assert.equal(good.status, 200);
    const blocked = await (await post(`${s.url}/api/requests`, goodOrder({ amount: 40 }))).json();
    assert.equal(blocked.status, 'blocked');
  } finally {
    await s.close();
  }
});

test('demo endpoint runs every scenario to its expected result', async () => {
  const s = await startServer();
  try {
    const { scenarios } = await (await fetch(`${s.url}/api/scenarios`)).json();
    assert.equal(scenarios.length, 6);
    for (const sc of scenarios) {
      const out = await (await post(`${s.url}/api/demo/${sc.id}`, {})).json();
      assert.equal(out.result.status, sc.expect, sc.id);
    }
    assert.equal((await post(`${s.url}/api/demo/nope`, {})).status, 404);
    const state = await (await fetch(`${s.url}/api/state`)).json();
    assert.equal(state.records.length, 6);
    assert.ok(state.stats.blockedAmount > 0);
  } finally {
    await s.close();
  }
});

test('dashboard assets are served with a strict CSP', async () => {
  const s = await startServer();
  try {
    const page = await fetch(s.url + '/');
    assert.equal(page.status, 200);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.ok(!/script-src[^;]*unsafe/.test(csp), 'no inline or eval scripts');
    assert.equal(page.headers.get('x-powered-by'), null);
    const grid = await fetch(s.url + '/vendor/ag-grid.js');
    assert.equal(grid.status, 200);
    assert.match(await grid.text(), /ag-grid/i);
  } finally {
    await s.close();
  }
});
