import fs from 'node:fs';
import path from 'node:path';

/**
 * Tiny .env loader (no dependency). Real environment variables always win.
 */
export function loadDotEnv(file = '.env', env = process.env) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[m[1]] === undefined || env[m[1]] === '') env[m[1]] = value;
  }
}

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    paypal: {
      clientId: env.PAYPAL_CLIENT_ID || '',
      secret: env.PAYPAL_SECRET || env.PAYPAL_CLIENT_SECRET || '',
      mode: (env.PAYPAL_MODE || 'sandbox').toLowerCase(),
    },
    ai: {
      apiKey: env.ANTHROPIC_API_KEY || '',
      model: env.AI_MODEL || 'claude-sonnet-5-5',
      timeoutMs: Number(env.AI_TIMEOUT_MS || 8000),
    },
    adminToken: env.ADMIN_TOKEN || '',
    dataFile: env.TOLLGATE_DATA || path.join('data', 'audit.json'),
  };
}
