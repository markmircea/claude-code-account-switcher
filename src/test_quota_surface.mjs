// test_quota_surface.mjs — the two behaviours that make Claude Code's own "wait for the usage limit
// and continue" work correctly behind a two-account pool.
//
//   1. QUOTA SHIM: a session that sees a 429 arms a timer for the reset epoch in that response's
//      rate-limit headers and then stops asking. It does not know a second account exists. If the
//      account that refused reopens LATER than a mate, the client must be told the earlier time.
//   2. BOUNDED HOLD: pool refuses, but reopens within seconds (last night: C filled 1:02, B 1:03).
//      Surfacing a limit message there starts a wait we could have skipped.
//
// Hermetic: a fake upstream and a gateway child pointed at a throwaway data dir under .probe/. The
// real config, vault, state and log in %LOCALAPPDATA%\claude-gw are never read or written.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { poolOpening, poolQuotaShim, isInferencePath } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_DATA = path.join(HERE, '..', '.probe', 'testdata');
const GW_PORT = 8795;
const FAKE_PORT = 8796;
const SECRET = 'test-secret-not-a-real-one';
const UPSTREAM_DIR = path.join(TEST_DATA, 'claude-gw');

let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  - ${detail}` : ''}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- fake upstream
// Scripted per test: `script` is a list of responses returned in order.
let script = [];
const seen = [];
function fakeUpstream() {
  return new Promise((resolve) => {
    const s = http.createServer(async (req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      await new Promise((r) => req.on('end', r));
      seen.push({ path: req.url, auth: req.headers.authorization || null });
      const next = script.shift() || { status: 200, headers: { 'anthropic-ratelimit-unified-status': 'allowed' }, body: '{}' };
      if (next.status === 200 && req.url.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...(next.headers || {}) });
        res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"x","type":"message","role":"assistant","model":"m","content":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
          + 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
        return;
      }
      res.writeHead(next.status, { 'content-type': 'application/json', ...(next.headers || {}) });
      res.end(next.body ?? '{}');
    });
    s.listen(FAKE_PORT, '127.0.0.1', () => resolve(s));
  });
}

function writeFixture(state) {
  fs.rmSync(TEST_DATA, { recursive: true, force: true });
  fs.mkdirSync(UPSTREAM_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPSTREAM_DIR, 'config.json'), JSON.stringify({
    host: '127.0.0.1', port: GW_PORT, upstream: `http://127.0.0.1:${FAKE_PORT}`,
    secret: SECRET, secretHeader: 'x-gw-secret', swapInferenceOnly: true, holdMaxMs: 4000,
    active: null,
    // cli-credential is the one kind resolvable without copying the vault; the fake upstream never
    // checks what it is given.
    accounts: [{ label: 'B', kind: 'cli-credential' }, { label: 'C', kind: 'cli-credential' }],
  }, null, 2));
  fs.writeFileSync(path.join(UPSTREAM_DIR, 'accounts_state.json'), JSON.stringify(state));
}

function startGw() {
  const child = spawn(process.execPath, [path.join(HERE, 'gw.mjs')], {
    env: { ...process.env, LOCALAPPDATA: TEST_DATA },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => console.log(`  gw stderr: ${String(d).trim()}`));
  return child;
}

async function call(pathname, { headerSecret = SECRET, bearer = 'Bearer client-own-login', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (headerSecret !== null) headers['x-gw-secret'] = headerSecret;
  if (bearer !== null) headers.authorization = bearer;
  const r = await fetch(`http://127.0.0.1:${GW_PORT}${pathname}`, {
    method: pathname === '/v1/models' ? 'GET' : 'POST',
    headers, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text };
}

function readLog() {
  try {
    return fs.readFileSync(path.join(UPSTREAM_DIR, 'gateway.jsonl'), 'utf8').trim().split('\n')
      .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  } catch { return []; }
}

async function main() {
  // ---------------- pure rules first (no sockets) ----------------
  ok(isInferencePath('/v1/messages') && isInferencePath('/v1/messages/count_tokens')
     && !isInferencePath('/v1/models') && !isInferencePath('/api/hello'),
     'only /v1/messages* counts as inference');

  const cfg = { accounts: [{ label: 'B', enabled: true }, { label: 'C', enabled: true }], active: null };
  const now = Date.now();
  const st = {
    B: { s5h: 'rejected', r5h: Math.floor((now + 2 * 3600e3) / 1000) },
    C: { s5h: 'rejected', r5h: Math.floor((now + 30e3) / 1000) },
  };
  const open = poolOpening(cfg, st, now);
  ok(open.label === 'C' && Math.abs(open.readyAt - (now + 30e3)) < 1000,
     'poolOpening picks the account that frees soonest', `${open.label} @ +${((open.readyAt - now) / 1000) | 0}s`);

  const shim = poolQuotaShim(cfg, st, 'B', now);
  ok(!!shim && shim.via === 'C', 'shim fires when the refusing account reopens later than a mate',
    `B reopens +${((shim.refusedReadyAt - now) / 1000) | 0}s, pool opens +${shim.retryAfter}s via ${shim.via}`);
  ok(poolQuotaShim(cfg, st, 'C', now) === null, 'no shim when the refusing account IS the soonest');
  ok(poolQuotaShim(cfg, { B: {}, C: st.C }, 'B', now) === null, 'no shim when the refusing account is not blocked');

  // ---------------- end-to-end ----------------
  const fake = await fakeUpstream();
  let gw = null;
  try {
    // 1. auth: header secret, legacy bearer secret, and a wrong one
    writeFixture({});
    gw = startGw();
    await sleep(1500);
    script = [{ status: 200, headers: { 'anthropic-ratelimit-unified-status': 'allowed' } }];
    let r = await call('/v1/messages?beta=true', { bearer: null });
    ok(r.status === 200, 'x-gw-secret header authenticates', `HTTP ${r.status}`);
    script = [{ status: 200, headers: { 'anthropic-ratelimit-unified-status': 'allowed' } }];
    r = await call('/v1/messages?beta=true', { headerSecret: null, bearer: `Bearer ${SECRET}` });
    ok(r.status === 200, 'legacy bearer secret still works (transition window)', `HTTP ${r.status}`);
    script = [{ status: 200 }];
    r = await call('/v1/messages?beta=true', { headerSecret: 'wrong', bearer: 'Bearer x' });
    ok(r.status === 401, 'wrong secret is refused', `HTTP ${r.status}`);

    // 2. passthrough: /v1/models keeps the client's own credential; /v1/messages gets re-signed
    seen.length = 0;
    script = [{ status: 200, body: '{"data":[]}' }, { status: 200, headers: { 'anthropic-ratelimit-unified-status': 'allowed' } }];
    r = await call('/v1/models', { bearer: 'Bearer my-claude-ai-login' });
    ok(r.status === 200, 'non-inference call passes through', `HTTP ${r.status}`);
    const authSeen = seen.map((s) => s.auth);
    ok(authSeen[0] === 'Bearer my-claude-ai-login', 'model listing keeps the client login, not a vault token', String(authSeen[0]));
    ok(!authSeen.some((a) => a && a.includes(SECRET)), 'the local secret never reaches upstream');
    await call('/v1/messages?beta=true', { bearer: 'Bearer my-claude-ai-login' });
    ok(seen[1].auth !== 'Bearer my-claude-ai-login', '/v1/messages IS re-signed with a pool credential', String(seen[1].auth).slice(0, 18) + '...');

    // 3. quota shim: B looked fine, B refused until +2h, C was already known to reopen in 60s.
    //    The client must be told 60s, because that is when WE can serve it.
    writeFixture({
      B: {},
      C: { s5h: 'rejected', r5h: nowSec() + 60, unifiedStatus: 'rejected', reset: nowSec() + 60 },
    });
    await sleep(1600); // let the gateway hot-reload the state file
    script = [{
      status: 429,
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-reset': String(nowSec() + 7200),
        'anthropic-ratelimit-unified-reset': String(nowSec() + 7200),
        'retry-after': '7200',
      },
      body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } }),
    }, { status: 200, headers: { 'anthropic-ratelimit-unified-status': 'allowed' } }];
    r = await call('/v1/messages?beta=true', { body: { model: 'claude-opus-5-5', stream: true, messages: [] } });
    const told5h = Number(r.headers.get('anthropic-ratelimit-unified-5h-reset'));
    const toldRetry = Number(r.headers.get('retry-after'));
    ok(r.status === 429, 'both-restricted still surfaces a real 429 (never a silent hang)', `HTTP ${r.status}`);
    ok(r.text.includes('rate_limit_error'), 'the limit body is untouched', r.text.slice(0, 60));
    ok(Math.abs(told5h - (nowSec() + 60)) < 5, 'the client is told when the POOL reopens, not the refusing account',
      `was ${nowSec() + 7200}, now +${told5h - nowSec()}s`);
    ok(toldRetry > 0 && toldRetry <= 62, 'retry-after shortened to match', String(toldRetry));
    ok(r.headers.get('anthropic-ratelimit-unified-5h-status') === 'rejected', 'statuses stay honest (still a limit)',
      String(r.headers.get('anthropic-ratelimit-unified-5h-status')));
    const logs = readLog();
    const shimRec = logs.find((l) => l.quotaShim);
    ok(!!shimRec, 'the shim is recorded in the log (auditable, not silent)',
      shimRec ? `via ${shimRec.quotaShim.via}, refusedReadyAt ${new Date(shimRec.quotaShim.refusedReadyAt).toLocaleTimeString()}` : '');

    // 4. bounded hold: everyone restricted for ~3s. Hold, then serve. No limit message at all.
    writeFixture({
      B: { s5h: 'rejected', r5h: nowSec() + 3, unifiedStatus: 'rejected', reset: nowSec() + 3 },
      C: { s5h: 'rejected', r5h: nowSec() + 3, unifiedStatus: 'rejected', reset: nowSec() + 3 },
    });
    await sleep(900);
    script = [
      { status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-reset': String(nowSec() + 3),  'retry-after': '3' },
        body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } }) },
      { status: 200, headers: { 'anthropic-ratelimit-unified-status': 'allowed' } },
    ];
    const t0 = Date.now();
    r = await call('/v1/messages?beta=true', { body: { model: 'claude-opus-5-5', stream: true, messages: [] } });
    const waited = Date.now() - t0;
    ok(r.status === 200, 'a pool that frees within the hold window serves the request instead of erroring',
      `HTTP ${r.status} after ${waited}ms`);
    ok(waited > 1000, 'it waited for the window instead of replaying instantly', `${waited}ms`);
    ok(readLog().some((l) => l.event === 'hold'), 'the hold is recorded', `waited ${waited}ms`);

    // 5. an unwaitably-far reset must NOT be turned into a hold (never stall a chat for hours)
    writeFixture({
      B: { s5h: 'rejected', r5h: nowSec() + 7200, unifiedStatus: 'rejected', reset: nowSec() + 7200 },
      C: { s5h: 'rejected', r5h: nowSec() + 7200, unifiedStatus: 'rejected', reset: nowSec() + 7200 },
    });
    await sleep(1600);
    script = [{ status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': String(nowSec() + 7200),  'retry-after': '7200' },
      body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } }) },
      { status: 200 }];
    const t1 = Date.now();
    r = await call('/v1/messages?beta=true', { body: { model: 'claude-opus-5-5', stream: true, messages: [] } });
    ok(r.status === 429 && Date.now() - t1 < 3000, 'a 2h-away reset fails fast, it is not held open',
      `HTTP ${r.status} in ${Date.now() - t1}ms`);
  } finally {
    if (gw) try { gw.kill(); } catch {}
    fake.close();
    fs.rmSync(TEST_DATA, { recursive: true, force: true });
  }

  console.log(`\n${fail ? `${fail} FAILED, ` : ''}${pass} passed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('test crashed:', e); process.exit(1); });
