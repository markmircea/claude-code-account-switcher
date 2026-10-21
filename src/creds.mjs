// Credential resolution. READ-ONLY with respect to anything the Claude Code CLI owns.
//
// D-10 (PLAN.md): the CLI wraps ~/.claude/.credentials.json in a lockfile + compare-and-swap
// write and assumes it is the sole writer. An external process refreshing that same chain risks
// corrupting it and logging the user out. So for kind:"cli-credential" we ONLY read, and we let
// the CLI refresh its own token. If the token turns out to be stale we surface that clearly
// rather than trying to fix it ourselves.

import fs from 'node:fs';
import path from 'node:path';
import { CLI_CREDENTIAL_PATH, HOME } from './config.mjs';
import { vaultGet } from './vault.mjs';

function readJsonSafe(file) {
  // Torn-read guard: a concurrent atomic rename can land mid-read. Retry once, then give up.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { json: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      if (err.code === 'ENOENT') return { err: 'missing-file' };
      if (attempt === 1) return { err: 'parse-failed' };
    }
  }
  return { err: 'parse-failed' };
}

// Identity for display only (which account is this?). Also read-only.
export function describeIdentity() {
  const g = readJsonSafe(path.join(HOME, '.claude.json'));
  if (g.err) return { identity: null, identityErr: g.err };
  const o = g.json?.oauthAccount;
  if (!o) return { identity: null, identityErr: 'no-oauthAccount' };
  return {
    identity: {
      accountUuid: o.accountUuid,
      email: o.emailAddress,
      subscription: o.organizationType || null,
      extraUsageEnabled: o.hasExtraUsageEnabled ?? null,
    },
  };
}

// Resolve the bearer token for an account. Never mutates anything.
export function resolveBearer(account, now = Date.now()) {
  if (account.kind === 'cli-credential') {
    const r = readJsonSafe(CLI_CREDENTIAL_PATH);
    if (r.err) return { err: r.err, hint: `is Claude Code logged in? (${CLI_CREDENTIAL_PATH})` };
    const o = r.json?.claudeAiOauth;
    if (!o?.accessToken) return { err: 'no-claudeAiOauth-slot' };

    const expiresInMs = typeof o.expiresAt === 'number' ? o.expiresAt - now : null;
    // Do NOT refresh. The CLI owns this chain (D-10). We only flag it so logs/UI can say why.
    return {
      token: o.accessToken,
      meta: {
        subscriptionType: o.subscriptionType ?? null,
        scopes: Array.isArray(o.scopes) ? o.scopes.join(' ') : null,
        expiresInMin: expiresInMs === null ? null : Math.round(expiresInMs / 60000),
        // stale is advisory only; a 401 from upstream will confirm it
        stale: expiresInMs !== null && expiresInMs < 0,
      },
    };
  }

  if (account.kind === 'vault') {
    // Vault accounts hold a `claude setup-token` value: inference-only and non-refreshing, which
    // is sufficient because the vault only ever needs to sign /v1/messages (D-2, D-10).
    const v = vaultGet(account.vaultRef || account.label);
    if (v.err) return { err: v.err, hint: 'run: cla-gw add <label>' };
    const expiresInDays = typeof account.expiresAt === 'number'
      ? Math.round((account.expiresAt - now) / 86400000) : null;
    return {
      token: v.token,
      meta: {
        kind: 'vault',
        scopes: 'user:inference (setup-token)',
        expiresInDays,
        stale: expiresInDays !== null && expiresInDays < 0,
        identity: account.identity || null,
      },
    };
  }

  return { err: `unknown-account-kind:${account.kind}` };
}
