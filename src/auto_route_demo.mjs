// No pin, no manual choice: A is parked (rate-limited until its reset epoch). Does the gateway
// route to B on its own, and does it say why? A's 429 is free; the B completion is one tiny call.
import { loadConfig, readAccountState } from './config.mjs';
const cfg = loadConfig();
const r = await fetch(`http://${cfg.host}:${cfg.port}/v1/messages?beta=true`, {
  method: 'POST',
  headers: { authorization: `Bearer ${cfg.secret}`, 'content-type': 'application/json',
             'anthropic-version': '2023-06-01', 'x-claude-code-session-id': 'auto-route-demo' },
  body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 8,
                         messages: [{ role: 'user', content: 'Reply with exactly: AUTO' }] }),
});
const j = await r.json().catch(() => ({}));
console.log(`status: ${r.status}  text: "${(j.content || []).map((c) => c.text || '').join('')}"`);
const st = readAccountState();
for (const [k, v] of Object.entries(st)) {
  console.log(`${k}: 7d=${v.u7d} status=${v.s7d} parked=${v.blockedUntil ? new Date(v.blockedUntil).toLocaleString() : 'no'}`);
}
