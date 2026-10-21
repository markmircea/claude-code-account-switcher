// Does the vaulted token actually work, and does a second account give us capacity the first lacks?
//
// This is the phase-2/4 exit test in manual form: pin A (which is out of weekly quota right now) and
// require a failure; pin B (vaulted) and require a real completion. Same gateway, same client
// headers, same transcript shape - only the signing account changes.
//
// Costs one tiny completion on the account under test. Prints no secrets.

import fs from 'node:fs';
import { loadConfig, saveConfig, pool, LOG_PATH, readAccountState } from './config.mjs';

const cfg0 = loadConfig();
const BASE = `http://${cfg0.host}:${cfg0.port}`;
const origActive = cfg0.active;
const origEnabled = Object.fromEntries(cfg0.accounts.map((a) => [a.label, a.enabled !== false]));

const MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-20250514'];
let MODEL = MODELS[0];

function prompt() {
  return {
    model: MODEL,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Reply with exactly: GWOK' }],
  };
}

async function call(label) {
  const r = await fetch(`${BASE}/v1/messages?beta=true`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg0.secret}`,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-claude-code-session-id': `failover-probe-${label}`,
    },
    body: JSON.stringify(prompt()),
  });
  const body = await r.text();
  let text = '';
  try {
    const j = JSON.parse(body);
    text = (j.content || []).map((c) => c.text || '').join('').slice(0, 40);
  } catch { /* non-JSON */ }
  return { status: r.status, text, body: body.slice(0, 200), reqId: r.headers.get('request-id') };
}

function setPin(cfg, label) { cfg.active = label; saveConfig(cfg); }
function logTail(n = 3) {
  try {
    return fs.readFileSync(LOG_PATH, 'utf8').trim().split(/\r?\n/).slice(-n)
      .map((l) => { const j = JSON.parse(l); return `${j.account} ${j.model || '?'} -> ${j.status} ${j.ttfbMs}ms ${j.requestId || ''}`; })
      .join('\n    ');
  } catch { return '(no log)'; }
}

let fail = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `  - ${d}` : ''}`); if (!c) fail++; };

try {
  const poolLabels = pool(cfg0).map((a) => a.label);
  ok('two accounts in the rotation', poolLabels.length >= 2, poolLabels.join(','));

  // Pick a model this account can actually use, so a 400 is never mistaken for a quota failure.
  let c = loadConfig(); setPin(c, 'B'); await new Promise((r) => setTimeout(r, 1100));
  let b = null;
  for (const m of MODELS) {
    MODEL = m;
    b = await call('B');
    if (b.status !== 400) break;
    console.log(`  model ${m} rejected (400), trying the next one`);
  }
  console.log(`  B served: HTTP ${b.status} reqId=${b.reqId} model=${MODEL} text="${b.text}"`);

  c = loadConfig(); setPin(c, 'A'); await new Promise((r) => setTimeout(r, 1100));
  const a = await call('A');
  console.log(`  pinned to A (the rate-limited one): client saw HTTP ${a.status} text="${a.text}"`);

  ok('B authenticates and completes', b.status === 200 && b.text.includes('GWOK'), `text="${b.text}"`);
  ok('pinned A still served the client — replayed onto B', a.status === 200 && a.text.includes('GWOK'),
     `status=${a.status} text="${a.text}"`);

  const logLines = fs.readFileSync(LOG_PATH, 'utf8').trim().split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const bRec = logLines.find((r) => r.requestId === b.reqId);
  ok('B was the account that served the unpinned call', bRec?.account === 'B', bRec ? `account=${bRec.account}` : 'no log entry');
  const sess = logLines.filter((r) => r.sessionId === 'failover-probe-A');
  ok('that request hit A first and took a real 429', sess.some((r) => r.account === 'A' && r.status === 429),
     sess.map((r) => `${r.account}:${r.status}`).join(' '));
  ok('then B served the same request', sess.some((r) => r.account === 'B' && r.status === 200));
  ok('replay event logged for the real upstream too',
     !!logLines.find((r) => r.event === 'failover-replay' && r.from === 'A' && r.to === 'B'));

  // Distinctness proof: an inference-only token cannot name its account (F28), but every response
  // names the org (F29). Two accounts sharing an org would double nothing.
  const stt = readAccountState();
  const orgA = stt.A?.org, orgB = stt.B?.org;
  ok('both accounts identified by org from response headers', !!orgA && !!orgB, `A=${orgA?.slice(0, 8)}… B=${orgB?.slice(0, 8)}…`);
  ok('A and B are genuinely different accounts', orgA !== orgB);
  ok('A parked after its 429', (stt.A?.blockedUntil || 0) > Date.now(),
     stt.A?.blockedUntil ? `until ${new Date(stt.A.blockedUntil).toLocaleString()}` : 'not parked');
  ok('B not parked', !(stt.B?.blockedUntil > Date.now()), `B 7d=${stt.B?.u7d} status=${stt.B?.s7d}`);

  console.log(`\nlast gateway log lines:\n    ${logTail()}`);
} finally {
  const c = loadConfig();
  c.active = origActive;
  c.accounts.forEach((x) => { x.enabled = origEnabled[x.label]; });
  saveConfig(c);
  console.log(`pin restored to ${origActive === null ? 'none (first enabled)' : origActive}`);
}
console.log(fail ? `\n${fail} check(s) failed` : '\nsecond account verified working through the gateway');
process.exit(fail ? 1 : 0);
