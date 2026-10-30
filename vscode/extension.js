// claude-gw status bar item: which account is serving Claude Code, what is left of its windows, when
// the pool reopens, and what the same traffic would have cost on a metered API key.
//
// Why an extension: the Claude Code panel in VS Code draws no settings.json statusLine, and Claude
// Code mods cannot draw in the VS Code panel yet. This reads the gateway's own files (the same state
// `cla-gw health` prints) and pings its unauthenticated /__gw/health. It never reads the vault, and it
// reads config.json only for the port, the account list and the price table - never the secret.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Must match DATA_DIR in src/config.mjs: %LOCALAPPDATA%\claude-gw on Windows, ~/.local/share/claude-gw elsewhere.
const DIR = path.join(process.env.LOCALAPPDATA || (process.platform === 'win32'
  ? path.join(process.env.USERPROFILE || '', 'AppData', 'Local')
  : path.join(process.env.HOME || '', '.local', 'share')), 'claude-gw');
const STATE_PATH = path.join(DIR, 'accounts_state.json');
const CONFIG_PATH = path.join(DIR, 'config.json');
const STATUS_PATH = path.join(DIR, 'status.json');

// Rates used to live here as a copied table. That copy is what made the hover quietly wrong: the
// gateway moved to per-model rates and this file still showed opus at 15/75. The numbers behind a cost
// figure now come FROM the gateway (status.json -> cost.rates + pricesAsOf), so there is one table and
// the hover can say when it was last checked instead of asserting rates it never verified.
const STALE_RATES_DAYS = 90;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function gatewayUp(host, port) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/__gw/health', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// As config.mjs availability(): usable again only when the LAST rejected window clears, and a terms
// wall parks an account the same way (no quota headers, so nothing else distinguishes it).
function blockedUntil(s, now) {
  let until = 0;
  if (s.s5h === 'rejected' && s.r5h * 1000 > now) until = Math.max(until, s.r5h * 1000);
  if (s.s7d === 'rejected' && s.r7d * 1000 > now) until = Math.max(until, s.r7d * 1000);
  if (s.blockedUntil > now) until = Math.max(until, s.blockedUntil);
  if (s.consentUntil > now) until = Math.max(until, s.consentUntil);
  return until;
}

// A window that has reset since the account last served: its real usage is unknown, not the old figure.
function pct(u, resetEpoch, now) {
  if (u == null || (resetEpoch && resetEpoch * 1000 <= now)) return '?';
  return `${Math.round(u * 100)}%`;
}

const when = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// A per-request figure can be $0.00004. Rounding that to "$0.00" reads as "free"; small values keep
// enough digits to be read, and the bar only shows cost once it is worth reading at all.
const COST_BAR_MIN_USD = 0.01;
const tok = (v) => v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v || 0);
// Rates are copied by hand from the pricing page, so the hover says how old the copy is instead of
// letting a stale table look authoritative. `now` is passed in so the pure render() stays testable.
function ratesAgeDays(asOf, now) {
  const t = Date.parse(asOf || '');
  return Number.isFinite(t) ? Math.floor((now - t) / 86_400_000) : Infinity;
}
const money = (v) => (v == null ? '?' : v === 0 ? '$0.00' : v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(6)}`);

// Pool's soonest reopening, the same computation pickAccount uses when it has nothing free.
function poolOpening(pool, st, now) {
  let best = null;
  for (const l of pool) {
    const u = blockedUntil(st(l), now);
    if (u > now && (!best || u < best.readyAt)) best = { label: l, readyAt: u };
  }
  return best;
}

// Rolling day/week/month/all-time from whatever the gateway published. New gateways publish
// cost.periods directly; old ones only publish byDay/todayUsd/totalUsd, so the same windows are
// derived here. A hover must not break on either combination - the extension and the gateway restart
// on different schedules.
function costPeriodsOf(cost, now) {
  if (cost.periods) return cost.periods;
  const byDay = cost.byDay || {};
  const DAY = 86_400_000;
  const key = (ms) => new Date(ms).toISOString().slice(0, 10);
  const sum = (n) => { let s = 0; for (let i = 0; i < n; i++) s += byDay[key(now - i * DAY)] || 0; return s; };
  let allTime = 0;
  for (const v of Object.values(byDay)) allTime += v;
  return { day: cost.todayUsd != null ? cost.todayUsd : sum(1),
           week: sum(7), month: sum(30),
           allTime: allTime || cost.totalUsd || 0 };
}

// Pure: everything the item shows, from the gateway's files. Exported so it can be checked outside VS Code.
function render(cfg, state, status, up, now = Date.now()) {
  if (!cfg) return { text: '$(question) claude-gw: no config', tooltip: `Nothing at ${CONFIG_PATH}`, alarm: false };
  if (!up) {
    return { text: '$(error) claude-gw DOWN', alarm: true,
             tooltip: `Nothing answers on ${cfg.host}:${cfg.port}, so Claude Code cannot reach the API. Run: \`cla-gw start\`` };
  }
  const poolLabels = cfg.accounts.filter((a) => a.enabled !== false).map((a) => a.label);
  const st = (label) => (state && state[label]) || {};
  const email = (label) => (cfg.accounts.find((a) => a.label === label) || {}).identity?.email || '';
  // Same rule as pickAccount: a pin wins, else the sticky account (latest activeAt).
  const current = cfg.active || poolLabels.filter((l) => st(l).activeAt).sort((x, y) => st(y).activeAt - st(x).activeAt)[0] || null;
  const open = poolOpening(poolLabels, st, now);
  const cost = (status && status.cost) || null;
  const terms = poolLabels.filter((l) => st(l).consentUntil > now);

  // --- the bar itself: EVERY account, always. The whole point of the gateway is that the pool, not
  // one account, decides whether a chat can run; a bar that names only the serving account makes you
  // hover to learn what the other two could do. `$(check)` = serving now, `⛔<clock>` = blocked until
  // then, `⚠terms` = needs a human to sign in and accept the terms (waiting never fixes it), `off` =
  // disabled. A usable account that is simply not serving carries no mark. (VS Code status items are
  // single-color, so the check is a glyph, not literally green - the hover's `✓ serving` uses the emoji,
  // which does render colored.) Usage is shown for every usable account, because "how much is left on C"
  // is the question the gateway is supposed to answer without a command. Blocked accounts show the
  // reopen time instead: their utilisation is not the interesting number. `open` and the separate terms
  // cell are gone - once all accounts are on the bar they just repeat the earliest ⛔ cell.
  const cellFor = (l) => {
    const s = st(l);
    const b = blockedUntil(s, now);
    // The check means "this one is answering right now", so it is withheld when the sticky/pinned
    // account is itself blocked - a check next to a ⛔ reads as a contradiction. Blocked cells stay
    // exactly as they were; standby cells carry no mark.
    const mark = (l === current && !(s.consentUntil > now) && b <= now) ? '$(check) ' : '';
    if (s.consentUntil > now) return `${mark}${l} ⚠terms`;
    if (b > now) return `${mark}${l} ⛔${clock(b)}`;
    return `${mark}${l} ${pct(s.u5h, s.r5h, now)}/${pct(s.u7d, s.r7d, now)}`;
  };
  const ordered = current ? [current, ...poolLabels.filter((l) => l !== current)] : poolLabels;
  const cells = ordered.map(cellFor);
  const disabled = cfg.accounts.filter((a) => a.enabled === false).map((a) => `${a.label} off`);
  if (disabled.length) cells.push(disabled.join(' '));
  if (!cells.length) cells.push('none enabled');
  if (cost && cost.todayUsd >= COST_BAR_MIN_USD) {
    // `>=` when some streams were cut off before their final output count arrived: the total is a floor.
    cells.push(`${(cost.coverage && (cost.coverage.partial || cost.coverage.blind)) ? '≥' : '≈'}${money(cost.todayUsd)} api`);
  }
  // A held chat is the one state where nothing is happening ON PURPOSE: the gateway is keeping a turn
  // alive across a quota window (up to 10 min) so nothing has to be re-typed. Without a cell here that
  // looks identical to a hang, from the user's seat.
  const held = status && status.holds && status.holds.n ? status.holds : null;
  if (held) cells.push(`⏳ ${held.n} held → ${clock(held.reopenAt)}`);
  const text = `$(pulse) gw: ${cells.join(' · ')}`;

  // --- the hover: the full picture, including the money ---
  const rows = (current ? [current, ...poolLabels.filter((l) => l !== current)] : poolLabels).map((l) => {
    const s = st(l);
    const until = blockedUntil(s, now);
    const stuck = s.consentUntil > now ? 'needs terms accepted' : (s.blockedUntil && s.blockedUntil > now && !s.r5h ? 'parked (no window info)' : null);
    const status = stuck || (until > now ? `blocked until ${when(until)}` : l === current ? '✅ serving' : 'standby');
    const seen = s.lastSeen ? `${Math.round((now - s.lastSeen) / 60000)} min ago` : 'never';
    return `| **${l}** | ${email(l) || '—'} | ${status} | ${pct(s.u5h, s.r5h, now)} | ${pct(s.u7d, s.r7d, now)} | ${s.r7d ? when(s.r7d * 1000) : '?'} | ${seen} |`;
  });
  const off = cfg.accounts.filter((a) => a.enabled === false).map((a) => `${a.label}${a.identity?.email ? ` (${a.identity.email})` : ''}`);

  const lines = [
    '**claude-gw** — Claude Code requests go through this gateway',
    '',
    '| account | email | status | 5h | 7d | 7d resets | last seen |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    'Switches only when the serving account hits a full 5h or weekly limit. `?` = unknown, or the window reset since it last served.',
    '',
  ];
  if (cost && ((cost.coverage && cost.coverage.priced) || cost.todayUsd)) {
    // One line of money, one line of honesty. The per-model token table, the rate rows and the
    // long coverage essays used to live here too; they turned a 3-second glance into a 40-line audit.
    // They all still live in `cla-gw cost`, which is where someone who WANTS the audit goes.
    const cov = cost.coverage || {};
    // A stream cut off before its final output count arrived is priced from what did arrive, and a
    // response recorded before token capture existed is priced at nothing at all. Either way the
    // totals are floors. Showing no marker there would be a claim the data does not support.
    const floor = (cov.partial || cov.blind) ? '≥' : '';
    const p = costPeriodsOf(cost, now);
    lines.push(`**Cost if this traffic had been metered API** — rolling windows at list prices`,
      '',
      `day **${floor}${money(p.day)}** · week **${floor}${money(p.week)}** · month **${floor}${money(p.month)}** · all-time **${floor}${money(p.allTime)}**`,
      '');
    // The floor marker travels with its explanation - one sentence, not a paragraph per caveat.
    const bits = [];
    if (cov.served != null) bits.push(`${cov.priced ?? '?'} of ${cov.served} served responses priced`);
    if (cov.partial) bits.push(`${cov.partial} cut off mid-stream`);
    if (cov.blind) bits.push(`${cov.blind} predate token capture and cannot be reconstructed`);
    lines.push(`${floor ? `≥ = a floor, not an exact total: ${bits.join('; ')}.` : `Coverage: ${bits.join('; ')}.`} \`cla-gw cost\` breaks it down by model, account and day; \`cla-gw prices\` prints the rate table.`, '');
    const unp = Object.entries(cost.unpriced || {});
    if (unp.length) {
      lines.push(`⚠ **not priced** (no rate row): ${unp.map(([m, n]) => `\`${m}\` ×${n}`).join(', ')} — add a row in config.json -> \`"prices"\`.`, '');
    }
    const oldDays = ratesAgeDays(cost.pricesAsOf, now);
    if (oldDays > STALE_RATES_DAYS) {
      lines.push(`⚠ the rate table is **${oldDays} days old** (copied \`${cost.pricesAsOf}\`) — rates move; update \`src/config.mjs\` or config.json -> \`"prices"\`.`, '');
    }
  } else {
    lines.push('Cost: nothing priced yet. The gateway prices every response it serves AND says how many it',
      'did not — run `cla-gw cost` for the totals and the coverage.', '');
  }
  if (held) {
    lines.push(`**${held.n} chat(s) are being held open by the gateway** — the turn is alive, not hung. It`,
      `has waited ${Math.max(1, Math.round((held.longestMs || 0) / 60000))} min and the pool reopens at **${when(held.reopenAt)}`,
      `(via ${(held.items || []).map((i) => i.via).filter(Boolean).join(', ') || 'the pool'})**. Type nothing: the`,
      'answer arrives on the same stream. Past ~10 min the gateway gives up and hands the client a real',
      '429 with the pool-corrected countdown, so the client arms its own wait instead.', '');
  }
  if (open) lines.push(`Pool reopens: **${open.label} at ${when(open.readyAt)}**. A chat that stopped at the limit needs one \`continue\` then; the gateway pops the same message when it happens.`, '');
  if (terms.length) lines.push(`**${terms.join(', ')} cannot serve at all** until someone signs into claude.ai as that address and accepts the updated Consumer Terms. Waiting does not fix it.`, '');
  if (off.length) lines.push(`Out of rotation: ${off.join(', ')}.`, '');
  lines.push('Click for `cla-gw health` in a terminal.');

  const alarm = !!open && poolLabels.every((l) => blockedUntil(st(l), now) > now);
  return { text, tooltip: lines.join('\n'), alarm: alarm || terms.length > 0 };
}

function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'claudeGw.health';
  context.subscriptions.push(item, vscode.commands.registerCommand('claudeGw.health', () => {
    const term = vscode.window.terminals.find((t) => t.name === 'claude-gw') || vscode.window.createTerminal('claude-gw');
    term.show();
    term.sendText('cla-gw health');
  }));

  const refresh = async () => {
    const cfg = readJson(CONFIG_PATH);
    const up = cfg ? await gatewayUp(cfg.host || '127.0.0.1', cfg.port || 8790) : false;
    const r = render(cfg, readJson(STATE_PATH), readJson(STATUS_PATH), up);
    item.text = r.text;
    const md = new vscode.MarkdownString(r.tooltip);
    md.supportThemeIcons = true;
    item.tooltip = md;
    item.backgroundColor = r.alarm ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    item.show();
  };

  // The gateway rewrites accounts_state.json and status.json on every request; the interval catches a
  // dead gateway and windows whose reset time passes while nothing is sent.
  let timer = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(refresh, 300); };
  let watcher = null;
  try {
    watcher = fs.watch(DIR, (_, file) => {
      if (!file || file === 'accounts_state.json' || file === 'status.json' || file === 'config.json') soon();
    });
  } catch { /* no gateway dir yet: the interval covers it */ }
  const tick = setInterval(refresh, 30_000);
  context.subscriptions.push({ dispose: () => { clearInterval(tick); clearTimeout(timer); if (watcher) watcher.close(); } });
  refresh();
}

module.exports = { activate, deactivate() {}, _render: render };
