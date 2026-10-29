// Faithful model probe. Ask the REAL client, not a hand-rolled fetch.
//
// Why this exists: raw fetches with minimal headers produced 429s for Sonnet and Opus on an account
// that the real client used at HTTP 200 minutes later, same model, same token. That fake signal led to
// a wrong conclusion ("the model is gated on this account") and to a healthy account being parked.
// `claude -p` sends whatever the real client sends (beta headers, UA, metadata, the works), so a
// verdict from it is a verdict about the account, not about my request shape.
//
// Usage: node src/probe_client.mjs <model>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { LOG_PATH, readAccountState } from './config.mjs';

const model = process.argv[2] || 'claude-opus-4-5';
const env = { ...process.env };
for (const v of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_GATEWAY']) {
  if (!env[v]) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `[Environment]::GetEnvironmentVariable('${v}','User')`], { encoding: 'utf8', timeout: 30000 });
    if (r.stdout?.trim()) env[v] = r.stdout.trim();
  }
}
if (!env.ANTHROPIC_BASE_URL) { console.log('no ANTHROPIC_BASE_URL anywhere - activate first (cla-gw activate)'); process.exit(1); }
console.log(`probing through ${env.ANTHROPIC_BASE_URL} with model ${model}\n`);

const before = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8').length : 0;
const t0 = Date.now();
const r = spawnSync('claude', ['-p', 'Reply with exactly: PROBEOK', '--model', model],
  { stdio: 'inherit', env, timeout: 240000 });
if (r.error) { console.log(`client failed to start: ${r.error.message}`); process.exit(1); }

let entries = [];
try {
  entries = fs.readFileSync(LOG_PATH, 'utf8').slice(before).trim().split(/\r?\n/)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.ts >= t0);
} catch { /* log rotated */ }
console.log('');
for (const e of entries) {
  console.log(`${e.account || e.event || '?'} ${e.status ?? ''} ${e.model || ''} org=${(e.org || '').slice(0, 8)} ${e.selectReason || ''}${e.warning ? ` | ${e.warning}` : ''}`);
}
const st = readAccountState();
console.log('\nstate after:');
for (const [k, v] of Object.entries(st)) {
  console.log(`  ${k}: 5h=${v.u5h}/${v.s5h} 7d=${v.u7d}/${v.s7d} reset=${v.r7d ? new Date(v.r7d * 1000).toLocaleString() : '?'} parked=${v.blockedUntil && v.blockedUntil > Date.now() ? new Date(v.blockedUntil).toLocaleString() : 'no'}`);
}
console.log('\nA verdict from this probe is about the ACCOUNT; a verdict from a raw fetch may be about the fetch.');
