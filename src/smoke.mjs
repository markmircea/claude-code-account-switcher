// Phase-2 smoke test. Verifies the proxy path end-to-end without changing any login.
//
// It sends ONE tiny inference request through the gateway using the CLI's own (read-only)
// credential. On this account the weekly limit is currently exhausted, so the expected outcome
// is a 429 passed straight through from upstream - which is the ideal free test, because it
// proves status/header/body pass-through. If the limit happens to have reset, it costs a
// handful of tokens (max_tokens: 8, "ping").

import { loadConfig, saveConfig, pool } from './config.mjs';

const cfg = loadConfig();
const origActive = cfg.active;
const base = `http://${cfg.host}:${cfg.port}`;
const auth = { authorization: `Bearer ${cfg.secret}` };
let fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  - ${detail}` : ''}`);
  if (!cond) fail++;
};

async function main() {
  // 1) liveness, unauthenticated, must not leak anything
  let r = await fetch(`${base}/__gw/health`).catch((e) => null);
  if (!r) { console.log('gateway not reachable - run: cla-gw start'); process.exit(1); }
  const health = await r.json();
  ok('health (no auth)', r.status === 200 && health.ok === true);
  ok('health leaks nothing secret', !JSON.stringify(health).includes(cfg.secret));

  // 2) status requires the local secret
  r = await fetch(`${base}/__gw/status`, { headers: { authorization: 'Bearer wrong' } });
  ok('wrong secret rejected', r.status === 401, `status=${r.status}`);
  r = await fetch(`${base}/__gw/status`, { headers: auth });
  const st = await r.json();
  ok('status with secret', r.status === 200 && typeof st.active === 'string', `active=${st.active}`);

  // 3) Host header guard (DNS-rebinding posture)
  r = await fetch(`${base}/__gw/health`).then((x) => x.json());
  ok('loopback host accepted', r.ok === true);

  // 4) real inference passthrough with the CLI-owned credential.
  //    Pinned deliberately: selection is pressure-based now, so an unpinned test could burn quota
  //    on - and then park - a vault account. The CLI-owned account is already quota-limited, which
  //    keeps this check free and deterministic.
  const cliAcct = cfg.accounts.find((a) => a.kind === 'cli-credential');
  if (cliAcct) {
    const c = loadConfig(); c.active = cliAcct.label; saveConfig(c);
    await new Promise((r) => setTimeout(r, 1100)); // config is hot-reloaded per request
  }
  r = await fetch(`${base}/v1/messages?beta=true`, {
    method: 'POST',
    headers: {
      ...auth,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219',
      'x-claude-code-session-id': 'smoke-test-session',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
  });
  const txt = await r.text();
  const upstreamAuthErr = txt.includes('authentication_error');
  ok('upstream reachable through gateway',
    // 200 = served, 429 = limit hit; both prove forwarding + status pass-through.
    (r.status === 200 || r.status === 429) && !upstreamAuthErr,
    `status=${r.status} requestId=${r.headers.get('request-id') || 'none'}`);
  ok('no gateway-injected auth failure', !upstreamAuthErr, upstreamAuthErr ? txt.slice(0, 160) : '');
  ok('preserves upstream content-type', /json/.test(r.headers.get('content-type') || ''), r.headers.get('content-type'));
  ok('did not double-encode body', !r.headers.get('content-encoding'), `enc=${r.headers.get('content-encoding')}`);

  // 5) empty rotation must fail fast and loudly (risk register), never stall
  const snapshot = JSON.parse(JSON.stringify(cfg));
  cfg.accounts.forEach((a) => { a.enabled = false; });
  saveConfig(cfg);
  const t0 = Date.now();
  r = await fetch(`${base}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
  });
  const empty = await r.json();
  ok('empty rotation fails fast', r.status === 503 && empty.gw?.code === 'empty-rotation' && Date.now() - t0 < 1500,
    `status=${r.status} in ${Date.now() - t0}ms code=${empty.gw?.code}`);
  saveConfig(snapshot); // restore exactly what we found
  const c2 = loadConfig(); c2.active = origActive; saveConfig(c2); // pin is restored explicitly: leaving a test pin behind has bitten us before
  const after = pool(loadConfig()).map((a) => a.label);
  ok('config restored', after.join(',') === pool(snapshot).map((a) => a.label).join(','), `pool=${after.join(',')}`);

  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('smoke error:', e.message); process.exit(1); });
