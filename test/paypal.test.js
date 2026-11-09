import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPalClient } from '../src/paypal.js';

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('live mode is refused: this project is sandbox-only', () => {
  assert.throws(() => createPayPalClient({ mode: 'live', clientId: 'a', secret: 'b' }), /sandbox-only/);
  assert.throws(() => createPayPalClient({ mode: 'production', clientId: 'a', secret: 'b' }), /sandbox-only/);
});

test('without credentials it simulates and never touches the network', async () => {
  const pp = createPayPalClient({ mode: 'sandbox', clientId: '', secret: '' }, async () => {
    throw new Error('network must not be used');
  });
  assert.equal(pp.simulated, true);
  const order = await pp.createOrder({ requestId: 'r1', amount: 10, currency: 'USD', description: 'x', merchant: 'm' });
  assert.equal(order.simulated, true);
  assert.match(order.approveUrl, /sandbox\.paypal\.com/);
  const payout = await pp.createPayout({ requestId: 'r2', amount: 10, currency: 'USD', recipient: 'a@b.c', note: 'n' });
  assert.equal(payout.simulated, true);
});

test('sandbox order: gets a token, posts the order, returns the approve link', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/oauth2/token')) return json(200, { access_token: 'TOKEN', expires_in: 300 });
    return json(201, { id: 'ORDER123', status: 'CREATED', links: [{ rel: 'payer-action', href: 'https://sandbox.paypal.com/approve/123' }] });
  };
  const pp = createPayPalClient({ mode: 'sandbox', clientId: 'cid', secret: 'sec' }, fetchImpl);
  assert.equal(pp.simulated, false);

  const out = await pp.createOrder({ requestId: 'req-1', amount: 24.5, currency: 'USD', description: 'Birthday book', merchant: 'bookstore.example' });
  assert.deepEqual(out, { id: 'ORDER123', status: 'CREATED', approveUrl: 'https://sandbox.paypal.com/approve/123', simulated: false });

  assert.equal(calls[0].url, 'https://api-m.sandbox.paypal.com/v1/oauth2/token');
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('cid:sec').toString('base64')}`);
  assert.equal(calls[1].url, 'https://api-m.sandbox.paypal.com/v2/checkout/orders');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer TOKEN');
  assert.equal(calls[1].init.headers['PayPal-Request-Id'], 'req-1', 'idempotency key');
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.intent, 'CAPTURE');
  assert.deepEqual(body.purchase_units[0].amount, { currency_code: 'USD', value: '24.50' });

  await pp.createOrder({ requestId: 'req-2', amount: 5, currency: 'USD', description: 'x', merchant: 'm' });
  assert.equal(calls.filter((c) => c.url.endsWith('/token')).length, 1, 'token is cached');
});

test('sandbox payout payload', async () => {
  let payload;
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/token')) return json(200, { access_token: 'T', expires_in: 300 });
    payload = { url, body: JSON.parse(init.body) };
    return json(201, { batch_header: { payout_batch_id: 'BATCH1', batch_status: 'PENDING' } });
  };
  const pp = createPayPalClient({ mode: 'sandbox', clientId: 'c', secret: 's' }, fetchImpl);
  const out = await pp.createPayout({ requestId: 'rq', amount: 12, currency: 'USD', recipient: 'team@tollgate.example', note: 'lunch' });
  assert.deepEqual(out, { id: 'BATCH1', status: 'PENDING', simulated: false });
  assert.equal(payload.url, 'https://api-m.sandbox.paypal.com/v1/payments/payouts');
  assert.equal(payload.body.items[0].receiver, 'team@tollgate.example');
  assert.equal(payload.body.items[0].amount.value, '12.00');
});

test('auth failure and API errors become readable errors (no secrets in them)', async () => {
  const badAuth = createPayPalClient({ mode: 'sandbox', clientId: 'c', secret: 'topsecret' }, async () => json(401, { error: 'invalid_client', error_description: 'Client Authentication failed' }));
  await assert.rejects(badAuth.createOrder({ requestId: 'r', amount: 1, currency: 'USD', description: '', merchant: 'm' }), (e) => {
    assert.match(e.message, /PayPal auth failed \(401\)/);
    assert.ok(!e.message.includes('topsecret'));
    return true;
  });

  const apiDown = createPayPalClient({ mode: 'sandbox', clientId: 'c', secret: 's' }, async (url) =>
    url.endsWith('/token') ? json(200, { access_token: 'T', expires_in: 300 }) : json(422, { name: 'UNPROCESSABLE_ENTITY', message: 'Bad amount' }),
  );
  await assert.rejects(apiDown.createOrder({ requestId: 'r', amount: 1, currency: 'USD', description: '', merchant: 'm' }), /failed \(422\): Bad amount/);
});
