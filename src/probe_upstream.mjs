// probe_upstream.mjs — a stand-in api.anthropic.com for the usage-limit auto-resume probe.
//
// WHY THIS EXISTS
// Claude Code has a built-in "wait for the claude.ai usage limit to reset, then continue the task"
// state machine (autoContinueAtUsageLimit). Whether it is *eligible* depends on how the session is
// authenticated: with a gateway credential (ANTHROPIC_AUTH_TOKEN) present the client treats itself
// as a non-subscription session and the whole feature is off. We need that proven before changing
// the live activation, so this file lets a real Claude Code session be pointed at a server that
// says "you are out of usage, it resets in N seconds" and then says "you are fine again".
//
// NOTHING HERE IS LIVE: no real upstream, no real quota, no env vars written, nothing in
// %LOCALAPPDATA%\claude-gw. It binds 127.0.0.1 only and answers whatever credential the client
// happens to send — the credential itself is what is under test.
//
// What the client learns the limit from (established by reading the 2.1.305 bundle, and confirmed
// by our own gateway log, which shows the client only ever calls /v1/messages*, /v1/models and
// never /api/oauth/usage in gateway mode):
//   * the unified rate-limit HEADERS on every /v1/messages response
//     (anthropic-ratelimit-unified-status / -5h-status / -5h-reset / -representative-claim)
//   * plus a 429 whose error type is rate_limit_error.
// So the fake has to be faithful about those two things and nothing else.
//
// Usage:
//   node src/probe_upstream.mjs start [--port 8791]        # detached listener + control file
//   node src/probe_upstream.mjs stop
//   node src/probe_upstream.mjs status
//   node src/probe_upstream.mjs ctl [--healthy] [--limit-now] [--reset-in 150]
//   node src/probe_upstream.mjs tail [--follow]
//   node src/probe_upstream.mjs selftest                   # prove the shapes without a client

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Deliberately inside the repo, never %LOCALAPPDATA%\claude-gw: the probe must not be able to
// disturb the real gateway's config, vault, state or log.
export const PROBE_DIR = path.join(HERE, '..', '.probe');
const CONTROL_PATH = path.join(PROBE_DIR, 'control.json');
const LOG_PATH = path.join(PROBE_DIR, 'requests.jsonl');
const PID_PATH = path.join(PROBE_DIR, 'upstream.pid');
const PORT = 8791;

const ORG = 'probe-org-not-real';

// ---------- control ----------
// phase: 'healthy' | 'limited'
// limitedAt/resetAt: epoch *seconds* (Anthropic's reset headers are in seconds).
function readControl() {
  try { return JSON.parse(fs.readFileSync(CONTROL_PATH, 'utf8')); }
  catch { return { phase: 'healthy' }; }
}
function writeControl(c) {
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  fs.writeFileSync(CONTROL_PATH, JSON.stringify(c, null, 2));
  return c;
}
// The phase is derived, not stored as a clock: `limited` holds until its reset epoch passes, which
// is exactly how the real window behaves and lets us watch the client wait.
function effectivePhase(c, nowSec = Math.floor(Date.now() / 1000)) {
  if (c.phase === 'healthy') return { phase: 'healthy' };
  if (c.limitedAt && nowSec < c.limitedAt) return { phase: 'healthy', startsLimitedAt: c.limitedAt };
  if (c.resetAt && nowSec >= c.resetAt) return { phase: 'healthy', wasLimitedUntil: c.resetAt };
  return { phase: 'limited' };
}

// ---------- logging (never a token) ----------
function credKind(v) {
  if (!v) return 'none';
  const s = String(v).replace(/^Bearer\s+/i, '');
  // Prefix classification only. We need to know WHICH credential the client decided to send
  // (oauth/setup-token vs API key vs our local secret), not the credential itself.
  if (s.startsWith('sk-ant-oat')) return 'bearer:oauth-or-setup-token';
  if (s.startsWith('sk-ant-api')) return 'bearer:api-key';
  if (s.length <= 64) return `bearer:opaque(len=${s.length})`;
  return `bearer:other(len=${s.length})`;
}
function log(rec) {
  try { fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: Date.now(), ...rec }) + '\n'); }
  catch { /* logging must never break the probe */ }
}

// ---------- response shapes ----------
function quotaHeaders(c, phase, nowSec) {
  const resetAt = c.resetAt || nowSec + 3600;
  const h = {
    'anthropic-organization-id': ORG,
    'request-id': `probe-${Math.random().toString(36).slice(2, 12)}`,
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-5h-utilization': phase === 'limited' ? '1' : '0.42',
    'anthropic-ratelimit-unified-5h-status': phase === 'limited' ? 'rejected' : 'allowed',
    'anthropic-ratelimit-unified-5h-reset': String(resetAt),
    'anthropic-ratelimit-unified-7d-utilization': '0.11',
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-7d-reset': String(nowSec + 5 * 86400),
    'anthropic-ratelimit-unified-status': phase === 'limited' ? 'rejected' : 'allowed',
    'anthropic-ratelimit-unified-reset': String(resetAt),
  };
  if (phase === 'limited') {
    h['retry-after'] = String(Math.max(1, (resetAt || nowSec + 60) - nowSec));
    // The real limit message the user sees is rendered from these headers, so mirror the shape the
    // pool actually produced last night: overage rejected because the account is out of credits.
    h['anthropic-ratelimit-unified-overage-status'] = 'rejected';
    h['anthropic-ratelimit-unified-overage-disabled-reason'] = 'out_of_credits';
  }
  return h;
}

function sse(res, obj) {
  res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
}

function streamOk(res, reqInfo, model) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    ...quotaHeaders(readControl(), 'healthy', Math.floor(Date.now() / 1000)),
  });
  const id = `probe_msg_${Math.random().toString(36).slice(2, 10)}`;
  sse(res, { type: 'message_start', message: {
    id, type: 'message', role: 'assistant', model: model || 'claude-probe',
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 12, cache_read_input_tokens: 0, output_tokens: 1 },
  } });
  sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  const text = `[probe ${reqInfo}] the stand-in upstream answered this request. If you are reading this in a chat, that chat is talking to the probe, not to Anthropic.`;
  for (const chunk of text.match(/.{1,24}/gs) || [text]) {
    sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } });
    // A ping mid-stream: the real API does this, and it keeps any idle-timeout assumption honest.
    sse(res, { type: 'ping' });
  }
  sse(res, { type: 'content_block_stop', index: 0 });
  sse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 40 } });
  sse(res, { type: 'message_stop' });
  res.end();
}

function limited(res, c, nowSec) {
  const body = JSON.stringify({ type: 'error',
    error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } });
  res.writeHead(429, {
    'content-type': 'application/json',
    'x-should-retry': 'true',
    ...quotaHeaders(c, 'limited', nowSec),
  });
  res.end(body);
}

// ---------- handler ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  let raw = '';
  await new Promise((r) => {
    req.on('data', (d) => { raw += d; if (raw.length < 4_000_000) return; req.destroy(); r(); });
    req.on('end', r);
    req.on('error', r);
  });

  let model = null, stream = null;
  if (raw) { try { const j = JSON.parse(raw); model = j.model ?? null; stream = j.stream ?? null; } catch {} }

  const info = {
    cred: credKind(req.headers.authorization || req.headers['x-api-key']),
    beta: req.headers['anthropic-beta'] || null,
    version: req.headers['anthropic-version'] || null,
    session: req.headers['x-claude-code-session-id'] || null,
    app: req.headers['x-app'] || null,
    ua: (req.headers['user-agent'] || '').slice(0, 60),
    // The client's own per-request timeout and retry counter. These are the real ceiling on any
    // gateway-side hold: a hold longer than x-stainless-timeout is a hold the client has already
    // abandoned, and x-stainless-retry-count tells us whether a "retry" is the client's SDK or its
    // usage-limit state machine.
    timeoutHdr: req.headers['x-stainless-timeout'] || null,
    retryCount: req.headers['x-stainless-retry-count'] || null,
    runtime: req.headers['x-stainless-runtime-version'] || null,
    // Stage 2 of the probe moves the gateway's local secret here, so watch for it.
    customHeaderNames: Object.keys(req.headers).filter((k) => /^x-/.test(k)).join(','),
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const c = readControl();
  const eff = effectivePhase(c, nowSec);

  if (p === '/v1/messages' || p === '/v1/messages/count_tokens' || p.startsWith('/v1/messages')) {
    const isCount = p.includes('count_tokens');
    if (!isCount && eff.phase === 'limited') {
      log({ ev: 'messages', path: p, model, stream, ...info, out: '429 limited', resetsAt: c.resetAt });
      return limited(res, c, nowSec);
    }
    if (isCount) {
      res.writeHead(200, { 'content-type': 'application/json',
        ...quotaHeaders(c, eff.phase, nowSec) });
      log({ ev: 'count_tokens', path: p, model, ...info, out: '200' });
      return res.end(JSON.stringify({ input_tokens: 1234 }));
    }
    log({ ev: 'messages', path: p, model, stream, ...info, out: '200 stream' });
    return streamOk(res, `t+${nowSec}`, model);
  }

  if (p === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    log({ ev: 'models', path: p, ...info, out: '200' });
    return res.end(JSON.stringify({
      data: [
        { type: 'model', id: 'claude-opus-5-5', display_name: 'Opus 5.5', created_at: '2026-01-01T00:00:00Z' },
        { type: 'model', id: 'claude-sonnet-4-5', display_name: 'Sonnet 4.5', created_at: '2025-01-01T00:00:00Z' },
        { type: 'model', id: 'claude-haiku-4-5', display_name: 'Haiku 4.5', created_at: '2025-01-01T00:00:00Z' },
      ],
      has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-haiku-4-5',
    }));
  }

  // Whether the client calls this at all is itself a finding: in gateway mode ours never saw it.
  res.writeHead(404, { 'content-type': 'application/json' });
  log({ ev: 'other', path: p, method: req.method, ...info, out: '404' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error',
    message: `probe upstream: no route for ${p}` } }));
}

// ---------- process management ----------
function runningPid() {
  try {
    const pid = Number(fs.readFileSync(PID_PATH, 'utf8'));
    if (!pid) return 0;
    // Kill-free liveness check on Windows: probe the port instead.
    return pid;
  } catch { return 0; }
}

async function start(port = PORT) {
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log({ ev: 'probe-error', err: String(e?.message).slice(0, 200) });
      try { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}'); } catch {}
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise((r, j) => { server.once('error', j); server.listen(port, '127.0.0.1', r); });
  fs.writeFileSync(PID_PATH, String(process.pid));
  console.log(`probe upstream listening on http://127.0.0.1:${port}`);
  console.log(`  control: ${CONTROL_PATH}`);
  console.log(`  log:     ${LOG_PATH}`);
  const shutdown = () => { try { fs.unlinkSync(PID_PATH); } catch {} process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'start';
  const flag = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? dflt : argv[i + 1];
  };
  const port = Number(flag('port', PORT));

  if (cmd === 'start') {
    if (argv.includes('--detach')) {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'start', '--port', String(port)],
        { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      console.log(`probe upstream started (pid ${child.pid}) on http://127.0.0.1:${port}`);
      return;
    }
    return start(port);
  }

  if (cmd === 'stop') {
    const pid = runningPid();
    if (!pid) return console.log('probe upstream: not running');
    try { process.kill(pid); console.log(`probe upstream stopped (pid ${pid})`); }
    catch (e) { console.log(`could not stop pid ${pid}: ${e.message}`); }
    try { fs.unlinkSync(PID_PATH); } catch {}
    return;
  }

  if (cmd === 'status') {
    const c = readControl();
    const eff = effectivePhase(c);
    console.log(`control: ${JSON.stringify(c)}`);
    console.log(`answering now: ${eff.phase}${eff.phase === 'limited' ? ` until ${new Date((c.resetAt || 0) * 1000).toLocaleString()}` : ''}`);
    try { console.log(`requests logged: ${fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean).length}`); }
    catch { console.log('requests logged: 0'); }
    return;
  }

  if (cmd === 'ctl') {
    const now = Math.floor(Date.now() / 1000);
    if (argv.includes('--healthy')) return console.log(JSON.stringify(writeControl({ phase: 'healthy' }), null, 2));
    const resetIn = flag('reset-in', null);
    const limitIn = flag('limit-in', null);
    const c = { phase: 'limited' };
    if (limitIn !== null) c.limitedAt = now + Number(limitIn);
    if (resetIn !== null) c.resetAt = now + Number(resetIn);
    return console.log(JSON.stringify(writeControl(c), null, 2));
  }

  if (cmd === 'tail') {
    const follow = argv.includes('--follow');
    let pos = 0;
    if (!follow) pos = 0;
    const dump = () => {
      let raw = '';
      try { raw = fs.readFileSync(LOG_PATH, 'utf8'); } catch { return; }
      if (raw.length === pos) return;
      for (const line of raw.slice(pos).split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          console.log(`${new Date(r.ts).toLocaleTimeString()} ${r.ev || r.err} ${r.path || ''} -> ${r.out || ''}` +
            `${r.model ? ` model=${r.model}` : ''} cred=${r.cred || '-'} beta=${(r.beta || '-').slice(0, 70)}` +
            `${r.resetsAt ? ` resetsAt=${new Date(r.resetsAt * 1000).toLocaleTimeString()}` : ''}`);
        } catch { console.log(line); }
      }
      pos = raw.length;
    };
    dump();
    if (follow) { const t = setInterval(dump, 700); process.on('SIGINT', () => { clearInterval(t); process.exit(0); }); }
    return;
  }

  if (cmd === 'selftest') {
    // Prove the two shapes against the running probe with no Claude Code involved.
    const base = `http://127.0.0.1:${port}`;
    const now = Math.floor(Date.now() / 1000);
    const hit = async (label) => {
      const r = await fetch(`${base}/v1/messages?beta=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer selftest',
          'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 32, stream: true,
          messages: [{ role: 'user', content: 'probe selftest' }] }),
      });
      const txt = await r.text();
      console.log(`${label}: HTTP ${r.status}  unified=${r.headers.get('anthropic-ratelimit-unified-status')}` +
        ` 5h=${r.headers.get('anthropic-ratelimit-unified-5h-status')}` +
        ` reset=${r.headers.get('anthropic-ratelimit-unified-5h-reset')}` +
        ` retry-after=${r.headers.get('retry-after')}`);
      console.log(`  body: ${txt.slice(0, 120).replace(/\n/g, ' ')}`);
      return r;
    };
    writeControl({ phase: 'healthy' });
    await hit('healthy   ');
    writeControl({ phase: 'limited', resetAt: now + 5 });
    await hit('limited   ');
    console.log('  ...waiting out the fake window (5s)...');
    await new Promise((r) => setTimeout(r, 6000));
    await hit('after-reset');
    writeControl({ phase: 'healthy' });
    console.log('selftest control restored to healthy.');
    return;
  }

  console.log('commands: start [--detach] | stop | status | ctl [--healthy|--limit-in N|--reset-in N] | tail [--follow] | selftest');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error('probe upstream failed:', e.message); process.exit(1); });
}
