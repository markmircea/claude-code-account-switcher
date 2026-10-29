// Selection rules, asserted directly — no network, no quota. This is the user's rule stated as code:
//   "either window being full triggers a switch; if all are restricted, use whoever activates soonest"
import { pickAccount, availability, modelGateOf, quotaSignals, classify429, setModelGate } from './config.mjs';

let fail = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `  - ${d}` : ''}`); if (!c) fail++; };
const H = 3600_000, D = 86400_000;
const now = Date.now();
const ep = (ms) => Math.round((now + ms) / 1000);

const cfg = { accounts: [
  { label: 'A', kind: 'cli-credential', enabled: true },
  { label: 'B', kind: 'vault', enabled: true },
], active: null };

// --- availability: usable only when EVERY window allows, so ready at the LATEST rejected reset ---
const A = { s5h: 'rejected', r5h: ep(1 * H), s7d: 'rejected', r7d: ep(2 * D), u5h: 0.64, u7d: 1.02, claim: 'seven_day' };
const avA = availability(A, now);
ok('A blocked by both windows', avA.blocked.length === 2, avA.blocked.map((b) => b.win).join('+'));
ok('A is usable at the LATER reset, not the sooner one',
   Math.abs(avA.readyAt - (ep(2 * D) * 1000)) < 2000, `ready ${new Date(avA.readyAt).toLocaleString()}`);

const B = { s5h: 'rejected', r5h: ep(3 * H), s7d: 'allowed', u5h: 1.0, u7d: 0.4 };
const avB = availability(B, now);
ok('B blocked by the 5h window only', avB.blocked.length === 1 && avB.blocked[0].win === '5h');

// --- both restricted -> pick whoever reactivates soonest (B in 3h, A in 2 days) ---
let sel = pickAccount(cfg, { A, B });
ok('all restricted: picks the soonest reactivation', sel.account?.label === 'B' &&
   sel.reason === 'all-restricted-soonest-reactivation', `${sel.account?.label} via ${sel.reason}`);
ok('says when it reactivates', /clears/.test(sel.warning || ''), sel.warning);

// --- one free: switch to it (either window being full is enough to trigger the switch) ---
const Bfree = { s5h: 'allowed', s7d: 'allowed', u5h: 0.0, u7d: 0.8 };
sel = pickAccount(cfg, { A, B: Bfree });
ok('A full on either window -> served by B', sel.account?.label === 'B', `${sel.account?.label} via ${sel.reason}`);

// --- sticky: the account in use keeps serving until a window is FULL, however high its usage.
//     The user's rule: switch only when an account is blocked by a full 5h or weekly window. ---
const T = now - 60_000;
const ok5 = (u5h, u7d, extra = {}) => ({ s5h: 'allowed', s7d: 'allowed', u5h, u7d, ...extra });
sel = pickAccount(cfg, { A: ok5(0.2, 0.98, { activeAt: T }), B: ok5(0.1, 0.5) });
ok('current account keeps serving at 98% (usage alone never switches)', sel.account?.label === 'A' &&
   sel.reason === 'sticky', `${sel.account?.label} via ${sel.reason}`);
sel = pickAccount(cfg, { A: { ...A, activeAt: T }, B: Bfree });
ok('current account blocked by a full window -> switch', sel.account?.label === 'B' &&
   sel.reason === 'switched-current-blocked', `${sel.account?.label} via ${sel.reason}`);
sel = pickAccount(cfg, { A: ok5(0.1, 0.1), B: { ...Bfree, activeAt: T } });
ok('after a switch the new account stays, even once the old one has more room', sel.account?.label === 'B' &&
   sel.reason === 'sticky', `${sel.account?.label} via ${sel.reason}`);
sel = pickAccount(cfg, { A: ok5(0.71, 0.1), B: ok5(0, 0) });
ok('nothing in use yet: start on the least used', sel.account?.label === 'B' &&
   sel.reason === 'first-available', `${sel.account?.label} via ${sel.reason}`);
sel = pickAccount(cfg, { A: ok5(0.3, 0.3, { activeAt: T, blockedUntil: now + 60_000, parkReason: 'unspecified-429' }), B: Bfree });
ok('a headerless blip is a one-request detour, not a switch', sel.account?.label === 'B' &&
   sel.reason === 'detour', `${sel.account?.label} via ${sel.reason}`);
// Replay inside one request: the 429'd account is excluded, and its state says why.
sel = pickAccount(cfg, { A: { ...A, activeAt: T }, B: Bfree }, new Set(['A']));
ok('replay after a quota 429 is a switch', sel.reason === 'switched-current-blocked', sel.reason);
sel = pickAccount(cfg, { A: ok5(0.3, 0.3, { activeAt: T }), B: Bfree }, new Set(['A']));
ok('replay after a non-quota failure is a detour', sel.account?.label === 'B' && sel.reason === 'detour', sel.reason);

// --- never strand the only account ---
sel = pickAccount({ ...cfg, accounts: [cfg.accounts[0]] }, { A: { s5h: 'allowed', s7d: 'allowed', u5h: 0.99, u7d: 0.99 } });
ok('the only account still serves at 99% (no self-stranding)', sel.account?.label === 'A', sel.reason);

// --- replay bookkeeping: tried accounts are excluded ---
sel = pickAccount(cfg, { A: A, B: Bfree }, new Set(['B']));
ok('excluded accounts are not re-tried', sel.account?.label === 'A', sel.account?.label);

// --- pinned account, when restricted, is reported as such (replay decides, not selection) ---
sel = pickAccount({ ...cfg, active: 'A' }, { A, B: Bfree });
ok('pinned-but-restricted reports both windows', sel.reason === 'pinned-blocked' && sel.blocked.length === 2, sel.warning);

// --- a headerless 429 parks briefly, not for a week ---
const blip = { blockedUntil: now + 60_000, parkReason: 'unspecified-429' };
const avBlip = availability(blip, now);
ok('headerless 429 parks briefly', avBlip.blocked.length === 1 && avBlip.blocked[0].win === 'blip' &&
   avBlip.readyAt - now < 5 * 60_000, `ready in ${Math.round((avBlip.readyAt - now) / 1000)}s`);

// --- disabled accounts are never chosen ---
sel = pickAccount({ ...cfg, accounts: [{ label: 'B', kind: 'vault', enabled: false }, cfg.accounts[0]] }, { A, B: Bfree });
ok('disabled accounts stay out of the rotation', sel.account?.label === 'A', sel.account?.label);

// --- a MODEL-level 429 gates the model, not the account. This is the shape that fooled us: Sonnet
//     rejected on B while B's own headers read 7d 80% allowed_warning, and the same token served
//     Haiku seconds later. Parking B for days was wrong. ---
const gate = { u7d: 0.1, s7d: 'allowed', modelGate: { 'claude-sonnet-4-5': now + 900_000 } };
const busy = { u7d: 0.5, s7d: 'allowed' };
ok('a model gate does not restrict the account', availability(gate, now).blocked.length === 0,
   JSON.stringify(availability(gate, now).blocked));
ok('model gate matches dated model ids', modelGateOf(gate, 'claude-sonnet-4-5-20250929', now) > now, 'prefix match');
const gateCur = { ...gate, activeAt: now - 60_000 };
sel = pickAccount(cfg, { A: busy, B: gateCur }, new Set(), 'claude-sonnet-4-5');
ok('model-gated account is skipped for THAT model even when it is the current one',
   sel.account?.label === 'A', `${sel.account?.label} via ${sel.reason}`);
ok('and it is a detour, so B stays the current account', sel.reason === 'detour', sel.reason);
sel = pickAccount(cfg, { A: busy, B: gateCur }, new Set(), 'claude-haiku-4-5');
ok('the same account still serves an ungated model', sel.account?.label === 'B', `${sel.account?.label} via ${sel.reason}`);
sel = pickAccount(cfg, { A: { ...gate }, B: gate }, new Set(), 'claude-sonnet-4-5');
ok('all gated for that model: still serves, and warns', !!sel.account && /gated/.test(sel.warning || ''),
   sel.warning || sel.reason);

// --- 429 classification, decided from THIS response's headers only (the misclassification that
//     parked a healthy B for days) ---
const HG = (o) => (k) => (Object.prototype.hasOwnProperty.call(o, k) ? String(o[k]) : null);
const RESET = Math.floor(now / 1000) + 3600;
const q1 = quotaSignals(HG({ 'anthropic-ratelimit-unified-7d-status': 'rejected',
  'anthropic-ratelimit-unified-7d-reset': RESET, 'retry-after': '3600' }));
ok('shape 1: quota rejection parks to the rejected window', q1.rejectedWindows.length === 1 && q1.hasQuotaHeaders,
   JSON.stringify(q1.rejectedWindows));
const q2 = quotaSignals(HG({ 'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
  'anthropic-ratelimit-unified-7d-utilization': '0.8', 'anthropic-ratelimit-unified-7d-reset': RESET,
  'anthropic-ratelimit-unified-overage-status': 'rejected' }));
ok('shape 2: headers present, nothing rejected -> model gate, no account park',
   q2.hasQuotaHeaders && q2.rejectedWindows.length === 0, JSON.stringify({ s7d: q2.s7d, w: q2.rejectedWindows }));
ok('overage-status rejected is NOT a capacity signal', !q2.rejectedWindows.length, 'overage is purchase state');
const q3 = quotaSignals(HG({}));
ok('shape 3: headerless 429 carries no quota info', !q3.hasQuotaHeaders && !q3.rejectedWindows.length, JSON.stringify(q3));
ok('merged state cannot invent a rejection (stale s7d ignored)',
   quotaSignals(HG({ 'anthropic-ratelimit-unified-7d-utilization': '0.8' })).rejectedWindows.length === 0);

// --- the headerless Opus/Sonnet 429 on a healthy B: gate the model, keep the account serving ---
const healthyB = { s7d: 'allowed_warning', u7d: 0.8, s5h: 'allowed', u5h: 0.01, lastGoodAt: now - 60_000 };
ok('headerless 429 on a recently-healthy account reads as a MODEL gate',
   classify429(HG({}), healthyB, now).kind === 'model', classify429(HG({}), healthyB, now).kind);
ok('headerless 429 with no history is only a blip', classify429(HG({}), {}, now).kind === 'blip',
   classify429(HG({}), {}, now).kind);
ok('a stale success (>6h) does not count as recent',
   classify429(HG({}), { ...healthyB, lastGoodAt: now - 7 * 3600_000 }, now).kind === 'blip');
ok('a real quota rejection still wins over model-gate guessing',
   classify429(HG({ 'anthropic-ratelimit-unified-7d-status': 'rejected',
     'anthropic-ratelimit-unified-7d-reset': RESET }), healthyB, now).kind === 'quota');

// --- escalating model gates: a model that keeps refusing an account must stop being re-probed on
//     every message (each probe is an upstream round trip the user waits for) ---
const esc = {}; const win = [];
for (let i = 0; i < 8; i++) { setModelGate(esc, 'claude-opus-4-5', 60_000); win.push(esc.modelGateWindow); }
ok('model gate escalates then caps at 4h', win.every((x, i) => i === 0 || x >= win[i - 1]) &&
   win[win.length - 1] === 4 * 3600_000, win.map((x) => `${Math.round(x / 60000)}m`).join(' '));
ok('gated model is preferred against even when the account is otherwise the best pick',
   pickAccount(cfg, { A: busy, B: { ...gate, modelGate: { 'claude-opus-4-5': now + 3600_000 } } }, new Set(), 'claude-opus-4-5').account?.label === 'A');

console.log(fail ? `\n${fail} check(s) failed` : '\nrotation rules verified');
process.exit(fail ? 1 : 0);
