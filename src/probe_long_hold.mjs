// probe_long_hold.mjs — does the VS CODE PANEL tolerate a LONG gateway hold?
//
// The question this answers (nothing else does): when the pool is empty and the gateway commits the
// SSE stream and keeps it alive with ping frames for minutes, does the extension's own agent-sdk
// stack (a) still be there when the window opens, and (b) render the answer as a normal turn?
// The panel never arms Claude Code's own usage-limit wait — proven on 2.1.305 and 2.1.306 — so this
// hold is the ONLY route to a panel chat that resumes itself when an account frees.
//
// It is deliberately NOT a test of terminal Claude Code. It drives the *extension's own bundled
// binary* in the resident `--input-format stream-json` shape the panel uses.
//
// NOTHING LIVE IS TOUCHED:
//   * a THROWAWAY gateway on its own port with its own scratch data dir (LOCALAPPDATA is redirected
//     before config.mjs is imported), fake vault tokens, upstream = the stand-in. The real gateway on
//     :8790, its config, vault, state and log are never opened — which matters because other live
//     chats (and the pi session itself) route through :8790.
//   * the stand-in answers any credential, so no request reaches Anthropic: zero quota.
//   * the client is pointed at the throwaway gateway through a `--settings` layer, because the
//     `env` block in ~/.claude/settings.json OVERRIDES the process environment (see HANDOFF).
// A watchdog always stops the children and removes the scratch dir.
//
//   node src/probe_long_hold.mjs --window 240              # 4-minute hold, real client binary
//   node src/probe_long_hold.mjs --window 1200             # 20-minute hold (real scale)
//   node src/probe_long_hold.mjs --window 60 --no-client   # gateway path only, no client
//   node src/probe_long_hold.mjs --window 240 --keep       # leave scratch/stand-in up to inspect
//   node src/probe_long_hold.mjs --selftest                # prove the harness without waiting

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE_DIR = path.join(HERE, '..', '.probe');
const SCRATCH = path.join(PROBE_DIR, 'gw-scratch');
const UP_PORT = Number(process.env.LH_UP_PORT || 8791);
const GW_PORT = Number(process.env.LH_GW_PORT || 8795);
const SECRET = 'longhold-' + os.userInfo().username + '-' + process.pid;

// config.mjs derives DATA_DIR from LOCALAPPDATA at import time, so this must happen first.
process.env.LOCALAPPDATA = SCRATCH;
process.env.CLAUDE_GW_NO_NOTIFY = '1';
const { CONFIG_PATH, DATA_DIR, LOG_PATH, ACCOUNT_STATE_PATH } = await import('./config.mjs');
const { vaultPut } = await import('./vault.mjs');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const argv = process.argv;
const has = (n) => argv.includes(`--${n}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(m);
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

// ---------- the binary under test: the EXTENSION's own, not the terminal CLI's ----------
function findExtensionBinary() {
  const roots = [path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(process.env.USERPROFILE || os.homedir(), '.vscode', 'extensions')];
  let best = null;
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      const m = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/.exec(n);
      if (!m) continue;
      const exe = path.join(root, n, 'resources', 'native-binary', 'claude.exe');
      if (!fs.existsSync(exe)) continue;
      const rank = (+m[1]) * 1e6 + (+m[2]) * 1e3 + (+m[3]);
      if (!best || rank > best.rank) best = { exe, version: `${m[1]}.${m[2]}.${m[3]}`, rank };
    }
  }
  return best;
}

const children = [];
function spawnChild(cmd, args, opts = {}) {
  const c = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...opts });
  children.push(c);
  return c;
}
let gw = null, up = null, client = null;
let finished = false;
function cleanup(keep = false) {
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  if (up) { try { spawn(process.execPath, [path.join(HERE, 'probe_upstream.mjs'), 'stop'], { stdio: 'ignore' }); } catch { /* best effort */ } }
  if (!keep) { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ } }
}

async function main() {
  const windowSec = Number(arg('window', 240));
  const keep = has('keep');
  const selftest = has('selftest');
  const win = selftest ? 20 : windowSec;

  const bin = findExtensionBinary();
  if (!bin && !has('no-client')) {
    say('FAIL: no anthropic.claude-code-* extension binary found; the panel cannot be represented.');
    say('      (run with --no-client for the gateway-only path)');
    process.exit(1);
  }

  say(`harness: throwaway gateway :${GW_PORT} (scratch ${SCRATCH}) -> stand-in :${UP_PORT}`);
  say(`client:  ${bin ? `${bin.exe}  (extension ${bin.version})` : '(none: --no-client)'}`);
  say(`window:  stand-in says "out of usage" for ${win}s`);
  if (selftest) say('SELFTEST: short window, proves the plumbing end to end, not the tolerance question.');

  // 1. stand-in upstream, armed limited.
  try { fs.mkdirSync(PROBE_DIR, { recursive: true }); } catch { /* exists */ }
  up = spawnChild(process.execPath, [path.join(HERE, 'probe_upstream.mjs'), 'start', '--port', String(UP_PORT)],
    { stdio: 'ignore' });
  await sleep(900);
  const control = path.join(PROBE_DIR, 'control.json');
  const resetAt = Math.floor(Date.now() / 1000) + win;
  fs.writeFileSync(control, JSON.stringify({ phase: 'limited', resetAt }, null, 2));

  // 2. throwaway gateway: one fake vault account, upstream = stand-in, silent hold too small to
  //    cover the window so the LONG (ping-keepalive) path is the only one that can serve.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    host: '127.0.0.1', port: GW_PORT, upstream: `http://127.0.0.1:${UP_PORT}`,
    secret: SECRET, secretHeader: 'x-gw-secret', swapInferenceOnly: true, active: null,
    accounts: [{ label: 'P', kind: 'vault', vaultRef: 'P', enabled: true }],
    holdMaxMs: 1500,
    holdStream: true,
    holdStreamMaxMs: (win * 1000) + 120_000,
  }, null, 2), { mode: 0o600 });
  vaultPut('P', 'fake-token-never-sent-anywhere-real');
  fs.writeFileSync(ACCOUNT_STATE_PATH, JSON.stringify({ P: { activeAt: Date.now() } }));

  gw = spawnChild(process.execPath, [path.join(HERE, 'gw.mjs')], { stdio: 'ignore' });
  let up2 = false;
  for (let i = 0; i < 60 && !up2; i++) {
    await sleep(200);
    up2 = await fetch(`http://127.0.0.1:${GW_PORT}/__gw/health`).then((r) => r.ok, () => false);
  }
  if (!up2) { say('FAIL: throwaway gateway never came up'); cleanup(keep); process.exit(1); }
  say(`${at()}  throwaway gateway is up`);

  // 3. the client, pointed at the throwaway gateway through a settings layer.
  const settingsPath = path.join(PROBE_DIR, 'long-hold-settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${GW_PORT}`,
      ANTHROPIC_CUSTOM_HEADERS: `x-gw-secret: ${SECRET}`,
      ANTHROPIC_AUTH_TOKEN: '',
    },
  }, null, 2));

  const events = [];
  let firstByteAt = null, answerText = '', sawError = null, sawRateLimit = false, resultEvent = null;

  if (has('no-client')) {
    // Gateway-only proof: raw SSE request, watch it wait and then get the real frames.
    const r = await fetch(`http://127.0.0.1:${GW_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'x-gw-secret': SECRET, 'content-type': 'application/json',
        authorization: 'Bearer client-login-not-forwarded', 'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20' },
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 32, stream: true,
        messages: [{ role: 'user', content: 'count to three' }] }),
    });
    firstByteAt = Date.now() - t0;
    const held = r.headers.get('x-gw-held');
    const dec = new TextDecoder();
    let raw = '';
    for await (const chunk of r.body) raw += dec.decode(chunk, { stream: true });
    answerText = raw;
    events.push({ t: Date.now() - t0, type: `http-${r.status}`, note: `x-gw-held=${held}` });
    say(`${at()}  raw client: HTTP ${r.status}, x-gw-held=${held}, stream ${raw.length}B`);
    say(`        frames: ${raw.split('\n').filter((l) => l.startsWith('event:')).map((l) => l.slice(6)).join(',')}`);
  } else {
    client = spawnChild(bin.exe, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--settings', settingsPath]);
    let buf = '';
    client.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch { say(`${at()}  (non-json from client) ${line.slice(0, 120)}`); continue; }
        const dt = Date.now() - t0;
        if (firstByteAt === null) firstByteAt = dt;
        events.push({ t: dt, type: e.type, subtype: e.subtype, is_error: e.is_error });
        say(`${at()}  client event: ${e.type}${e.subtype ? '/' + e.subtype : ''}` +
          `${e.is_error !== undefined ? ` is_error=${e.is_error}` : ''}` +
          `${e.result ? ` :: ${String(e.result).slice(0, 90)}` : ''}`);
        if (e.type === 'rate_limit_event') sawRateLimit = true;
        if (e.type === 'result') { resultEvent = e; answerText = String(e.result || ''); sawError = e.is_error === true; }
        if (e.type === 'assistant') {
          const c = e.message?.content || [];
          answerText = c.map((x) => x.text || '').join('') || answerText;
        }
      }
    });
    client.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) say(`${at()}  client stderr: ${s.slice(0, 160)}`); });
    client.on('exit', (code) => say(`${at()}  client process exited code=${code}`));

    // One turn, then hold stdin open like the panel does.
    client.stdin.write(JSON.stringify({ type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'count to three' }] } }) + '\n');
    say(`${at()}  turn sent to the panel-shaped client`);

    const deadline = (win * 1000) + 300_000;
    for (let waited = 0; waited < deadline && !resultEvent; waited += 1000) await sleep(1000);
  }

  // 4. verdict, from the throwaway gateway's own log plus the stand-in's request log.
  await sleep(600);
  const gwLog = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l)) : [];
  const standin = fs.existsSync(path.join(PROBE_DIR, 'requests.jsonl'))
    ? fs.readFileSync(path.join(PROBE_DIR, 'requests.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l)).slice(-4)
    : [];

  say('\n--- throwaway gateway log ---');
  for (const r of gwLog) {
    if (!r.account && !r.event && !r.status) continue;
    say(`  ${new Date(r.ts).toLocaleTimeString()} ${r.event || r.method || ''} ${r.path || ''} ` +
      `HTTP ${r.status ?? ''} acct=${r.account ?? '-'} held=${r.heldMs ?? ''} waitMs=${r.waitMs ?? ''} ` +
      `waited=${r.totalMs ?? ''} ${r.resumed ? 'RESUMED' : ''}`.trim());
  }
  say('--- what the stand-in saw (last 4) ---');
  for (const r of standin) {
    say(`  ${new Date(r.ts).toLocaleTimeString()} ${r.ev} ${r.out} ua=${String(r.ua || '').slice(0, 42)} ` +
      `x-stainless-timeout=${r.timeoutHdr ?? '-'} retries=${r.retryCount ?? '-'}`);
  }

  const holdLine = gwLog.find((r) => r.event === 'hold-stream');
  // The line that matters is the one the gateway marked RESUMED (the held request finally served).
  // A real client fires extra small requests right after (topic/title generation), and picking the
  // first 200 measures one of those instead of the hold.
  const served = gwLog.find((r) => r.resumed) || gwLog.find((r) => r.status && r.status < 400);
  const waitedMs = served?.totalMs ?? (events.at(-1)?.t ?? 0);
  // Measure the wait against the window the gateway actually PROMISED (hold-stream waitMs), not the
  // nominal one: on a short selftest window the client's own startup latency eats several seconds
  // before the request even lands, and the real 2.1.306 client is 3-13s from turn-send to first
  // /v1/messages. The thing under test is "did it wait the whole time it said it would".
  const promisedMs = holdLine?.waitMs ?? win * 1000;
  const heldMs = served?.heldMs ?? 0;
  const checks = [
    ['the gateway committed the stream instead of handing over a 429',
      !!holdLine, holdLine ? `hold-stream waitMs=${holdLine.waitMs}` : 'no hold-stream line'],
    ['the turn was NOT ended by a refusal (is_error false, answer delivered)',
      sawError !== true && !!resultEvent, sawError === true ? 'is_error result' : (resultEvent ? 'result delivered' : 'no result')],
    ['the request waited for the window rather than answering early',
      heldMs >= promisedMs * 0.8 && heldMs >= 3000,
      `held ${heldMs}ms vs promised ${promisedMs}ms (nominal ${win * 1000}ms, client saw the answer at ${waitedMs}ms)`],
    ['the answer arrived on the same stream, as a normal turn',
      /probe|three|1.*2.*3|ok/i.test(answerText) && !sawError, `result="${String(answerText).slice(0, 70)}"`],
    ['the client was still connected when the window opened',
      !!served && !gwLog.some((r) => r.event === 'hold-stream-abort'),
      gwLog.some((r) => r.event === 'hold-stream-abort') ? 'hold-stream-abort logged' : 'no abort'],
  ];
  let fail = false;
  say('');
  for (const [name, pass, why] of checks) {
    say(`${pass ? 'PASS' : 'FAIL'}  ${name}  - ${why}`);
    if (!pass) fail = true;
  }
  // Informational, not a failure: the committed stream carries the refusal's quota headers, and the
  // client turns those into a rate_limit_event even though the turn itself succeeded. Watch whether
  // that ever coincides with the client giving up - it is the one signal that could un-arm things.
  say(`NOTE  rate_limit_event seen by the client: ${sawRateLimit ? 'yes (limit notice shown, turn still completed)' : 'no'}`);
  const timeoutHdr = standin.map((r) => r.timeoutHdr).filter(Boolean).pop();
  if (timeoutHdr) say(`\nclient's own per-request timeout header: x-stainless-timeout=${timeoutHdr}s ` +
    `-> a hold longer than that is a hold the client has already abandoned.`);
  say(fail ? '\nVERDICT: the panel path did NOT ride out the hold.' : `\nVERDICT: the panel-shaped client rode out a ${win}s hold.`);
  cleanup(keep);
  process.exit(fail ? 1 : 0);
}

const watchdog = setTimeout(() => {
  say(`\nWATCHDOG: no result within the expected span - restoring.`);
  cleanup(has('keep'));
  process.exit(1);
}, (Number(arg('window', 240)) * 1000) + 480_000);

main().catch((e) => { say('probe_long_hold failed: ' + (e?.stack || e)); cleanup(has('keep')); process.exit(1); });
