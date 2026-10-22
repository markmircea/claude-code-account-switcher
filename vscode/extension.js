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

// Mirrors PRICE_TABLE in src/config.mjs. Kept as a copy because the extension must run without
// importing gateway code; if they drift, `cla-gw cost` is right and the hover is a rounded echo of it,
// and the hover says which table it used.
const PRICE_TABLE = {
  opus:   { in: 15,   out: 75,  cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { in: 3,    out: 15,  cacheWrite: 3.75,  cacheRead: 0.3 },
  haiku:  { in: 1,    out: 5,   cacheWrite: 1.25,  cacheRead: 0.1 },
};

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
const money = (v) => (v == null ? '?' : `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`);

// Pool's soonest reopening, the same computation pickAccount uses when it has nothing free.
function poolOpening(pool, st, now) {
  let best = null;
  for (const l of pool) {
    const u = blockedUntil(st(l), now);
    if (u > now && (!best || u < best.readyAt)) best = { label: l, readyAt: u };
  }
  return best;
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

  // --- the bar itself: short enough to be read without hunting for it ---
  const cells = [`gw${current ? '→' : ' '}${current || poolLabels.join('/')}`];
  if (current) {
    const s = st(current);
    const b = blockedUntil(s, now);
    cells.push(b > now ? `blocked ${(clock(b))}` : `${pct(s.u5h, s.r5h, now)}/${pct(s.u7d, s.r7d, now)}`);
  }
  if (cost && cost.todayUsd) cells.push(`≈${money(cost.todayUsd)} api`);
  if (open) cells.push(`opens ${clock(open.readyAt)}`);
  if (terms.length) cells.push(`⚠ ${terms.join(',')} terms`);
  const text = `$(pulse) ${cells.join(' · ')}`;

  // --- the hover: the full picture, including the money ---
  const rows = (current ? [current, ...poolLabels.filter((l) => l !== current)] : poolLabels).map((l) => {
    const s = st(l);
    const until = blockedUntil(s, now);
    const stuck = s.consentUntil > now ? 'needs terms accepted' : (s.blockedUntil && s.blockedUntil > now && !s.r5h ? 'parked (no window info)' : null);
    const status = stuck || (until > now ? `blocked until ${when(until)}` : l === current ? 'serving' : 'standby');
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
  if (cost) {
    lines.push(`**Cost at API list prices** (what a metered key would have billed for the same tokens)`,
      '',
      `| today | this gateway run | |`,
      `|---|---|---|`,
      `| **${money(cost.todayUsd)}** | ${money(cost.totalUsd)} | ${Object.entries(cost.byAccount || {}).map(([a, v]) => `${a} ${money(v)}`).join(' · ') || '—'} |`,
      '');
    const days = Object.entries(cost.byDay || {}).sort().slice(-7);
    if (days.length) lines.push(`per day: ${days.map(([d, v]) => `${d.slice(5)} ${money(v)}`).join(' · ')}`, '');
    const fams = Object.keys(PRICE_TABLE).map((f) => {
      const p = { ...PRICE_TABLE[f], ...((cfg.prices || {})[f] || {}) };
      return `${f} ${p.in}/${p.out}`;
    });
    lines.push('rates per Mtok in/out: ' + fams.join(' · ') + ' — cache reads count at 0.1x, and they are',
      'the bulk of what an agent session would cost. Override in config.json -> "prices", or run',
      '`cla-gw cost` for the durable per-model breakdown.',
      '');
  } else {
    lines.push('Cost: nothing recorded yet - the gateway starts counting tokens from the version that',
      'captures usage. Run `cla-gw cost` for the durable numbers.', '');
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
