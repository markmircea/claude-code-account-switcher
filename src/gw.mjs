// claude-gw: localhost gateway that re-signs Claude Code inference with a selected account.
//
// Captured contract (PLAN.md "Proxy contract", live on 2.1.263 and 2.1.294):
//   POST /v1/messages?beta=true
//     authorization: Bearer <ANTHROPIC_AUTH_TOKEN, sent verbatim>   <- our local shared secret
//     anthropic-version / anthropic-beta                            <- must be preserved
//     x-claude-code-session-id: <uuid>                              <- per-conversation key (F22)
//     no x-api-key
// So this file does exactly one interesting thing: swap the bearer, preserve everything else,
// stream the response back untouched. Phase 2 = no failover, no retry, single account.

import http from 'node:http';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { loadConfig, saveConfig, pickAccount, pool, availability, setModelGate, classify429, LOG_PATH, PID_PATH, STATUS_PATH, ACCOUNT_STATE_PATH, readAccountState, writeAccountState, poolOpening, poolQuotaShim, applyQuotaShim, isInferencePath } from './config.mjs';
import { notifySwitch } from './notify.mjs';
import { resolveBearer, describeIdentity } from './creds.mjs';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
// undici decompresses transparently, so these must not be forwarded downstream,
// or the client will try to gunzip already-decoded bytes.
const DECODED_AWAY = new Set(['content-encoding', 'content-length']);
const MAX_BODY = 64 * 1024 * 1024;

const startedAt = Date.now();
const stats = { requests: 0, byAccount: {}, errors: 0, recent: [] };

// Per-account quota state, learned from the unified rate-limit headers that EVERY /v1/messages
// response carries (F27) - including for vault tokens, which cannot read /api/oauth/usage at all
// (F28). It costs nothing: these headers are already in the response we are forwarding.
const accountState = readAccountState();
let stateMtime = (() => { try { return fs.statSync(ACCOUNT_STATE_PATH).mtimeMs; } catch { return 0; } })();

// Config is hot-reloaded per request; state must be too, otherwise deleting accounts_state.json (a
// reset, or a test starting from a clean slate) is silently ignored by the running gateway and the
// stale in-memory copy is written straight back.
function reloadStateIfChanged() {
  let m = 0;
  try { m = fs.statSync(ACCOUNT_STATE_PATH).mtimeMs; } catch { m = 0; }
  if (m === stateMtime) return;
  stateMtime = m;
  for (const k of Object.keys(accountState)) delete accountState[k];
  Object.assign(accountState, readAccountState());
}

function persistState() {
  writeAccountState(accountState);
  try { stateMtime = fs.statSync(ACCOUNT_STATE_PATH).mtimeMs; } catch { stateMtime = 0; }
}

// primary=false for a detour (see pickAccount): it served, but must not become the sticky account.
function observeQuota(acct, hdrs, status, model = null, primary = true) {
  const s = accountState[acct.label] || (accountState[acct.label] = {});
  const n = (k) => { const v = hdrs.get(k); return v === null ? null : Number(v); };
  // Absent headers must not erase what we already learned. A fake upstream (tests) or a bare error
  // response carries none of them, and blindly assigning used to wipe good utilisation to null.
  const set = (k, v) => { if (v !== null && v !== undefined) s[k] = v; };
  s.lastSeen = Date.now();
  s.lastStatus = status;
  s.requests = (s.requests || 0) + 1;
  set('org', hdrs.get('anthropic-organization-id'));
  set('workspace', hdrs.get('anthropic-workspace-id'));
  set('u5h', n('anthropic-ratelimit-unified-5h-utilization')); set('s5h', hdrs.get('anthropic-ratelimit-unified-5h-status'));
  set('u7d', n('anthropic-ratelimit-unified-7d-utilization')); set('s7d', hdrs.get('anthropic-ratelimit-unified-7d-status'));
  set('unifiedStatus', hdrs.get('anthropic-ratelimit-unified-status'));
  set('claim', hdrs.get('anthropic-ratelimit-unified-representative-claim'));
  set('reset', n('anthropic-ratelimit-unified-reset'));
  set('r7d', n('anthropic-ratelimit-unified-7d-reset')); set('r5h', n('anthropic-ratelimit-unified-5h-reset'));
  set('overageStatus', hdrs.get('anthropic-ratelimit-unified-overage-status'));
  set('overageDisabledReason', hdrs.get('anthropic-ratelimit-unified-overage-disabled-reason'));
  set('retryAfter', n('retry-after'));

  // THREE 429 shapes exist (all observed live on these two accounts), and they must be handled
  // differently - getting this wrong takes a healthy account out of the pool for days:
  //   1. quota rejection   -> a window status says `rejected`, with reset epochs / retry-after.
  //                          Park the account until its LAST rejected window clears.
  //   2. model-level gate  -> headers present, but NO status says rejected. Observed: Sonnet rejected
  //                          on B while 7d read 80% allowed_warning, and the same token served Haiku
  //                          seconds later. The model is gated, not the account.
  //   3. headerless blip   -> the opaque {"message":"Error"}, no quota info. Short park only.
  const verdict = classify429((k) => hdrs.get(k), s, Date.now());
  const { sig } = verdict;

  if (status === 200) {
    // A served request is direct proof of capacity; any earlier park or model gate was too pessimistic.
    s.blockedUntil = 0;
    s.parkReason = null;
    s.lastGoodAt = Date.now();
    if (primary) s.activeAt = Date.now();
    if (model && s.modelGate) {
      for (const k of Object.keys(s.modelGate)) {
        if (k === model || model.startsWith(k) || k.startsWith(model)) delete s.modelGate[k];
      }
    }
    if (model && s.modelGateHits) {
      for (const k of Object.keys(s.modelGateHits)) {
        if (k === model || model.startsWith(k) || k.startsWith(model)) delete s.modelGateHits[k];
      }
    }
  } else if (status === 429 && verdict.kind === 'quota') {
    // Park to the LATEST rejected window: a request needs every window to allow, so the account is
    // usable again only when its last one clears.
    const until = Math.max(...sig.rejectedWindows.map((x) => x * 1000));
    s.blockedUntil = Math.min(Math.max(s.blockedUntil || 0, until), Date.now() + 8 * 86400000);
    s.parkReason = 'quota';
  } else if (status === 429 && verdict.kind === 'model') {
    setModelGate(s, model);
    s.soft429 = (s.soft429 || 0) + 1;
    // Deliberately does NOT set blockedUntil - the account is fine, this model is not. Parking the
    // account here used to knock out the working Haiku traffic each time Opus was tried.
    s.parkReason = null;
  } else if (status === 429) {
    s.bare429 = (s.bare429 || 0) + 1;
    s.blockedUntil = Math.max(s.blockedUntil || 0, Date.now() + (sig.retryAfter ? Math.min(sig.retryAfter, 900) * 1000 : 60_000));
    s.parkReason = 'unspecified-429';
  }

  // An inference-only token cannot tell us who it belongs to (F28), but the response names the org
  // (F29). Record it once so `cla-gw ls` can prove two accounts are actually different accounts.
  if (s.org && acct.kind === 'vault' && acct.identity?.org !== s.org) {
    const cfg2 = loadConfig();
    const row = cfg2.accounts.find((a) => a.label === acct.label);
    if (row) { row.identity = { ...(row.identity || {}), org: s.org, workspace: s.workspace }; saveConfig(cfg2); }
  }
  persistState();
}

// F22: every request carries x-claude-code-session-id, so we can report which account served
// WHICH conversation - the statusline uses this rather than a single global "active" label.
const sessions = new Map();
const MAX_SESSIONS = 60;

let lastStatusWrite = 0;
function writeStatus(cfg, force = false) {
  const now = Date.now();
  if (!force && now - lastStatusWrite < 250) return; // keep the hot path cheap
  lastStatusWrite = now;
  try {
    fs.writeFileSync(STATUS_PATH, JSON.stringify({
      ts: now,
      uptimeMs: now - startedAt,
      running: true,
      pin: cfg.active ?? null,
      pool: pool(cfg).map((a) => a.label),
      disabled: cfg.accounts.filter((a) => a.enabled === false).map((a) => a.label),
      byAccount: stats.byAccount,
      requests: stats.requests,
      errors: stats.errors,
      sessions: Array.from(sessions.entries()).slice(-25),
      accounts: accountState,
    }));
  } catch { /* status is best-effort; never fail a request over it */ }
}

function noteSession(sessionId, account, status) {
  if (!sessionId) return;
  sessions.set(sessionId, { account, status, ts: Date.now() });
  if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
}

function eq(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Log WHICH KIND of credential the client presented, never the credential. This is how we can see
// whether a session is in subscription mode (its own claude.ai login) or legacy gateway-key mode -
// which is the difference between Claude Code offering to wait out a usage limit and not.
function credKind(v) {
  if (!v) return 'none';
  const s = String(v).replace(/^Bearer\s+/i, '');
  if (s.startsWith('sk-ant-oat')) return 'login:oauth-or-setup-token';
  if (s.startsWith('sk-ant-api')) return 'login:api-key';
  return `login:opaque(${s.length})`;
}

function logLine(rec) {
  // Never log tokens, secrets, or authorization values.
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(rec) + '\n');
  } catch { /* logging must never break a request */ }
}

function errRes(res, status, type, message, code) {
  const body = JSON.stringify({ type: 'error', error: { type, message }, gw: { code } });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    // Deliberately non-retryable for auth/config faults, so the CLI fails fast instead of
    // walking its retry ladder while the user watches a spinner (PLAN.md risk: empty rotation).
    'x-should-retry': String(status >= 500 && status !== 503),
  });
  res.end(body);
  stats.errors++;
  return { status, code };
}

function allowedHost(h, port) {
  if (!h) return false;
  const host = String(h).toLowerCase().replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

// Headers forwarded upstream: drop hop-by-hop and the client's credential, keep everything else
// (anthropic-beta and the oauth capability in particular - the upstream needs it in subscription mode).
function forwardHeaders(req, token, secretHdr = 'x-gw-secret') {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === 'host' || lk === 'authorization' || lk === 'accept-encoding') continue;
    if (lk === secretHdr) continue; // local-only, never leaves the machine
    if (typeof v === 'string' || typeof v === 'number') headers[k] = v;
  }
  headers.authorization = `Bearer ${token}`;
  return headers;
}

// One pass over the pool, used by the long hold after it has waited the window out. Deliberately
// simpler than the inline path above (no notifications, no nested holds): by then the decision is
// only "who can answer now".
async function attemptWithPool({ cfg, req, body, url, model, sessionId, secretHdr }) {
  const exclude = new Set();
  for (let i = 0; i < Math.max(1, pool(cfg).length); i++) {
    const sel = pickAccount(cfg, accountState, exclude, model);
    if (!sel.account) return { sel, up: null };
    const cred = resolveBearer(sel.account);
    if (cred.err) return { sel, up: null, credErr: cred.err };
    try {
      const up = await fetch(url, {
        method: req.method || 'POST',
        headers: forwardHeaders(req, cred.token, secretHdr),
        body: body.length ? body : undefined,
      });
      observeQuota(sel.account, up.headers, up.status, model, true);
      if (up.status !== 429 && up.status !== 529) return { sel, up };
      try { up.body?.cancel(); } catch { /* not needed */ }
      exclude.add(sel.account.label);
    } catch (e) {
      logLine({ ts: Date.now(), account: sel.account.label, path: url, err: String(e?.cause?.code || e?.message || e).slice(0, 200), sessionId });
      exclude.add(sel.account.label);
    }
  }
  return { sel: null, up: null };
}

// Keep a streaming request alive across a long quota wait, then serve it.
// The client sees: 200 + SSE, ping frames every 20s, then the real message frames. It never sees the
// refusal, so the turn never ends and nothing has to be re-typed.
async function holdStreamed({ req, res, cfg, body, url, model, sessionId, t0, refused, refusedAccount, open }) {
  const secretHdr = (cfg.secretHeader || 'x-gw-secret').toLowerCase();
  const waitMs = Math.max(0, open.readyAt - Date.now());
  const out = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-gw-held': String(waitMs) };
  // Pass the refusal's quota headers through, pool-corrected, so the client's own countdown stays
  // honest while the turn is still in flight.
  for (const [k, v] of refused.headers) {
    if (k.startsWith('anthropic-ratelimit') || k === 'retry-after') out[k] = v;
  }
  const shim = refusedAccount ? poolQuotaShim(cfg, accountState, refusedAccount, Date.now()) : null;
  applyQuotaShim(out, shim);
  res.writeHead(200, out);
  let aborted = false;
  res.on('close', () => { aborted = true; });
  const pingFrame = 'event: ping\ndata: {"type":"ping"}\n\n';
  res.write(pingFrame); // immediate: the client sees motion rather than silence
  const pings = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(pingFrame); }, 20_000);
  logLine({ ts: Date.now(), event: 'hold-stream', waitMs, via: open.label, sessionId, model });
  try {
    await Promise.race([
      new Promise((r) => setTimeout(r, waitMs + 800)),
      new Promise((r) => res.once('close', r)),
    ]);
    if (aborted) { logLine({ ts: Date.now(), event: 'hold-stream-abort', waitedMs: Date.now() - t0, sessionId }); return; }
    reloadStateIfChanged();
    const { sel, up } = await attemptWithPool({ cfg, req, body, url, model, sessionId, secretHdr });
    if (up && up.status < 400 && up.body) {
      const src = Readable.fromWeb(up.body);
      let bytes = 0;
      src.on('data', (c) => { bytes += c.length; });
      src.on('close', () => logLine({ ts: Date.now(), account: sel?.account?.label || null, path: url.split('?')[0],
        status: up.status, sessionId, model, bytes, heldMs: waitMs, totalMs: Date.now() - t0, resumed: true }));
      src.on('error', () => { try { res.destroy(); } catch {} });
      src.pipe(res);
      return;
    }
    // Still refused after waiting the window out: end the stream with a real error frame rather than
    // a silent hang, so the client reports it normally.
    res.write('event: error\ndata: ' + JSON.stringify({ type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } }) + '\n\n');
    res.end();
    logLine({ ts: Date.now(), event: 'hold-stream-refused', account: sel?.account?.label || null, sessionId, model,
      totalMs: Date.now() - t0 });
  } finally {
    clearInterval(pings);
  }
}

// Non-inference traffic in supported mode: forward with the credential the client presented. The
// vault tokens are inference-only, so letting them sign account/model/usage calls would either 403
// or tell the client something about the wrong account. Our local secret header never travels.
async function forwardClientCredential({ req, res, cfg, body, bearer, reqPath, sessionId, t0 }) {
  const url = new URL(req.url, cfg.upstream).toString();
  const secretHdr = (cfg.secretHeader || 'x-gw-secret').toLowerCase();
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === 'host' || lk === 'authorization' || lk === 'accept-encoding' || lk === secretHdr) continue;
    if (typeof v === 'string' || typeof v === 'number') headers[k] = v;
  }
  headers.authorization = `Bearer ${bearer}`;
  let up;
  try {
    up = await fetch(url, { method: req.method || 'GET', headers, body: body.length ? body : undefined });
  } catch (e) {
    logLine({ ts: Date.now(), event: 'passthrough', path: reqPath, status: 502,
      err: String(e?.cause?.code || e?.message || e).slice(0, 200), sessionId });
    return errRes(res, 502, 'api_error', 'claude-gw could not reach the upstream for this request', 'passthrough-failed');
  }
  const out = { 'content-type': up.headers.get('content-type') || 'application/json' };
  for (const [k, v] of up.headers) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || DECODED_AWAY.has(lk)) continue;
    out[k] = v;
  }
  logLine({ ts: Date.now(), event: 'passthrough', path: reqPath, method: req.method, status: up.status,
    sessionId, ms: Date.now() - t0, account: null });
  res.writeHead(up.status, out);
  if (!up.body) { res.end(); return; }
  Readable.fromWeb(up.body).pipe(res);
}

async function handle(req, res) {
  const t0 = Date.now();
  stats.requests++;

  const peer = req.socket.remoteAddress || '';
  if (!(peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1')) {
    return errRes(res, 403, 'authentication_error', 'peer is not loopback', 'non-loopback-peer');
  }
  if (!allowedHost(req.headers.host)) {
    return errRes(res, 403, 'authentication_error', 'Host header not permitted', 'bad-host');
  }

  // Unauthenticated liveness only. No secrets, no account data.
  if (req.method === 'GET' && req.url === '/__gw/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, gw: 'claude-gw', uptimeMs: Date.now() - startedAt }));
  }

  const cfg = loadConfig();

  // Everything else (including status) requires the local shared secret. It may arrive in the
  // credential slot (legacy mode) or, the supported mode, in a header - because the credential slot
  // is now reserved for the client's own claude.ai login, which is what keeps Claude Code's
  // usage-limit auto-resume switched on. Header wins when both are present.
  const secretHeader = (cfg.secretHeader || 'x-gw-secret').toLowerCase();
  const hdrSecret = req.headers[secretHeader];
  const bearer = req.headers.authorization
    ? String(req.headers.authorization).replace(/^Bearer\s+/i, '')
    : (req.headers['x-api-key'] || '');
  let authMode = null;
  if (typeof hdrSecret === 'string' && hdrSecret && eq(hdrSecret, cfg.secret)) authMode = 'header';
  else if (bearer && eq(bearer, cfg.secret)) authMode = 'bearer';
  if (!authMode) {
    return errRes(res, 401, 'authentication_error', 'invalid local gateway secret', 'bad-secret');
  }

  if (req.method === 'GET' && req.url === '/__gw/status') {
    const { account } = pickAccount(cfg, accountState);
    let ident = null;
    try { ident = describeIdentity().identity; } catch { /* display only */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      accounts: accountState,
      uptimeMs: Date.now() - startedAt,
      active: account ? account.label : null,
      pin: cfg.active,
      pool: pool(cfg).map((a) => a.label),
      disabled: cfg.accounts.filter((a) => a.enabled === false).map((a) => a.label),
      cliIdentity: ident,
      sessions: Array.from(sessions.entries()).slice(-25),
      stats: { ...stats, recent: stats.recent.slice(-20) },
    }));
  }

  // ---- inference / API passthrough ----
  reloadStateIfChanged();
  let body;
  try { body = await readBody(req); }
  catch (e) { return errRes(res, 413, 'invalid_request_error', 'body too large', 'body-too-large'); }

  const url = new URL(req.url, cfg.upstream).toString();
  const reqPath = new URL(req.url, 'http://127.0.0.1').pathname;
  const sessionId = req.headers['x-claude-code-session-id'] || null;
  const method = req.method || 'POST';

  // Non-inference traffic keeps the credential the client presented. In supported mode that is the
  // user's own claude.ai login; a 1-year inference-only vault token must never be spent on an
  // account/usage/model endpoint, where it either 403s or reports the wrong account.
  if (!isInferencePath(reqPath) && cfg.swapInferenceOnly !== false
      && authMode === 'header' && bearer && !eq(bearer, cfg.secret)) {
    return forwardClientCredential({ req, res, cfg, body, bearer, reqPath, sessionId, t0 });
  }

  // ---- choose, forward, and fail over BEFORE a single byte reaches the client ----
  // Replaying is safe here and only here: a request rejected with 429/529 consumed nothing, and
  // nothing has been streamed yet. Once the first SSE token is on the wire we never retry - that
  // would double-bill and duplicate text into the same transcript.
  const tried = new Set();
  const model = (() => { try { return JSON.parse(body.toString('utf8')).model; } catch { return null; } })();
  const wantsStream = (() => { try { return JSON.parse(body.toString('utf8')).stream === true; } catch { return false; } })();
  const maxAttempts = Math.max(1, pool(cfg).length);
  let sel = null, up = null, noAccountReason = null, credStale = false;
  let heldMs = 0;

  // Two rounds at most: round 2 only happens if we deliberately held the request because the pool
  // was about to free up anyway. Nothing is replayed once bytes have reached the client, and nothing
  // has been streamed at this point, so replaying here is free.
  for (let round = 0; round < 2; round++) {
    tried.clear();
    up = null;
    noAccountReason = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      sel = pickAccount(cfg, accountState, tried, model);
      if (!sel.account) { noAccountReason = sel.reason; break; }

      const cred = resolveBearer(sel.account);
      if (cred.err) {
        // A missing credential is not a quota signal; spinning through the pool would not help.
        return errRes(res, 503, 'authentication_error',
          `claude-gw cannot read a credential for "${sel.account.label}": ${cred.err}`, cred.err);
      }

      const headers = forwardHeaders(req, cred.token, (cfg.secretHeader || 'x-gw-secret').toLowerCase());
      headers['content-type'] = req.headers['content-type'] || 'application/json';
      credStale = !!cred.meta?.stale;

      let r;
      try {
        r = await fetch(url, { method, headers, body: body.length ? body : undefined });
      } catch (e) {
        logLine({ ts: Date.now(), account: sel.account.label, path: req.url, method, sessionId,
          err: String(e?.cause?.code || e?.message || e).slice(0, 200), ms: Date.now() - t0 });
        tried.add(sel.account.label);
        continue; // transport failure: another account may still work; bounded by maxAttempts
      }

      observeQuota(sel.account, r.headers, r.status, model, sel.reason !== 'detour');
      up = r;
      // Only quota/overload responses are worth moving off. 4xx/5xx of any other kind are the client's
      // or upstream's problem and get passed through untouched.
      if (r.status !== 429 && r.status !== 529) break;

      tried.add(sel.account.label);
      const next = pickAccount(cfg, accountState, new Set(tried), model);
      if (!next.account) break;
      const nextAvail = availability(accountState[next.account.label], Date.now());
      if (nextAvail.blocked.length) break; // every alternative is restricted too - surface the real 429

      logLine({ ts: Date.now(), event: 'failover-replay', from: sel.account.label, to: next.account.label,
                upstreamStatus: r.status, claim: accountState[sel.account.label]?.claim || null,
                blocked: nextAvail.blocked, sessionId });
      if (next.reason !== 'detour') notifySwitch(sel.account.label, next.account.label, `upstream ${r.status}`);
    }

    // Bounded hold: the pool refused, but somebody reopens inside a few tens of seconds. Surfacing a
    // limit message here would make the client start a wait that we could have skipped entirely.
    const refused = up && (up.status === 429 || up.status === 529);
    if (!refused || round > 0 || !(cfg.holdMaxMs > 0)) break;
    const open = poolOpening(cfg, accountState, Date.now());
    const waitMs = open ? open.readyAt - Date.now() : Infinity;
    if (waitMs <= 0 || waitMs > cfg.holdMaxMs) break;
    // Is the client still there? Note req.destroyed is NOT the test: the request stream is fully
    // consumed by readBody, so it is routinely true by now even for a waiting client.
    if (res.writableEnded || res.destroyed || !res.socket || res.socket.destroyed) break;

    logLine({ ts: Date.now(), event: 'hold', account: sel.account?.label || null, waitMs,
      via: open.label, sessionId, model });
    try { up.body?.cancel(); } catch { /* refused body is not needed */ }
    await new Promise((r) => setTimeout(r, Math.min(waitMs + 750, cfg.holdMaxMs + 1500)));
    heldMs = waitMs;
    reloadStateIfChanged();
  }

  // A wait measured in minutes or hours cannot be held silently - the client stops caring about a
  // connection that sends no bytes for roughly five minutes. For a streaming request we can still
  // recover: commit the stream now, keep it alive with ping frames, and forward for real the moment
  // the pool reopens. This is what keeps an extension-panel chat (which never arms Claude Code's own
  // wait) alive until the nearest account frees.
  if (up && (up.status === 429 || up.status === 529) && wantsStream && cfg.holdStream !== false && !res.writableEnded) {
    const open = poolOpening(cfg, accountState, Date.now());
    const waitMs = open ? open.readyAt - Date.now() : Infinity;
    if (waitMs > 0 && waitMs <= (cfg.holdStreamMaxMs ?? 6 * 3600_000)) {
      return holdStreamed({ req, res, cfg, body, url, model, sessionId, t0, refused: up,
        refusedAccount: sel?.account?.label || null, open });
    }
  }

  if (!up) {
    // Explicit, immediate failure - never stall (empty rotation must fail loudly).
    return errRes(res, 503, 'rate_limit_error',
      noAccountReason === 'no-enabled-accounts'
        ? 'No Claude accounts are enabled in claude-gw. Run: cla-gw enable <label>'
        : 'claude-gw has no account able to serve this request',
      noAccountReason === 'no-enabled-accounts' ? 'empty-rotation' : 'no-available-account');
  }

  const out = { 'content-type': up.headers.get('content-type') || 'application/json' };
  for (const [k, v] of up.headers) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || DECODED_AWAY.has(lk)) continue;
    out[k] = v;
  }

  // Make the limit we hand the client describe the POOL, not just the account that refused. A Claude
  // Code session that hits a usage limit arms a timer for the reset epoch in these headers and then
  // stops asking - so an epoch belonging to the later-reopening account costs real working time
  // (last night: refused at 1:03, both windows clear at 3:10). Statuses, body, status code and error
  // type stay exactly as upstream sent them; only the countdown moves, and only ever earlier.
  let shim = null;
  if (up.status === 429) {
    shim = poolQuotaShim(cfg, accountState, sel.account.label, Date.now());
    applyQuotaShim(out, shim);
  }

  const ttfb = Date.now() - t0;
  res.writeHead(up.status, out);

  // Notify on a change of serving account even when no replay was needed (e.g. A was already known
  // restricted, so this request simply went to B). Throttled per pair inside notifySwitch.
  // A detour is not a switch: the next request goes back to the sticky account, so stay quiet.
  const switched = up.status < 400 && sel.reason !== 'detour';
  if (switched && stats.lastServed && stats.lastServed !== sel.account.label) {
    notifySwitch(stats.lastServed, sel.account.label, sel.reason);
  }
  if (switched) stats.lastServed = sel.account.label;

  const rec = {
    ts: Date.now(), account: sel.account.label, selectReason: sel.reason,
    method, path: req.url.split('?')[0], status: up.status, sessionId,
    model,
    ttfbMs: ttfb, totalMs: ttfb, requestId: up.headers.get('request-id') || null,
    org: accountState[sel.account.label]?.org || null,
    u7d: accountState[sel.account.label]?.u7d ?? null,
    s7d: accountState[sel.account.label]?.s7d || null,
    claim: accountState[sel.account.label]?.claim || null,
    blockedUntil: accountState[sel.account.label]?.blockedUntil || null,
  };
  if (sel.warning) rec.warning = sel.warning;
  if (credStale) rec.warning = 'cli credential reported stale; CLI refreshes it (D-10)';
  if (heldMs) rec.heldMs = heldMs;
  if (shim) rec.quotaShim = { via: shim.via, readyEpochSec: shim.readyEpochSec,
    refusedReadyAt: shim.refusedReadyAt };
  rec.clientCred = credKind(req.headers.authorization);

  stats.byAccount[sel.account.label] = (stats.byAccount[sel.account.label] || 0) + 1;
  if (up.status >= 400) stats.errors++;

  if (!up.body) { logLine(rec); writeStatus(cfg); return; }

  const src = Readable.fromWeb(up.body);
  let bytes = 0;
  src.on('data', (c) => { bytes += c.length; });
  src.on('close', () => {
    rec.bytes = bytes; rec.totalMs = Date.now() - t0; logLine(rec);
    noteSession(sessionId, sel.account.label, up.status);
    writeStatus(cfg);
  });
  src.on('error', (e) => {
    rec.streamErr = String(e?.message).slice(0, 200); rec.bytes = bytes; logLine(rec); res.destroy();
    noteSession(sessionId, sel.account.label, up.status);
    writeStatus(cfg, true);
  });
  res.on('close', () => { if (!rec.finished) { rec.clientAbort = true; src.destroy(); } });
  res.on('finish', () => { rec.finished = true; });
  src.pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { reject(new Error('too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function start() {
  const cfg = loadConfig();
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      stats.errors++;
      logLine({ ts: Date.now(), err: `handler:${String(e?.message).slice(0, 200)}` });
      if (!res.headersSent) errRes(res, 500, 'api_error', 'gateway internal error', 'internal');
      // Headers already on the wire (e.g. a 200/429 line written, then a throw): the honest thing is
      // to end the connection. Leaving it open makes the client hang with no error at all — that is
      // exactly how one of our own bugs presented.
      else { try { res.destroy(); } catch { /* already gone */ } }
    });
  });
  // Long streaming responses: don't let Node time the request out mid-stream.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, resolve);
  });

  fs.writeFileSync(PID_PATH, String(process.pid));
  writeStatus(cfg, true);
  console.log(`claude-gw listening on http://${cfg.host}:${cfg.port}`);
  console.log(`  pool: ${pool(cfg).map((a) => a.label).join(', ') || '(EMPTY - rotation disabled)'}`);
  console.log(`  disabled: ${cfg.accounts.filter((a) => a.enabled === false).map((a) => a.label).join(', ') || '(none)'}`);
  console.log(`  pin: ${cfg.active || '(none - first enabled)'}`);
  console.log(`  log: ${LOG_PATH}`);

  const shutdown = () => { try { fs.unlinkSync(PID_PATH); } catch {} server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

// cli.mjs spawns this file directly as a detached background process.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/src/gw.mjs')) {
  start().catch((e) => { console.error('claude-gw failed to start:', e.message); process.exit(1); });
}
