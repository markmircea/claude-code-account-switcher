// Replay test: the request that HITS the limit must still be served, by the next account, with the
// client never seeing the 429. Driven against a fake upstream, so it is free, deterministic, and
// cannot touch your real quota. You WILL see a Windows toast — that is the notification working.
//
// Sequence: pin A -> fake upstream answers A with a quota-shaped 429 (unified headers + reset) ->
// gateway must park A, replay once on B, and return B's 200 to the client.

import fs from 'node:fs';
import http from 'node:http';
import { loadConfig, saveConfig, CONFIG_PATH, ACCOUNT_STATE_PATH, LOG_PATH } from './config.mjs';

let fail = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `  - ${d}` : ''}`); if (!c) fail++; };

const cfg0 = loadConfig();
const orig = { upstream: cfg0.upstream, active: cfg0.active };
// Snapshot the WHOLE config, not just the fields this test changes. The fake upstream's org header
// was written through into B's real identity by observeQuota, and `cla-gw doctor` found
// `11111111-test-org-B` sitting in the live config days later. Tests must not leak into state.
const configSnapshot = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : null;
const stateSnapshot = fs.existsSync(ACCOUNT_STATE_PATH) ? fs.readFileSync(ACCOUNT_STATE_PATH, 'utf8') : null;
const logLenBefore = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8').length : 0;

const RESET_EPOCH = Math.round((Date.now() + 3600_000) / 1000);
let hits = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const bearer = (req.headers.authorization || '').slice(-6);
    hits.push(bearer);
    if (hits.length === 1) {
      // Quota-shaped rejection: the shape that carries an epoch, i.e. park until it.
      res.writeHead(429, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-7d-status': 'rejected',
        'anthropic-ratelimit-unified-7d-utilization': '1.05',
        'anthropic-ratelimit-unified-7d-reset': String(RESET_EPOCH),
        'anthropic-ratelimit-unified-representative-claim': 'seven_day',
        'anthropic-organization-id': '00000000-test-org-A',
        'retry-after': '3600',
        'x-should-retry': 'true',
      });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error',
        message: "This request would exceed your account's rate limit. Please try again later." } }));
    }
    res.writeHead(200, { 'content-type': 'application/json',
      'anthropic-organization-id': '11111111-test-org-B',
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.3',
      'anthropic-ratelimit-unified-status': 'allowed' });
    res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'SERVED_BY_BACKUP' }], model: 'fake' }));
  });
});

// Watchdog: a hung test must never leave the live gateway pointing at a fake upstream. That already
// happened once, so cleanup lives in `finally` AND a hard exit timer backs it up.
const watchdog = setTimeout(() => {
  console.log('WATCHDOG: test did not finish in 40s; forcing cleanup and exit');
  try { fake.closeAllConnections?.(); fake.close(); } catch { /* already gone */ }
  restore();
  process.exit(1);
}, 40000);

function restore() {
  // Cleanup that can throw is worse than no cleanup: this one threw (an undeclared variable) and
  // left the LIVE gateway pointing at a fake upstream, which would 502 every real request.
  try {
    if (configSnapshot !== null) fs.writeFileSync(CONFIG_PATH, configSnapshot);
    else { const c = loadConfig(); c.upstream = orig.upstream; c.active = orig.active; saveConfig(c); }
    if (stateSnapshot !== null) fs.writeFileSync(ACCOUNT_STATE_PATH, stateSnapshot);
    else fs.rmSync(ACCOUNT_STATE_PATH, { force: true });
    console.log(`config + account state restored from snapshot (upstream ${orig.upstream}, pin ${orig.active})`);
  } catch (e) {
    try {
      const c = loadConfig(); c.upstream = orig.upstream; c.active = orig.active; saveConfig(c);
    } catch { /* nothing left to try */ }
    console.log(`restore threw (${e.message}); upstream forced back to ${orig.upstream}`);
  }
}

try {
  await new Promise((resolve) => fake.listen(8793, '127.0.0.1', resolve));

  // Clean slate: A must look healthy, otherwise selection would pick B up front and the 429 we are
  // trying to test would never happen.
  fs.rmSync(ACCOUNT_STATE_PATH, { force: true }); // a real reset: the gateway hot-reloads state now
  // Pin the FIRST ENABLED account, not the literal 'A': A is out of rotation now, and pinning a
  // disabled account makes selection fall through to the pool, which silently retargets every
  // expectation below (that is what this test's failures were, not a routing bug).
  const c = loadConfig();
  const [first, second] = c.accounts.filter((a) => a.enabled !== false).map((a) => a.label);
  if (!second) { console.log('SKIP: this test needs two accounts in rotation'); process.exit(0); }
  c.upstream = 'http://127.0.0.1:8793';
  c.active = first;
  saveConfig(c);
  await new Promise((r) => setTimeout(r, 1100));

  const r = await fetch(`http://${cfg0.host}:${cfg0.port}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg0.secret}`, 'content-type': 'application/json',
               'anthropic-version': '2023-06-01', 'x-claude-code-session-id': 'replay-test' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 8,
                           messages: [{ role: 'user', content: 'replay me' }] }),
  });
  const j = await r.json().catch(() => ({}));
  const text = (j.content || []).map((x) => x.text || '').join('');

  ok('client got 200, not the 429', r.status === 200, `status=${r.status}`);
  ok('client got the backup account answer', text === 'SERVED_BY_BACKUP', `text="${text}"`);
  ok('exactly two upstream attempts (replayed once, no retry storm)', hits.length === 2, `attempts=${hits.length}`);
  ok('the two attempts used different credentials', hits[0] !== hits[1], `${hits[0]} vs ${hits[1]}`);

  const newLog = fs.readFileSync(LOG_PATH, 'utf8').slice(logLenBefore);
  const events = newLog.trim().split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const replay = events.find((e) => e.event === 'failover-replay');
  ok('replay was logged with from/to', replay?.from === first && replay?.to === second,
     replay ? `${replay.from} -> ${replay.to} because ${replay.upstreamStatus}` : 'no failover-replay entry');
  const served = events.filter((e) => e.account).pop();
  ok('final account recorded as the backup', served?.account === second, `account=${served?.account} status=${served?.status}`);
  ok('replay recorded the reason (which window)', replay?.claim === 'seven_day', `claim=${replay?.claim}`);

  const st = JSON.parse(fs.readFileSync(ACCOUNT_STATE_PATH, 'utf8'));
  ok('the refusing account parked until the epoch the headers stated', (st[first]?.blockedUntil || 0) > Date.now() &&
     Math.abs(st[first].blockedUntil - RESET_EPOCH * 1000) < 5000,
     st[first]?.blockedUntil ? new Date(st[first].blockedUntil).toLocaleString() : 'not parked');
  ok('it parked for quota, not as a blip', st[first]?.parkReason === 'quota', `parkReason=${st[first]?.parkReason}`);
  ok('the backup account identified by org from the fake response', st[second]?.org === '11111111-test-org-B', `org=${st[second]?.org}`);
} finally {
  clearTimeout(watchdog);
  // closeAllConnections first: server.close() alone waits for keep-alive sockets, and the gateway
  // holds one - that hang is what left the live config pointing at this fake server.
  try { fake.closeAllConnections?.(); } catch { /* older node */ }
  fake.close();
  restore();
}
console.log(fail ? `\n${fail} check(s) failed` : '\nmid-request failover verified: the request that hits the limit is still served');
process.exit(fail ? 1 : 0);
