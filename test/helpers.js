import { createStore } from '../src/store.js';
import { createPayPalClient } from '../src/paypal.js';
import { createRiskAssessor } from '../src/risk.js';
import { createGuard } from '../src/guard.js';
import { createApp } from '../src/app.js';
import { createAlerter } from '../src/alerts.js';
import { createAgentRegistry } from '../src/agents.js';

/** A full Tollgate stack in memory, PayPal in simulation mode (no network). */
export function makeStack({ adminToken = '', ai = {}, fetchImpl, paypalCfg, alertFetch } = {}) {
  const store = createStore(null);
  const paypal = createPayPalClient(paypalCfg || { mode: 'sandbox', clientId: '', secret: '' }, fetchImpl);
  const risk = createRiskAssessor(ai, fetchImpl);
  const alerts = createAlerter({ store, fetchImpl: alertFetch || (async () => ({ status: 200 })) });
  const agents = createAgentRegistry(store);
  const guard = createGuard({ store, paypal, risk, alerts });
  const config = { adminToken };
  return { store, paypal, risk, guard, config, alerts, agents };
}

export async function startServer(opts) {
  const stack = makeStack(opts);
  const app = createApp(stack);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { ...stack, url, close: () => new Promise((r) => server.close(r)) };
}

export const goodOrder = (over = {}) => ({
  agentId: `agent-${Math.random().toString(36).slice(2)}`,
  action: 'order',
  amount: 24,
  merchant: 'bookstore.example',
  description: 'Birthday book',
  userIntent: 'Buy a birthday book under $30',
  context: 'Product page: a book, $24.',
  ...over,
});
