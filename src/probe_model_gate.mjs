// Is a 429 an ACCOUNT verdict or a MODEL verdict? One B request (sonnet) was rejected while its
// own headers said 7d=80% allowed_warning, and every 200 from B had been haiku. If the gate is
// per-model, parking the whole account until the weekly reset takes a working account out of the
// pool for days - the exact failure mode the plan warns about.
//
// Cheap by design: rejected requests cost nothing, and the successes are 8-token pings.
// Run: cla-gw reset-state, then: node src/probe_model_gate.mjs
import { loadConfig, saveConfig, readAccountState, availability } from './config.mjs';

const cfg = loadConfig();
const orig = cfg.active;
const KEEP = ['anthropic-ratelimit-unified-status', 'anthropic-ratelimit-unified-reset',
  'anthropic-ratelimit-unified-representative-claim', 'anthropic-ratelimit-unified-5h-utilization',
  'anthropic-ratelimit-unified-5h-status', 'anthropic-ratelimit-unified-5h-reset',
  'anthropic-ratelimit-unified-7d-utilization', 'anthropic-ratelimit-unified-7d-status',
  'anthropic-ratelimit-unified-7d-reset', 'anthropic-ratelimit-unified-overage-status',
  'anthropic-ratelimit-unified-overage-disabled-reason', 'retry-after', 'anthropic-organization-id'];

async function call(model, session) {
  const c = loadConfig();
  const r = await fetch(`http://${c.host}:${c.port}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { authorization: `Bearer ${c.secret}`, 'content-type': 'application/json',
               'anthropic-version': '2023-06-01', 'x-claude-code-session-id': session },
    body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with exactly: GWOK' }] }),
  });
  const body = await r.text();
  const hdr = Object.fromEntries([...r.headers].filter(([k]) => KEEP.includes(k.toLowerCase())));
  return { status: r.status, hdr, body: body.slice(0, 160) };
}

try {
  const c = loadConfig(); c.active = process.argv[2] || 'B'; saveConfig(c);
  await new Promise((r) => setTimeout(r, 1100));
  const before = readAccountState();
  console.log(`pinned ${c.active}; state before: ` +
    Object.entries(before).map(([k, v]) => `${k} ready@${availability(v, Date.now()).readyAt > Date.now() ? 'RESTRICTED' : 'now'}`).join('  '));

  // Order matters: sonnet first (the one that was rejected), then the model that always worked.
  for (const [model, session] of [['claude-sonnet-4-5', 'gate-sonnet'], ['claude-haiku-4-5', 'gate-haiku']]) {
    const r = await call(model, session);
    console.log(`\n${model} -> HTTP ${r.status}`);
    for (const [k, v] of Object.entries(r.hdr)) console.log(`  ${k}: ${v}`);
    console.log(`  body: ${r.body}`);
    if (model.includes('sonnet') && r.status === 200) console.log('  (sonnet succeeded - the earlier rejection was not permanent; treat with care)');
  }

  const after = readAccountState();
  const st = after[c.active] || {};
  console.log(`\nafter: ${c.active} u7d=${st.u7d} s7d=${st.s7d} blockedUntil=${st.blockedUntil ? new Date(st.blockedUntil).toLocaleString() : 'none'} parkReason=${st.parkReason || 'none'}`);
  console.log(`verdict: if the second call returned 200 while the first did not, the 429 was a MODEL-level gate and the whole account should NOT have been parked.`);
} finally {
  const c = loadConfig(); c.active = orig; saveConfig(c);
  console.log(`pin restored to ${orig}`);
}
