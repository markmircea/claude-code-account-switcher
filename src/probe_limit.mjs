// probe_limit.mjs — driver for the "does Claude Code resume itself at the reset?" probe.
//
// It never touches live configuration. It (1) schedules the fake upstream in probe_upstream.mjs,
// (2) writes throwaway .cmd launchers that point ONE process (a terminal, or one VS Code window) at
// the fake upstream, leaving the real gateway and every other window alone, and (3) prints what
// evidence we are collecting.
//
// The two variants are the whole experiment:
//   A = today's model: ANTHROPIC_AUTH_TOKEN set (a "gateway credential") -> client is NOT a
//       claude.ai subscription session -> the built-in usage-limit wait/continue is disabled.
//   B = proposed model: only ANTHROPIC_BASE_URL set -> the saved claude.ai login stays the active
//       credential -> the client should arm, wait for the reset, and continue on its own.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE_DIR = path.join(HERE, '..', '.probe');
const UPSTREAM = path.join(HERE, 'probe_upstream.mjs');
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const has = (name) => process.argv.includes(`--${name}`);
const up = (args) => spawn(process.execPath, [UPSTREAM, ...args], { stdio: 'inherit' });

function writeLauncher(name, body) {
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  const p = path.join(PROBE_DIR, name);
  fs.writeFileSync(p, body);
  return p;
}

function ensureUpstream() {
  try { fs.writeFileSync(path.join(PROBE_DIR, '.keep'), ''); } catch { fs.mkdirSync(PROBE_DIR, { recursive: true }); }
  // Best-effort: if something is already listening, starting another is harmless (EADDRINUSE).
  const child = spawn(process.execPath, [UPSTREAM, 'start', '--port', String(PORT), '--detach'],
    { stdio: 'ignore', detached: true, windowsHide: true });
  child.unref();
}

const ENV_LINES = (variant) => variant === 'A'
  ? `set "ANTHROPIC_BASE_URL=${BASE}"\r\nset "ANTHROPIC_AUTH_TOKEN=probe-local-secret"\r\n`
  : `set "ANTHROPIC_BASE_URL=${BASE}"\r\nset "ANTHROPIC_AUTH_TOKEN="\r\n`;

function cmdTerminal(variant) {
  return writeLauncher(`run_terminal_${variant}.cmd`,
    `@echo off\r\n` +
    `title claude-gw probe ${variant} (fake upstream, not real usage)\r\n` +
    ENV_LINES(variant) +
    `echo PROBE VARIANT ${variant}: this session talks to ${BASE}, not Anthropic.\r\n` +
    `echo Nothing you type here costs quota. Close this window when done.\r\n\r\n` +
    `claude\r\n`);
}

function codeBin() {
  try {
    const out = spawnSync('where', ['code.cmd'], { encoding: 'utf8' }).stdout || '';
    const hit = out.split('\n').map((s) => s.trim()).filter(Boolean)[0];
    if (hit) return hit;
  } catch { /* fall through */ }
  const guess = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd');
  return fs.existsSync(guess) ? guess : 'code.cmd';
}

function cmdVscode(variant) {
  const ws = path.join(PROBE_DIR, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'PROBE.md'),
    `# Probe workspace\n\nThis VS Code window is pointed at a fake upstream (${BASE}).\n` +
    `Chats in this window cost no quota. Close the window when the probe is over.\n`);
  const udd = path.join(PROBE_DIR, 'vscode-userdata');
  return writeLauncher(`run_vscode_${variant}.cmd`,
    `@echo off\r\n` +
    ENV_LINES(variant) +
    `"${codeBin()}" --new-window --user-data-dir "${udd}" "${ws}"\r\n`);
}

function cmdVscodeReal(variant = 'B') {
  // Same throwaway window, but pointed at the REAL gateway and REAL accounts instead of the stand-in.
  // This is how you watch the real thing: a chat that hits a live limit arms Claude Code's own wait,
  // and continues itself at the reset. Costs whatever the failed request already cost, nothing more.
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA, 'claude-gw', 'config.json'), 'utf8'));
  } catch (e) {
    throw new Error(`cannot read the live gateway config to build a real-mode launcher: ${e.message}`);
  }
  const ws = path.join(PROBE_DIR, 'ws-real');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'PROBE.md'),
    `# Real-mode test window\n\nThis window talks to the REAL gateway on ${cfg.host}:${cfg.port} with the NEW\ncredential model (login to the gateway, no ANTHROPIC_AUTH_TOKEN). Real quota applies.\n`);
  const udd = path.join(PROBE_DIR, 'vscode-userdata');
  return writeLauncher(`run_vscode_real.cmd`,
    `@echo off\r\n`
    + `set "ANTHROPIC_BASE_URL=http://${cfg.host}:${cfg.port}"\r\n`
    + `set "ANTHROPIC_AUTH_TOKEN="\r\n`
    + `set "ANTHROPIC_CUSTOM_HEADERS=${cfg.secretHeader || 'x-gw-secret'}: ${cfg.secret}"\r\n`
    + `"${codeBin()}" --new-window --user-data-dir "${udd}" "${ws}"\r\n`);
}

function main() {
  const cmd = process.argv[2] || 'help';
  const now = Math.floor(Date.now() / 1000);

  if (cmd === 'arm') {
    ensureUpstream();
    const limitIn = Number(arg('limit-in', '0'));
    const resetIn = Number(arg('reset-in', '180'));
    const c = { phase: 'limited' };
    if (limitIn > 0) c.limitedAt = now + limitIn;
    c.resetAt = now + resetIn;
    fs.mkdirSync(PROBE_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROBE_DIR, 'control.json'), JSON.stringify(c, null, 2));
    console.log(`fake limit: ${limitIn > 0 ? `starts in ${limitIn}s, ` : 'now'} ` +
      `available again ${new Date(c.resetAt * 1000).toLocaleTimeString()} (in ${resetIn}s)`);
    return;
  }

  if (cmd === 'launch') {
    const variant = (arg('variant', 'A')).toUpperCase();
    if (has('real')) {
      const p = cmdVscodeReal();
      if (has('dry')) { console.log(`--- ${p} ---\n${fs.readFileSync(p, 'utf8')}`); return; }
      const r = spawn('cmd.exe', ['/c', 'start', 'claude-gw real-mode test', p], { windowsHide: false });
      r.on('error', (e) => console.log(`could not open the window: ${e.message}`));
      console.log(`opened ${p}  (REAL gateway, REAL quota, no auto-resume loss - this is the new mode)`);
      return;
    }
    ensureUpstream();
    const p = has('vscode') ? cmdVscode(variant) : cmdTerminal(variant);
    if (has('dry')) { console.log(`--- ${p} ---\n${fs.readFileSync(p, 'utf8')}`); return; }
    const r = spawn('cmd.exe', ['/c', 'start', `claude-gw probe ${variant}`, p], { windowsHide: false });
    r.on('error', (e) => console.log(`could not open the window: ${e.message}`));
    console.log(`opened ${p}`);
    return;
  }

  if (cmd === 'watch') {
    return up(['tail', '--follow']);
  }

  if (cmd === 'heal' || cmd === 'stop') {
    up([cmd === 'heal' ? 'ctl' : 'stop', ...(cmd === 'heal' ? ['--healthy'] : [])]);
    return;
  }

  console.log(`claude-gw usage-limit probe

  node src/probe_upstream.mjs start --detach     # fake upstream on ${BASE}
  node src/probe_limit.mjs arm [--limit-in 0] [--reset-in 180]
  node src/probe_limit.mjs launch --variant A    # today's model (gateway credential set)
  node src/probe_limit.mjs launch --variant B    # proposed model (base URL only)
  node src/probe_limit.mjs launch --variant B --vscode
  node src/probe_limit.mjs launch --real             # throwaway window on the REAL gateway, new mode
  node src/probe_limit.mjs watch                 # every request the fake upstream sees
  node src/probe_limit.mjs heal                  # fake upstream answers normally again
  node src/probe_upstream.mjs stop

What each variant proves:
  A  the client holds a gateway credential, so it is not a subscription session; expected to stop
     at the limit and wait for you.
  B  the saved claude.ai login stays the credential; expected to show it is waiting for the reset
     and continue the turn by itself once ${BASE} says usage is available again.

Nothing here writes environment variables, touches the vault, or reaches api.anthropic.com.`);
}

try { main(); } catch (e) { console.error('probe driver failed:', e.message); process.exit(1); }
