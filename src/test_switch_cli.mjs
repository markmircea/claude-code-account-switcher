// `cla-gw switch` / /switch — manual account choice must reach EVERY account, and must refuse to park you
// on a wall without saying so. Tested against fixture files in a scratch CLAUDE_GW_DATA_DIR (.probe/switchtest),
// so the running gateway's pin is never touched.
//
//   node src/test_switch_cli.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('.probe', 'switchtest');
let fail = 0;
const ok = (name, cond, got = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  - ${String(got).split('\n')[0]}`}`);
  if (!cond) fail++;
};
const cli = (args) => spawnSync(process.execPath, ['src/cli.mjs', 'switch', ...args], {
  env: { ...process.env, CLAUDE_GW_DATA_DIR: DIR }, encoding: 'utf8',
}).stdout || '';
const pinned = () => JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).active;

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
  active: null,
  accounts: [{ label: 'B', kind: 'oauth' }, { label: 'C', kind: 'oauth' }, { label: 'D', kind: 'oauth', enabled: false }],
}));
const nowSec = Math.floor(Date.now() / 1000);
fs.writeFileSync(path.join(DIR, 'accounts_state.json'), JSON.stringify({
  B: { u5h: 1, s5h: 'rejected', r5h: nowSec - 60, u7d: 0.4, s7d: 'allowed', activeAt: Date.now() - 9000, lastStatus: 429, lastSeen: Date.now() },
  C: { u5h: 0.2, s5h: 'allowed', r5h: nowSec + 3600, u7d: 0.1, s7d: 'allowed', activeAt: Date.now(), lastStatus: 200, lastSeen: Date.now() },
  D: { u5h: 0.0, s5h: 'allowed', u7d: 0.0, s7d: 'allowed', lastStatus: 200, lastSeen: Date.now() },
}));

// 1. Every ENABLED account is reachable, by label and by the number the listing shows.
const listing = cli([]);
ok('the listing numbers the rows so a number can be typed', /1\s.*B/.test(listing) && /2\s.*C/.test(listing), listing);
ok('a disabled account is still listed, marked DISABLED, and not silently hidden', /DISABLED/.test(listing), listing);
for (const [arg, label] of [['b', 'B'], ['B', 'B'], ['c', 'C'], ['1', 'B'], ['2', 'C']]) {
  cli([arg]);
  ok(`switch ${arg} pins ${label}`, pinned() === label, `${pinned()}`);
  cli(['off']);
}
ok('off returns to automatic', pinned() === null, String(pinned()));

// 2. A disabled account is refused with the way back, not "no such account".
const dis = cli(['d']);
ok('switching to a disabled account says it is disabled and how to enable it',
  /is disabled/.test(dis) && /cla-gw enable D/.test(dis), dis);
ok('and it does not pin it', pinned() === null, String(pinned()));

// 3. A number past the end is a plain refusal.
// Three accounts are configured (one disabled) and all three are listed, so the refusal counts 3.
ok('an out-of-range number refuses rather than wrapping', /only 3 accounts/.test(cli(['9'])), cli(['9']));

// 4. `next` must not pick the account already serving, and never picks a limited one without saying so.
const nxt = cli(['next']);
ok('next moves off the serving account', pinned() && pinned() !== 'C', String(pinned()));
ok('next says which account and that it applies on the next request', /pinned to B/.test(nxt), nxt);
cli(['off']);

// 5. Pinning into a currently-limited account is allowed but must warn with the reopen time.
fs.writeFileSync(path.join(DIR, 'accounts_state.json'), JSON.stringify({
  B: { u5h: 1, s5h: 'rejected', r5h: nowSec + 7200, u7d: 0.4, s7d: 'allowed', activeAt: Date.now(), lastStatus: 429, lastSeen: Date.now() },
  C: { u5h: 0.2, s5h: 'allowed', activeAt: Date.now() - 5000, lastStatus: 200, lastSeen: Date.now() },
}));
const wall = cli(['b']);
ok('pinning into a limited account warns, with the reopen time', /WARNING/.test(wall) && /does not reopen until/.test(wall), wall);
ok('and it says how to undo it', /switch off/.test(wall), wall);
cli(['off']);

console.log(fail ? `\n${fail} FAILED` : '\nswitch reaches every account, and says what a choice costs');
process.exit(fail ? 1 : 0);
