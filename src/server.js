import { loadConfig, loadDotEnv } from './config.js';
import { createStore } from './store.js';
import { createPayPalClient } from './paypal.js';
import { createRiskAssessor } from './risk.js';
import { createGuard } from './guard.js';
import { createApp } from './app.js';
import { createAlerter } from './alerts.js';
import { createAgentRegistry } from './agents.js';

loadDotEnv();
const config = loadConfig();

const store = createStore(config.dataFile);
const paypal = createPayPalClient(config.paypal);
const risk = createRiskAssessor(config.ai);
const alerts = createAlerter({ store });
const agents = createAgentRegistry(store);
const guard = createGuard({ store, paypal, risk, alerts });
const app = createApp({ config, store, paypal, risk, guard, alerts, agents });

app.listen(config.port, config.host, () => {
  console.log(`Tollgate running at http://localhost:${config.port}`);
  console.log(`  PayPal:    ${paypal.simulated ? 'SIMULATION (no PayPal keys set)' : 'sandbox API'}`);
  console.log(`  AI review: ${risk.aiEnabled ? `on (${config.ai.model})` : 'off (built-in heuristic only)'}`);
  if (!config.adminToken) {
    console.log('  Note: ADMIN_TOKEN is not set, so anyone who can reach this server can approve payments.');
    console.log('        That is fine on your own computer. Set ADMIN_TOKEN before deploying.');
  }
});
