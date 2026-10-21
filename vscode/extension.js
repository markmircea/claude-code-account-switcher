// claude-gw status bar item: which account is serving Claude Code, and each account's 5h / 7d usage.
//
// Why an extension: the Claude Code panel in VS Code draws no settings.json statusLine, and Claude
// Code mods cannot draw in the VS Code panel yet. This reads the gateway's own files (the same state
// `cla-gw health` prints) and pings its unauthenticated /__gw/health. It never reads the vault, and it
// reads config.json only for the port and the account list, never using the secret in it.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const http = require('http');

const DIR = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'claude-gw');
const STATE_PATH = path.join(DIR, 'accounts_state.json');
const CONFIG_PATH = path.join(DIR, 'config.json');

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

// As config.mjs availability(): usable again only when the LAST rejected window clears.
function blockedUntil(s, now) {
  let until = 0;
  if (s.s5h === 'rejected' && s.r5h * 1000 > now) until = Math.max(until, s.r5h * 1000);
  if (s.s7d === 'rejected' && s.r7d * 1000 > now) until = Math.max(until, s.r7d * 1000);
  if (s.blockedUntil > now) until = Math.max(until, s.blockedUntil);
  return until;
}

// A window that has reset since the account last served: its real usage is unknown, not the old figure.
function pct(u, resetEpoch, now) {
  if (u == null || (resetEpoch && resetEpoch * 1000 <= now)) return '?';
  return `${Math.round(u * 100)}%`;
}

const when = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

// Pure: everything the item shows, from the gateway's files. Exported so it can be checked outside VS Code.
function render(cfg, state, up, now = Date.now()) {
  if (!cfg) return { text: '$(question) claude-gw: no config', tooltip: `Nothing at ${CONFIG_PATH}`, alarm: false };
  if (!up) {
    return { text: '$(error) claude-gw DOWN', alarm: true,
             tooltip: `Nothing answers on ${cfg.host}:${cfg.port}, so Claude Code cannot reach the API. Run: \`cla-gw start\`` };
  }
  const pool = cfg.accounts.filter((a) => a.enabled !== false).map((a) => a.label);
  const st = (label) => (state && state[label]) || {};
  // Same rule as pickAccount: a pin wins, else the sticky account (latest activeAt).
  const current = cfg.active || pool.filter((l) => st(l).activeAt).sort((x, y) => st(y).activeAt - st(x).activeAt)[0] || null;
  const order = current ? [current, ...pool.filter((l) => l !== current)] : pool;

  const cell = (l) => {
    const s = st(l);
    return blockedUntil(s, now) ? `${l} blocked` : `${l} ${pct(s.u5h, s.r5h, now)}/${pct(s.u7d, s.r7d, now)}`;
  };
  const rows = order.map((l) => {
    const s = st(l);
    const until = blockedUntil(s, now);
    const status = until ? `blocked until ${when(until)}` : l === current ? 'serving' : 'standby';
    const seen = s.lastSeen ? `${Math.round((now - s.lastSeen) / 60000)} min ago` : 'never';
    return `| **${l}** | ${status} | ${pct(s.u5h, s.r5h, now)} | ${pct(s.u7d, s.r7d, now)} | ${s.r7d ? when(s.r7d * 1000) : '?'} | ${seen} |`;
  });
  const off = cfg.accounts.filter((a) => a.enabled === false).map((a) => a.label);
  const tooltip = [
    '**claude-gw**: Claude Code requests go through this gateway',
    '',
    '| account | | 5h | 7d | 7d resets | last seen |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    'Switches only when the serving account hits a full 5h or weekly limit. Usage updates when an account serves a request; `?` means unknown, or the window reset since.',
    '',
    off.length ? `Out of rotation: ${off.join(', ')}. ` : '',
    'Click for `cla-gw health` in a terminal.',
  ].join('\n');
  const text = `$(pulse) gw${current ? '→' : ' '}${order.map(cell).join(' · ')}${cfg.active ? ' (pinned)' : ''}`;
  return { text, tooltip, alarm: false };
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
    const r = render(cfg, readJson(STATE_PATH), up);
    item.text = r.text;
    const md = new vscode.MarkdownString(r.tooltip);
    md.supportThemeIcons = true;
    item.tooltip = md;
    item.backgroundColor = r.alarm ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    item.show();
  };

  // The gateway rewrites accounts_state.json on every request; the interval catches a dead gateway
  // and windows whose reset time passes while nothing is sent.
  let timer = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(refresh, 300); };
  let watcher = null;
  try {
    watcher = fs.watch(DIR, (_, file) => { if (!file || file === 'accounts_state.json' || file === 'config.json') soon(); });
  } catch { /* no gateway dir yet: the interval covers it */ }
  const tick = setInterval(refresh, 30_000);
  context.subscriptions.push({ dispose: () => { clearInterval(tick); clearTimeout(timer); if (watcher) watcher.close(); } });
  refresh();
}

module.exports = { activate, deactivate() {}, _render: render };
