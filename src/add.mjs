// `cla-gw add <label>` — enrol another account into the rotation.
//
// Uses `claude setup-token`: a 1-year, inference-only OAuth token — the weakest credential that
// still does the job, since the vault only ever signs /v1/messages (PLAN.md D-2, D-10).
//
// WHY THIS IS INTERACTIVE. setup-token is an Ink TUI. When its stdout is piped it renders NOTHING
// and exits 0 — measured, not assumed. An earlier version of this file spawned it with piped stdio,
// so the child died before its OAuth callback listener was listening: the browser then redirected to
// a dead port and the token was lost. Hence: inherit the real console, let the user drive it, and
// take the token by paste. `--auto` keeps the piped attempt for anyone who wants to try it, but it
// is not the default and it is documented as unreliable.
//
// The token is never written to the repo, the gateway log, or a command-line argument. It goes to
// the DPAPI vault (stdin to PowerShell).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DATA_DIR, loadConfig, saveConfig, HOME } from './config.mjs';
import { vaultPut, vaultPath, vaultRm, vaultLs } from './vault.mjs';
import { describeIdentity } from './creds.mjs';
import { probeInference } from './preflight.mjs';

const TOKEN_RE = /sk-ant-oat[0-9]{2}-[A-Za-z0-9_\-]{16,}/;
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(HOME, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
const YEAR_MS = 365 * 86400000;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

// Who is already in the pool, so "sign in as the other account" is a concrete instruction rather
// than a guess. Note what we CANNOT know: which accounts your *browser* is signed into.
function rotationReport(cfg) {
  const rows = cfg.accounts.map((a) => {
    let who = 'identity unknown';
    if (a.kind === 'cli-credential') {
      const id = describeIdentity().identity;
      if (id) who = `${id.email}  uuid=${id.accountUuid.slice(0, 8)}…`;
    } else if (a.identity) {
      who = `${a.identity.email || '(no email)'}  uuid=${(a.identity.uuid || '').slice(0, 8)}…`;
    }
    const state = a.enabled === false ? 'DISABLED (not in rotation)' : 'in rotation';
    return `  ${a.label.padEnd(6)} ${a.kind.padEnd(16)} ${state.padEnd(24)} ${who}`;
  });

  // "Signed in" is per-store, and there are two stores that matter.
  let signedIn = '';
  try {
    const g = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    if (g.oauthAccount?.accountUuid) {
      const em = g.oauthAccount.emailAddress || g.oauthAccount.email || '?';
      signedIn = `  CLI + VS Code extension (shared ~/.claude): signed in as ${em}` +
                 `  uuid=${g.oauthAccount.accountUuid.slice(0, 8)}…`;
    } else {
      signedIn = '  CLI + VS Code extension (shared ~/.claude): NOT signed in (no oauthAccount)';
    }
  } catch { signedIn = '  CLI + VS Code extension (shared ~/.claude): could not read ~/.claude.json'; }

  const vault = vaultLs();
  return (rows.length ? rows.join('\n') : '  (no accounts in the rotation yet)') +
    '\n' + signedIn +
    `\n  vault tokens held: ${vault.length ? vault.join(', ') : '(none)'}`;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let answered = false;
    rl.question(question, (a) => { answered = true; rl.close(); resolve(a.trim()); });
    // Without this, closed/empty stdin means the callback never fires and we exit silently. Seen.
    rl.on('close', () => { if (!answered) resolve(''); });
  });
}

function provisionDir(label) {
  const d = path.join(DATA_DIR, 'provision', label);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Run setup-token in THIS console so its TUI actually renders and its callback port stays open.
function provisionInteractive(cfgDir) {
  return new Promise((resolve) => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfgDir };
    delete env.ANTHROPIC_BASE_URL;   // never let the gateway proxy its own login
    delete env.ANTHROPIC_AUTH_TOKEN;
    const child = spawn(CLAUDE_BIN, ['setup-token'], { env, cwd: cfgDir, stdio: 'inherit' });
    child.on('exit', (code) => resolve({ code }));
    child.on('error', (e) => resolve({ err: e.message }));
  });
}

// Best-effort: piped attempt. Kept for completeness; see the header for why it is not the default.
function provisionAutomated(cfgDir, onOutput) {
  return new Promise((resolve) => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfgDir };
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const child = spawn(CLAUDE_BIN, ['setup-token'], { env, cwd: cfgDir, windowsHide: true });
    let all = '';
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    const onData = (b) => {
      const s = stripAnsi(b.toString('utf8'));
      all += s; onOutput(s);
      const m = all.match(TOKEN_RE);
      if (m) finish({ token: m[0] });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const nudges = [1500, 4000, 9000].map((ms) => setTimeout(() => { try { child.stdin.write('\n'); } catch {} }, ms));
    child.on('exit', () => {
      nudges.forEach(clearTimeout);
      const m = all.match(TOKEN_RE);
      finish(m ? { token: m[0] } : { err: 'no token in output (setup-token is a TUI; it renders nothing when piped)', output: all.slice(-400) });
    });
    child.on('error', (e) => finish({ err: e.message }));
    setTimeout(() => finish({ err: 'timed out' }), 360000);
  });
}

// Best-effort identity check so a second token for an account you already have is caught rather
// than silently adding no capacity. An inference-only token may lack user:profile; then we say so.
async function identify(token) {
  for (const p of ['/api/oauth/profile', '/api/oauth/validate']) {
    try {
      const r = await fetch(`https://api.anthropic.com${p}`, {
        headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const j = await r.json().catch(() => ({}));
      const uuid = j?.account?.uuid || j?.uuid || j?.accountUuid || j?.account?.id || null;
      const email = j?.account?.email_address || j?.email_address || j?.email || null;
      if (uuid || email) return { uuid, email, via: p };
    } catch { /* next */ }
  }
  return null;
}

export async function addAccount(label, { paste = false, auto = false } = {}) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(label)) {
    console.log('label must be short and simple, e.g. B or work');
    return 2;
  }
  const cfg = loadConfig();
  if (cfg.accounts.some((a) => a.label === label)) {
    console.log(`label "${label}" already exists. Use cla-gw enable/disable, or cla-gw forget ${label} --yes`);
    return 2;
  }
  if (fs.existsSync(vaultPath(label))) {
    console.log(`a vault entry for "${label}" already exists; cla-gw forget ${label} --yes first`);
    return 2;
  }

  const cfgDir = provisionDir(label);

  // --- what you already have, printed BEFORE the browser step ---
  console.log(`\naccounts known to the gateway right now:`);
  console.log(rotationReport(cfg));
  console.log(`\nI cannot see which accounts your BROWSER is signed into. That is the one thing
only you can check. Add a NEW account here: one whose email is not in the list above.`);

  let token = null;
  if (paste) {
    const entered = await ask('paste the token (starts with sk-ant-oat): ');
    if (!entered) { console.log('no token received. Pipe it: echo <token> | cla-gw add <label> --paste'); return 2; }
    const m = entered.match(TOKEN_RE);
    if (!m) { console.log(`that does not look like a setup-token value (${entered.length} chars)`); return 2; }
    token = m[0];
  } else {
    if (auto) {
      const res = await provisionAutomated(cfgDir, (s) => process.stdout.write(s));
      if (res.token) token = res.token;
      else console.log(`\n--auto did not work (${res.err}). Continuing interactively.`);
    }
    if (!token) {
      console.log(`\nstarting: "${CLAUDE_BIN}" setup-token   (config dir: ${cfgDir})`);
      console.log(`Your real login at ${HOME}\\.claude is NOT used or modified by this.`);
      console.log(`\nWhat will happen: Claude opens a browser and prints an authorize URL here.`);
      console.log(`  - If that browser/profile is not the one you want, IGNORE the window it opened,`);
      console.log(`    copy the URL from the line above (or the address bar) and open it where you want.`);
      console.log(`  - Sign in with a NEW account, then authorise.`);
      console.log(`  - Claude prints a long token beginning sk-ant-oat. That is the thing we need.`);
      console.log(`    It is printed on screen because setup-token has no other way to hand it over;`);
      console.log(`    it is not logged anywhere by us.\n`);
      const res = await provisionInteractive(cfgDir);
      if (res.err) console.log(`could not run setup-token: ${res.err}`);
      token = (await ask('\npaste the token that was just printed: ')).match(TOKEN_RE)?.[0] || null;
      if (!token) {
        console.log(`no token captured. Nothing was added — the browser step alone does not enrol an account.
If the browser showed an error after authorising, the callback did not reach the process.`);
        return 1;
      }
    }
  }

  vaultPut(label, token);
  const ident = await identify(token);

  // Ask the credential to do the job before letting it into rotation. A token can parse, authenticate
  // against /api/oauth/*, and still be unable to serve a single inference request — on 2026-10-22 the
  // new account answered everything with `400 ...accept them in claude.ai...` because its Consumer
  // Terms had not been accepted. Enrolled as-is, it became the only unparked account in the pool, so
  // selection sent every chat on the machine to it. See src/preflight.mjs for why this has to be a real
  // (1-token) completion rather than count_tokens.
  process.stdout.write('\nprobing inference with the new credential (one 1-token request)...\n');
  const pre = await probeInference(token);
  if (pre.verdict === 'token-rejected') {
    vaultRm(label);
    console.log(`\nNOT ADDED: upstream rejected this token (HTTP ${pre.status}) - ${pre.detail}`);
    console.log('Nothing was enrolled and the vault entry was removed. Re-run cla-gw add with a fresh setup-token.');
    return 1;
  }
  // Anything the pool cannot route around by waiting: enrol it switched OFF, so it cannot black-hole
  // chats, and say exactly what a human has to do to switch it on.
  const unusable = pre.ok === false;

  const known = [];
  try {
    const g = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    if (g.oauthAccount?.accountUuid) known.push({ label: 'A', ...g.oauthAccount });
  } catch { /* fine */ }
  for (const a of cfg.accounts) if (a.identity?.uuid) known.push({ label: a.label, ...a.identity });

  let verdict = 'identity NOT verifiable with an inference-only token — check the browser: did you sign in as an account not listed above?';
  if (ident?.uuid) {
    const dup = known.find((k) => (k.accountUuid || k.uuid) === ident.uuid);
    verdict = dup
      ? `WARNING: this token belongs to the SAME account as "${dup.label}" (${ident.email}). It adds NO capacity. Remove it: cla-gw forget ${label} --yes`
      : `verified as a distinct account: ${ident.email || '(no email)'}  uuid=${ident.uuid.slice(0, 8)}…`;
  }

  cfg.accounts.push({
    label,
    kind: 'vault',
    vaultRef: label,
    enabled: !unusable,
    addedAt: Date.now(),
    expiresAt: Date.now() + YEAR_MS,
    identity: ident ? { uuid: ident.uuid, email: ident.email } : null,
    note: unusable ? `setup-token: inference-only, 1 year, no refresh — NOT SERVING (${pre.verdict})`
                   : 'setup-token: inference-only, 1 year, no refresh',
  });
  saveConfig(cfg);

  console.log(`\nvaulted: ${vaultPath(label)}`);
  console.log(verdict);
  console.log(`inference probe: ${pre.verdict}${pre.status ? ` (HTTP ${pre.status})` : ''} - ${pre.detail}`);
  if (pre.verdict === 'limited-now') {
    console.log('note: this account is OUT OF USAGE right now. It is enrolled, but expect it to be parked until its window resets.');
  }
  if (unusable) {
    console.log(`\nENROLLED BUT DISABLED — this account cannot serve a single request yet.`);
    console.log(`It was added with enabled:false; the gateway would otherwise have routed chats to it and lost them.`);
    console.log(`Fix it, then: cla-gw enable ${label}`);
  }
  console.log(`\nrotation now:`);
  console.log(rotationReport(cfg));
  console.log(`\nTakes effect on the next request (config is re-read per request). Expires in ~365 days.`);
  return 0;
}
