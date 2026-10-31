#!/usr/bin/env node
// cla-gw control CLI. This is the authoritative surface; the later dashboard is a skin over it.
//
//   cla-gw start | stop | status | ls | switch [label|next|off] | use <label>|none | enable <label> | disable <label> | env
//
// Naming (PLAN.md phase 5): start|stop act on the gateway itself;
// enable|disable act on an account's rotation membership. Never overloaded.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { ensureConfig, loadConfig, saveConfig, pool, availability, poolReopening, HOME, PID_PATH, CONFIG_PATH, LOG_PATH, STATUS_PATH, ACCOUNT_STATE_PATH, readAccountState } from './config.mjs';
import { resolveBearer, describeIdentity } from './creds.mjs';
import { addAccount } from './add.mjs';
import { vaultLs, vaultRm } from './vault.mjs';
import { activate, deactivate, doctor, runWithoutGateway, serviceInstalled, systemctl, UNIT_NAME } from './activate.mjs';
import { preflightAccount } from './preflight.mjs';
import { auditRouting } from './audit_routing.mjs';
import { buildVsix } from './vsix.mjs';
import { priceFor, familyOf, PRICES, PRICES_AS_OF, ratesInPlay, WEB_SEARCH_USD_PER_REQUEST, classifyCostRows } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // not URL.pathname: a space would arrive as %20
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

// { status, st }: st is set only when THIS gateway answered. null = nothing answers on the port at all.
async function statusReply(cfg) {
  try {
    const r = await fetch(`http://${cfg.host}:${cfg.port}/__gw/status`, {
      headers: { authorization: `Bearer ${cfg.secret}` },
      signal: AbortSignal.timeout(4000),
    });
    let body = null;
    try { body = await r.json(); } catch { }
    return { status: r.status, st: r.ok && Array.isArray(body?.pool) ? body : null };
  } catch (e) { return null; }
}

async function getStatus(cfg) {
  return (await statusReply(cfg))?.st || null;
}

// Something holds the port but is not this gateway: another program, or a claude-gw started with a different
// config.json (its secret no longer matches). Seen 10-31: a 401 page was taken for our status and crashed `status`.
async function foreignPortHolder(cfg) {
  const r = await statusReply(cfg);
  if (!r || r.st) return null;
  return `something else answers on ${cfg.host}:${cfg.port} (HTTP ${r.status}): another program, or a claude-gw ` +
    `started with a different config.json. Stop it, or change "port" in ${CONFIG_PATH} and run cla-gw activate again.`;
}

async function main() {
  const { cfg, created } = ensureConfig();
  if (created) console.log(`created config: ${CONFIG_PATH}`);

  switch (cmd) {
    case 'start': {
      const foreign = await foreignPortHolder(cfg);
      if (foreign) { console.log(`not started: ${foreign}`); process.exitCode = 1; return; }
      if (serviceInstalled()) {
        // Linux with the systemd unit: systemd owns the process, and restarts it if it crashes.
        if (await getStatus(cfg) && !systemctl('is-active', UNIT_NAME).ok) {
          console.log('a gateway started outside systemd is already answering; leaving it. Hand it over with: cla-gw stop && cla-gw start');
          return;
        }
        const s = systemctl('start', UNIT_NAME);
        await new Promise((r) => setTimeout(r, 1200));
        const st = await getStatus(cfg);
        if (!s.ok) console.log(`systemctl --user start ${UNIT_NAME} failed: ${s.out}`);
        else console.log(st ? `running (systemd ${UNIT_NAME}); pool: ${st.pool.join(', ')}` : `systemd started ${UNIT_NAME} but nothing answers - journalctl --user -u ${UNIT_NAME}`);
        console.log(`log: ${LOG_PATH}`);
        return;
      }
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
      if (serviceInstalled() && systemctl('is-active', UNIT_NAME).ok) {
        const s = systemctl('stop', UNIT_NAME);
        console.log(s.ok ? `stopped (systemd ${UNIT_NAME}; it starts again at next login - cla-gw deactivate removes it)` : `systemctl --user stop failed: ${s.out}`);
        return;
      }
      if (!fs.existsSync(PID_PATH)) { console.log('not running (no pid file)'); return; }
      const pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
      try { process.kill(pid); console.log(`stopped pid ${pid}`); }
      catch (e) { console.log(`could not signal pid ${pid}: ${e.code}`); }
      try { fs.unlinkSync(PID_PATH); } catch {}
      return;
    }

    case 'status': {
      const st = await getStatus(cfg);
      if (!st) { const foreign = await foreignPortHolder(cfg); console.log(foreign ? `gateway: NOT RUNNING - but ${foreign}` : 'gateway: NOT RUNNING'); console.log(`config pool: ${pool(cfg).map((a) => a.label).join(', ') || '(empty)'}`); console.log(`config upstream: ${cfg.upstream}${/127\.0\.0\.1|localhost/.test(cfg.upstream) ? '   <-- LOOPBACK: tests only; real traffic would 502. Fix: node src/reset_upstream.mjs' : ''}`); return; }
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

    case 'cost': {
      // What the routed traffic would have cost on a metered API key. Only useful if the rates are right,
      // so the table actually used is printed with it, along with where to correct it.
      const di = argv.indexOf('--days');
      const days = di > 0 && argv[di + 1] ? Number(argv[di + 1]) : 7;
      const since = Date.now() - days * 86400_000;
            let rows = [];
      try {
        rows = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean)
          .map((s) => { try { return JSON.parse(s); } catch { return null; } })
          .filter((l) => l && l.ts >= since);
      } catch { console.log(`no log yet at ${LOG_PATH}`); return; }
      // Coverage rules live in config.mjs so `cla-gw cost`, the hover and the tests agree. A served
      // response either carried a usage object, or carries a usageMiss marker, or predates capture — and
      // the third case must be named, not folded into the denominator or dropped.
      const cls = classifyCostRows(rows);
      const { costable, missed, partial, unpriced, blind } = cls;
      rows = cls.priced;
      if (!costable.length) {
        console.log(`no token usage recorded in the last ${days} day(s).`);
        console.log('usage is captured from responses the gateway serves, so this needs traffic AND a');
        console.log('gateway running the version that records it (the log line carries a "usage" object).');
        return;
      }
      const byModel = new Map(), byAccount = new Map(), byDay = new Map();
      for (const l of rows) {
        const m = l.priceModel || l.model || 'unknown';
        const t = byModel.get(m) || { in: 0, out: 0, cw: 0, cr: 0, search: 0, usd: 0, n: 0 };
        t.in += l.usage.in || 0; t.out += l.usage.out || 0;
        t.cw += l.usage.cw || 0; t.cr += l.usage.cr || 0;
        t.search += l.usage.search || 0;
        t.usd += l.costUsd || 0; t.n++;
        byModel.set(m, t);
        const a = byAccount.get(l.account || '?') || { usd: 0, n: 0 };
        a.usd += l.costUsd || 0; a.n++;
        byAccount.set(l.account || '?', a);
        const d = new Date(l.ts).toISOString().slice(0, 10);
        byDay.set(d, (byDay.get(d) || 0) + (l.costUsd || 0));
      }
      const money = (v) => `$${v.toFixed(v < 1 ? 4 : 2)}`;
      const tok = (v) => v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v);
      const total = [...byModel.values()].reduce((a, t) => a + t.usd, 0);
      // A stream that carried the input side but whose final output count never arrived makes the total a
      // floor. Say that instead of presenting a guess as a figure.
      const floor = cls.floor ? '>=' : '';
      console.log(`API-equivalent cost for the last ${days} day(s): ${rows.length} priced responses`
        + (partial.length ? `, ${partial.length} partial (total is a FLOOR)` : '') + '\n');
      console.log('  model                     reqs    input   output   cache-w   cache-r  search  list price');
      for (const [m, t] of [...byModel.entries()].sort((a, b) => b[1].usd - a[1].usd)) {
        console.log(`  ${m.padEnd(25)} ${String(t.n).padStart(5)} ${tok(t.in).padStart(8)} ${tok(t.out).padStart(8)} ${tok(t.cw).padStart(9)} ${tok(t.cr).padStart(9)} ${String(t.search).padStart(7)} ${(floor + money(t.usd)).padStart(12)}`);
      }
      console.log(`\n  total at list: ${floor}${money(total)}`);
      console.log(`  (cache reads are included on purpose - they are why a long agent session would look`);
      console.log(`   ruinous on a metered key and are exactly what the subscription is buying)`);
      console.log(`\n  by day:     ${[...byDay.entries()].sort().map(([d, v]) => `${d.slice(5)} ${money(v)}`).join('  ')}`);
      console.log(`  by account: ${[...byAccount.entries()].sort((a, b) => b[1].usd - a[1].usd).map(([a, v]) => `${a} ${money(v.usd)}/${v.n}req`).join('  ')}`);
      // Coverage belongs next to the total. 0 of 2,002 responses once priced while 38 checks were green:
      // how much traffic was NOT priced is part of what the number means.
      console.log(`\n  coverage:   ${rows.length} priced of ${costable.length} costable responses`
        + ` (${missed.length} served with no usage object${partial.length ? `, ${partial.length} partial` : ''})`);
      if (blind.length) {
        console.log(`  blind spot: ${blind.length} served response(s) in this window predate token capture`
          + ` (capture began ${cls.captureFrom ? new Date(cls.captureFrom).toLocaleString() : 'unknown'})`);
        console.log(`              they are counted nowhere, so the total is what capture SAW, not what the`
          + ` window spent. Not\n              reconstructable: those responses were never recorded.`);
      }
      if (unpriced.size) {
        console.log(`  UNPRICED:   ${[...unpriced.entries()].map(([m, n]) => `${m} x${n}`).join(', ')}`);
        console.log(`              no row in the price table, so their tokens are counted but not priced:`);
        console.log(`              "prices": {"<model id>": {"in": 0, "out": 0, "w5": 0, "w1h": 0, "cr": 0}}`);
      }
      const rates = ratesInPlay(cfg, [...byModel.keys()]);
      console.log(`\n  rates used (USD per Mtok, table as of ${PRICES_AS_OF}):`);
      for (const r of rates) {
        console.log(`    ${r.model.padEnd(22)} in ${r.in} / out ${r.out} / 5m write ${r.w5} / 1h write ${r.w1h} / cache hit ${r.cr}`);
      }
      console.log(`    web search is billed separately at $${WEB_SEARCH_USD_PER_REQUEST * 1000} per 1,000 searches, and is in the total when usage reports it.`);
      console.log(`  Stale or wrong? Correct them in ${CONFIG_PATH}`);
      console.log(`  e.g. "prices": {"claude-opus-5-5": {"in": 4, "out": 20}} or per family: {"opus": {"in": 4}}.`);
      console.log('  `cla-gw prices` prints the whole table.');
      return;
    }

    case 'prices': {
      // The table behind every cost number, with its date. Rates move; an undated table is a slow lie.
      console.log(`Claude API list prices, USD per million tokens - copied ${PRICES_AS_OF}`);
      console.log('source: platform.claude.com/docs/en/about-claude/pricing (check it; rates change)\n');
      console.log('  model                 input  output  5m write  1h write  cache hit');
      for (const [m, p] of Object.entries(PRICES)) {
        const q = priceFor(m, cfg);
        const over = q.in !== p.in || q.out !== p.out || q.w5 !== p.w5 || q.w1h !== p.w1h || q.cr !== p.cr;
        console.log(`  ${m.padEnd(21)} ${String(q.in).padStart(5)} ${String(q.out).padStart(7)} ${String(q.w5).padStart(9)} ${String(q.w1h).padStart(9)} ${String(q.cr).padStart(10)}${over ? '   <- overridden in config.json' : ''}`);
      }
      console.log('\n  fast mode (usage.speed == "fast") bills a different list where published: opus-5-5 8/40, opus-5 and 4.8 10/50.');
      console.log('  inference_geo "us" is 1.1x on every category, and it stacks with fast mode.');
      console.log('  Haiku 5.5 pays the higher row for the WHOLE request once prompt + cache tokens pass 100k.');
      console.log('  Cache: 5m write 1.25x base input, 1h write 2x, hit 0.1x - except 0.05x on opus-5-5/sonnet-5-5.');
      console.log(`\n  Override in ${CONFIG_PATH} -> "prices": {"<model id>": {...}} or {"<family>": {...}}.`);
      console.log('  A model with no row is reported UNPRICED by `cla-gw cost`; it is never priced by guess.');
      return;
    }


    case 'audit': {
      // "Is the account switcher still doing what the rules say?" - answered against real traffic, not
      // fixtures. Run it after any change to routing, and before trusting a quiet week.
      if (argv[1] !== 'routing') { console.log('usage: cla-gw audit routing [--hours N]'); return; }
      const hi = argv.indexOf('--hours');
      const hours = hi > 0 ? (Number(argv[hi + 1]) || 24) : 24;
      const a = auditRouting({ hours });
      if (a.error) { console.log(a.error); return; }
      console.log(`routing audit: ${a.audited} routed requests over the last ${hours} h`
        + ` (${a.skipped} synthetic/test requests skipped, ${a.partialPicture} written before the quota snapshot was logged)`);
      console.log('  why each request went where it did:');
      for (const [k, v] of Object.entries(a.counts).sort((x, y) => y[1] - x[1])) console.log(`    ${k.padEnd(38)} ${v}`);
      console.log(`\n  permanent switches: ${a.switches}   detours: ${a.detours}`);
      if (a.problems.length) {
        console.log(`\n  PROBLEMS (${a.problems.length}):`);
        for (const p of a.problems.slice(0, 20)) console.log(`    - ${p}`);
        process.exitCode = 1;
      } else {
        console.log('\n  no rule violations: never a blocked account while one was free, stickiness held,');
        console.log('  detours did not move the sticky account, and no shim ever lengthened a wait.');
      }
      return;
    }

    case 'add': {
      const label = argv[1];
      if (!label) { console.log('usage: cla-gw add <label> [--paste | --auto]'); return; }
      process.exitCode = await addAccount(label, { paste: argv.includes('--paste'), auto: argv.includes('--auto') });
      return;
    }

    case 'install-slash': {
      // /switch typed inside Claude Code. Any ~/.claude/commands/<name>.md becomes /<name>, and a
      // !`...` line in that file is executed by the harness BEFORE the model reads the prompt - so the
      // account change itself is deterministic shell, and the model is only asked to read the result.
      // disable-model-invocation in the file means the model cannot decide to switch accounts by itself.
      const name = argv[1] || 'switch';
      if (!/^[a-z][a-z-]*$/.test(name)) { console.log('command names are lowercase letters and dashes'); return; }
      const file = path.join(HERE, '..', 'commands', `${name}.md`);
      if (!fs.existsSync(file)) { console.log(`no such command file: ${file}`); return; }
      const dir = path.join(HOME, '.claude', 'commands');
      fs.mkdirSync(dir, { recursive: true });
      const dst = path.join(dir, `${name}.md`);
      const body = fs.readFileSync(file, 'utf8');
      if (fs.existsSync(dst) && fs.readFileSync(dst, 'utf8') === body) {
        console.log(`already installed and identical: ${dst}`);
        return;
      }
      if (fs.existsSync(dst)) {
        console.log(`${dst} exists and differs from ${file}.`);
        console.log('Not overwritten - it may be yours. Diff them, then delete it and re-run if you want ours.');
        return;
      }
      fs.copyFileSync(file, dst);
      console.log(`installed /${name} -> ${dst}`);
      console.log('A session that is already running may need restarting to list it.');
      console.log('The first use asks to allow Bash(cla-gw switch:*): a prefix allow for one command, and the');
      console.log('only thing reachable through it writes config.json (the pin). It cannot enable, disable or');
      console.log('forget an account.');
      return;
    }

    case 'install-extension': {
      // The status bar extension, built and installed from here: an npm install has no Python and the
      // vscode/ folder is buried in node_modules, so the .vsix has to be one command away.
      const file = buildVsix(path.join(os.tmpdir(), 'claude-gw-vsix'));
      if (argv.includes('--print')) {
        console.log(file);
        console.log(`code --install-extension "${file}" --force`);
        return;
      }
      // Windows needs the whole command as one quoted string (and shell: true) or "code" is not found.
      const res = process.platform === 'win32'
        ? spawnSync(`code --install-extension "${file}" --force`, { stdio: 'inherit', shell: true })
        : spawnSync('code', ['--install-extension', file, '--force'], { stdio: 'inherit' });
      if (res.error || res.status !== 0) {
        console.log('VS Code\'s "code" command was not found or failed. Install the file by hand:');
        console.log(`  code --install-extension "${file}" --force`);
        process.exitCode = 1;
        return;
      }
      console.log(`installed the claude-gw status bar (${path.basename(file)}). Reload VS Code windows to show it.`);
      return;
    }

    case 'statusline': {
      const self = path.join(HERE, 'statusline.mjs').replace(/\\/g, '/');
      console.log('# Add to ~/.claude/settings.json (top-level key). I have not edited that file for you.');
      console.log('# Shows which gateway account is serving THIS conversation (F22/D-7).');
      console.log(JSON.stringify({ statusLine: { type: 'command', command: `node "${self}"` } }, null, 2));
      return;
    }

    case 'switch': {
      // Manual account choice, one hand. Wraps the `use` pin with the state you need to choose well.
      //   cla-gw switch          where are we, what is available, what to type next
      //   cla-gw switch C        pin to C (any label, case-insensitive)
      //   cla-gw switch 2        pin the second account in the list - the number is the one the listing shows
      //   cla-gw switch next     move to the next account that is actually open
      //   cla-gw switch off      stop pinning; the rules decide again
      // No restart: config.json is re-read per request. Applies to the NEXT request of every chat, and an
      // in-flight reply finishes on the account it started on.
      const json = argv.includes('--json');
      // Flags and the label argument are separated so `switch --json` still counts as "no target given".
      const arg = (argv.slice(1).filter((x) => !x.startsWith('--'))[0] || '').toLowerCase();
      const st = readAccountState();
      const now = Date.now();
      // Which account served last = the one the rules consider in use (stickiness), independent of the pin.
      let maxActive = 0;
      for (const a of cfg.accounts) maxActive = Math.max(maxActive, st[a.label]?.activeAt || 0);
      const pct = (v) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '?');
      const win = (status, reset, used, now) => {
        // A `rejected` whose reset epoch has already passed is not a known block - it is a claim from an
        // older request that time has since overtaken. Only the next request can prove it is open again,
        // so it must not print as plain 'allowed' next to 100% used.
        if (status === 'rejected' && reset && reset * 1000 > now) return `USED until ${new Date(reset * 1000).toLocaleTimeString()}`;
        if (status === 'rejected') return `${pct(used)} used, clock says refilled (unverified)`;
        if (status === 'allowed') return `${pct(used)} allowed`;
        return 'unknown';
      };
      // Deliberately over cfg.accounts, not pool(): a DISABLED account must still be listed, or switching
      // to it reads as "no such account" instead of "it is disabled, here is how to bring it back".
      const rows = cfg.accounts.map((a) => {
        const s = st[a.label] || {};
        const av = availability(s, now);
        return { label: a.label, enabled: a.enabled !== false, pinned: cfg.active === a.label,
                 serving: !!s.activeAt && s.activeAt === maxActive, blocked: av.blocked, readyAt: av.readyAt,
                 windows: `5h ${win(s.s5h, s.r5h, s.u5h, now)}   7d ${win(s.s7d, s.r7d, s.u7d, now)}`,
                 last: s.lastStatus ? `last response ${s.lastStatus} at ${new Date(s.lastSeen).toLocaleTimeString()}` : 'never served through the gateway' };
      });
      const serving = rows.find((r) => r.serving);

      if (!arg) {
        // Machine-readable for the VS Code status bar or any script, so nothing has to parse prose.
        if (json) {
          console.log(JSON.stringify({ serving: serving?.label ?? null, pin: cfg.active ?? null,
            accounts: rows.map((r) => ({ label: r.label, enabled: r.enabled, serving: r.serving,
              pinned: r.pinned, blocked: r.blocked.map((b) => ({ win: b.win, readyAt: b.readyAt })),
              u5h: st[r.label]?.u5h ?? null, u7d: st[r.label]?.u7d ?? null,
              lastStatus: st[r.label]?.lastStatus ?? null })) }));
          return;
        }
        console.log(`serving now: ${serving ? serving.label : '(nothing has served yet)'}   pin: ${cfg.active ?? '(none - automatic)'}\n`);
        for (const [i, r] of rows.entries()) {
          console.log(`  ${i + 1}${r.pinned ? '▶' : ' '} ${r.label}  ${r.serving ? 'serving  ' : '         '}` +
            `${r.enabled ? '' : 'DISABLED  '}${r.windows}` +
            (r.blocked.length
              ? `   BLOCKED: ${r.blocked.map((b) => b.win).join('+')} until ${new Date(r.readyAt).toLocaleString()}`
              : '   not blocked') +
            `   [${r.last}]`);
        }
        console.log('\n  cla-gw switch <label|number>   pin one (applies on the next request, no restart)');
        console.log('  cla-gw switch next           the next account that is open right now');
        console.log('  cla-gw switch off            back to automatic (stays on one account until a window fills)');
        console.log('\n  a live reply is not moved - it finishes on the account it started on, and the first');
        console.log('  request on a new account rebuilds the prompt cache (slower, and those tokens are paid)');
        return;
      }
      if (/^(off|auto|none)$/.test(arg)) {
        cfg.active = null; saveConfig(cfg);
        console.log('pin cleared: automatic routing again (one account stays in use until a window is full).');
        return;
      }
      let target = rows.find((r) => r.label.toLowerCase() === arg);
      if (!target && /^[0-9]+$/.test(arg)) target = rows[Number(arg) - 1];
      if (!target && /^[0-9]+$/.test(arg)) {
        console.log(`there are only ${rows.length} accounts, so ${arg} is not one of them.`); return;
      }
      if (arg === 'next') {
        // Prefer an account that is genuinely open, and among those the one with the most headroom left.
        const open = rows.filter((r) => r.enabled && !r.blocked.length && r.label !== serving?.label)
          .sort((x, y) => Math.max(st[x.label]?.u5h ?? 0, st[x.label]?.u7d ?? 0)
                          - Math.max(st[y.label]?.u5h ?? 0, st[y.label]?.u7d ?? 0));
        if (!open.length) {
          const next = poolReopening(cfg, st, now);
          console.log('every other account is limited right now, so switching would park you on a wall.'
            + (next ? ` The pool reopens with ${next.label} at ${new Date(next.readyAt).toLocaleString()}.` : ''));
          return;
        }
        target = open[0];
      }
      if (!target) { console.log(`no such account "${argv[1]}". Labels: ${rows.map((r) => r.label).join(', ')}`); return; }
      if (!target.enabled) {
        console.log(`${target.label} is disabled (cla-gw enable ${target.label} to bring it back). Not pinned.`);
        return;
      }
      cfg.active = target.label; saveConfig(cfg);
      console.log(`pinned to ${target.label} - applies on the next request of every chat (hot reload, no restart).`);
      console.log(`  evidence for ${target.label}: ${target.last}`);
      if (target.blocked.length) {
        console.log(`WARNING: ${target.label} is limited now (${target.blocked.map((b) => b.win).join('+')}) ` +
          `and does not reopen until ${new Date(target.readyAt).toLocaleString()}. A pin is honoured, so chats ` +
          'will be refused with that time instead of moved to an account that is open. `cla-gw switch off` undoes it.');
      }
      if (serving && serving.label !== target.label) {
        console.log(`was ${serving.label}: that chat's prompt cache is rebuilt on ${target.label}'s first request.`);
      }
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
      if (process.platform !== 'win32') {
        console.log('# bash/zsh - Claude Code itself reads the env block in ~/.claude/settings.json; this is for one shell.');
        console.log('# Remove with: eval "$(cla-gw clear-env)"');
        console.log('export CLAUDE_CODE_USE_GATEWAY=1');
        console.log(`export ANTHROPIC_BASE_URL="http://${cfg.host}:${cfg.port}"`);
        console.log(`export ANTHROPIC_CUSTOM_HEADERS="${(cfg.secretHeader || 'x-gw-secret')}: ${cfg.secret}"`);
        console.log('unset ANTHROPIC_AUTH_TOKEN   # must stay unset');
        return;
      }
      console.log('# PowerShell — sets the gateway for BOTH the CLI and the VS Code extension (D-6).');
      console.log('# Remove with: cla-gw clear-env  (then restart the shell / VS Code)');
      console.log(`$env:CLAUDE_CODE_USE_GATEWAY = "1"`);
      console.log(`$env:ANTHROPIC_BASE_URL      = "http://${cfg.host}:${cfg.port}"`);
      console.log(`$env:ANTHROPIC_CUSTOM_HEADERS = "${(cfg.secretHeader || 'x-gw-secret')}: ${cfg.secret}"`);
      console.log(`Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue   # must stay unset`);
      return;
    }

    case 'clear-env': {
      if (process.platform !== 'win32') {
        console.log('unset CLAUDE_CODE_USE_GATEWAY ANTHROPIC_BASE_URL ANTHROPIC_CUSTOM_HEADERS ANTHROPIC_AUTH_TOKEN');
        return;
      }
      console.log('# PowerShell');
      console.log('Remove-Item Env:CLAUDE_CODE_USE_GATEWAY,Env:ANTHROPIC_BASE_URL,Env:ANTHROPIC_CUSTOM_HEADERS,Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue');
      return;
    }

    default:
      console.log('usage: cla-gw start | stop | status | health | check [labels] | doctor | activate [--legacy|--no-startup] | deactivate | reset-state | notify | ls | add <label> [--paste|--auto] | forget <label> --yes |');
      console.log('       switch [label|number|next|off]  (manual account choice: no args = the pool + what to type); install-slash [name]  (put /switch into Claude Code); install-extension [--print]  (the VS Code status bar)');
      console.log('       use <label>|none | enable <label> | disable <label> | email <label> <addr> | check [labels] | cost [--days N] | prices | env | clear-env | statusline');
  }
}

main().catch((e) => { console.error('cla-gw error:', e.message); process.exit(1); });
