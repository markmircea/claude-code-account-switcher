#!/usr/bin/env node
// cla-gw control CLI. This is the authoritative surface; the later dashboard is a skin over it.
//
//   cla-gw start | stop | status | ls | use <label>|none | enable <label> | disable <label> | env
//
// Naming (PLAN.md phase 5): start|stop act on the gateway itself;
// enable|disable act on an account's rotation membership. Never overloaded.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ensureConfig, loadConfig, saveConfig, pool, PID_PATH, CONFIG_PATH, LOG_PATH, STATUS_PATH, ACCOUNT_STATE_PATH, readAccountState } from './config.mjs';
import { resolveBearer, describeIdentity } from './creds.mjs';
import { addAccount } from './add.mjs';
import { vaultLs, vaultRm } from './vault.mjs';
import { activate, deactivate, doctor, runWithoutGateway } from './activate.mjs';
import { preflightAccount } from './preflight.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';

function stateLine(s) {
  if (!s) return 'no traffic observed through the gateway yet';
  const pct = (v) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
  const when = (epoch) => (epoch ? new Date(epoch * 1000).toLocaleString() : '?');
  const parked = s.blockedUntil && s.blockedUntil > Date.now()
    ? `  PARKED(${s.parkReason || '?'} until ${new Date(s.blockedUntil).toLocaleString()})` : '';
  const terms = s.consentUntil && s.consentUntil > Date.now()
    ? `  NEEDS TERMS at claude.ai (org ${s.orgId ? String(s.orgId).slice(0, 8) + ' - ' : ''}parked until ${new Date(s.consentUntil).toLocaleTimeString()})` : '';
  const bare = s.bare429 ? `  headerless-429s=${s.bare429}` : '';
  const blind = (s.u5h == null && s.u7d == null) ? '  [quota state not seen from real traffic yet]' : '';
  // Usage is only learned from responses, so a window that has reset since this account last served
  // would otherwise keep showing its old 100%/rejected.
  const win = (u, st, reset) => (reset && reset * 1000 <= Date.now()
    ? `reset ${new Date(reset * 1000).toLocaleTimeString()}, not used since`
    : `${pct(u)}/${st || 'n/a'}`);
  return `5h ${win(s.u5h, s.s5h, s.r5h)}  7d ${win(s.u7d, s.s7d, s.r7d)}  claim=${s.claim || '?'}  ` +
         `7d resets ${when(s.r7d)}  reqs=${s.requests || 0}${parked}${terms}${bare}${blind}`;
}

function orgWarning(cfg) {
  const st = readAccountState();
  const seen = new Map();
  for (const a of cfg.accounts) {
    const org = st[a.label]?.org;
    if (!org) continue;
    if (seen.has(org)) return `WARNING: ${seen.get(org)} and ${a.label} share org ${org.slice(0, 8)}… — they are the SAME account, so capacity is not doubled`;
    seen.set(org, a.label);
  }
  return null;
}

function accountsTable(cfg) {
  const st = readAccountState();
  return cfg.accounts.map((a) => {
    const marks = [];
    if (a.enabled === false) marks.push('DISABLED');
    if (cfg.active === a.label) marks.push('PINNED');
    let extra = '';
    if (a.kind === 'cli-credential') {
      const c = resolveBearer(a);
      if (c.err) extra = `credential: ${c.err}`;
      else extra = `token ok (expires in ${c.meta.expiresInMin} min)${c.meta.stale ? ' [STALE]' : ''}`;
    } else if (a.kind === 'vault') {
      const c = resolveBearer(a);
      const who = a.identity?.email || (a.identity?.org ? `org ${a.identity.org.slice(0, 8)}…` : 'identity unverified');
      if (c.err) extra = `vault: ${c.err}`;
      else extra = `vault ok · ${who} · expires in ${c.meta.expiresInDays} d${c.meta.stale ? ' [EXPIRED]' : ''}`;
    }
    return `  ${a.label.padEnd(6)} ${a.kind.padEnd(16)} ${extra.padEnd(52)} ${marks.join(',') || ''}\n         org ${(st[a.label]?.org || a.identity?.org || '?').slice(0, 8)}…  ${stateLine(st[a.label])}`;
  }).filter(Boolean).join('\n') + (orgWarning(cfg) ? `\n\n  ${orgWarning(cfg)}` : '');
}

async function getStatus(cfg) {
  try {
    const r = await fetch(`http://${cfg.host}:${cfg.port}/__gw/status`, {
      headers: { authorization: `Bearer ${cfg.secret}` },
      signal: AbortSignal.timeout(4000),
    });
    return await r.json();
  } catch (e) { return null; }
}

async function main() {
  const { cfg, created } = ensureConfig();
  if (created) console.log(`created config: ${CONFIG_PATH}`);

  switch (cmd) {
    case 'start': {
      if (fs.existsSync(PID_PATH) && await getStatus(cfg)) {
        console.log(`already running (pid ${fs.readFileSync(PID_PATH, 'utf8').trim()})`);
        return;
      }
      const child = spawn(process.execPath, [path.join(HERE, 'gw.mjs')], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref();
      await new Promise((r) => setTimeout(r, 1200));
      const st = await getStatus(cfg);
      console.log(st ? `started; pool: ${st.pool.join(', ')}` : 'started but not answering /__gw/status — check the log');
      console.log(`log: ${LOG_PATH}`);
      return;
    }

    case 'stop': {
      if (!fs.existsSync(PID_PATH)) { console.log('not running (no pid file)'); return; }
      const pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
      try { process.kill(pid); console.log(`stopped pid ${pid}`); }
      catch (e) { console.log(`could not signal pid ${pid}: ${e.code}`); }
      try { fs.unlinkSync(PID_PATH); } catch {}
      return;
    }

    case 'status': {
      const st = await getStatus(cfg);
      if (!st) { console.log('gateway: NOT RUNNING'); console.log(`config pool: ${pool(cfg).map((a) => a.label).join(', ') || '(empty)'}`); console.log(`config upstream: ${cfg.upstream}${/127\.0\.0\.1|localhost/.test(cfg.upstream) ? '   <-- LOOPBACK: tests only; real traffic would 502. Fix: node src/reset_upstream.mjs' : ''}`); return; }
      console.log(`gateway: RUNNING on ${cfg.host}:${cfg.port} (uptime ${(st.uptimeMs / 1000).toFixed(0)}s)`);
      // `pin` is what the user forced; `would serve next` is what selection currently picks. Showing
      // only the latter once read as "the pin is B" when there was no pin at all.
      console.log(`  pin: ${cfg.active || '(none - auto)'}   would serve next: ${st.active}   pool: ${st.pool.join(', ')}   disabled: ${st.disabled.join(', ') || '(none)'}`);
      console.log(`  upstream: ${cfg.upstream}${/127\.0\.0\.1|localhost/.test(cfg.upstream) ? '   <-- LOOPBACK: tests only; real traffic will 502' : ''}`);
      if (st.cliIdentity) console.log(`  CLI-owned account: ${st.cliIdentity.email} (${st.cliIdentity.subscription})`);
      console.log(`  requests: ${st.stats.requests}  errors: ${st.stats.errors}  byAccount: ${JSON.stringify(st.stats.byAccount)}`);
      console.log(`  status file: ${STATUS_PATH}`);
      return;
    }

    case 'ls': {
      console.log(`config: ${CONFIG_PATH}`);
      console.log(accountsTable(cfg));
      const id = describeIdentity().identity;
      if (id) console.log(`\nCLI identity (account A): ${id.email}  uuid=${id.accountUuid}  extraUsage=${id.extraUsageEnabled}`);
      console.log(`vault entries: ${vaultLs().join(', ') || '(none)'}`);
      console.log('\n"disable" removes an account from the rotation but keeps its credential (D-12).');
      console.log('"disable" is NOT revoke - the token stays valid until it expires or you revoke it at claude.ai.');
      return;
    }

    case 'notify': {
      const { notify } = await import('./notify.mjs');
      const how = await notify('claude-gw: test notification', 'if you can see this, account-switch alerts work');
      console.log(`sent via ${how}`);
      return;
    }

    case 'activate': {
      await activate({ noStartup: process.argv.includes('--no-startup'), legacy: process.argv.includes('--legacy') });
      return;
    }

    case 'deactivate': {
      await deactivate();
      return;
    }

    case 'doctor': {
      const healthy = await doctor();
      process.exit(healthy ? 0 : 1);
      return;
    }

    case 'run': {
      // cla-gw run -- <claude args>: one Claude session with the gateway vars stripped, i.e. your
      // real login direct. Nothing persistent changes.
      const args = process.argv.slice(3).filter((a) => a !== '--');
      runWithoutGateway(args.length ? args : ['-p', 'hi']);
      return;
    }

    case 'reset-state': {
      // The gateway hot-reloads this file, so removing it is enough - no restart needed.
      fs.rmSync(ACCOUNT_STATE_PATH, { force: true });
      console.log(`cleared quota state: ${ACCOUNT_STATE_PATH}`);
      console.log('the running gateway picks the reset up on its next request; state rebuilds from real traffic');
      console.log('note: accounts that were parked become eligible again immediately');
      return;
    }

    case 'health': {
      const st = readAccountState();
      console.log(`per-account quota state — learned from rate-limit headers on real traffic (F27/F28/F29); nothing is polled, so vault-only tokens are covered too: ${ACCOUNT_STATE_PATH}`);
      for (const a of cfg.accounts) {
        console.log(`\n${a.label}${a.enabled === false ? ' (DISABLED)' : ''}: ${stateLine(st[a.label])}`);
        if (st[a.label]?.org) console.log(`   org=${st[a.label].org}  workspace=${st[a.label].workspace || '?'}` + (a.identity?.email ? `  email=${a.identity.email}` : ''));
        const gates = Object.entries(st[a.label]?.modelGate || {}).filter(([, u]) => u > Date.now());
        if (gates.length) {
          const hits = st[a.label].modelGateHits || {};
          console.log(`   MODEL-GATED (429 with healthy-looking window headers): ${gates.map(([m, u]) => `${m} until ${new Date(u).toLocaleString()}${hits[m] ? ` (gate grows with each rejection: ${hits[m]} so far)` : ''}`).join(', ')}`);
        }
        // Not a capacity signal, printed for context only. `rejected/out_of_credits` shows up on
        // SUCCESSFUL responses too - it just means extra-usage purchase is off. Reading it as
        // "out of capacity" is how I mis-called the pool exhausted once.
        console.log(`   overage purchase: ${st[a.label]?.overageStatus || '-'}/${st[a.label]?.overageDisabledReason || '-'}`);
      }
      const w = orgWarning(cfg);
      if (w) console.log(`\n${w}`);
      return;
    }

    case 'check': {
      // Live probe: not "does the token parse" but "can this account answer a request". `health` reads
      // headers we happened to see on past traffic; this asks upstream now, at one token per account.
      // Worth running before `add`ing another account in a panic — the 2026-10-22 pool was not short of
      // accounts, it was short of SERVABLE ones, and the new one was dead on arrival.
      const want = argv.slice(1).filter((a) => !a.startsWith('--'));
      const targets = want.length ? cfg.accounts.filter((a) => want.includes(a.label)) : cfg.accounts;
      if (!targets.length) { console.log(`no such account(s): ${want.join(', ')}\npool: ${cfg.accounts.map((a) => a.label).join(', ')}`); process.exitCode = 2; return; }
      console.log(`probing ${targets.map((a) => a.label).join(', ')} against ${cfg.upstream} (one 1-token request each)`);
      const results = await Promise.all(targets.map(async (a) => ({ label: a.label, r: await preflightAccount(a, cfg.upstream) })));
      let bad = 0;
      for (const { label, r } of results) {
        const acc = cfg.accounts.find((a) => a.label === label);
        if (!r.ok) bad++;
        console.log(`  ${r.ok ? 'ok  ' : 'FIX '} ${label}${acc?.enabled === false ? ' (DISABLED in pool)' : ''}: ${r.verdict}${r.detail ? ` - ${r.detail}` : ''}`);
        if (r.verdict === 'terms-wall') {
          const who = acc?.identity?.email || `the account with org ${(readAccountState()[label]?.org || acc?.identity?.org || '?').slice(0, 8)}…`;
          console.log(`       -> sign in to claude.ai as ${who} and accept the terms, then: cla-gw enable ${label}`);
        }
      }
      console.log(bad ? `\n${bad} account(s) cannot serve at all right now. Waiting will not fix a terms wall.` : '\nall probed accounts can serve inference');
      process.exitCode = bad ? 1 : 0;
      return;
    }

    case 'email': {
      // A setup-token cannot report who it belongs to, and "sign in as this account" is useless advice
      // when the pool has three of them. Record the address; org id stays the thing that catches a
      // duplicate enrolment of the same account.
      const label = argv[1], addr = (argv[2] || '').trim();
      const acc = cfg.accounts.find((a) => a.label === label);
      if (!acc) { console.log(`no such account: ${label}
pool: ${cfg.accounts.map((a) => a.label).join(', ')}`); process.exitCode = 2; return; }
      if (!addr) {
        console.log(`usage: cla-gw email <label> <email-on-claude.ai>`);
        console.log(`known now: ${cfg.accounts.map((a) => `${a.label}=${a.identity?.email || '?'}`).join('  ')}`);
        return;
      }
      if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(addr)) { console.log(`that is not an email address: ${addr}`); process.exitCode = 2; return; }
      const dup = cfg.accounts.find((a) => a.label !== label && a.identity?.email?.toLowerCase() === addr.toLowerCase());
      acc.identity = { ...(acc.identity || {}), email: addr, emailSource: 'user' };
      saveConfig(cfg);
      console.log(`${label} -> ${addr}${dup ? `  WARNING: "${dup.label}" is already recorded as ${addr}; two labels, one account - that is not extra capacity` : ''}`);
      return;
    }

    case 'add': {
      const label = argv[1];
      if (!label) { console.log('usage: cla-gw add <label> [--paste | --auto]'); return; }
      process.exitCode = await addAccount(label, { paste: argv.includes('--paste'), auto: argv.includes('--auto') });
      return;
    }

    case 'statusline': {
      const self = path.join(HERE, 'statusline.mjs').replace(/\\/g, '/');
      console.log('# Add to ~/.claude/settings.json (top-level key). I have not edited that file for you.');
      console.log('# Shows which gateway account is serving THIS conversation (F22/D-7).');
      console.log(JSON.stringify({ statusLine: { type: 'command', command: `node "${self}"` } }, null, 2));
      return;
    }

    case 'use': {
      const label = argv[1];
      if (!label) { console.log('usage: cla-gw use <label>|none'); return; }
      cfg.active = label === 'none' ? null : label;
      if (cfg.active && !cfg.accounts.some((a) => a.label === cfg.active)) {
        console.log(`unknown label "${cfg.active}"`); return;
      }
      saveConfig(cfg);
      console.log(`pin: ${cfg.active ?? '(none - auto: stays on the current account until a window is full)'}. Applies on the next request (hot reload).`);
      return;
    }

    case 'forget': {
      // Deliberately requires --yes, and deliberately honest about what it does NOT do.
      const label = argv[1];
      if (!label) { console.log('usage: cla-gw forget <label> --yes'); return; }
      if (!argv.includes('--yes')) {
        console.log(`refusing without --yes.
Removing "${label}" deletes the LOCAL vault entry and config row only.
It does NOT revoke the token at Anthropic - there is no revoke endpoint in Claude Code - so the
1-year token stays valid server-side until it expires or you remove it at claude.ai settings.
If you just want it out of the rotation: cla-gw disable ${label}
Re-run with --yes if you really mean deletion.`);
        return;
      }
      const cfg2 = loadConfig();
      const before = cfg2.accounts.length;
      cfg2.accounts = cfg2.accounts.filter((a) => a.label !== label);
      if (cfg2.active === label) cfg2.active = null;
      saveConfig(cfg2);
      const removed = vaultRm(label);
      console.log(`config row: ${before > cfg2.accounts.length ? 'removed' : 'absent'}; vault entry: ${removed ? 'removed' : 'absent'}`);
      console.log('reminder: not revoked server-side.');
      return;
    }

    case 'enable':
    case 'disable': {
      const label = argv[1];
      if (!label) { console.log(`usage: cla-gw ${cmd} <label>`); return; }
      const a = cfg.accounts.find((x) => x.label === label);
      if (!a) { console.log(`unknown label "${label}"`); return; }
      a.enabled = cmd === 'enable';
      saveConfig(cfg);
      // Fail loudly, as the risk register requires: an empty rotation is a footgun, not a feature.
      const remaining = pool(cfg).map((x) => x.label);
      console.log(`${label} -> ${a.enabled ? 'IN rotation' : 'out of rotation'} (hot reload)`);
      if (remaining.length === 0) {
        console.log('WARNING: rotation is now EMPTY. Claude Code requests will fail fast with a clear');
        console.log('         error rather than hang. Re-enable an account before continuing.');
      } else {
        console.log(`rotation: ${remaining.join(', ')}`);
      }
      return;
    }

    case 'env': {
      // The local shared secret, printed deliberately: it guards a loopback-only endpoint and is
      // not an Anthropic credential. It still should not end up committed or pasted into logs.
      // NOTE the deliberate absence of ANTHROPIC_AUTH_TOKEN: setting it makes Claude Code treat the
      // session as a billed-API session and switch off auto-continue at the usage limit.
      console.log('# PowerShell — sets the gateway for BOTH the CLI and the VS Code extension (D-6).');
      console.log('# Remove with: cla-gw clear-env  (then restart the shell / VS Code)');
      console.log(`$env:CLAUDE_CODE_USE_GATEWAY = "1"`);
      console.log(`$env:ANTHROPIC_BASE_URL      = "http://${cfg.host}:${cfg.port}"`);
      console.log(`$env:ANTHROPIC_CUSTOM_HEADERS = "${(cfg.secretHeader || 'x-gw-secret')}: ${cfg.secret}"`);
      console.log(`Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue   # must stay unset`);
      return;
    }

    case 'clear-env': {
      console.log('# PowerShell');
      console.log('Remove-Item Env:CLAUDE_CODE_USE_GATEWAY,Env:ANTHROPIC_BASE_URL,Env:ANTHROPIC_CUSTOM_HEADERS,Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue');
      return;
    }

    default:
      console.log('usage: cla-gw start | stop | status | health | check [labels] | doctor | activate [--legacy|--no-startup] | deactivate | reset-state | notify | ls | add <label> [--paste|--auto] | forget <label> --yes |');
      console.log('       use <label>|none | enable <label> | disable <label> | email <label> <addr> | check [labels] | env | clear-env | statusline');
  }
}

main().catch((e) => { console.error('cla-gw error:', e.message); process.exit(1); });
