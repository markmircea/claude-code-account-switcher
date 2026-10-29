// probe_hold.mjs — does the VS Code extension (or any client) tolerate a request that the gateway
// keeps open while the pool waits for its quota window to reopen?
//
// That is the fallback path for chats that cannot arm Claude Code's own "continue at the reset"
// (the extension panel did not, on 2.1.305): instead of handing the client a limit message and
// letting the turn END, the gateway holds the request and answers the moment an account frees up.
// The chat just appears to be thinking. Whether the client waits that long is the open question,
// and it is measurable for free - this points the LIVE gateway at a stand-in upstream, so no quota
// is spent and no real answer is needed.
//
//   node src/probe_hold.mjs [--window 180] [--minutes 15]   # arm, then restore automatically
//   node src/probe_hold.mjs selftest [--window 120]         # prove the gateway holds, no client
//   node src/probe_hold.mjs restore                        # undo right now
//
// WHILE THIS RUNS EVERY CLAUDE CHAT ON THIS MACHINE IS ANSWERED BY THE STAND-IN. It restores on
// exit, on Ctrl-C, and on a hard timer, but do not walk away from it expecting real work.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, CONFIG_PATH } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = 'http://127.0.0.1:8791';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : Number(process.argv[i + 1]); };
const cmd = process.argv[2] || 'run';

const SNAP = path.join(HERE, '..', '.probe', 'hold-config.json');

function snapshotAndPoint(windowSec, long = false) {
  const cfg = loadConfig();
  if (!fs.existsSync(SNAP)) {
    fs.mkdirSync(path.dirname(SNAP), { recursive: true });
    fs.writeFileSync(SNAP, JSON.stringify({ upstream: cfg.upstream, holdMaxMs: cfg.holdMaxMs,
      holdStream: cfg.holdStream, holdStreamMaxMs: cfg.holdStreamMaxMs }));
  }
  cfg.upstream = FAKE;
  if (long) {
    // Force the LONG path: a tiny silent-hold ceiling means the window can only be covered by
    // committing the stream and keeping it alive with ping frames. This is the path an extension-panel
    // chat depends on, and whether a real client tolerates ping-before-first-token is what we are here
    // to find out.
    cfg.holdMaxMs = 5000;
    cfg.holdStream = true;
    cfg.holdStreamMaxMs = windowSec * 1000 + 60_000;
  } else {
    cfg.holdMaxMs = windowSec * 1000 + 30_000; // hold the whole window, plus a margin
  }
  saveConfig(cfg);
  return cfg;
}

function restore() {
  if (!fs.existsSync(SNAP)) { console.log('nothing to restore (no snapshot)'); return; }
  const s = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  const cfg = loadConfig();
  cfg.upstream = s.upstream;
  cfg.holdMaxMs = s.holdMaxMs;
  saveConfig(cfg);
  fs.rmSync(SNAP, { force: true });
  console.log(`restored: upstream ${cfg.upstream}, holdMaxMs ${cfg.holdMaxMs}`);
  console.log('the running gateway hot-reloads config.json, so no restart is needed');
}

function ensureFake() {
  const c = spawn(process.execPath, [path.join(HERE, 'probe_upstream.mjs'), 'start', '--detach'],
    { stdio: 'ignore', detached: true, windowsHide: true });
  c.unref();
}

// Write the stand-in's control file directly (same shape probe_upstream.mjs reads).
function armFake(windowSec) {
  const dir = path.join(HERE, '..', '.probe');
  fs.mkdirSync(dir, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(dir, 'control.json'),
    JSON.stringify({ phase: 'limited', resetAt: now + windowSec }, null, 2));
  return { resetAt: now + windowSec };
}

async function hit(label) {
  const cfg = loadConfig();
  const t0 = Date.now();
  try {
    const r = await fetch(`http://${cfg.host}:${cfg.port}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.secret}`,
        'anthropic-version': '2023-06-01', 'x-claude-code-session-id': 'hold-probe' },
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 64, stream: true,
        messages: [{ role: 'user', content: 'hold probe' }] }),
      signal: AbortSignal.timeout(4 * 3600_000),
    });
    const txt = await r.text();
    console.log(`${label}: HTTP ${r.status} after ${((Date.now() - t0) / 1000).toFixed(1)}s  ${txt.slice(0, 80).replace(/\n/g, ' ')}`);
    return r.status;
  } catch (e) {
    console.log(`${label}: client gave up after ${((Date.now() - t0) / 1000).toFixed(1)}s - ${e.name} ${e.message}`);
    return 0;
  }
}

async function main() {
  if (cmd === 'restore') return restore();

  const windowSec = arg('window', 180);
  const long = process.argv.includes('--long');

  if (cmd === 'selftest') {
    ensureFake();
    await new Promise((r) => setTimeout(r, 1200));
    const resetAt = armFake(windowSec).resetAt;
    snapshotAndPoint(windowSec, long);
    console.log(`${long ? 'LONG hold (ping-keepalive stream)' : 'silent hold'}: stand-in says "out of usage" until ${new Date(resetAt * 1000).toLocaleTimeString()} (${windowSec}s)`);
    console.log('expected: the gateway holds the request and then serves it, no error to the client\n');
    let fail = 0;
    try {
      const s1 = await hit(`hold ${windowSec}s  `);
      if (s1 !== 200) fail++;
      // and a second one, to be sure it is not a one-off
      armFake(windowSec);
      const s2 = await hit('again        ');
      if (s2 !== 200) fail++;
    } finally {
      restore();
    }
    console.log(fail ? '\nFAIL: the client saw an error, or the hold did not happen' : '\nhold works end to end: both requests were served after waiting out the window');
    process.exit(fail ? 1 : 0);
  }

  // run: arm it, then hand the keyboard to a human to type in a chat
  ensureFake();
  await new Promise((r) => setTimeout(r, 1200));
  const resetAt = armFake(windowSec).resetAt;
  snapshotAndPoint(windowSec);
  const minutes = arg('minutes', 15);
  console.log(`
POINTING THE LIVE GATEWAY AT A STAND-IN UPSTREAM. Every Claude chat on this machine is now
answered by the stand-in - nothing costs quota, and nothing is real. It restores itself in
${minutes} minutes, on Ctrl-C, or with:  node src/probe_hold.mjs restore

NOW, in the chat you are testing (the VS Code extension panel):
  1. type:  test
  2. watch it: it should sit there with no error for ${windowSec} seconds
  3. at ${new Date(resetAt * 1000).toLocaleTimeString()} it should answer, with text that says the
     stand-in upstream replied

If instead you get an error, a retry, or the turn just ending, that tells us the client will not
wait, and the hold has to be shorter (or the panel needs a different answer).
`);
  const stop = setTimeout(() => { console.log('\ntime up, restoring'); restore(); process.exit(0); }, minutes * 60_000);
  process.on('SIGINT', () => { clearTimeout(stop); restore(); process.exit(0); });
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`(the stand-in will answer normally from ${new Date(resetAt * 1000).toLocaleTimeString()} onwards;`
    + ` set a fresh window with: node src/probe_upstream.mjs ctl --reset-in ${windowSec})`);
  await new Promise((r) => setTimeout(r, (minutes - 0.05) * 60_000));
  clearTimeout(stop);
  restore();
}

main().catch((e) => { try { restore(); } catch {} console.error('probe_hold failed:', e.message); process.exit(1); });
