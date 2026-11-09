import { randomUUID } from 'node:crypto';

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

/**
 * Minimal PayPal REST client (Orders v2 + Payouts v1), SANDBOX ONLY.
 *
 * - With no credentials it runs in simulation mode and never touches the network,
 *   so judges can try the whole flow without a PayPal account.
 * - "live" mode is refused on purpose: this project is a sandbox demo.
 */
export function createPayPalClient(cfg, fetchImpl = fetch) {
  if (cfg.mode !== 'sandbox') {
    throw new Error(
      `Tollgate is sandbox-only (PAYPAL_MODE=${cfg.mode} is not allowed). Use PAYPAL_MODE=sandbox.`,
    );
  }
  const simulated = !(cfg.clientId && cfg.secret);
  let token = null; // { value, expiresAt }

  async function getToken() {
    if (token && token.expiresAt > Date.now() + 30_000) return token.value;
    const basic = Buffer.from(`${cfg.clientId}:${cfg.secret}`).toString('base64');
    const res = await fetchImpl(`${SANDBOX_BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`PayPal auth failed (${res.status}): ${data.error_description || data.error || 'unknown error'}`);
    }
    token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 300) * 1000 };
    return token.value;
  }

  async function api(method, path, body, requestId) {
    const accessToken = await getToken();
    const res = await fetchImpl(`${SANDBOX_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data.message || data.error_description || data.name || 'request failed';
      throw new Error(`PayPal ${method} ${path} failed (${res.status}): ${detail}`);
    }
    return data;
  }

  const money = (amount) => Number(amount).toFixed(2);

  return {
    mode: 'sandbox',
    simulated,

    /** Create an order. The buyer still approves it on PayPal (approveUrl). */
    async createOrder({ requestId, amount, currency, description, merchant }) {
      if (simulated) {
        const id = `SIM-ORDER-${randomUUID().slice(0, 8).toUpperCase()}`;
        return {
          id,
          status: 'CREATED',
          approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
          simulated: true,
        };
      }
      const data = await api(
        'POST',
        '/v2/checkout/orders',
        {
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: requestId,
              custom_id: requestId,
              description: String(description || `Purchase from ${merchant}`).slice(0, 127),
              amount: { currency_code: currency, value: money(amount) },
            },
          ],
        },
        requestId,
      );
      const approve = (data.links || []).find((l) => l.rel === 'approve' || l.rel === 'payer-action');
      return { id: data.id, status: data.status, approveUrl: approve?.href || null, simulated: false };
    },

    /** Send a payout to an email address (sandbox Payouts API). */
    async createPayout({ requestId, amount, currency, recipient, note }) {
      if (simulated) {
        return {
          id: `SIM-PAYOUT-${randomUUID().slice(0, 8).toUpperCase()}`,
          status: 'PENDING',
          simulated: true,
        };
      }
      const data = await api(
        'POST',
        '/v1/payments/payouts',
        {
          sender_batch_header: {
            sender_batch_id: requestId,
            email_subject: 'You have a payment',
          },
          items: [
            {
              recipient_type: 'EMAIL',
              receiver: recipient,
              amount: { value: money(amount), currency },
              note: String(note || 'Tollgate payout').slice(0, 160),
              sender_item_id: requestId,
            },
          ],
        },
        requestId,
      );
      return {
        id: data.batch_header?.payout_batch_id,
        status: data.batch_header?.batch_status || 'PENDING',
        simulated: false,
      };
    },
  };
}
