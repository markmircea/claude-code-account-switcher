// The VS Code status bar must name EVERY account, not just the serving one.
//
// Why this is a test and not a glance: the bar used to render one cell (the sticky account) and hide
// the other two in the hover. That is exactly the shape that silently degrades as accounts get parked,
// disabled or terms-walled — you cannot see the pool, only the survivor. These checks hold the rule:
// every configured account gets a cell, and a blocked one says WHEN rather than a percentage.
//
// vscode/extension.js is CommonJS and starts with require('vscode'), which does not exist outside the
// editor, so Module._load is intercepted. render() itself is pure: files in, text out.
//
//   node src/test_statusbar.mjs

import Module from 'node:module';
import { createRequire } from 'node:module';

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return {}; // activate() is never called here; render() needs nothing
  return origLoad.call(this, request, ...rest);
};
const ext = createRequire(import.meta.url)('../vscode/extension.js');
Module._load = origLoad;

let fail = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `  - ${d}` : ''}`); if (!c) fail++; };

const NOW = 1_800_000_000_000; // fixed clock: the clocks printed below are derived from it
const HOUR = 3600_000;

const cfg = {
  host: '127.0.0.1', port: 8790, active: null, secretHeader: 'x-gw-secret',
  accounts: [
    { label: 'B', kind: 'vault' },
    { label: 'C', kind: 'vault' },
    { label: 'D', kind: 'vault' },
    { label: 'A', kind: 'vault', enabled: false },
  ],
};
const state = {
  // B: 5h window rejected, clears in 2h. Must read as a reopen time, never as a percentage.
  B: { activeAt: NOW - 9 * HOUR, u5h: 1, s5h: 'rejected', r5h: (NOW + 2 * HOUR) / 1000, u7d: 0.4, s7d: 'allowed', r7d: NOW / 1000 + 3 * 24 * 3600 },
  // C: terms wall. Not quota — a human has to sign in.
  C: { activeAt: NOW - 5 * HOUR, consentUntil: NOW + HOUR },
  // D: serving (newest activeAt), room left.
  D: { activeAt: NOW - 60_000, u5h: 0.28, s5h: 'allowed', r5h: NOW / 1000 + 2 * 3600, u7d: 0.25, s7d: 'allowed', r7d: NOW / 1000 + 5 * 24 * 3600 },
};
const status = {
  cost: {
    todayUsd: 1.234, totalUsd: 4.5, byDay: { "2026-10-23": 1.234 }, byAccount: { D: 4.5 },
    byModel: { "claude-opus-5-5": { usd: 4.4, n: 40, in: 1200, out: 90, cw: 800, cr: 40000, search: 2 } },
    coverage: { priced: 40, served: 41, partial: 1 },
    unpriced: {}, pricesAsOf: "2026-10-23",
    rates: [{ model: "claude-opus-5-5", in: 4, out: 20, w5: 5, w1h: 8, cr: 0.2 }],
  },
};

const r = ext._render(cfg, state, status, true, NOW);
const bar = r.text.replace('$(pulse) ', '');
console.log(`bar: ${bar}\n`);

ok('every pool account is on the bar without hovering',
  ['B', 'C', 'D'].every((l) => new RegExp(`(^|[ ·])(\\$\\(check\\) )?${l}(?= |·|$)`).test(bar)), bar);
ok('a disabled account is still listed, marked off', /(^|[ ·])A off/.test(bar));
ok('the serving account is marked with a check and comes first',
  bar.indexOf('$(check) D') < bar.indexOf(' B') && bar.includes('$(check) D'), bar.slice(0, 30));
ok('exactly one check on the bar: standby and blocked accounts carry no mark',
  (bar.match(/\$\(check\)/g) || []).length === 1, bar);
// A pinned/sticky account that is ITSELF blocked must not wear the check next to its own ⛔.
const pinnedBlocked = ext._render({ ...cfg, active: 'B' }, state, status, true, NOW);
ok('a blocked serving account keeps its ⛔ cell and gets no check',
  /(^|[ ·])B ⛔/.test(pinnedBlocked.text) && !/\$\(check\) B/.test(pinnedBlocked.text), pinnedBlocked.text);
ok('the serving account carries its 5h/7d usage', /\$\(check\) D 28%\/25%/.test(bar));
ok('a quota-blocked account says WHEN, not a percentage', /B ⛔\d/.test(bar) && !/B \d/.test(bar));
ok('a terms-walled account says it needs terms, not a clock', /C ⚠terms/.test(bar));
ok('cost stays on the bar, and >= because the fixture has a partial stream', /(≈|≥)\$1\.23 api/.test(bar), bar);
ok('no separate "opens" cell once every account is visible (it would repeat the ⛔ cell)', !/opens/.test(bar));

// The money half of the hover. These exist because the extension used to keep its OWN rate table, and
// when the gateway moved to per-model rates the hover kept quoting opus at 15/75 forever. The gateway
// now publishes the rates it used (status.json -> cost.rates) and the hover only echoes them.
const covStatus = JSON.parse(JSON.stringify(status));
const withCost = (patch) => { const s = JSON.parse(JSON.stringify(status)); s.cost = patch; return s; };
const hover = ext._render(cfg, state, withCost({ ...covStatus.cost, todayUsd: 0.0004 }), true, NOW).tooltip;
ok('a sub-cent day does not clutter the bar (it reads as noise next to the pool)',
  !/ api\b/.test(ext._render(cfg, state, withCost({ ...covStatus.cost, todayUsd: 0.0004 }), true, NOW).text));
ok('but the hover still shows it, with enough digits to read', /\$0\.000400/.test(hover), (hover.match(/\$0\.000400/) || [''])[0]);
const floorHover = ext._render(cfg, state, withCost({ ...covStatus.cost, coverage: { priced: 40, served: 41, partial: 9 } }), true, NOW);
ok('a partial stream turns the bar and the hover into a floor (>=), not an equals',
  floorHover.text.includes('≥') && floorHover.tooltip.includes('≥'), floorHover.text);
const covHover = ext._render(cfg, state, status, true, NOW).tooltip;
ok('hover states its coverage in one footnote: priced N of M', /40 of 41 served responses priced/.test(covHover),
  covHover.split('\n').find((l) => l.includes('served responses priced')) || '');
ok('hover gives the rolling windows the user asked for: day, week, month, all-time',
  /day .*week .*month .*all-time/.test(covHover), (covHover.match(/day [^\n]*/) || [''])[0]);
ok('the audit dump is gone from the hover: no per-model token table, no rate rows',
  !/cache-w/.test(covHover) && !/in-out/.test(covHover) && !/\| model \|/.test(covHover));
ok('the by-account cost row is gone too (cla-gw cost owns the breakdown)', !/by account/.test(covHover));
// An OLD gateway (no cost.periods field) must still get the full window line, derived from byDay.
const oldGwCost = { todayUsd: 1.234, totalUsd: 4.5,
  byDay: { [new Date(NOW).toISOString().slice(0, 10)]: 1.234,
           [new Date(NOW - 3 * 86400_000).toISOString().slice(0, 10)]: 2.0,
           [new Date(NOW - 40 * 86400_000).toISOString().slice(0, 10)]: 1.266 } };
const oldGwHover = ext._render(cfg, state, { cost: oldGwCost }, true, NOW).tooltip;
ok('an old gateway without cost.periods still gets day/week/month/all-time, computed from byDay',
  /day \*\*\$1\.23/.test(oldGwHover) && /week \*\*\$3\.23/.test(oldGwHover) && /all-time \*\*\$4\.50/.test(oldGwHover),
  (oldGwHover.match(/day [^\n]*/) || [''])[0]);
ok('stale rates are called out, not presented as current',
  /days old/.test(ext._render(cfg, state, withCost({ ...covStatus.cost, pricesAsOf: '2025-01-01' }), true, NOW).tooltip));
const unpHover = ext._render(cfg, state, withCost({ ...covStatus.cost, unpriced: { 'claude-opus-6-0': 3 } }), true, NOW).tooltip;
ok('unpriced models are named as unpriced rather than priced by guess',
  /not priced/.test(unpHover) && /claude-opus-6-0/.test(unpHover));
ok('an empty cost block says nothing is priced rather than showing $0',
  /nothing priced yet/.test(ext._render(cfg, state, withCost(null), true, NOW).tooltip));

// The hover must still carry the detail the bar now cannot fit.
ok('hover still table-formats every account', ['B', 'C', 'D'].every((l) => r.tooltip.includes(`**${l}**`)));
ok('the hover marks the serving account with a colored check', /✅ serving/.test(r.tooltip) && !/✅ standby/.test(r.tooltip));
ok('hover explains the terms wall', /accepts the updated Consumer Terms/.test(r.tooltip));
ok('alarm stays on when the whole pool is walled', ext._render(cfg,
  { B: { ...state.B, consentUntil: NOW + HOUR }, C: state.C, D: { ...state.D, s5h: 'rejected', r5h: (NOW + HOUR) / 1000 } },
  status, true, NOW).alarm === true);

// Degenerate pools must not render an empty or misleading bar.
const oneAcct = { ...cfg, accounts: [{ label: 'D', kind: 'vault' }] };
ok('single-account pool still names it', /gw: \$\(check\) D/.test(ext._render(oneAcct, { D: state.D }, status, true, NOW).text));
ok('a single blocked account names itself with no check', /gw: B ⛔/.test(ext._render({ ...cfg, accounts: [{ label: 'B', kind: 'vault' }] }, { B: state.B }, status, true, NOW).text));
const allOff = ext._render({ ...cfg, accounts: [{ label: 'A', enabled: false }] }, {}, status, true, NOW).text;
ok('all accounts disabled: still lists them, marks them off, no fake usage', /A off/.test(allOff) && !/\d%/.test(allOff), allOff);
ok('no accounts configured at all says so', /none enabled/.test(ext._render({ ...cfg, accounts: [] }, {}, status, true, NOW).text));
ok('gateway down beats everything', /claude-gw DOWN/.test(ext._render(cfg, state, status, false, NOW).text));

// Length: the bar is right-aligned and VS Code hides neighbours when it overflows. Three accounts
// must stay readable; this is the ceiling the layout was designed for.
const three = ext._render({ ...cfg, accounts: cfg.accounts.slice(0, 3) }, state, status, true, NOW).text;
ok('three-account bar stays under 70 chars', three.length < 70, `${three.length}: ${three}`);

// A day that contains records from before token capture existed is a FLOOR, not an exact total. The bar
// has to say so with ≥ and the hover has to name the blind spot; a precise-looking number that is quietly
// missing two days of history is worse than an obvious approximation.
const blindCost = { todayUsd: 3.0, totalUsd: 9.0, byAccount: {}, byModel: {},
  coverage: { priced: 4, served: 4, partial: 0, blind: 137 } };
const b1 = ext._render(cfg, state, { cost: blindCost }, true, NOW);
ok('pre-capture records force the bar to a floor marker', /≥\$3\.00 api/.test(b1.text), b1.text);
ok('the hover names the blind spot in the footnote', /137 predate token capture/.test(b1.tooltip));
const b2 = ext._render(cfg, state, { cost: { ...blindCost, coverage: { priced: 4, served: 5, partial: 1, blind: 0 } } }, true, NOW);
ok('a stream cut off mid-output also forces the floor marker', /≥\$3\.00 api/.test(b2.text), b2.text);
const b3 = ext._render(cfg, state, { cost: { ...blindCost, coverage: { priced: 4, served: 4, partial: 0, blind: 0 } } }, true, NOW);
ok('a fully covered day prints without the marker', /≈\$3\.00 api/.test(b3.text), b3.text);

// A held chat must be distinguishable from a hang. The gateway parks a turn for up to 10 minutes to ride
// out a quota window; from the user's seat that is identical to a freeze unless the bar says otherwise.
const heldStatus = { cost: status.cost, holds: { n: 2, reopenAt: NOW + 6 * 60_000, longestMs: 4 * 60_000,
  items: [{ sessionId: 's1', via: 'B', model: 'claude-opus-5-5', heldMs: 4 * 60_000, reopenAt: NOW + 6 * 60_000 },
           { sessionId: 's2', via: 'B', model: 'claude-opus-5-5', heldMs: 2 * 60_000, reopenAt: NOW + 6 * 60_000 }] } };
const h1 = ext._render(cfg, state, heldStatus, true, NOW);
ok('held chats get a bar cell with the reopen time', /⏳ 2 held →/.test(h1.text), h1.text);
ok('the hover says the turn is alive, not hung', /being held open by the gateway/.test(h1.tooltip)
  && /the turn is alive, not hung/.test(h1.tooltip));
ok('the hover names which account will serve them', /via B/.test(h1.tooltip));
ok('no holds -> no cell', !/⏳/.test(ext._render(cfg, state, { cost: status.cost, holds: { n: 0 } }, true, NOW).text));
ok('a gateway without the holds field still renders', !/⏳/.test(ext._render(cfg, state, { cost: status.cost }, true, NOW).text));

// The per-conversation badge (src/statusline.mjs, what Claude Code shows as `gw→X`).
//
// Why this is tested: the badge is looked up by session_id, and a FAILED response stamps it too. That is
// how a chat ends up showing `gw→B` when B only ever answered it with a 403 detour while the pool was
// serving on D — per-conversation truth that reads like a pool statement. Fixtures are written to a throw-
// away dir via CLAUDE_GW_DATA_DIR so the running gateway's status.json is never touched.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sdir = path.join('.probe', 'statusline');
fs.mkdirSync(sdir, { recursive: true });
// The statusline compares against the REAL clock (it must be honest about staleness), so this fixture is
// built from Date.now() rather than the fixed NOW the bar checks above use.
const SNOW = Date.now();
const statusFixture = (ts) => JSON.stringify({
  ts, pin: null, pool: ['B', 'C', 'D'], disabled: [], requests: 1, errors: 0,
  accounts: {
    B: { u5h: 1, u7d: 0.68, s5h: 'rejected', r5h: Math.floor(SNOW / 1000) - 3600, activeAt: SNOW - 9e7 },
    C: { u5h: 1, u7d: 0.68, s5h: 'rejected', r5h: Math.floor(SNOW / 1000) - 3600, activeAt: SNOW - 8e7 },
    D: { u5h: 0.38, u7d: 0.05, s5h: 'allowed', activeAt: SNOW },
  },
  sessions: [['badchat', { account: 'B', status: 403, ts: SNOW }],
             ['goodchat', { account: 'D', status: 200, ts: SNOW }]],
});
const askStatusline = (sid, ts = Date.now()) => {
  fs.writeFileSync(path.join(sdir, 'status.json'), statusFixture(ts));
  return execFileSync(process.execPath, ['src/statusline.mjs'], {
    input: JSON.stringify({ session_id: sid }),
    env: { ...process.env, CLAUDE_GW_DATA_DIR: path.resolve(sdir) },
  }).toString().trim();
};

const badgeBad = askStatusline('badchat');
ok('a failed last reply is not shown as a plain account badge', /gw→B/.test(badgeBad) && /last reply 403 from B/.test(badgeBad), badgeBad);
ok('and it says where the pool actually is', /pool is on D/.test(badgeBad), badgeBad);
ok('a served conversation gets no failure note', !/last reply/.test(askStatusline('goodchat')));
ok('a conversation the gateway has not served is marked as inferred', /gw→~D/.test(askStatusline('never-seen')));
ok('a stale status.json says idle rather than an account', /gw: idle/.test(askStatusline('badchat', SNOW - 10 * 60_000)));

console.log(fail ? `\n${fail} FAILED` : '\nstatus bar shows the whole pool');
process.exit(fail ? 1 : 0);
