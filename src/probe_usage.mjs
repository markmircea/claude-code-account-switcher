// Per-account usage probe. Phase 4 needs this for EVERY account in the pool, so it is a file and
// not a throwaway: it answers "can a vaulted inference-only token even see its own limits?"
// Usage is free (no inference cost) and never touches the model.
import { loadConfig } from './config.mjs';
import { resolveBearer } from './creds.mjs';

const cfg = loadConfig();
const labels = process.argv.slice(2).length ? process.argv.slice(2) : cfg.accounts.map((a) => a.label);

for (const label of labels) {
  const acct = cfg.accounts.find((a) => a.label === label);
  if (!acct) { console.log(`${label}: not in config`); continue; }
  const sel = resolveBearer(acct);
  if (sel.err) { console.log(`${label}: credential unavailable (${sel.err})`); continue; }
  let r;
  try {
    r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${sel.token}`, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { console.log(`${label}: fetch failed (${e.message})`); continue; }
  if (!r.ok) {
    const t = await r.text();
    console.log(`${label}: HTTP ${r.status} ${t.slice(0, 160)}`);
    continue;
  }
  const j = await r.json().catch(() => ({}));
  const limits = (j.limits || []).map((l) => `${l.kind}: ${l.percent}% active=${l.is_active} sev=${l.severity} resets=${l.resets_at}`);
  console.log(`${label}: HTTP 200 uuid=${j.account?.uuid?.slice(0, 8) || '?'} subscription=${j.subscription?.type || '?'} extra=${j.extra_usage?.is_enabled}`);
  limits.forEach((l) => console.log(`   ${l}`));
}
