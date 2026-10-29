// cla-gw audit routing — did the account switcher actually obey the rules on real traffic?
//
// Unit tests (test_selection, test_sticky, test_routing_rules) prove the rules. This proves the RUNNING
// gateway followed them, which is the half that rots: a new knob, a new 429 shape, a header the API
// started or stopped sending, or a refactor of the delivery path can all break switching while every unit
// test stays green. It reads the gateway log and checks each routed request against what the gateway
// itself recorded it knew at that moment.
//
//   cla-gw audit routing [--hours N]        (default 24)
//
// What makes this exact rather than a guess: every request line carries the quota picture as it stood
// around that request (u5h/s5h/r5h, u7d/s7d/r7d, claim, consentUntil, blockedUntil). Reconstructing state
// from responses instead - which the first version did - produced 43 false accusations, because a block's
// reset epoch was never in the log at all. Those fields are recorded now.
//
// Two judgement calls, both learned by getting them wrong:
//   * a request is judged against the picture from that account's PREVIOUS request, never its own record -
//     a response is allowed to discover the block it hit;
//   * 'sticky' moving is only a contradiction if nothing in between could have moved it (a non-detour
//     routing to another account stamps that account as the one in use, by design).
//
// What it refuses to claim: records written before those fields existed are counted as `partialPicture`
// and judged only on the picture they carry; synthetic traffic from the test/probe harnesses (no upstream
// request-id) is skipped, since it never touched a real account.

import fs from 'node:fs';
import { LOG_PATH } from './config.mjs';

const snap = (r) => ({
  s5h: r.s5h || null, r5h: typeof r.r5h === 'number' ? r.r5h : null,
  s7d: r.s7d || null, r7d: typeof r.r7d === 'number' ? r.r7d : null,
  blockedUntil: typeof r.blockedUntil === 'number' ? r.blockedUntil : null,
  consentUntil: typeof r.consentUntil === 'number' ? r.consentUntil : null,
});

function blockedFor(s, at) {
  const b = [];
  if (s.s5h === 'rejected' && s.r5h && s.r5h * 1000 > at) b.push({ win: '5h', until: s.r5h * 1000 });
  if (s.s7d === 'rejected' && s.r7d && s.r7d * 1000 > at) b.push({ win: '7d', until: s.r7d * 1000 });
  if (s.consentUntil && s.consentUntil > at) b.push({ win: 'terms', until: s.consentUntil });
  if (s.blockedUntil && s.blockedUntil > at) b.push({ win: 'park', until: s.blockedUntil });
  return b;
}

export function auditRouting({ hours = 24 } = {}) {
  const since = Date.now() - hours * 3600_000;
  let lines = [];
  try { lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean); } catch { return { error: `no log at ${LOG_PATH}` }; }

  const all = [];
  for (const s of lines) {
    let r = null;
    try { r = JSON.parse(s); } catch { continue; }
    if (r && r.selectReason && r.account && r.ts >= since) all.push(r);
  }
  all.sort((a, b) => a.ts - b.ts);
  if (!all.length) return { error: 'no routed requests in that window' };

  // Synthetic requests (tests, probes) never saw a real account and must not be judged as routing.
  const recs = all.filter((r) => r.requestId);
  const skipped = all.length - recs.length;

  const problems = [];
  const counts = {};
  let switches = 0, detours = 0, partialPicture = 0;
  const lastKnown = new Map();          // account -> picture as of its previous request
  let stickyAccount = null, stickySetBy = 0, movedSinceSticky = false;

  for (const r of recs) {
    counts[r.selectReason] = (counts[r.selectReason] || 0) + 1;
    const s = snap(r);
    if (!r.s5h && !r.s7d && !r.blockedUntil && !r.consentUntil) partialPicture++;
    const forced = /^(pinned|all-restricted|pin-unavailable|no-enabled)/.test(r.selectReason) || r.selectReason === 'detour';

    // Rule 1 - never route to an account that was ALREADY known to be limited while another was free.
    const knew = lastKnown.get(r.account) || s;
    const knewBlocked = blockedFor(knew, r.ts);
    const freeOthers = [...lastKnown.entries()]
      .filter(([label, s2]) => label !== r.account && blockedFor(s2, r.ts).length === 0)
      .map(([label]) => label);
    if (knewBlocked.length && !forced && freeOthers.length) {
      problems.push(`${new Date(r.ts).toLocaleTimeString()} sent to ${r.account}, already limited (`
        + knewBlocked.map((b) => `${b.win} until ${new Date(b.until).toLocaleTimeString()}`).join(', ')
        + `), while ${freeOthers.join(',')} looked free  [${r.selectReason}]`);
    }

    // Rule 2 - 'sticky' means the same account, unless something legitimately moved it.
    if (r.selectReason === 'sticky') {
      if (stickyAccount && stickyAccount !== r.account && r.ts - stickySetBy > 2000 && !movedSinceSticky) {
        problems.push(`${new Date(r.ts).toLocaleTimeString()} 'sticky' moved ${stickyAccount} -> ${r.account} `
          + `with nothing in between that could have moved it`);
      }
      stickyAccount = r.account; stickySetBy = r.ts; movedSinceSticky = false;
    } else if (r.selectReason !== 'detour' && r.account !== stickyAccount) {
      movedSinceSticky = true;               // this request made another account the one in use
    }

    // Rule 3 - counts that make a quiet week and a broken week look different.
    if (r.selectReason === 'detour') detours++;
    if (r.selectReason === 'switched-current-blocked' && stickyAccount && stickyAccount !== r.account) switches++;

    // Rule 4 - the pool shim may only ever shorten the wait handed to the client.
    if (r.quotaShim && r.quotaShim.refusedReadyAt) {
      const handed = r.quotaShim.readyEpochSec * 1000;
      if (handed > r.quotaShim.refusedReadyAt) {
        problems.push(`${new Date(r.ts).toLocaleTimeString()} shim LENGTHENED the wait: handed `
          + `${new Date(handed).toLocaleTimeString()} vs the refusing account's own `
          + `${new Date(r.quotaShim.refusedReadyAt).toLocaleTimeString()}`);
      }
    }

    lastKnown.set(r.account, s);
  }

  return { since, audited: recs.length, skipped, partialPicture, counts, switches, detours, problems };
}
