// preflight.mjs — "can this credential actually serve inference, right now?"
//
// WHY THIS EXISTS: on 2026-10-22 a freshly-added account (D) answered every request with HTTP 400
// "We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai…".
// A 400 carries no quota headers, so selection saw an account with every window wide open — and it
// was the ONLY account not parked, so every chat on the machine was routed to it and died on a 400
// instead of an honest limit message. `cla-gw add` accepted the credential because it parsed and
// because /api/oauth/profile answered; nothing ever asked it to do the one thing the pool needs.
// The wall is not quota, and the gateway (since 24e7363) parks and routes around it — but the fix for
// "the new account is dead on arrival" is to find that out BEFORE it is in rotation.
//
// MEASURED, so do not "optimise" this into a cheaper call: /v1/messages/count_tokens does NOT see the
// terms wall. Same token, same moment — count_tokens -> 200 {"input_tokens":8}, /v1/messages -> 400
// Consumer Terms. The consent gate sits on real inference only. So the probe is a real completion,
// held to max_tokens: 1 plus a one-word prompt, which costs on the order of one token.

import { isConsentWall } from './config.mjs';
import { resolveBearer } from './creds.mjs';

// Probed in order. A 400 that complains about the model field is a model-name problem, not an account
// problem, so we try the next candidate rather than reporting a working account as broken.
const MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-6'];
const looksLikeModelComplaint = (t) => /model/i.test(String(t || '')) && !isConsentWall(t);

/**
 * Ask one token to do a real (1-token) completion.
 * @returns {{ok:boolean, verdict:string, status:number, detail:string}} — ok:false means
 *          "this credential must not be put into rotation as-is".
 */
export async function probeInference(token, upstream = 'https://api.anthropic.com') {
  let inconclusive = null;
  for (const model of MODELS) {
    let r;
    try {
      r = await fetch(`${upstream}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        // The prompt and the ceiling are deliberately tiny: this runs while a human is mid-`add`.
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      return { ok: false, verdict: 'unreachable', status: 0,
        detail: String(e?.cause?.code || e?.message || e) };
    }
    const text = await r.text().catch(() => '');
    if (r.ok) return { ok: true, verdict: 'serves-inference', status: r.status, detail: model };
    // The wall that needs a human clicking in a browser. Waiting, retrying and rotating never help.
    if (isConsentWall(text)) {
      return { ok: false, verdict: 'terms-wall', status: r.status,
        detail: 'sign in to claude.ai as this account and accept the updated Consumer Terms, then enable it' };
    }
    if (r.status === 401 || r.status === 403) {
      return { ok: false, verdict: 'token-rejected', status: r.status,
        detail: (text.match(/"message"\s*:\s*"([^"]{0,160})/) || [, text.slice(0, 160)])[1] };
    }
    // Out of usage right now: the credential is good, the window is not. Fine to enrol.
    if (r.status === 429 || r.status === 529) {
      return { ok: true, verdict: 'limited-now', status: r.status, detail: 'credential works; currently rate-limited' };
    }
    if (looksLikeModelComplaint(text)) {
      inconclusive = { ok: true, verdict: 'model-unavailable', status: r.status, detail: `${model} rejected` };
      continue;
    }
    return { ok: false, verdict: `http-${r.status}`, status: r.status, detail: text.slice(0, 200) };
  }
  // Every candidate was rejected as a bad model name, but the credential authenticated. Ambiguous —
  // enrol it and let real traffic decide, rather than refusing an account we cannot actually disprove.
  return inconclusive || { ok: false, verdict: 'no-response', status: 0, detail: 'no attempt made' };
}

/** Preflight a configured account by resolving its credential the same way the gateway does. */
export async function preflightAccount(account, upstream = 'https://api.anthropic.com') {
  const c = resolveBearer(account);
  if (c.err) return { ok: false, verdict: 'no-credential', status: 0, detail: c.err };
  return { ...(await probeInference(c.token, upstream)), label: account.label };
}
