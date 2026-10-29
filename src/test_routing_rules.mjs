// The routing rules, written as tests that cannot be satisfied by accident.
//
// WHY. `test_selection.mjs` and `test_sticky.mjs` cover the behaviours that were hard to get right.
// This file covers the CONTRACT, so a later change somewhere else (a new knob, a new 429 shape, a price
// table, a status bar) cannot quietly move traffic somewhere it should not. Every check names the rule it
// protects, and the last section is an invariant sweep over a matrix of states: it does not assert which
// account wins, it asserts what may never happen.
//
//   node src/test_routing_rules.mjs

import { pickAccount, availability, classify429, poolQuotaShim } from './config.mjs';

let fail = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `  - ${d}` : ''}`); if (!c) fail++; };

const NOW = Date.now();
const H = 3600_000;
const future = (ms) => Math.floor((NOW + ms) / 1000);

const mk = (labels, active = null) => ({
  active, accounts: labels.map((l) => ({ label: l, kind: 'vault', enabled: l !== 'A' })),
});
const cfg = mk(['A', 'B', 'C', 'D']);
const free = (at = 0) => ({ lastGoodAt: NOW - at, activeAt: NOW - at, u5h: 0.2, s5h: 'allowed', r5h: future(2 * H), u7d: 0.2, s7d: 'allowed', r7d: future(4 * 24 * H) });
const sel = (state, model = null, exclude = new Set(), c = cfg) => { const r = pickAccount(c, state, exclude, model); return { label: r.account?.label ?? null, ...r }; };

// 1. Stickiness: the account in use stays in use.
{
  const st = { B: free(9 * H), C: free(1 * H), D: free(5 * H) };
  const r = sel(st);
  ok('STICKY: the account that served most recently serves again', r.label === 'C' && r.reason === 'sticky', `${r.label}/${r.reason}`);
}
// 2. Usage pressure alone never moves traffic (it would cost the prompt cache).
{
  const st = { B: { ...free(9 * H), u5h: 0.05 }, C: { ...free(1 * H), u5h: 0.97, s5h: 'allowed_warning' }, D: free(5 * H) };
  const r = sel(st);
  ok('PRESSURE: near-full but allowed => no switch; usage only breaks ties', r.label === 'C' && r.reason === 'sticky', `${r.label}/${r.reason}`);
}
// 3. A full window is the only thing that moves it permanently.
{
  const st = { B: free(9 * H), C: { ...free(1 * H), s5h: 'rejected', r5h: future(1 * H) }, D: { ...free(5 * H), u7d: 0.9 } };
  const r = sel(st);
  ok('QUOTA WINDOW: rejected 5h => a real switch, least-pressured free account', r.label === 'B' && r.reason === 'switched-current-blocked', `${r.label}/${r.reason}`);
}
// 4. Blocked until the LAST rejected window clears, not the first.
{
  const av = availability({ s5h: 'rejected', r5h: future(1 * H), s7d: 'rejected', r7d: future(3 * H) }, NOW);
  ok('MULTI-WINDOW: readyAt is the later epoch (a request needs every window to allow)',
    Math.abs(av.readyAt - (NOW + 3 * H)) < 2000 && av.blocked.length === 2, `${av.readyAt}`);
}
// 5. A terms-of-service wall is not quota: route around it, and say what to click.
{
  const st = { B: free(9 * H), C: { ...free(1 * H), consentUntil: NOW + H }, D: free(5 * H) };
  const av = availability(st.C, NOW);
  const r = sel(st);
  ok('TERMS WALL: counted as blocked under its own window name', av.blocked.some((b) => b.win === 'terms'), JSON.stringify(av.blocked));
  ok('TERMS WALL: the wall account is not selected', r.label !== 'C', r.label);
}
// 6. A model gate is a one-request detour; the account stays in use.
{
  const st = { B: free(9 * H), C: { ...free(1 * H), modelGate: { 'claude-opus-5-5': NOW + 4 * H }, modelGateWindow: 900_000 }, D: free(5 * H) };
  const r = sel(st, 'claude-opus-5-5');
  ok('MODEL GATE: detours for this model only', r.label !== 'C' && r.reason === 'detour', `${r.label}/${r.reason}`);
  const other = sel(st, 'claude-haiku-4-5');
  ok('MODEL GATE: the same account still serves a different model', other.label === 'C' && other.reason === 'sticky', `${other.label}/${other.reason}`);
}
// 7. A headerless 429 parks briefly and does NOT count as a switch.
{
  const st = { B: free(9 * H), C: { ...free(1 * H), blockedUntil: NOW + 60_000, parkReason: 'unspecified-429' }, D: free(5 * H) };
  const av = availability(st.C, NOW);
  const r = sel(st);
  ok('HEADERLESS 429: parked as a blip', av.blocked.some((b) => b.win === 'blip'), JSON.stringify(av.blocked));
  ok('HEADERLESS 429: a detour, so the sticky account is not moved', r.reason === 'detour' && r.label !== 'C', `${r.label}/${r.reason}`);
}
// 8. Recovery: once the epoch has passed the account is usable again, no restart needed.
{
  const st = { B: free(9 * H), C: { ...free(1 * H), activeAt: NOW - 1000, s5h: 'rejected', r5h: future(-H) }, D: free(5 * H) };
  const r = sel(st);
  ok('RECOVERY: an expired window stops blocking, from the state alone', r.label === 'C' && r.reason === 'sticky', `${r.label}/${r.reason}`);
}
// 9. Everything limited: whoever reopens soonest, and the answer says when.
{
  const st = { B: { ...free(9 * H), s5h: 'rejected', r5h: future(2 * H) }, C: { ...free(1 * H), s5h: 'rejected', r5h: future(H) }, D: { ...free(5 * H), s7d: 'rejected', r7d: future(4 * H) } };
  const r = sel(st);
  ok('ALL LIMITED: pick the soonest reactivation', r.label === 'C' && r.reason === 'all-restricted-soonest-reactivation', `${r.label}/${r.reason}`);
}
// 10. Pins are honoured, including when the pinned account is limited - but a dead pin is not a licence to pick blindly.
{
  const st = { B: free(9 * H), C: free(1 * H), D: free(5 * H) };
  ok('PIN: a live pin wins over stickiness', sel(st, null, new Set(), mk(['A', 'B', 'C', 'D'], 'B')).label === 'B');
  const blockedPin = sel({ ...st, B: { ...st.B, s5h: 'rejected', r5h: future(H) } }, null, new Set(), mk(['A', 'B', 'C', 'D'], 'B'));
  ok('PIN BLOCKED: honoured, but flagged and with the reopen time', blockedPin.reason === 'pinned-blocked' && blockedPin.label === 'B' && !!blockedPin.warning, blockedPin.reason);
  // The hole this replaced picked enabled[0] by config order: it ignored parked windows and stickiness.
  const deadPin = sel({ B: { ...free(9 * H), s5h: 'rejected', r5h: future(H) }, C: free(1 * H), D: free(5 * H) }, null, new Set(), mk(['A', 'B', 'C', 'D'], 'A'));
  ok('DEAD PIN: never hands work to a parked account', deadPin.label !== 'B', `${deadPin.label}/${deadPin.reason}`);
  ok('DEAD PIN: still obeys stickiness, and says the pin was dead', deadPin.label === 'C' && deadPin.reason === 'pin-unavailable' && /disabled or unknown/.test(deadPin.warning || ''), `${deadPin.label}/${deadPin.reason}`);
}
// 11. Replay excludes: the account that just refused is never re-tried inside one request.
{
  const st = { B: free(9 * H), C: free(1 * H), D: free(5 * H) };
  const r = sel(st, null, new Set(['C']));
  ok('REPLAY: an excluded account cannot be chosen', r.label !== 'C', r.label);
  ok('REPLAY: excluding every account fails loudly rather than looping', sel(st, null, new Set(['B', 'C', 'D'])).account === null);
}
// 12. Disabled accounts are invisible to routing.
{
  const st = { A: free(0), B: free(9 * H), C: free(1 * H), D: free(5 * H) };
  ok('DISABLED: never selected, even when it is the fittest', !['A'].includes(sel(st).label), sel(st).label);
}
// 13. The quota shim may only shorten a wait, never lengthen one.
{
  const st = { B: { ...free(9 * H), s5h: 'rejected', r5h: future(3 * H), reset: future(3 * H) }, C: { ...free(1 * H), s5h: 'allowed', r5h: future(H) } };
  const shim = poolQuotaShim(cfg, st, 'B', NOW);
  ok('SHIM: a free account is announced instead of the refusing one', shim && shim.via === 'C', JSON.stringify(shim));
  ok('SHIM: the countdown handed to the client is never later than the refusing account\'s own',
    shim.readyEpochSec * 1000 <= NOW + 3 * H, `${shim.readyEpochSec}`);
  ok('SHIM: nothing invented when the refusing account is itself the soonest',
    (() => { const s2 = poolQuotaShim(cfg, { B: { ...free(9 * H), s5h: 'rejected', r5h: future(H), reset: future(H) }, C: { ...st.C, s5h: 'rejected', r5h: future(2 * H) } }, 'B', NOW); return !s2 || s2.readyEpochSec * 1000 <= NOW + H; })());
}
// 14. The three 429 shapes stay distinguishable (getting this wrong parks a healthy account for days).
{
  const hdr = (kv) => (k) => (kv[k] === undefined ? null : String(kv[k]));
  const q = classify429(hdr({ 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': String(future(H)) }), free(), NOW);
  const m = classify429(hdr({ 'anthropic-ratelimit-unified-7d-status': 'allowed_warning', 'anthropic-ratelimit-unified-7d-utilization': '0.8' }), free(), NOW);
  const b = classify429(hdr({}), {}, NOW);
  const b2 = classify429(hdr({}), { s5h: 'allowed', s7d: 'allowed', lastGoodAt: NOW - 60_000 }, NOW);
  ok('429 shape 1: quota rejection parks to the window', q.kind === 'quota', q.kind);
  ok('429 shape 2: headers but nothing rejected => the model is gated, not the account', m.kind === 'model', m.kind);
  ok('429 shape 3: no quota info on an account we have never seen => short park only', b.kind === 'blip', b.kind);
  ok('429 shape 3b: no quota info on an account that served a minute ago => model gate', b2.kind === 'model', b2.kind);
}
// 15. INVARIANT SWEEP. Does not assert who wins; asserts what may never happen, whatever the knobs do.
{
  const windows = [undefined, 'allowed', 'allowed_warning', 'rejected'];
  const parks = [0, NOW + H];
  const gates = [null, 'claude-opus-5-5'];
  let n = 0, bad = [];
  for (const s5h of windows) for (const s7d of windows) for (const park of parks) for (const gate of gates)
    for (const consent of [0, NOW + H]) for (const pin of [null, 'A', 'B', 'gone']) {
      const st = {
        B: { ...free(9 * H), s5h, r5h: future(H), s7d, r7d: future(3 * H), blockedUntil: park, consentUntil: consent, modelGate: gate ? { [gate]: NOW + H } : undefined },
        C: { ...free(1 * H), s5h: 'allowed', r5h: future(H), s7d: 'allowed', r7d: future(3 * H) },
        D: { ...free(5 * H), s5h: 'allowed', r5h: future(H), s7d: 'allowed', r7d: future(3 * H) },
      };
      const model = 'claude-opus-5-5';
      const r = pickAccount({ ...cfg, active: pin }, st, new Set(), model);
      n++;
      if (r.account && r.account.enabled === false) bad.push(`disabled account chosen (pin=${pin})`);
      const blocked = availability(st[r.account?.label], NOW).blocked.length > 0;
      const anyFree = ['B', 'C', 'D'].some((l) => availability(st[l], NOW).blocked.length === 0);
      if (r.account && blocked && anyFree && r.reason !== 'pinned-blocked' && r.reason !== 'pinned-model-gated')
        bad.push(`chose a blocked ${r.account.label} while a free account existed (${r.reason}; s5h=${s5h}, s7d=${s7d}, park=${park}, gate=${gate}, consent=${consent}, pin=${pin})`);
    }
  ok(`INVARIANT: ${n} state combinations - never a blocked account while one is free, never a disabled one`,
    bad.length === 0, bad.slice(0, 3).join(' | '));
}

console.log(fail ? `\n${fail} FAILED` : '\nrouting contract holds');
process.exit(fail ? 1 : 0);
