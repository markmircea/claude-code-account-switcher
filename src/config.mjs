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
export function availability(s, now = Date.now()) {
  if (!s) return { blocked: [], readyAt: 0 };
  const blocked = [];
  for (const [win, st, reset] of [['5h', s.s5h, s.r5h], ['7d', s.s7d, s.r7d]]) {
    if (st === 'rejected' && reset && reset * 1000 > now) blocked.push({ win, readyAt: reset * 1000 });
  }
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

export function readAccountState() {
  try { return JSON.parse(fs.readFileSync(ACCOUNT_STATE_PATH, 'utf8')) || {}; } catch { return {}; }
}
export function writeAccountState(state) {
  try { fs.writeFileSync(ACCOUNT_STATE_PATH, JSON.stringify(state)); return true; } catch { return false; }
}
