// watch_autoresume.mjs — sits on the gateway log and records what happens around a usage-limit reset,
// so the "did the chat resume itself?" verdict is captured whether or not anyone is watching.
//
//   node src/watch_autoresume.mjs --session <id-prefix> [--reset <epochSec>] [--for 1200]
//
// Writes to .probe/autoresume-watch.log. Nothing is polled from Anthropic; this only reads the log
// the gateway already writes.

import fs from 'node:fs';
import path from 'node:path';
import { ACCOUNT_STATE_PATH, LOG_PATH } from './config.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const session = arg('session', '');
const reset = Number(arg('reset', 0)) || 0;
const forSec = Number(arg('for', 1500));
const OUT = path.join(process.cwd(), '.probe', 'autoresume-watch.log');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const say = (m) => {
  const line = `${new Date().toLocaleTimeString()}  ${m}`;
  console.log(line);
  try { fs.appendFileSync(OUT, line + '\n'); } catch { /* keep watching */ }
};

let pos = 0;
try { pos = fs.statSync(LOG_PATH).size; } catch { /* fresh */ }
if (reset) say(`watching for any chat that is waiting, after the reset at ${new Date(reset * 1000).toLocaleTimeString()} (for ${forSec}s)`);

// A chat is an "armed candidate" the moment we hand it a limit. Any later 200 for that session, with
// nobody typing, is the auto-resume firing. This is per-session, so a terminal and an extension panel
// are tracked independently and both are proven by behaviour rather than by what their UI renders.
const waiting = new Set();

const deadline = Date.now() + forSec * 1000;
const timer = setInterval(() => {
  let raw = '';
  try { raw = fs.readFileSync(LOG_PATH, 'utf8'); } catch { return; }
  if (raw.length < pos) pos = 0; // log rotated/truncated
  const fresh = raw.slice(pos).trim().split(/\r?\n/).filter(Boolean);
  pos = raw.length;
  for (const l of fresh) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!r.path || r.event === 'failover-replay') continue;
    const sid = String(r.sessionId || '');
    const mine = session && sid.startsWith(session);
    if (r.status === 429 && sid) waiting.add(sid);
    const resumed = r.status === 200 && sid && waiting.has(sid);
    const interesting = r.event === 'hold' || r.quotaShim || r.status >= 400 || resumed;
    if (!mine && !interesting) continue;
    const bits = [r.path, `HTTP ${r.status}`, r.account || '-', r.event || '',
      r.quotaShim ? `shim via ${r.quotaShim.via} -> ${new Date(r.quotaShim.readyEpochSec * 1000).toLocaleTimeString()}` : '',
      r.heldMs ? `held ${r.heldMs}ms` : '',
      `cred=${r.clientCred || '-'}`,
      r.sessionId ? `session=${String(r.sessionId).slice(0, 8)}` : ''].filter(Boolean).join('  ');
    say(`${mine ? 'TARGET   ' : resumed ? 'RESUMED  ' : 'other     '}  ${bits}`);
    if ((mine || resumed) && r.status === 200) {
      say(`>>> ${sid.slice(0, 8)} was served after the reset. Gap from the reset: ${((r.ts - (reset || r.ts) * 1000) / 1000).toFixed(0)}s (Claude Code's own jitter is 30-180s).`);
      // Do not exit: a terminal and an extension panel may resume at different moments, and we want
      // the record for each waiting chat, not just the first one.
    }
  }
  if (reset && Date.now() > reset * 1000) {
    const st = (() => { try { return JSON.parse(fs.readFileSync(ACCOUNT_STATE_PATH, 'utf8')); } catch { return {}; } })();
    const free = Object.entries(st).filter(([, s]) => {
      const blocked = [['s5h', 'r5h'], ['s7d', 'r7d']].some(([k, rk]) => s[k] === 'rejected' && s[rk] * 1000 > Date.now());
      return !blocked;
    }).map(([k]) => k);
    if (free.length) say(`pool: ${free.join(', ')} now able to serve`);
  }
  if (Date.now() > deadline) {
    say('watch window closed without the armed chat being served - the continuation did NOT self-initiate');
    clearInterval(timer);
    process.exit(1);
  }
}, 1500);
process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
