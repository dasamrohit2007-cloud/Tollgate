import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS } from '../src/scenarios.js';
import { goodOrder, makeStack } from './helpers.js';

test('every built-in scenario gets its expected decision', async () => {
  for (const s of SCENARIOS) {
    const { guard } = makeStack(); // fresh stack so earlier scenarios do not use up budget
    const out = await guard.submit({ ...s.request });
    assert.equal(out.ok, true, s.id);
    assert.equal(out.record.status, s.expect, `${s.id}: ${JSON.stringify(out.record.reasons.map((r) => r.message))}`);
  }
});

test('a clean order executes and is recorded with PayPal details', async () => {
  const { guard, store } = makeStack();
  const { record } = await guard.submit(goodOrder());
  assert.equal(record.status, 'executed');
  assert.equal(record.paypal.simulated, true);
  assert.match(record.paypal.id, /^SIM-ORDER-/);
  assert.equal(store.spentToday(), 24);
});

test('blocked requests never reach PayPal and never count as spend', async () => {
  const { guard, store, paypal } = makeStack();
  let calls = 0;
  paypal.createOrder = async () => {
    calls += 1;
    return {};
  };
  const { record } = await guard.submit(goodOrder({ amount: 500 }));
  assert.equal(record.status, 'blocked');
  assert.equal(calls, 0);
  assert.equal(store.spentToday(), 0);
});

test('invalid requests are rejected without being logged', async () => {
  const { guard, store } = makeStack();
  const out = await guard.submit({ action: 'order', amount: -1 });
  assert.equal(out.ok, false);
  assert.equal(store.list().length, 0);
});

test('pending request: approve executes once, a second approve is refused', async () => {
  const { guard, store } = makeStack();
  const { record } = await guard.submit(goodOrder({ amount: 75, merchant: 'giftshop.example', description: 'Coffee gift set', userIntent: 'Find a coffee gift set around $80' }));
  assert.equal(record.status, 'pending');
  assert.equal(store.spentToday(), 0, 'pending money has not moved');

  const first = await guard.decide(record.id, true);
  assert.equal(first.record.status, 'executed');
  assert.equal(first.record.decidedBy, 'owner');
  assert.equal(store.spentToday(), 75);

  const second = await guard.decide(record.id, true);
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.equal(store.spentToday(), 75, 'no double payment');
});

test('rejecting a pending request sends nothing', async () => {
  const { guard, store, paypal } = makeStack();
  let calls = 0;
  paypal.createOrder = async () => {
    calls += 1;
    return {};
  };
  const { record } = await guard.submit(goodOrder({ amount: 75, merchant: 'giftshop.example', description: 'Coffee gift set', userIntent: 'coffee gift set around $80' }));
  const out = await guard.decide(record.id, false);
  assert.equal(out.record.status, 'rejected');
  assert.equal(calls, 0);
  assert.equal(store.spentToday(), 0);
});

test('unknown request id', async () => {
  const { guard } = makeStack();
  const out = await guard.decide('nope', true);
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
});

test('hard rules are re-checked at approval time (policy tightened after the request)', async () => {
  const { guard } = makeStack();
  const { record } = await guard.submit(goodOrder({ amount: 75, merchant: 'giftshop.example', description: 'Coffee gift set', userIntent: 'coffee gift set around $80' }));
  assert.equal(record.status, 'pending');
  await guard.updatePolicy({ perTransactionLimit: 60, approvalThreshold: 40 });
  const out = await guard.decide(record.id, true);
  assert.equal(out.record.status, 'blocked');
  assert.ok(out.record.reasons.some((r) => /re-checked at approval/.test(r.message)));
});

test('payouts: allowlisted recipient waits for approval, stranger is blocked', async () => {
  const { guard } = makeStack();
  const ok = await guard.submit({ agentId: 'a', action: 'payout', amount: 20, recipient: 'team@tollgate.example', description: 'Team reimbursement', userIntent: 'Reimburse the team for lunch $20' });
  assert.equal(ok.record.status, 'pending');
  const bad = await guard.submit({ agentId: 'a', action: 'payout', amount: 20, recipient: 'stranger@evil.example', description: 'Reimbursement', userIntent: 'Reimburse the team for lunch $20' });
  assert.equal(bad.record.status, 'blocked');
});

test('parallel requests cannot overspend the daily budget', async () => {
  const { guard, store } = makeStack();
  // 12 clean $30 orders at the same instant against a $250 budget: exactly 8 fit.
  const results = await Promise.all(Array.from({ length: 12 }, () => guard.submit(goodOrder({ amount: 30 }))));
  const executed = results.filter((r) => r.record.status === 'executed').length;
  assert.equal(executed, 8);
  assert.equal(store.spentToday(), 240);
  assert.equal(results.filter((r) => r.record.status === 'blocked').length, 4);
});

test('pending requests reserve budget so approvals cannot be stacked past it', async () => {
  const { guard, store } = makeStack();
  await guard.updatePolicy({ dailyBudget: 100, approvalThreshold: 20, perTransactionLimit: 100 });
  const mk = () => goodOrder({ amount: 60, merchant: 'giftshop.example', description: 'gift set', userIntent: 'a gift set around $60' });
  const a = await guard.submit(mk());
  const b = await guard.submit(mk()); // 60 reserved + 60 > 100
  assert.equal(a.record.status, 'pending');
  assert.equal(b.record.status, 'blocked');
  assert.equal(store.spentToday(), 0);
});

test('per-agent rate limit', async () => {
  const { guard } = makeStack();
  const statuses = [];
  for (let i = 0; i < 8; i += 1) {
    const { record } = await guard.submit(goodOrder({ agentId: 'chatty', amount: 5 }));
    statuses.push(record.status);
  }
  assert.equal(statuses.filter((s) => s === 'executed').length, 6);
  assert.equal(statuses.filter((s) => s === 'blocked').length, 2);
});

test('PayPal failure is recorded and does not count as spend', async () => {
  const { guard, store, paypal } = makeStack();
  paypal.createOrder = async () => {
    throw new Error('PayPal is down');
  };
  const { record } = await guard.submit(goodOrder());
  assert.equal(record.status, 'failed');
  assert.match(record.error, /PayPal is down/);
  assert.equal(store.spentToday(), 0);
});

test('policy updates are validated', async () => {
  const { guard, store } = makeStack();
  const bad = await guard.updatePolicy({ dailyBudget: -5 });
  assert.equal(bad.ok, false);
  assert.equal(store.getPolicy().dailyBudget, 250);
  const good = await guard.updatePolicy({ dailyBudget: 400 });
  assert.equal(good.ok, true);
  assert.equal(store.getPolicy().dailyBudget, 400);
});
