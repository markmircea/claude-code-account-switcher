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
import { loadConfig, saveConfig, pickAccount, pool, availability, setModelGate, classify429, LOG_PATH, PID_PATH, STATUS_PATH, ACCOUNT_STATE_PATH, readAccountState, writeAccountState, poolOpening, poolQuotaShim, applyQuotaShim, isInferencePath, isConsentWall, markConsentRequired, CONSENT_PARK_MS, newUsage, scanUsage, usageCost, poolReopening, PRICES_AS_OF, ratesInPlay } from './config.mjs';
import { notifySwitch, notifyPoolOpen, notifyConsent } from './notify.mjs';
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
const stats = {
  requests: 0, byAccount: {}, byAccountCost: {}, costUsd: 0, costByDay: {}, costByModel: {},
  // Coverage: how many costable responses were served vs how many actually produced a usage object.
  // Without this, a capture bug is indistinguishable from a quiet day - which is exactly how the last
  // one survived (0 of 2,002 priced, 38 green tests).
  servedCostable: 0, pricedResponses: 0, partialResponses: 0, blindResponses: 0,
  unpriced: {}, unpricedTokens: {},
  errors: 0, recent: [],
};
const dayKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);

// Rolling windows over the per-day map: the last 1/7/30 day-keys, plus everything ever captured.
// Deliberately rolling, not calendar - "the past day/week/month" is the question, and a Monday or
// 1st-of-month boundary would make the figure fall without any traffic. The hover shows these.
function costPeriods(byDay, now) {
  const DAY = 86_400_000;
  const wk = new Set(), mo = new Set();
  for (let i = 0; i < 7; i++) wk.add(dayKey(now - i * DAY));
  for (let i = 0; i < 30; i++) mo.add(dayKey(now - i * DAY));
  let week = 0, month = 0, allTime = 0;
  for (const [dk, v] of Object.entries(byDay)) {
    allTime += v;
    if (wk.has(dk)) week += v;
    if (mo.has(dk)) month += v;
  }
  return { day: byDay[dayKey(now)] || 0, week, month, allTime };
}

// stats is per-process, but the status bar shows "today" (and the hover day/week/month/all-time).
// Without this, a restart mid-day would drop the day's spend to $0.00 and the number would silently
// be wrong. The log is the durable record, so the totals are re-read from it on boot. The scan used
// to be capped at a 4 MB tail - which silently truncated the "all time" figure as the log grew. The
// cap is gone: it is one read at boot, and `cla-gw cost` already reads the whole file per invocation.
// Records written before usage capture worked have neither `usage` nor `usageMiss`, so they are skipped:
// the day starts from zero and coverage counts only what this version could actually see.
try {
  const raw = fs.readFileSync(LOG_PATH, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let l = null;
    try { l = JSON.parse(line); } catch { continue; }
    if (!l) continue;
    if (l.usageMiss) { if (l.path === '/v1/messages' && l.status < 400) stats.servedCostable++; continue; }
    // Neither a usage object nor a usageMiss marker: this record predates token capture. Folding it into
    // the denominator would make a ten-day capture failure look like a quiet week; dropping it silently
    // makes today's total look complete when it is a floor. Count it, name it in the hover.
    if (!l.usage) {
      if (l.path === '/v1/messages' && l.status < 400) stats.blindResponses++;
      continue;
    }
    if (l.usageUncosted) continue;                    // count_tokens: usage, but nothing billed
    if (l.path === '/v1/messages') stats.servedCostable++;
    if (typeof l.costUsd !== 'number') {
      if (l.unpriced) { stats.unpriced[l.unpriced] = (stats.unpriced[l.unpriced] || 0) + 1; }
      continue;
    }
    stats.pricedResponses++;
    if (l.usagePartial) stats.partialResponses++;
    const dk = dayKey(l.ts);
    stats.costByDay[dk] = (stats.costByDay[dk] || 0) + l.costUsd;
    stats.costUsd += l.costUsd;
    if (l.account) stats.byAccountCost[l.account] = (stats.byAccountCost[l.account] || 0) + l.costUsd;
    const m = l.priceModel || l.model || 'unknown';
    const bm = stats.costByModel[m] || (stats.costByModel[m] = { usd: 0, n: 0, in: 0, out: 0, cw: 0, cr: 0, search: 0 });
    bm.usd += l.costUsd; bm.n++;
    bm.in += l.usage.in || 0; bm.out += l.usage.out || 0;
    bm.cw += l.usage.cw || 0; bm.cr += l.usage.cr || 0; bm.search += l.usage.search || 0;
  }
} catch { /* no log yet */ }

// Turn a scanned usage object into money and book it - in ONE place, because the normal path and the
// long-hold path both stream a response, and a pricing fix that lands in one and not the other is a
// silent discrepancy between what a held chat cost and what the same chat cost unheld.
function bookUsage(rec, usage, model, cfg) {
  const costable = rec.path === '/v1/messages' && rec.status < 400;
  if (costable) stats.servedCostable++;
  if (!(usage.in || usage.out || usage.cw || usage.cr)) {
    // A served inference response with no usage is a capture failure, not a free request.
    if (costable) rec.usageMiss = 'no usage object in the response';
    return;
  }
  if (!costable) {
    // /v1/messages/count_tokens answers with a usage object and bills nothing. Pricing it would invent
    // cost out of thin air (it is called constantly by Claude Code's context tracking).
    rec.usageUncosted = rec.path;
    return;
  }
  const cost = usageCost(usage, model, cfg);
  rec.usage = usage;
  rec.priceFamily = cost.family;
  rec.priceModel = cost.model || null;
  rec.priceExact = cost.exact;
  if (cost.incomplete) rec.priceIncomplete = true;   // a config.json row missing rates: named, not guessed
  if (cost.applied && cost.applied.length) rec.priceApplied = cost.applied;
  if (cost.usd === null) {
    // No rates for this model: no money number. Record the tokens and name the model - a guessed
    // family rate is how a $0.04 request gets reported as $0.15.
    rec.unpriced = cost.unpriced;
    stats.unpriced[rec.unpriced] = (stats.unpriced[rec.unpriced] || 0) + 1;
    stats.unpricedTokens[rec.unpriced] = (stats.unpricedTokens[rec.unpriced] || 0)
      + ((usage.in || 0) + (usage.out || 0) + (usage.cw || 0) + (usage.cr || 0));
    return;
  }
  stats.pricedResponses++;
  // Input side known, final output count never arrived (aborted or errored stream): the number is a
  // floor, and saying so beats presenting it as exact.
  if (!usage.out && usage.in) { rec.usagePartial = true; stats.partialResponses++; }
  rec.costUsd = Number(cost.usd.toFixed(6));
  stats.costUsd += cost.usd;
  const dk = dayKey(rec.ts || Date.now());
  stats.costByDay[dk] = (stats.costByDay[dk] || 0) + cost.usd;
  if (rec.account) stats.byAccountCost[rec.account] = (stats.byAccountCost[rec.account] || 0) + cost.usd;
  const m = rec.priceModel || 'unknown';
  const bm = stats.costByModel[m] || (stats.costByModel[m] = { usd: 0, n: 0, in: 0, out: 0, cw: 0, cr: 0, search: 0 });
  bm.usd += cost.usd; bm.n++;
  bm.in += usage.in || 0; bm.out += usage.out || 0;
  bm.cw += usage.cw || 0; bm.cr += usage.cr || 0; bm.search += usage.search || 0;
}

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

// Chats the gateway is currently HOLDING open against a quota window (the long hold). The client already
// learns about it - the response carries `x-gw-held: <ms>` - but the VS Code extension reads files, not
// response headers, so it cannot see that a chat is parked. A turn that has said nothing for 14 minutes
// is precisely the thing the status bar should be explaining, so the same fact is published here.
const holds = new Map(); // sessionId -> { since, reopenAt, via, model, sessionId }

function holdsPayload(now) {
  // Prune by the reopen epoch: every exit path already deletes, but a leaked entry would haunt the bar
  // for the rest of the process's life.
  for (const [k, h] of holds) if (h.reopenAt + 5000 < now) holds.delete(k);
  if (!holds.size) return { n: 0 };
  const items = [...holds.values()];
  return {
    n: items.length,
    reopenAt: Math.min(...items.map((h) => h.reopenAt)),
    longestMs: Math.max(...items.map((h) => now - h.since)),
    items: items.map((h) => ({ sessionId: h.sessionId, via: h.via, model: h.model,
      heldMs: now - h.since, reopenAt: h.reopenAt })),
  };
}

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
      // "what would this have cost on the API" - today, and since this gateway process started.
      // coverage/unpriced/partial are here because a cost number without them is unverifiable: the bar
      // has to be able to say how much of the traffic it did NOT price.
      cost: { todayUsd: stats.costByDay[dayKey()] || 0, totalUsd: stats.costUsd,
        periods: costPeriods(stats.costByDay, now),
        byDay: stats.costByDay, byAccount: stats.byAccountCost, byModel: stats.costByModel,
        coverage: { priced: stats.pricedResponses, served: stats.servedCostable, partial: stats.partialResponses,
                    blind: stats.blindResponses },
        unpriced: stats.unpriced, unpricedTokens: stats.unpricedTokens,
        pricesAsOf: PRICES_AS_OF, rates: ratesInPlay(cfg, Object.keys(stats.costByModel)) },
      opening: poolReopening(cfg, accountState, now),
      holds: holdsPayload(now),
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

// One alert per pool opening. A chat refused at the limit does not wake itself up - headless sessions
// never arm, and interactive ones that were parked past the client's ~900 s wall lost the arm too - so
// the least the gateway can do is say the exact second it can be continued. One alert per opening;
// state is re-checked before speaking, so a window that moved late stays quiet (the next refusal
// re-schedules for the new epoch).
let openAlertEpoch = 0;
function scheduleOpenAlert(cfg, shim) {
  const epochSec = shim?.readyEpochSec;
  if (!epochSec) return;
  const delay = epochSec * 1000 - Date.now() + 5000;
  if (delay <= 0 || delay > 24 * 3600_000) return; // already open, or implausibly far out
  if (epochSec === openAlertEpoch) return;
  openAlertEpoch = epochSec;
  logLine({ ts: Date.now(), event: 'open-alert', at: epochSec, inMs: delay });
  const timer = setTimeout(() => {
    if (epochSec === openAlertEpoch) openAlertEpoch = 0;
    reloadStateIfChanged();
    const open = poolOpening(cfg, accountState, Date.now());
    if (!open || open.readyAt <= Date.now() + 60_000) notifyPoolOpen(open?.label || 'the pool', new Date(epochSec * 1000));
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
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
  const holdKey = sessionId || `anon-${Date.now()}`;
  holds.set(holdKey, { since: Date.now(), reopenAt: open.readyAt, via: open.label, model, sessionId });
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
      const usage = newUsage();
      src.on('data', (c) => { bytes += c.length; try { scanUsage(usage, c.toString('utf8')); } catch {} });
      // `url` here is absolute (it is the upstream URL), so the pathname has to be taken from it -
      // otherwise the record's `path` disagrees with the normal path's and cost coverage cannot match.
      const rec = { ts: Date.now(), account: sel?.account?.label || null, path: new URL(url).pathname,
        status: up.status, sessionId, model, bytes, heldMs: waitMs, totalMs: Date.now() - t0, resumed: true };
      src.on('close', () => {
        rec.bytes = bytes; rec.totalMs = Date.now() - t0;
        bookUsage(rec, usage, model, cfg);
        logLine(rec);
        noteSession(sessionId, sel?.account?.label || null, up.status);
        writeStatus(cfg);
      });
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
    holds.delete(holdKey); // resumed, refused, or abandoned: either way the chat is no longer parked
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
  let consent = null;      // a terms wall we saw: label + the upstream text, which is the fix message
  let consumed = null;     // body of a response we already read (bodies are single-use)

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

      // A terms wall is not quota and not the client's problem: that account cannot serve at all until
      // someone accepts the updated Consumer Terms in claude.ai. Park it under its own window name so
      // selection routes around it, keep the upstream text (it is the actionable part), and try an
      // account that can actually answer. Without this, one half-provisioned account black-holes every
      // chat on the machine with a 400 the failover logic used to treat as "not our business".
      if (r.status === 400) {
        const text = await r.text();
        if (isConsentWall(text)) {
          consent = { label: sel.account.label, text };
          markConsentRequired(accountState[sel.account.label] ||= {}, Date.now());
          persistState();
          logLine({ ts: Date.now(), event: 'consent-required', account: sel.account.label, sessionId,
            parkedMs: CONSENT_PARK_MS, model });
          notifyConsent(sel.account.label, accountState[sel.account.label]?.orgId || sel.account.orgId || '');
          tried.add(sel.account.label);
          up = null;   // body consumed above - it must never be replayed as a live stream
          continue;
        }
        consumed = text;   // an ordinary 400: the client's problem, passed through verbatim below
        break;
      }

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

  // Every reachable account is behind the terms wall: hand the upstream message through untouched,
  // because it is the one thing that tells the user what to click.
  if (!up && consent) {
    res.writeHead(400, { 'content-type': 'application/json', 'x-gw-consent': consent.label });
    res.end(consent.text);
    logLine({ ts: Date.now(), account: consent.label, path: reqPath, method, status: 400, sessionId,
      model, ms: Date.now() - t0, consent: true });
    return;
  }

  // A response whose body we already read (any 400, to tell a terms wall from a bad request) is
  // re-sent as text; the stream is spent and must not be piped.
  if (up && consumed !== null) {
    const hdr = { 'content-type': up.headers.get('content-type') || 'application/json' };
    for (const [k, v] of up.headers) {
      if (k.startsWith('anthropic-ratelimit') || k.toLowerCase() === 'retry-after') hdr[k] = v;
    }
    res.writeHead(up.status, hdr);
    res.end(consumed);
    logLine({ ts: Date.now(), account: sel?.account?.label || null, path: reqPath, method, status: up.status,
      sessionId, model, ms: Date.now() - t0 });
    return;
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
    // A chat refused here usually just stops with its turn over - nothing retries it, and the user is
    // asleep. The gateway knows the exact epoch the pool reopens, so it says so when it happens.
    // One alert per opening, and it checks the state again before speaking.
    scheduleOpenAlert(cfg, shim);
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
    // The quota picture as it stood BEFORE this request. Recorded on the request line on purpose: it is
    // the only way `cla-gw audit routing` can tell whether the account this request went to was already
    // known to be limited at that moment. s5h and the reset epochs were missing here once, which made the
    // five_hour park unauditable - the audit could only guess, and guessed wrong 43 times.
    u5h: accountState[sel.account.label]?.u5h ?? null,
    s5h: accountState[sel.account.label]?.s5h || null,
    r5h: accountState[sel.account.label]?.r5h ?? null,
    u7d: accountState[sel.account.label]?.u7d ?? null,
    s7d: accountState[sel.account.label]?.s7d || null,
    r7d: accountState[sel.account.label]?.r7d ?? null,
    claim: accountState[sel.account.label]?.claim || null,
    consentUntil: accountState[sel.account.label]?.consentUntil || null,
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
  // Token accounting: the bytes the client is already receiving get scanned for the usage objects the
  // API sends anyway. Text frames only, and any error in the scan is swallowed for the same reason.
  const ct = String(out['content-type'] || '').toLowerCase();
  const tap = up.status < 400 && (ct.includes('json') || ct.includes('event-stream'));
  const usage = newUsage();
  src.on('data', (c) => {
    bytes += c.length;
    if (tap) { try { scanUsage(usage, c.toString('utf8')); } catch { /* never break a stream */ } }
  });
  // 'close' and 'error' can both fire for one response. While cost was only a log line that merely
  // duplicated a record; now it would duplicate money, so the record is written once.
  let logged = false;
  function finish(extra, forceStatus = false) {
    if (logged) return;
    logged = true;
    if (extra) Object.assign(rec, extra);
    rec.bytes = bytes; rec.totalMs = Date.now() - t0;
    bookUsage(rec, usage, model, cfg);
    logLine(rec);
    noteSession(sessionId, sel.account.label, up.status);
    writeStatus(cfg, forceStatus);
  }
  src.on('close', () => finish());
  src.on('error', (e) => { res.destroy(); finish({ streamErr: String(e?.message).slice(0, 200) }, true); });
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
