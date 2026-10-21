// Dump the FULL 429 from the exhausted account (free — rejected before inference) plus headers.
// The switch logic in phase 4 depends on what this actually says, so it is worth re-checking: the
// first capture (weeks ago) was the opaque {"message":"Error"}, and it is no longer that.
import { loadConfig, saveConfig } from './config.mjs';
const cfg = loadConfig();
const orig = cfg.active;
try {
  const c = loadConfig(); c.active = process.argv[2] || 'A'; saveConfig(c);
  await new Promise((r) => setTimeout(r, 1100));
  const r = await fetch(`http://${cfg.host}:${cfg.port}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.secret}`, 'content-type': 'application/json',
               'anthropic-version': '2023-06-01', 'x-claude-code-session-id': 'probe-429' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 8,
                           messages: [{ role: 'user', content: 'hi' }] }),
  });
  console.log(`status: ${r.status}`);
  console.log('headers:');
  for (const [k, v] of r.headers) console.log(`  ${k}: ${v}`);
  const body = await r.text();
  console.log('body:');
  try { console.log(JSON.stringify(JSON.parse(body), null, 1)); } catch { console.log(body); }
} finally {
  const c = loadConfig(); c.active = orig; saveConfig(c);
  console.log(`\npin restored to ${orig}`);
}
