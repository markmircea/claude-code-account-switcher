// Sticky routing, end to end: a real gateway process against a fake upstream, in a THROWAWAY data
// dir. Nothing here touches your live config, state, log, vault or quota, and no real token is sent.
//
// The rule under test: switch accounts ONLY when the one in use is blocked by a full 5h or weekly
// window. High usage never switches, recovery never switches back, and a 429 that is not a full
// window is a one-request detour that leaves the current account where it is.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gw-sticky-'));
process.env.LOCALAPPDATA = SCRATCH; // config.mjs derives DATA_DIR from this at import time
process.env.CLAUDE_GW_NO_NOTIFY = '1';
const { DATA_DIR, CONFIG_PATH, ACCOUNT_STATE_PATH, LOG_PATH } = await import('./config.mjs');
const { vaultPut } = await import('./vault.mjs');

let fail = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `  - ${d}` : ''}`); if (!c) fail++; };

const GW_PORT = 18794, UP_PORT = 18795, SECRET = 'sticky-test-secret';
const epoch = (ms) => Math.ceil((Date.now() + ms) / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What the fake upstream answers, per account. Each step swaps these.
const healthy = (u5h) => ({ status: 200, headers: {
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-status': 'allowed', 'anthropic-ratelimit-unified-5h-utilization': String(u5h),
  'anthropic-ratelimit-unified-7d-status': 'allowed', 'anthropic-ratelimit-unified-7d-utilization': '0.1' } });
const full5h = (resetInMs) => ({ status: 429, headers: {
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-utilization': '1.0',
  'anthropic-ratelimit-unified-5h-reset': String(epoch(resetInMs)),
  'anthropic-ratelimit-unified-representative-claim': 'five_hour' } });
const headerless429 = () => ({ status: 429, headers: {} });
let plan = {};
let hits = [];

const fake = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const who = (req.headers.authorization || '').endsWith('fake-token-A') ? 'A' : 'B';
    hits.push(who);
    const p = plan[who];
    res.writeHead(p.status, { 'content-type': 'application/json', ...p.headers });
    res.end(JSON.stringify(p.status === 200
      ? { id: 'msg_test', type: 'message', role: 'assistant', content: [{ type: 'text', text: `SERVED_BY_${who}` }] }
      : { type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }));
  });
});

let gw = null;
function cleanup() {
  try { gw?.kill(); } catch { /* gone */ }
  try { fake.closeAllConnections?.(); fake.close(); } catch { /* gone */ }
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
}
const watchdog = setTimeout(() => { console.log('WATCHDOG: no finish in 40s'); cleanup(); process.exit(1); }, 40000);

async function send(model = 'claude-haiku-4-5') {
  hits = [];
  const r = await fetch(`http://127.0.0.1:${GW_PORT}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const j = await r.json().catch(() => ({}));
  await sleep(100); // the log line is written when the stream closes
  const st = JSON.parse(fs.readFileSync(ACCOUNT_STATE_PATH, 'utf8'));
  const current = Object.entries(st).filter(([, a]) => a.activeAt)
    .sort((x, y) => y[1].activeAt - x[1].activeAt)[0]?.[0];
  const last = fs.readFileSync(LOG_PATH, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l))
    .filter((e) => e.account).pop();
  return { status: r.status, text: (j.content || []).map((x) => x.text || '').join(''),
           hits: hits.join(','), current, reason: last?.selectReason };
}

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    host: '127.0.0.1', port: GW_PORT, upstream: `http://127.0.0.1:${UP_PORT}`, secret: SECRET, active: null,
    accounts: [
      { label: 'A', kind: 'vault', vaultRef: 'A', enabled: true },
      { label: 'B', kind: 'vault', vaultRef: 'B', enabled: true },
    ],
  }, null, 2));
  vaultPut('A', 'fake-token-A');
  vaultPut('B', 'fake-token-B');
  // A is the account in use when the test starts.
  fs.writeFileSync(ACCOUNT_STATE_PATH, JSON.stringify({
    A: { activeAt: Date.now() - 60_000, s5h: 'allowed', s7d: 'allowed', u5h: 0.5, u7d: 0.1 },
  }));

  await new Promise((r) => fake.listen(UP_PORT, '127.0.0.1', r));
  gw = spawn(process.execPath, [path.join(HERE, 'gw.mjs')], { env: process.env, stdio: 'ignore', windowsHide: true });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await sleep(100);
    up = await fetch(`http://127.0.0.1:${GW_PORT}/__gw/health`).then((r) => r.ok, () => false);
  }
  if (!up) throw new Error('test gateway did not start');

  // 1. A's 5h window fills: this request is replayed on B, and B becomes the current account.
  plan = { A: full5h(2000), B: healthy(0.2) };
  let r = await send();
  ok('full 5h window on the current account: the request is still served', r.status === 200 &&
     r.text === 'SERVED_BY_B', `${r.status} ${r.text}`);
  ok('tried A once, replayed once on B', r.hits === 'A,B', r.hits);
  ok('B is now the current account, and the log says why', r.current === 'B' &&
     r.reason === 'switched-current-blocked', `current=${r.current} reason=${r.reason}`);

  // 2. Sticky: A is not even tried.
  r = await send();
  ok('next request goes straight to B', r.hits === 'B' && r.reason === 'sticky', `${r.hits} via ${r.reason}`);

  // 3. High usage alone never switches.
  plan.B = healthy(0.98);
  await send();
  r = await send();
  ok('B at 98% of its 5h window keeps serving', r.hits === 'B' && r.current === 'B', `${r.hits} current=${r.current}`);

  // 4. A's window clears: still no switch back while B is fine.
  plan.A = healthy(0.1);
  await sleep(3500);
  r = await send();
  ok('A recovered, traffic stays on B', r.hits === 'B', r.hits);

  // 5. A 429 that is not a full window: served elsewhere this once, current account unchanged.
  plan.B = headerless429();
  r = await send();
  ok('non-quota 429 on B: this request is served by A', r.status === 200 && r.text === 'SERVED_BY_A',
     `${r.status} ${r.text} hits=${r.hits}`);
  ok('...as a detour: B is still the current account', r.current === 'B' && r.reason === 'detour',
     `current=${r.current} reason=${r.reason}`);
  plan.B = healthy(0.98);
  r = await send('claude-sonnet-4-5'); // haiku is model-gated on B for a while after step 5
  ok('the next request is back on B', r.hits === 'B', r.hits);
} catch (e) {
  ok('test ran to completion', false, e.message);
} finally {
  clearTimeout(watchdog);
  cleanup();
}
console.log(fail ? `\n${fail} check(s) failed` : '\nsticky routing verified: accounts switch only on a full window');
process.exit(fail ? 1 : 0);
