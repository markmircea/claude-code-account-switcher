// Claude Code `statusLine` command. Prints which gateway account is serving THIS conversation.
//
// Add to ~/.claude/settings.json (prints ready-to-paste JSON: node src/cli.mjs statusline):
//   "statusLine": { "type": "command", "command": "node <repo>/src/statusline.mjs" }
//
// Claude Code pipes a JSON object on stdin; we use session_id to look up the account the gateway
// served for that session (F22). Pure file read - no network, no subprocess - because this runs on
// every render.
//
// Why this exists: /usage and the account chip bypass the base-URL override (F13/F26), so they
// keep reporting the pinned account no matter which one actually served the request. This is the
// only truthful indicator available (PLAN.md D-7).

import fs from 'node:fs';
import { STATUS_PATH } from './config.mjs';

const STALE_MS = 5 * 60 * 1000;

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.on('data', (d) => { s += d; });
    process.stdin.on('end', () => resolve(s));
    setTimeout(() => resolve(s), 500); // never hang the render
  });
}

async function main() {
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { /* tolerate */ }
  const sid = input.session_id || input.sessionId || null;

  let st = null;
  try { st = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')); } catch { /* gateway not started */ }

  if (!st) { console.log('gw: stopped'); return; }
  if (Date.now() - st.ts > STALE_MS) {
    console.log(`gw: idle (${st.pool?.join(',') || 'empty'})`);
    return;
  }

  const hit = sid ? (st.sessions || []).find(([id]) => id === sid) : null;
  // Not observed for this session yet: the sticky account (latest activeAt) is what serves next.
  const sticky = Object.entries(st.accounts || {})
    .filter(([label, a]) => a?.activeAt && (st.pool || []).includes(label))
    .sort((x, y) => y[1].activeAt - x[1].activeAt)[0]?.[0];
  const serving = hit ? hit[1].account : (st.pin || sticky || st.pool?.[0] || 'none');
  const mark = hit ? '' : '~';  // '~' = inferred, not observed for this session
  const pool = (st.pool || []).join(',');
  const disabled = st.disabled?.length ? ` | off:${st.disabled.join(',')}` : '';
  // Usage of the serving account, from the same rate-limit headers `cla-gw health` reads.
  const pct = (v) => (v == null ? '?' : `${Math.round(v * 100)}%`);
  const a = st.accounts?.[serving];
  const usage = a ? ` 5h ${pct(a.u5h)} 7d ${pct(a.u7d)}` : '';
  // When nobody in the pool can serve, the only number that matters is WHEN one can - that is the
  // time a waiting chat will wake up on its own, so show it instead of a red mystery.
  let opens = '';
  const now = Date.now();
  const readyAtOf = (label) => {
    const s = st.accounts?.[label] || {};
    let r = 0;
    for (const [stKey, rKey] of [['s5h', 'r5h'], ['s7d', 'r7d']]) {
      if (s[stKey] === 'rejected' && s[rKey] && s[rKey] * 1000 > now) r = Math.max(r, s[rKey] * 1000);
    }
    if (!r && s.blockedUntil > now) r = s.blockedUntil;
    if (s.consentUntil > now) r = Math.max(r, s.consentUntil); // terms wall: cannot serve either
    return r;
  };
  const poolLabels = st.pool || [];
  if (poolLabels.length) {
    const blocked = poolLabels.map(readyAtOf);
    if (blocked.every((r) => r > now)) {
      const i = blocked.indexOf(Math.min(...blocked));
      opens = ` | all full, ${poolLabels[i]} opens ${new Date(blocked[i]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
  }
  // A failed response stamps the conversation too, so the badge can read "B" when B only ever answered
  // with an error - and if that request was a detour, the pool is NOT on B. Seen live: a chat showing
  // `gw->B` after a 403 detour while the pool was serving on D. The badge is per-conversation truth, not
  // the pool's choice, so it has to say which one it is talking about.
  const last = hit ? hit[1] : null;   // `hit` is the [sessionId, info] ENTRY - reading hit.status is undefined
  const fail = (last && last.status >= 400)
    ? ` | last reply ${last.status} from ${serving}` +
      (sticky && sticky !== serving ? `; pool is on ${sticky}` : '')
    : '';
  console.log(`gw→${mark}${serving}${usage} [${pool}]${disabled}${opens}${fail}`);
}

main().catch(() => console.log('gw: ?'));
