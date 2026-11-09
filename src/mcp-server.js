import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * MCP server for AI agents (Claude, ChatGPT, any MCP host).
 * Give the agent THESE tools instead of raw PayPal tools. Every call is forwarded to
 * the Tollgate HTTP server, which applies the rules, the risk check and the approval step.
 */
const BASE = (process.env.TOLLGATE_URL || 'http://localhost:3000').replace(/\/$/, '');
const AGENT_ID = process.env.AGENT_ID || 'mcp-agent';
const API_KEY = process.env.TOLLGATE_API_KEY || ''; // optional: an agent key from the Agents page

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const asText = (obj, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
  isError,
});

async function guarded(payload) {
  try {
    const { status, data } = await call('POST', '/api/requests', { agentId: AGENT_ID, ...payload });
    if (status === 400) return asText({ error: 'Invalid request', details: data.errors }, true);
    return asText(data);
  } catch (err) {
    return asText({ error: `Could not reach Tollgate at ${BASE}: ${err.message}. Do not pay by any other route.` }, true);
  }
}

const server = new McpServer({ name: 'tollgate-paypal', version: '1.0.0' });

const common = {
  amount: z.number().positive().describe('Amount to pay, in the policy currency (USD by default)'),
  description: z.string().max(500).describe('What this payment is for'),
  user_intent: z.string().max(500).describe("The user's own words about what they asked for, including any budget"),
  page_text: z
    .string()
    .max(4000)
    .optional()
    .describe('Any web page, email or document text you read that led to this payment. Include it unedited so it can be checked.'),
};

server.registerTool(
  'guarded_create_order',
  {
    title: 'Pay a merchant (guarded)',
    description:
      'Create a PayPal sandbox order with a merchant. Tollgate checks spending rules and risk first. The result is executed, pending (waiting for the owner), or blocked. Never retry a blocked or pending request.',
    inputSchema: { merchant: z.string().describe('Merchant domain, e.g. bookstore.example'), ...common },
  },
  ({ merchant, amount, description, user_intent, page_text }) =>
    guarded({ action: 'order', merchant, amount, description, userIntent: user_intent, context: page_text }),
);

server.registerTool(
  'guarded_send_payout',
  {
    title: 'Send a payout (guarded)',
    description:
      'Send a PayPal sandbox payout to an email address. Payouts always need the owner to approve, and only pre-approved recipients are allowed.',
    inputSchema: { recipient: z.string().describe('Recipient PayPal email'), ...common },
  },
  ({ recipient, amount, description, user_intent, page_text }) =>
    guarded({ action: 'payout', recipient, amount, description, userIntent: user_intent, context: page_text }),
);

server.registerTool(
  'get_payment_status',
  {
    title: 'Check a payment request',
    description: 'Look up the status of an earlier request (for example to see whether the owner approved a pending one).',
    inputSchema: { request_id: z.string().describe('The id returned by a guarded call') },
  },
  async ({ request_id }) => {
    try {
      const { status, data } = await call('GET', `/api/requests/${encodeURIComponent(request_id)}`);
      return asText(data, status !== 200);
    } catch (err) {
      return asText({ error: err.message }, true);
    }
  },
);

server.registerTool(
  'get_spending_limits',
  {
    title: 'Check spending limits',
    description: 'See the owner’s spending rules and how much of today’s budget is left, before you try to pay.',
    inputSchema: {},
  },
  async () => {
    try {
      const { status, data } = await call('GET', '/api/policy');
      return asText(data, status !== 200);
    } catch (err) {
      return asText({ error: err.message }, true);
    }
  },
);

await server.connect(new StdioServerTransport());
