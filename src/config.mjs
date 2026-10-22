// Config + account registry for claude-gw.
//
// Design notes (see PLAN.md):
//  - D-10 credential ownership: account "A" is CLI-owned. This process NEVER writes to
//    ~/.claude/.credentials.json. It only reads it (see creds.mjs).
//  - D-12 rotation membership: `enabled` on each account decides whether it is in the pool.
//    Toggling it is hot-reloaded per request, so it takes effect mid-conversation without
//    restarting anything.
//  - The `secret` below is a LOCAL shared secret between the launcher and the proxy. It is not
//    a credential and must never be logged.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME = process.env.USERPROFILE || process.env.HOME;
export const DATA_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(HOME, '.local', 'share'),
  'claude-gw',
);
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const LOG_PATH = path.join(DATA_DIR, 'gateway.jsonl');
export const PID_PATH = path.join(DATA_DIR, 'gateway.pid');
export const STATUS_PATH = path.join(DATA_DIR, 'status.json');
export const ACCOUNT_STATE_PATH = path.join(DATA_DIR, 'accounts_state.json');

// Where the Claude Code CLI keeps its own (CLI-owned) credential. Read-only for us.
export const CLI_CREDENTIAL_PATH = path.join(HOME, '.claude', '.credentials.json');

const DEFAULTS = () => ({
  host: '127.0.0.1',
  port: 8790,
  upstream: 'https://api.anthropic.com',
  secret: crypto.randomBytes(24).toString('hex'),
  // The local shared secret travels in a HEADER, not in the credential slot. That is deliberate:
  // setting ANTHROPIC_AUTH_TOKEN (a "gateway credential") makes Claude Code treat the session as a
  // billed API session, and it then turns OFF its own "wait for the claude.ai usage limit to reset,
  // then continue the task" feature - the one thing that keeps overnight chats alive. With only
  // ANTHROPIC_BASE_URL set, the client keeps using its saved claude.ai login against us (proved on
  // 2.1.305: it sends its own OAuth bearer with anthropic-beta including oauth-2025-04-20) while
  // this gateway re-signs /v1/messages with a pool account. `cla-gw activate` writes the header.
  secretHeader: 'x-gw-secret',
  // Only /v1/messages* gets re-signed. Everything else (model listing, account/usage calls a future
  // version may add) keeps the client's own credential, so a 1-year inference-only vault token is
  // never presented to an endpoint that expects the real login.
  swapInferenceOnly: true,
  // When every account is restricted but one frees up almost immediately (last night: C filled at
  // 1:02, B at 1:03), hold the request instead of surfacing a limit message the client would then
  // have to wait out. Bounded, once per request; 0 disables it.
  holdMaxMs: 45000,
  // null => "pick the first enabled account". `cla-gw use <label>` sets this.
  active: null,
  accounts: [
    {
      label: 'A',
      kind: 'cli-credential', // read from CLI_CREDENTIAL_PATH, refreshed by the CLI itself
      enabled: true,
      note: 'pinned real login; credential owned by the Claude Code CLI (D-10)',
    },
  ],
});

export function ensureConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    const cfg = DEFAULTS();
    // 0600-ish: on Windows ACLs govern this; the mode bits are best-effort.
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    return { cfg, created: true };
  }
  return { cfg: parse(fs.readFileSync(CONFIG_PATH, 'utf8')), created: false };
}

function parse(raw) {
  const cfg = JSON.parse(raw);
  if (!Array.isArray(cfg.accounts) || cfg.accounts.length === 0) {
    throw new Error('config.accounts must be a non-empty array');
  }
  // Defaults for keys added after a config file already existed. Without this, an older config.json
  // silently opts out of features it never heard of - which is exactly how the bounded hold ended up
  // disabled on a live gateway that otherwise had every reason to use it.
  if (cfg.secretHeader === undefined) cfg.secretHeader = 'x-gw-secret';
  if (cfg.swapInferenceOnly === undefined) cfg.swapInferenceOnly = true;
  if (cfg.holdMaxMs === undefined) cfg.holdMaxMs = 45000;
  // Long holds: when the pool reopens in MINUTES or HOURS rather than seconds, a silent hold cannot
  // work (the client gives up on a connection with no bytes after roughly five minutes). For
  // streaming requests we can still recover: commit the stream, keep it alive with ping frames, and
  // forward for real when the window opens. Cap it so a chat is never parked past a plausible reset.
  if (cfg.holdStream === undefined) cfg.holdStream = true;
  // Measured, not guessed (2026-10-21 overnight, three chats, gateway log): a Claude Code client
  // abandons a held-but-silent-then-pinged stream at ~911 s (15.2 min) - five aborts at 910.9-911.6 s,
  // despite a ping every 20 s. Pings buy ~10 minutes over the ~5 min no-bytes timeout, and then the
  // client's own patience ends it. So a ceiling above ~12 min is strictly harmful: the chat stalls for
  // 15 minutes, the request is then lost, and because the client never saw a 429 on the first attempt
  // it also never armed its own wait - which is the only mechanism that survives a multi-hour window.
  // Park only waits short enough to actually deliver; longer ones must fail fast with an honest
  // countdown so the client can arm.
  if (cfg.holdStreamMaxMs === undefined) cfg.holdStreamMaxMs = 600_000;
  for (const a of cfg.accounts) {
    if (!a.label || !a.kind) throw new Error('each account needs {label, kind}');
    if (a.enabled === undefined) a.enabled = true;
  }
  const seen = new Set();
  for (const a of cfg.accounts) {
    if (seen.has(a.label)) throw new Error(`duplicate account label: ${a.label}`);
    seen.add(a.label);
  }
  return cfg;
}

let cache = { mtimeMs: 0, cfg: null };

// Hot reload: a `cla-gw disable B` from another process takes effect on the next request.
export function loadConfig() {
  const st = fs.statSync(CONFIG_PATH);
  if (cache.cfg && cache.cfg.__mtime === st.mtimeMs) return cache.cfg;
  const cfg = parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cfg.__mtime = st.mtimeMs;
  cache = { mtimeMs: st.mtimeMs, cfg };
  return cfg;
}

export function saveConfig(cfg) {
  const out = { ...cfg };
  delete out.__mtime;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2), { mode: 0o600 });
  cache = { mtimeMs: 0, cfg: null }; // force reload
  return out;
}

export function pool(cfg) {
  return cfg.accounts.filter((a) => a.enabled !== false);
}

// Phase 2: honour an explicit pin, else first enabled. Phase 4 replaces this with
// lowest-utilisation + cooldown selection.
// When is this account actually able to serve a request? A request needs EVERY window to allow, so
// the account is ready at the LATEST reset among its rejected windows - not the earliest. A's 5h
// window refills tonight while its weekly stays blown until Oct 16; A is unusable until Oct 16.
// The upstream text that means "this account must accept the updated consumer terms". Matched on the
// body, never the status: a 400 is otherwise the client's problem and must pass through untouched.
export const CONSENT_PARK_MS = 30 * 60_000;
export function isConsentWall(text) {
  return /Consumer Terms|Privacy Policy|accept them in claude\.ai/i.test(String(text || ''));
}
export function markConsentRequired(s, now = Date.now(), ms = CONSENT_PARK_MS) {
  s.consentUntil = now + ms;
  s.consentFlaggedAt = now;
  return s;
}

export function availability(s, now = Date.now()) {
  if (!s) return { blocked: [], readyAt: 0 };
  const blocked = [];
  for (const [win, st, reset] of [['5h', s.s5h, s.r5h], ['7d', s.s7d, s.r7d]]) {
    if (st === 'rejected' && reset && reset * 1000 > now) blocked.push({ win, readyAt: reset * 1000 });
  }
  // A terms-of-service wall ("accept the updated Consumer Terms in claude.ai") is not quota: the
  // account cannot serve at all until a human clicks. It gets its own window name so the pool routes
  // around it and the status line can say what to do instead of showing a phantom quota window.
  if (s.consentUntil && s.consentUntil > now) blocked.push({ win: 'terms', readyAt: s.consentUntil });
  // A headerless 429 gives no window and no epoch; it parks briefly under the legacy field.
  if (s.blockedUntil && s.blockedUntil > now && !blocked.some((b) => b.win === 'blip')) {
    if (s.parkReason === 'unspecified-429') blocked.push({ win: 'blip', readyAt: s.blockedUntil });
    else if (!blocked.length) blocked.push({ win: s.claim || 'unknown', readyAt: s.blockedUntil });
  }
  return { blocked, readyAt: blocked.reduce((m, b) => Math.max(m, b.readyAt), 0) };
}

// A 429 verdict must come from THIS response's headers. Reading the merged per-account state instead
// (which is what an earlier version did) means a stale `rejected` from yesterday parks an account
// today, or a fresh quota rejection gets misread as a model gate.
export function quotaSignals(get) {
  const H = (k) => { const v = get(k); return v === null || v === undefined ? null : String(v); };
  const N = (k) => { const v = H(k); return v === null ? null : Number(v); };
  const s5h = H('anthropic-ratelimit-unified-5h-status');
  const s7d = H('anthropic-ratelimit-unified-7d-status');
  const unifiedStatus = H('anthropic-ratelimit-unified-status');
  const r5h = N('anthropic-ratelimit-unified-5h-reset');
  const r7d = N('anthropic-ratelimit-unified-7d-reset');
  const reset = N('anthropic-ratelimit-unified-reset');
  const rejectedWindows = [];
  if (s5h === 'rejected' && r5h) rejectedWindows.push(r5h);
  if (s7d === 'rejected' && r7d) rejectedWindows.push(r7d);
  if (unifiedStatus === 'rejected' && reset) rejectedWindows.push(reset);
  const hasQuotaHeaders = [reset, r5h, r7d, N('anthropic-ratelimit-unified-7d-utilization'),
    N('anthropic-ratelimit-unified-5h-utilization')].some((x) => x !== null) ||
    [s5h, s7d, unifiedStatus].some((x) => x !== null);
  return { s5h, s7d, unifiedStatus, r5h, r7d, reset, rejectedWindows, hasQuotaHeaders,
           retryAfter: N('retry-after') };
}

// Decide what a 429 MEANS, from this response plus what we last learned from a real one.
//   quota -> a window in THIS response says rejected: park the account to that reset.
//   model -> quota headers present but nothing rejected, OR no headers at all while the account's
//            last real observation showed healthy windows and a recent success. Observed on B:
//            Opus/Sonnet 429 (headerless) with 5h 0.01 allowed / 7d 0.8 allowed_warning, while
//            Haiku on the same token returned 200 seconds earlier. That is the model, not the account.
//   blip  -> headerless and genuinely unknown: park briefly, never for days.
export function classify429(get, s = {}, now = Date.now()) {
  const sig = quotaSignals(get);
  if (sig.rejectedWindows.length) return { kind: 'quota', sig };
  if (sig.hasQuotaHeaders) return { kind: 'model', sig };
  const windowsKnownHealthy = s.s5h !== 'rejected' && s.s7d !== 'rejected' && (s.s5h || s.s7d);
  const recentlyServed = now - (s.lastGoodAt || 0) < 6 * 3600_000;
  return { kind: windowsKnownHealthy && recentlyServed ? 'model' : 'blip', sig };
}

// A 429 whose rate-limit headers say the account is FINE (observed live: Sonnet rejected while
// 7d=80% allowed_warning, and the same token served Haiku seconds later) is a per-MODEL gate, not an
// account verdict. It belongs to one model for a while; it must not take the account out of the pool.
export function modelGateOf(s, model, now = Date.now()) {
  if (!s || !s.modelGate || !model) return 0;
  for (const [k, until] of Object.entries(s.modelGate)) {
    // Prefix match both ways: 'claude-sonnet-4-5' and 'claude-sonnet-4-5-20250929' are the same model.
    if (until > now && (k === model || model.startsWith(k) || k.startsWith(model))) return until;
  }
  return 0;
}

export function setModelGate(s, model, ms = 15 * 60_000) {
  if (!model) return 0;
  const now = Date.now();
  s.modelGate = Object.fromEntries(Object.entries(s.modelGate || {}).filter(([, u]) => u > now));
  // Escalate: a model repeatedly refusing an otherwise-healthy account is usually entitlement, not a
  // transient window, and re-probing it per message costs a round trip each time. Grows 15m, 1h, 4h,
  // capped at 4h - NOT 24h, because a 429 is not always a real signal: hand-rolled probe requests
  // (missing the headers a real client sends) produced fake Sonnet/Opus 429s on an account that the
  // real client used at 200 minutes later. Any success on that model clears the gate immediately.
  s.modelGateHits = s.modelGateHits || {};
  const hits = (s.modelGateHits[model] || 0) + 1;
  s.modelGateHits[model] = hits;
  const window = Math.min(4 * 3600_000, ms * (4 ** (hits - 1)));
  s.modelGate[model] = now + window;
  s.modelGateWindow = window;
  return s.modelGate[model];
}

export function pickAccount(cfg, state = {}, exclude = new Set(), model = null) {
  const enabled = pool(cfg).filter((a) => !exclude.has(a.label));
  if (enabled.length === 0) return { account: null, reason: 'no-enabled-accounts' };

  const now = Date.now();
  const availOf = (a) => availability(state[a.label], now);
  const pressure = (a) => {
    const s = state[a.label] || {};
    return Math.max(s.u5h ?? 0, s.u7d ?? 0);
  };

  if (cfg.active) {
    const pinned = enabled.find((a) => a.label === cfg.active);
    if (pinned) {
      const av = availOf(pinned);
      if (av.blocked.length) {
        return { account: pinned, reason: 'pinned-blocked', blocked: av.blocked,
                 warning: `pinned "${pinned.label}" is limited by ${av.blocked.map((b) => b.win).join('+')}; ` +
                          `usable again ${new Date(av.readyAt).toLocaleString()}` };
      }
      const gate = model ? modelGateOf(state[pinned.label], model, now) : 0;
      if (gate) {
        // The user asked for this account by name, so honour it - but say what is about to happen.
        return { account: pinned, reason: 'pinned-model-gated',
                 warning: `"${pinned.label}" is gated for ${model} until ${new Date(gate).toLocaleString()}` };
      }
      return { account: pinned, reason: 'pinned' };
    }
    return { account: enabled[0], reason: 'pin-unavailable',
             warning: `pinned account "${cfg.active}" is disabled/unknown; using "${enabled[0].label}"` };
  }

  const free = enabled.filter((a) => !availOf(a).blocked.length);
  if (free.length === 0) {
    // Everything is restricted: hand back whoever reactivates SOONEST (your rule), and say when.
    const soonest = enabled.slice().sort((x, y) => availOf(x).readyAt - availOf(y).readyAt)[0];
    const av = availOf(soonest);
    return { account: soonest, reason: 'all-restricted-soonest-reactivation', blocked: av.blocked,
             warning: `all accounts restricted; ${soonest.label} reactivates soonest ` +
                      `(${av.blocked.map((b) => b.win).join('+')} clears ${new Date(av.readyAt).toLocaleString()})` };
  }

  // Sticky: stay on the account in use until a full 5h or weekly window blocks it. Usage alone never
  // moves traffic, because the prompt cache is per account and every switch resends the whole
  // conversation uncached. "In use" = latest activeAt, which the gateway stamps on every request it
  // serves other than a detour.
  const current = pool(cfg).filter((a) => state[a.label]?.activeAt)
    .sort((x, y) => state[y.label].activeAt - state[x.label].activeAt)[0] || null;
  const gated = (a) => !!(model && modelGateOf(state[a.label], model, now));
  if (current && free.includes(current) && !gated(current)) return { account: current, reason: 'sticky' };

  // Moving off it. Only a full window makes that permanent; a model gate, a headerless blip or a
  // transport failure is a one-request detour that leaves `current` where it is.
  const quotaBlocked = !!current && availOf(current).blocked.some((b) => b.win !== 'blip');
  const reason = !current ? 'first-available' : quotaBlocked ? 'switched-current-blocked' : 'detour';

  // Model gates: prefer an account that is not gated for THIS model, but never strand the request.
  const candidates = free.filter((a) => !gated(a));
  const base = candidates.length ? candidates : free;
  // Least used first, so the next forced switch is as far away as possible.
  const ranked = base.slice().sort((x, y) =>
    pressure(x) - pressure(y) || ((state[x.label]?.requests || 0) - (state[y.label]?.requests || 0)));
  const out = { account: ranked[0], reason };
  if (!candidates.length && model) {
    out.warning = `every account is gated for ${model} right now; trying ${ranked[0].label} anyway`;
  }
  return out;
}

// Which account will be able to serve SOONEST, and when. The pool - not the account that just
// refused. This is the number a waiting chat actually needs.
export function poolOpening(cfg, state = {}, now = Date.now()) {
  const enabled = pool(cfg);
  if (!enabled.length) return null;
  let best = null;
  for (const a of enabled) {
    const av = availability(state[a.label], now);
    const readyAt = Math.max(av.readyAt, now); // unblocked => ready now
    if (!best || readyAt < best.readyAt) best = { label: a.label, readyAt, blocked: av.blocked };
  }
  return best;
}

// When the pool next GAINS capacity - only accounts actually blocked count, and null when nobody is.
// poolOpening() answers a different question ("who is closest to serving", where unblocked means now),
// which is a fine answer for routing and a confusing one for a status bar.
export function poolReopening(cfg, state = {}, now = Date.now()) {
  let best = null;
  for (const a of pool(cfg)) {
    const av = availability(state[a.label], now);
    if (av.blocked.length && av.readyAt > now && (!best || av.readyAt < best.readyAt)) {
      best = { label: a.label, readyAt: av.readyAt };
    }
  }
  return best;
}

// Should the 429 we are about to hand the client describe the POOL rather than the refusing
// account? Only ever to SHORTEN the wait, never to lengthen it.
//
// Why: a Claude Code session that hits a usage limit arms a timer for the reset epoch in that 429's
// rate-limit headers (proven: the probe armed for exactly the epoch we sent) and then waits, without
// asking again. It does not know a second account exists. If the account that refused reopens at
// 04:00 but a mate reopens at 03:10, the honest-for-the-account answer is a lie for the user: the
// chat sleeps 50 minutes past the point where we could have served it. Statuses stay untouched, so
// it still reads as the same kind of limit; only the reset epochs and retry-after move.
export function poolQuotaShim(cfg, state, refusingLabel, now = Date.now()) {
  const refused = availability(state[refusingLabel], now);
  if (!refused.blocked.length) return null;
  const open = poolOpening(cfg, state, now);
  if (!open || open.readyAt >= refused.readyAt - 1000) return null;
  const readyEpochSec = Math.floor(open.readyAt / 1000);
  const retryAfter = Math.max(1, Math.ceil((open.readyAt - now) / 1000));
  return { readyEpochSec, retryAfter, via: open.label, refusedReadyAt: refused.readyAt };
}

// Apply a shim to a header object about to be sent to the client. Statuses stay exactly as upstream
// sent them (it is still a real limit); only the countdown moves, and only ever to the earlier time.
export function applyQuotaShim(out, shim) {
  if (!shim) return out;
  for (const win of ['5h', '7d']) {
    if (out[`anthropic-ratelimit-unified-${win}-status`] === 'rejected') {
      out[`anthropic-ratelimit-unified-${win}-reset`] = String(shim.readyEpochSec);
    }
  }
  if (out['anthropic-ratelimit-unified-status'] === 'rejected') {
    out['anthropic-ratelimit-unified-reset'] = String(shim.readyEpochSec);
  }
  out['retry-after'] = String(shim.retryAfter);
  return out;
}

// ---------------------------------------------------------------------------
// What this traffic would have cost on the API. The subscription is flat and the gateway knows the
// tokens, so the honest number is "tokens x list price", not a guess.
// Family rates per million tokens. Override per family or per exact model id in config.json ->
// "prices", e.g. {"prices": {"opus": {"in": 15, "out": 75}}} or {"prices": {"claude-opus-5-5": {...}}}.
// Cache multipliers follow the published ones (write 1.25x input, read 0.1x), so a stale table only
// needs the base pair corrected.
export const PRICE_TABLE = {
  opus:   { in: 15,   out: 75,  cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { in: 3,    out: 15,  cacheWrite: 3.75,  cacheRead: 0.3 },
  haiku:  { in: 1,    out: 5,   cacheWrite: 1.25,  cacheRead: 0.1 },
};
export function priceFor(model, cfg) {
  const m = String(model || '').toLowerCase();
  const fam = Object.keys(PRICE_TABLE).find((f) => m.includes(f)) || 'sonnet';
  const p = { ...PRICE_TABLE[fam] };
  const over = (cfg && cfg.prices) || {};
  Object.assign(p, over[fam] || {}, over[m] || {});
  return { family: fam, ...p };
}
export function usageCost(usage, model, cfg) {
  const p = priceFor(model, cfg);
  const usd = ((usage.in || 0) * p.in + (usage.out || 0) * p.out
    + (usage.cw || 0) * p.cacheWrite + (usage.cr || 0) * p.cacheRead) / 1e6;
  return { usd, family: p.family, price: p };
}
export function newUsage() { return { in: 0, out: 0, cw: 0, cr: 0 }; }

// Pull usage out of whatever just came through. A streaming answer carries it twice: message_start has
// the input side (including the cache splits, which are what make an agent session's bill surprising)
// and the last message_delta has the output count. Regex over frames rather than parsing the stream:
// this runs on the hot path of a response we must not disturb, and a misread can only ever mean a
// wrong number in `cla-gw cost`, never a broken answer.
export function scanUsage(acc, text) {
  for (const m of String(text).matchAll(/"usage"\s*:\s*\{[^{}]*\}/g)) {
    let u = null;
    try { u = JSON.parse(m[0].slice(m[0].indexOf('{'))); } catch { continue; }
    if (typeof u.input_tokens === 'number') acc.in = u.input_tokens;
    if (typeof u.output_tokens === 'number') acc.out = u.output_tokens;
    if (typeof u.cache_creation_input_tokens === 'number') acc.cw = u.cache_creation_input_tokens;
    if (typeof u.cache_read_input_tokens === 'number') acc.cr = u.cache_read_input_tokens;
  }
  return acc;
}

// /v1/messages and its satellites are inference. Everything else is not, and must not be re-signed.
export function isInferencePath(pathname) {
  return pathname === '/v1/messages' || pathname.startsWith('/v1/messages/');
}

export function readAccountState() {
  try { return JSON.parse(fs.readFileSync(ACCOUNT_STATE_PATH, 'utf8')) || {}; } catch { return {}; }
}
export function writeAccountState(state) {
  try { fs.writeFileSync(ACCOUNT_STATE_PATH, JSON.stringify(state)); return true; } catch { return false; }
}
