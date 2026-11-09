import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, checkPolicy, normalizeRequest, validatePolicy } from '../src/policy.js';

const req = (over = {}) => normalizeRequest({ action: 'order', amount: 20, merchant: 'bookstore.example', ...over }).request;
const codes = (list) => list.map((x) => x.code);

test('normalizeRequest rejects bad input', () => {
  assert.equal(normalizeRequest(null).ok, false);
  assert.equal(normalizeRequest([]).ok, false);
  assert.equal(normalizeRequest({ action: 'steal', amount: 5 }).ok, false);
  assert.equal(normalizeRequest({ action: 'order', amount: -5, merchant: 'x' }).ok, false);
  assert.equal(normalizeRequest({ action: 'order', amount: 'abc', merchant: 'x' }).ok, false);
  assert.equal(normalizeRequest({ action: 'order', amount: 5 }).ok, false, 'orders need a merchant');
  assert.equal(normalizeRequest({ action: 'payout', amount: 5 }).ok, false, 'payouts need a recipient');
});

test('normalizeRequest cleans and caps fields', () => {
  const r = normalizeRequest({ action: 'ORDER', amount: '12.345', merchant: '  Shop.EXAMPLE ', context: 'x'.repeat(9000) }).request;
  assert.equal(r.action, 'order');
  assert.equal(r.amount, 12.35);
  assert.equal(r.merchant, 'shop.example');
  assert.equal(r.context.length, 4000);
  assert.equal(r.currency, 'USD');
});

test('clean in-budget order from allowlisted merchant has no violations or flags', () => {
  const out = checkPolicy({ request: req(), policy: DEFAULT_POLICY });
  assert.deepEqual(out, { violations: [], flags: [] });
});

test('hard limits block', () => {
  assert.ok(codes(checkPolicy({ request: req({ amount: 101 }), policy: DEFAULT_POLICY }).violations).includes('OVER_LIMIT'));
  assert.ok(codes(checkPolicy({ request: req({ merchant: 'evil.example' }), policy: DEFAULT_POLICY }).violations).includes('UNKNOWN_MERCHANT'));
  assert.ok(codes(checkPolicy({ request: req({ currency: 'EUR' }), policy: DEFAULT_POLICY }).violations).includes('CURRENCY'));
  assert.ok(codes(checkPolicy({ request: req({ amount: 40 }), policy: DEFAULT_POLICY, spentToday: 220 }).violations).includes('OVER_BUDGET'));
  assert.ok(codes(checkPolicy({ request: req(), policy: DEFAULT_POLICY, recentCount: 6 }).violations).includes('RATE_LIMIT'));
});

test('amount exactly at a limit is allowed; one cent over is not', () => {
  assert.equal(checkPolicy({ request: req({ amount: 100 }), policy: DEFAULT_POLICY }).violations.length, 0);
  assert.ok(checkPolicy({ request: req({ amount: 100.01 }), policy: DEFAULT_POLICY }).violations.length > 0);
  assert.equal(checkPolicy({ request: req({ amount: 50 }), policy: DEFAULT_POLICY }).flags.length, 0);
  assert.equal(codes(checkPolicy({ request: req({ amount: 50.01 }), policy: DEFAULT_POLICY }).flags)[0], 'APPROVAL_THRESHOLD');
});

test('payouts: unknown recipient blocked, known recipient still needs approval, switch-off blocks', () => {
  const payout = (over) => req({ action: 'payout', merchant: '', recipient: 'team@tollgate.example', amount: 10, ...over });
  const known = checkPolicy({ request: payout(), policy: DEFAULT_POLICY });
  assert.equal(known.violations.length, 0);
  assert.deepEqual(codes(known.flags), ['PAYOUT_APPROVAL']);
  assert.ok(codes(checkPolicy({ request: payout({ recipient: 'x@evil.example' }), policy: DEFAULT_POLICY }).violations).includes('UNKNOWN_RECIPIENT'));
  assert.ok(codes(checkPolicy({ request: payout(), policy: { ...DEFAULT_POLICY, payoutsEnabled: false } }).violations).includes('PAYOUTS_DISABLED'));
});

test('validatePolicy merges, normalises and rejects bad values', () => {
  const ok = validatePolicy({ dailyBudget: '300', allowedMerchants: [' A.example ', 'a.example', 'B.example'], currency: 'eur' });
  assert.equal(ok.ok, true);
  assert.equal(ok.policy.dailyBudget, 300);
  assert.deepEqual(ok.policy.allowedMerchants, ['a.example', 'b.example']);
  assert.equal(ok.policy.currency, 'EUR');
  assert.equal(ok.policy.perTransactionLimit, DEFAULT_POLICY.perTransactionLimit, 'untouched fields keep their value');

  for (const bad of [
    { perTransactionLimit: -1 },
    { dailyBudget: 'lots' },
    { maxRequestsPerMinute: 0 },
    { maxRequestsPerMinute: 1.5 },
    { payoutsEnabled: 'yes' },
    { currency: 'DOLLARS' },
    { allowedMerchants: 'bookstore.example' },
    { allowedMerchants: [1, 2] },
    { approvalThreshold: 500 }, // above the 100 limit
  ]) {
    assert.equal(validatePolicy(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(validatePolicy('nope').ok, false);
});
