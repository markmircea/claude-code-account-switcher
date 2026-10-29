// Which models can a given account actually serve, and is the one you use daily gated?
// GET /v1/models goes through the gateway like any other path (it proxies generically with the
// selected account's bearer), so this is free. The ping after it is ~8 tokens.
//
// Matters because the Sonnet gate (F30) showed the gate can be PER MODEL: an account can be healthy
// and still reject one model. Which model you sit on changes what "that account is fine" means.
import { loadConfig, saveConfig, readAccountState, availability } from './config.mjs';

const cfg = loadConfig();
const orig = cfg.active;
const label = process.argv[2] || 'B';
const ping = (process.argv[3] || 'claude-opus-4-5').split(',');

async function req(path, init = {}) {
  const c = loadConfig();
  const r = await fetch(`http://${c.host}:${c.port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${c.secret}`, 'content-type': 'application/json',
               'anthropic-version': '2023-06-01', 'x-claude-code-session-id': 'probe-models',
               ...(init.headers || {}) },
  });
  const text = await r.text();
  return { status: r.status, text, hdrs: r.headers };
}

try {
  const c = loadConfig(); c.active = label; saveConfig(c);
  await new Promise((r) => setTimeout(r, 1100));
  const st = readAccountState()[label] || {};
  console.log(`pinned ${label}: ${availability(st, Date.now()).readyAt > Date.now() ? 'RESTRICTED' : 'available'}  5h=${st.u5h} 7d=${st.u7d}  gates=${Object.keys(st.modelGate || {}).join(',') || 'none'}`);

  const m = await req('/v1/models');
  console.log(`\nGET /v1/models -> HTTP ${m.status}`);
  let ids = [];
  try { ids = (JSON.parse(m.text).data || []).map((d) => d.id); } catch { console.log(m.text.slice(0, 200)); }
  console.log(ids.length ? ids.join('\n') : '(no model list returned)');

  for (const model of ping) {
    const before = readAccountState()[label] || {};
    const r = await req('/v1/messages?beta=true', {
      method: 'POST',
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with exactly: GWOK' }] }),
    });
    const after = readAccountState()[label] || {};
    console.log(`\n${model} -> HTTP ${r.status}`);
    console.log(`  ${r.status === 200 ? r.text.slice(0, 120) : r.text.slice(0, 200)}`);
    console.log(`  windows after: 5h=${after.u5h}/${after.s5h}  7d=${after.u7d}/${after.s7d}  (was 5h=${before.u5h} 7d=${before.u7d})`);
    const g = (after.modelGate || {})[model];
    if (g) console.log(`  -> gateway recorded a MODEL GATE for ${model} until ${new Date(g).toLocaleString()}; account itself ${availability(after, Date.now()).readyAt > Date.now() ? 'parked' : 'stays in the pool'}`);
  }
} finally {
  const c = loadConfig(); c.active = orig; saveConfig(c);
  console.log(`\npin restored to ${orig}`);
}
