// Phase-3 checks: vault round-trip, status file, per-session statusline. All quota-free.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, STATUS_PATH } from './config.mjs';
import { vaultPut, vaultGet, vaultLs, vaultRm } from './vault.mjs';

let fail = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `  - ${d}` : ''}`); if (!c) fail++; };
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

// ---- vault ----
const CANARY = 'sk-ant-oat01-dpapi-roundtrip-canary-value-0123456789';
const label = 'zz-smoke-tmp';
try { vaultRm(label); } catch {}
vaultPut(label, CANARY);
const got = vaultGet(label);
ok('vault round-trip (DPAPI)', got.token === CANARY, got.err || '');
ok('vault cached on second read', vaultGet(label).cached === true);
const file = path.join(process.env.LOCALAPPDATA, 'claude-gw', 'vault', `${label}.dpapi`);
const raw = fs.readFileSync(file, 'utf8');
ok('vault file holds no plaintext token', !raw.includes('sk-ant') && !raw.includes('canary'), `len=${raw.length}`);
ok('vault listed', vaultLs().includes(label));
vaultRm(label);
ok('vault removed', !vaultLs().includes(label));

// ---- status file + per-session mapping, driven through the gateway with a fake upstream ----
// The restore is in a finally block on purpose: an earlier version crashed between pointing
// upstream at the fake and putting it back, leaving the live gateway forwarding to a dead port.
const cfg = loadConfig();
const origUpstream = cfg.upstream;
const origActive = cfg.active;
const fake = (await import('node:http')).default.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('event: message_stop\n\n'); res.end();
});
try {
  await new Promise((r) => fake.listen(8792, '127.0.0.1', r));
  cfg.upstream = 'http://127.0.0.1:8792';
  cfg.active = 'A'; // pin: selection is pressure-based now, so this test must not assume "A"
  saveConfig(cfg);

  const SID = 'phase3-session-probe';
  const r = await fetch(`http://${cfg.host}:${cfg.port}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.secret}`, 'content-type': 'application/json',
               'anthropic-version': '2023-06-01', 'x-claude-code-session-id': SID },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
  await r.text();
  await new Promise((r) => setTimeout(r, 400)); // status write is throttled, give it a beat

  const st = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
  ok('status.json written', Array.isArray(st.sessions) && st.pool.includes('A'), `pool=${st.pool}`);
  ok('session mapped to account A', st.sessions.some(([id, v]) => id === SID && v.account === 'A'));

  const sl = spawnSync(process.execPath, [path.join(HERE, 'statusline.mjs')],
    { input: JSON.stringify({ session_id: SID }), encoding: 'utf8' });
  ok('statusline answers', sl.status === 0 && !!sl.stdout.trim(), JSON.stringify(sl.stdout.trim()));
  ok('statusline names the right account', /gw→A/.test(sl.stdout), sl.stdout.trim());
  ok('statusline without session id still works (inferred)', /gw→~?A/.test(
    spawnSync(process.execPath, [path.join(HERE, 'statusline.mjs')], { input: '{}', encoding: 'utf8' }).stdout));
} finally {
  const c = loadConfig();
  c.upstream = origUpstream;
  c.active = origActive;
  saveConfig(c);
  fake.close();
  console.log(`upstream restored -> ${origUpstream}, pin restored -> ${origActive}`);
}
console.log(fail ? `\n${fail} check(s) failed` : '\nphase-3 checks passed');
process.exit(fail ? 1 : 0);
