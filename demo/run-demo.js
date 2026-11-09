// Runs every demo scenario against a running Tollgate server and prints the decisions.
//   npm start            (in one terminal)
//   npm run demo         (in another)
const BASE = (process.env.TOLLGATE_URL || 'http://localhost:3000').replace(/\/$/, '');
const headers = { 'content-type': 'application/json', ...(process.env.ADMIN_TOKEN ? { 'x-admin-token': process.env.ADMIN_TOKEN } : {}) };

const icon = { executed: 'ALLOWED', pending: 'ASK YOU', blocked: 'BLOCKED', rejected: 'REJECTED', failed: 'FAILED' };

async function main() {
  const list = await (await fetch(`${BASE}/api/scenarios`)).json();
  let mismatches = 0;
  for (const s of list.scenarios) {
    const res = await fetch(`${BASE}/api/demo/${s.id}`, { method: 'POST', headers });
    const data = await res.json();
    if (!res.ok) throw new Error(`${s.id}: ${data.error || res.status}`);
    const r = data.result;
    const ok = r.status === s.expect;
    if (!ok) mismatches += 1;
    console.log(`\n[${icon[r.status] || r.status}] ${s.title}  (risk ${r.riskScore}/100)${ok ? '' : `  <-- expected ${s.expect}`}`);
    for (const reason of r.reasons.slice(0, 3)) console.log(`   - ${reason}`);
  }
  console.log(mismatches ? `\n${mismatches} scenario(s) did not match the expected decision.` : '\nAll scenarios behaved as expected.');
  process.exitCode = mismatches ? 1 : 0;
}

main().catch((err) => {
  const hint = /token/i.test(err.message)
    ? 'The server has ADMIN_TOKEN set. Run: ADMIN_TOKEN=<your token> npm run demo'
    : `Is the server running at ${BASE}? (npm start)`;
  console.error(`Could not run the demo: ${err.message}\n${hint}`);
  process.exit(1);
});
