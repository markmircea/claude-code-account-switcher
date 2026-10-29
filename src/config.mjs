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
// CLAUDE_GW_DATA_DIR moves every live file in one place - used by the probe harnesses and by tests that
// need to feed a fixture status.json to src/statusline.mjs without touching the running gateway's state.
export const DATA_DIR = process.env.CLAUDE_GW_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(HOME, '.local', 'share'), 'claude-gw');
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

let cache = { raw: null, cfg: null };

// Hot reload: a `cla-gw disable B` from another process takes effect on the next request.
// Keyed on the file's CONTENT, not its mtime: Windows file times tick about every 16 ms, so a write landing
// in the same tick as the previous one kept the mtime and the change was never seen (test_config_safety
// failed ~1 run in 3 on exactly that). The file is a few KB; reading it costs about what the stat did.
export function loadConfig() {
  let raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  if (cache.cfg && cache.raw === raw) return cache.cfg;
  let cfg;
  try {
    cfg = parse(raw);
  } catch (e) {
    // config.json is rewritten while the gateway is serving (that is what `cla-gw switch` and
    // `cla-gw use` do, now also from inside a chat via /switch). saveConfig writes to a temp file and
    // renames, which makes a torn read very unlikely - but "very unlikely" and "every request fails at
    // once" is a bad trade. Retry once, then keep serving on the last config that parsed.
    let again = null;
    const t = Date.now(); while (Date.now() - t < 5) { /* 5 ms: error path only */ }
    try { raw = fs.readFileSync(CONFIG_PATH, 'utf8'); again = parse(raw); } catch { /* fall through */ }
    if (!again) {
      if (cache.cfg) {
        console.error(`config.json unreadable (${e.message}); continuing on the last good config`);
        return cache.cfg;
      }
      throw e;
    }
    cfg = again;
  }
  cache = { raw, cfg };
  return cfg;
}

export function saveConfig(cfg) {
  const out = { ...cfg };
  delete out.__mtime;
  // Atomic on purpose: the gateway re-reads config.json per request, so a reader must never see a half
  // file. writeFileSync alone can expose a partially-written file, and a half config.json parses to
  // nothing - which would take the whole pool down for one request.
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
  cache = { raw: null, cfg: null }; // force reload
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

  const pinnedLabel = cfg.active || null;
  if (pinnedLabel) {
    const pinned = enabled.find((a) => a.label === pinnedLabel);
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
    // The pin names a disabled or unknown account. This used to return `enabled[0]` — a label chosen by
    // config ORDER, which ignored every parked window, ignored stickiness (throwing away that account's
    // prompt cache) and could spend a request on an account already known to be limited. A dead pin is not
    // an instruction to pick blindly: fall through to the same pool rules an unpinned request gets.
  }

  const free = enabled.filter((a) => !availOf(a).blocked.length);
  if (free.length === 0) {
    // Everything is restricted: hand back whoever reactivates SOONEST (your rule), and say when.
    const soonest = enabled.slice().sort((x, y) => availOf(x).readyAt - availOf(y).readyAt)[0];
    const av = availOf(soonest);
    const why = `all accounts restricted; ${soonest.label} reactivates soonest ` +
      `(${av.blocked.map((b) => b.win).join('+')} clears ${new Date(av.readyAt).toLocaleString()})`;
    return { account: soonest, reason: 'all-restricted-soonest-reactivation', blocked: av.blocked,
             warning: pinnedLabel ? `pinned account "${pinnedLabel}" is disabled or unknown; ` + why : why };
  }

  // Sticky: stay on the account in use until a full 5h or weekly window blocks it. Usage alone never
  // moves traffic, because the prompt cache is per account and every switch resends the whole
  // conversation uncached. "In use" = latest activeAt, which the gateway stamps on every request it
  // serves other than a detour.
  const current = pool(cfg).filter((a) => state[a.label]?.activeAt)
    .sort((x, y) => state[y.label].activeAt - state[x.label].activeAt)[0] || null;
  const gated = (a) => !!(model && modelGateOf(state[a.label], model, now));
  if (current && free.includes(current) && !gated(current)) {
    if (pinnedLabel) {
      return { account: current, reason: 'pin-unavailable',
               warning: `pinned account "${pinnedLabel}" is disabled or unknown; staying on "${current.label}" (sticky)` };
    }
    return { account: current, reason: 'sticky' };
  }

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
  const out = { account: ranked[0], reason: pinnedLabel ? 'pin-unavailable' : reason };
  if (pinnedLabel) {
    out.warning = `pinned account "${pinnedLabel}" is disabled or unknown; the pool rule chose `
      + `"${ranked[0].label}" (${out.reason})`;
  }
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
//
// Per EXACT model id, in USD per million tokens: in / out / 5m cache write / 1h cache write / cache hit.
// Absolute rates, not multipliers, because the multipliers are not constant: a cache hit is 0.1x base
// input on most models but **0.05x on Opus 5.5 and Sonnet 5.5** and 0.025x on Fable/Mythos 5.1. A
// multiplier table gets that wrong silently.
//
// The old table was three families and its `opus` row (15/75/18.75/1.5) was Opus **4.1** pricing while
// this pool runs claude-opus-5-5 (4/20/5/8 + 0.20 hits) - every number would have been ~3.75x high on
// input and output, 9.4x on cache writes. Family names now only label a row; they never supply rates.
//
// Source: platform.claude.com/docs/en/about-claude/pricing, copied 2026-10-23 (see PRICES_AS_OF).
// Correct them in config.json -> "prices", per exact model id or per family:
//   {"prices": {"claude-opus-5-5": {"in": 4}, "haiku": {"in": 1}}}
export const PRICES_AS_OF = '2026-10-23';
export const WEB_SEARCH_USD_PER_REQUEST = 10 / 1000; // $10 per 1,000 searches, on top of tokens
export const US_INFERENCE_MULTIPLIER = 1.1;          // inference_geo: "us" (Claude 4.6+)
export const PRICES = {
  'claude-fable-5-1':   { in: 10,   out: 50,  w5: 12.50, w1h: 20,   cr: 0.25 },
  'claude-mythos-5-1':  { in: 10,   out: 50,  w5: 12.50, w1h: 20,   cr: 0.25 },
  'claude-fable-5':     { in: 10,   out: 50,  w5: 12.50, w1h: 20,   cr: 1.00 },
  'claude-mythos-5':    { in: 10,   out: 50,  w5: 12.50, w1h: 20,   cr: 1.00 },
  'claude-opus-5-5':    { in: 4,    out: 20,  w5: 5,     w1h: 8,    cr: 0.20, fast: { in: 8,  out: 40 } },
  'claude-opus-5':      { in: 5,    out: 25,  w5: 6.25,  w1h: 10,   cr: 0.50, fast: { in: 10, out: 50 } },
  'claude-opus-4-8':    { in: 5,    out: 25,  w5: 6.25,  w1h: 10,   cr: 0.50, fast: { in: 10, out: 50 } },
  'claude-opus-4-7':    { in: 5,    out: 25,  w5: 6.25,  w1h: 10,   cr: 0.50 },
  'claude-opus-4-6':    { in: 5,    out: 25,  w5: 6.25,  w1h: 10,   cr: 0.50 },
  'claude-opus-4-5':    { in: 5,    out: 25,  w5: 6.25,  w1h: 10,   cr: 0.50 },
  'claude-opus-4-1':    { in: 15,   out: 75,  w5: 18.75, w1h: 30,   cr: 1.50 },
  'claude-opus-4':      { in: 15,   out: 75,  w5: 18.75, w1h: 30,   cr: 1.50 },
  'claude-sonnet-5-5':  { in: 2,    out: 10,  w5: 2.50,  w1h: 4,    cr: 0.10 },
  'claude-sonnet-5':    { in: 2,    out: 10,  w5: 2.50,  w1h: 4,    cr: 0.20 },
  'claude-sonnet-4-6':  { in: 3,    out: 15,  w5: 3.75,  w1h: 6,    cr: 0.30 },
  'claude-sonnet-4-5':  { in: 3,    out: 15,  w5: 3.75,  w1h: 6,    cr: 0.30 },
  'claude-sonnet-4':    { in: 3,    out: 15,  w5: 3.75,  w1h: 6,    cr: 0.30 },
  'claude-haiku-4-5':   { in: 1,    out: 5,   w5: 1.25,  w1h: 2,    cr: 0.10 },
  'claude-haiku-3-5':   { in: 0.80, out: 4,   w5: 1,     w1h: 1.60, cr: 0.08 },
  // Haiku 5.5 is priced by prompt length (input + cache reads + cache writes > 100k pays the higher
  // row, for the WHOLE request). Kept in the table so the day it is used the rates are already right.
  'claude-haiku-5-5':   { in: 0.10, out: 0.50, w5: 0.125, w1h: 0.20, cr: 0.01,
                          long: { in: 0.50, out: 2.50, w5: 0.625, w1h: 1.00, cr: 0.05 }, longOver: 100_000 },
};
const MODEL_DATE_SUFFIX = /-\d{8}$/;
export function normalizeModel(model) {
  return String(model || '').toLowerCase().trim().replace(MODEL_DATE_SUFFIX, '');
}
export function familyOf(model) {
  const m = normalizeModel(model);
  for (const f of ['opus', 'sonnet', 'haiku', 'fable', 'mythos']) if (m.includes(f)) return f;
  return 'unknown';
}

export function priceFor(model, cfg) {
  const key = normalizeModel(model);
  const family = familyOf(key);
  const over = (cfg && cfg.prices) || {};
  const entry = key ? PRICES[key] : null;
  const own = (key && over[key]) || null;      // rates supplied in config.json for this exact model
  const byFamily = over[family] || null;
  // No rates, no number. Guessing from the family name is how a $0.04 request gets reported as $0.15:
  // a missing total that names the model is better than a wrong one. A config.json row for a model this
  // table does not know counts as real rates - that override IS the correction.
  const p = { ...(entry || {}), ...((family === 'unknown' ? null : byFamily) || {}), ...(own || {}) };
  if (!entry && !own) return { model: key || null, family, exact: false, in: null, out: null, w5: null, w1h: null, cr: null };
  if (typeof p.in !== 'number' || typeof p.out !== 'number') {
    return { model: key || null, family, exact: false, incomplete: true, ...p };
  }
  return { model: key, family, exact: true, ...p };
}

export function usageCost(usage, model, cfg) {
  const p = priceFor(model, cfg);
  if (!p.exact) return { usd: null, family: p.family, model: p.model, exact: false,
                         incomplete: !!p.incomplete, price: p,
                         unpriced: p.model || '(no model in the request)' };
  let { in: rin, out: rout, w5: rw5, w1h: rw1h, cr: rcr } = p;
  // A config.json row may give only the base pair; the cache multipliers are published (write 1.25x / 2x,
  // read 0.1x), so derive them instead of producing NaN out of a missing field.
  if (typeof rw5 !== 'number') rw5 = rin * 1.25;
  if (typeof rw1h !== 'number') rw1h = rin * 2;
  if (typeof rcr !== 'number') rcr = rin * 0.1;
  const applied = [];

  // Haiku 5.5 tier: prompt length counts every input token, including cache reads and writes.
  if (p.long && ((usage.in || 0) + (usage.cr || 0) + (usage.cw || 0)) > p.longOver) {
    ({ in: rin, out: rout, w5: rw5, w1h: rw1h, cr: rcr } = p.long);
    applied.push('long-context tier');
  }
  // Fast mode is a different price list, and the response says whether it was used.
  if (usage.speed === 'fast' && p.fast) {
    rin = p.fast.in; rout = p.fast.out; applied.push('fast mode');
  }
  // Data residency: inference_geo "us" is 1.1x on every category, and it stacks with the two above.
  if (usage.geo === 'us') {
    rin *= US_INFERENCE_MULTIPLIER; rout *= US_INFERENCE_MULTIPLIER;
    rw5 *= US_INFERENCE_MULTIPLIER; rw1h *= US_INFERENCE_MULTIPLIER; rcr *= US_INFERENCE_MULTIPLIER;
    applied.push('inference_geo us');
  }
  // Cache writes: the TTL split is in the response, and 1h writes cost 2x base input against 1.25x for
  // 5m. Use the split when present; when only the total is present, assume 5m and say so in `applied`.
  let w5 = usage.w5 || 0, w1h = usage.w1h || 0;
  if (!w5 && !w1h) { w5 = usage.cw || 0; if (w5) applied.push('cache TTL unknown -> priced as 5m'); }
  else { const rest = (usage.cw || 0) - w5 - w1h; if (rest > 0) { w5 += rest; applied.push('cache TTL split incomplete'); } }

  const tokens = ((usage.in || 0) * rin + (usage.out || 0) * rout + w5 * rw5 + w1h * rw1h + (usage.cr || 0) * rcr) / 1e6;
  const tools = (usage.search || 0) * WEB_SEARCH_USD_PER_REQUEST;
  if (usage.search) applied.push(`${usage.search} web search${usage.search === 1 ? '' : 'es'}`);
  return { usd: tokens + tools, tokenUsd: tokens, toolUsd: tools, family: p.family, model: p.model,
           exact: true, applied, price: { in: rin, out: rout, w5: rw5, w1h: rw1h, cr: rcr } };
}
// The rate rows behind a total, for the hover and `cla-gw cost`. A cost number a reader cannot check is
// not a cost number; this is what makes "which rates produced this?" answerable without opening source.
export function ratesInPlay(cfg, seenModels = []) {
  const over = (cfg && cfg.prices) || {};
  const keys = [...new Set(seenModels.filter(Boolean))].filter((k) => PRICES[k] || over[k]);
  return keys.map((k) => {
    const p = priceFor(k, cfg);
    return { model: k, in: p.in, out: p.out, w5: p.w5, w1h: p.w1h, cr: p.cr };
  });
}

// Split a window of log records into what the cost total actually means. Pure, so `cla-gw cost` and the
// tests read the same rules.
//
// The distinction that matters: a served response with NO usage object and NO usageMiss marker was
// written by a gateway that predates capture (capture went live 2026-10-23 04:44). Counting those in the
// coverage denominator would turn "the scanner was broken for ten days" into a healthy-looking 15%, and
// hiding them entirely (which the first version did) makes today's total look complete when it is a
// floor. So they are counted separately, reported by name, and push the printed total to `>=`.
export function classifyCostRows(rows) {
  const served = rows.filter((l) => l.path === '/v1/messages' && l.status < 400);
  const costable = served.filter((l) => l.usage || l.usageMiss);
  const blind = served.filter((l) => !l.usage && !l.usageMiss);
  const priced = costable.filter((l) => typeof l.costUsd === 'number');
  const unpriced = new Map();
  for (const l of costable) if (l.unpriced) unpriced.set(l.unpriced, (unpriced.get(l.unpriced) || 0) + 1);
  // When the blind spot exists, say where capture began rather than how much history is missing: one
  // date is actionable, a count of old records is not.
  const captureFrom = costable.reduce((m, l) => (m === null || l.ts < m ? l.ts : m), null);
  return {
    served, costable, priced, blind, unpriced,
    missed: costable.filter((l) => l.usageMiss),
    partial: costable.filter((l) => l.usagePartial),
    captureFrom,
    // The total is a floor if anything in the window went unpriced: old records, a cut stream, or a
    // model with no rate row. Honest `>=` beats a precise number that is quietly short.
    floor: blind.length > 0 || costable.some((l) => l.usagePartial || l.unpriced),
  };
}

export function newUsage() {
  const u = { in: 0, out: 0, cw: 0, cr: 0, w5: 0, w1h: 0, think: 0, search: 0, fetch: 0 };
  // Non-enumerable on purpose: `rec.usage = usage` goes straight into the log, and the rolling carry
  // of a half-received frame must never appear there.
  Object.defineProperty(u, 'carry', { value: '', writable: true, enumerable: false });
  Object.defineProperty(u, 'objects', { value: 0, writable: true, enumerable: false });
  return u;
}

// Index of the brace that closes the object opening at `from`, or -1 if it is not complete in this
// text. Strings and escapes are tracked because a JSON string may contain braces - a tool_result
// full of code is exactly the payload that used to derail naive brace counting.
function closeBrace(s, from) {
  let depth = 0, inStr = false, esc = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { if (inStr) esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { if (--depth === 0) return i; }
  }
  return -1;
}

// Merge one parsed usage object. LAST value wins per field, deliberately: a stream carries the input
// side in message_start and a cumulative output count in the final message_delta, so summing them
// would bill the prompt twice. Everything nested is the reason this function exists - see scanUsage.
function mergeUsage(acc, u) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  let v;
  if ((v = num(u.input_tokens)) !== null) acc.in = v;
  if ((v = num(u.output_tokens)) !== null) acc.out = v;
  if ((v = num(u.cache_read_input_tokens)) !== null) acc.cr = v;
  if ((v = num(u.cache_creation_input_tokens)) !== null) acc.cw = v;
  if (u.cache_creation && typeof u.cache_creation === 'object') {
    // A 5-minute write costs 1.25x base input, a 1-HOUR write 2x. Treating every write as 5m
    // undercounts; a real captured frame wrote 12,019 tokens to a 1h cache.
    if ((v = num(u.cache_creation.ephemeral_5m_input_tokens)) !== null) acc.w5 = v;
    if ((v = num(u.cache_creation.ephemeral_1h_input_tokens)) !== null) acc.w1h = v;
  }
  if (u.output_tokens_details && typeof u.output_tokens_details === 'object') {
    if ((v = num(u.output_tokens_details.thinking_tokens)) !== null) acc.think = v;
  }
  if (u.server_tool_use && typeof u.server_tool_use === 'object') {
    // Billed per search, not per token ($10 / 1,000), so they have to be kept separate from tokens.
    if ((v = num(u.server_tool_use.web_search_requests)) !== null) acc.search = v;
    if ((v = num(u.server_tool_use.web_fetch_requests)) !== null) acc.fetch = v;
  }
  // Both of these are pricing multipliers (fast mode 2x, inference_geo "us" 1.1x). Read now, applied
  // by usageCost, because the response is the only place that says which of them applied.
  if (typeof u.speed === 'string' && u.speed) acc.speed = u.speed;
  if (typeof u.inference_geo === 'string' && u.inference_geo) acc.geo = u.inference_geo;
}

// Pull usage out of whatever just came through.
//
// It used to be a regex: /"usage"\s*:\s*\{[^{}]*\}/ - which cannot match a usage object that contains
// a nested object, and EVERY real usage object does now (cache_creation, server_tool_use,
// output_tokens_details, iterations). Measured result: 0 of 2,002 successful responses priced. The
// test stayed green because its fixture was a hand-written flat object - the one shape the regex could
// read. So this parses properly, and the tests use frames captured from real traffic.
//
// A frame can be split across `data` events, so an unfinished object is carried into the next call
// (bounded: if a stream somehow never closes it, the carry is dropped rather than growing).
// Still text-frames-only, and still every error swallowed: a wrong number is acceptable, a broken
// stream never is.
const CARRY_MAX = 64 * 1024;
export function scanUsage(acc, text) {
  const buf = (acc.carry || '') + String(text);
  acc.carry = '';
  let i = 0;
  for (;;) {
    const k = buf.indexOf('"usage"', i);
    if (k < 0) {
      // The key itself can straddle a chunk boundary (`..."usa` | `ge":{...}`). Keep the shortest
      // suffix that could still grow into a "usage" key, and nothing more.
      if (!acc.carry) {
        const tail = buf.slice(-16);
        const q = tail.lastIndexOf('"');
        if (q >= 0 && '"usage"'.startsWith(tail.slice(q))) acc.carry = tail.slice(q);
      }
      break;
    }
    const open = buf.indexOf('{', k + 7);
    if (open < 0) { acc.carry = buf.slice(k); break; }   // cut between the key and its object
    const end = closeBrace(buf, open);
    if (end < 0) {                             // object still in flight when the chunk ended
      if (buf.length - k <= CARRY_MAX) acc.carry = buf.slice(k);
      break;
    }
    let u = null;
    try { u = JSON.parse(buf.slice(open, end + 1)); } catch { u = null; }
    if (u && typeof u === 'object') { acc.objects++; mergeUsage(acc, u); }
    i = end + 1;
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
