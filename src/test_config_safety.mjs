// config.json is written while the gateway is serving. That is what `cla-gw switch` / `cla-gw use` do —
// and now also what /switch inside a live chat does — so two things must hold, and neither is obvious:
//
//   * a reader must never see a half-written file (saveConfig writes a temp file and renames);
//   * if config.json is unreadable for any other reason, the gateway keeps serving on the last config
//     that parsed instead of failing every request at once — and with no cached config it says so loudly
//     rather than inventing an empty pool.
//
// Run as a child process per case, with CLAUDE_GW_DATA_DIR pointed at a scratch dir, so the module-level
// config cache of the real gateway (and of this test file's own import) is never entangled.
//
//   node src/test_config_safety.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('.probe', 'cfg_safety');
let fail = 0;
const ok = (name, cond, got = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  - ${got}`}`);
  if (!cond) fail++;
};
// stdout AND stderr are both evidence here: the point of one case is that the failure is *reported*.
const run = (script, env = {}) => {
  const p = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, CLAUDE_GW_DATA_DIR: DIR, ...env }, encoding: 'utf8',
  });
  return (p.stdout || '') + (p.stderr || '');
};
const jsonLine = (s) => JSON.parse(s.split('\n').filter((l) => l.startsWith('{')).pop());

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

// 1. Atomic save: no temp file left behind, and the file that remains parses with the accounts intact.
let out = run(`
  import { saveConfig, loadConfig, CONFIG_PATH } from './src/config.mjs';
  import fs from 'node:fs';
  saveConfig({ accounts: [{ label: 'B', kind: 'oauth' }, { label: 'D', kind: 'oauth' }] });
  const left = fs.readdirSync(process.env.CLAUDE_GW_DATA_DIR).filter((f) => f.endsWith('.tmp'));
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  console.log(JSON.stringify({ left, labels: cfg.accounts.map((a) => a.label) }));
`);
let r1 = jsonLine(out);
ok('saveConfig leaves no .tmp file behind', r1.left.length === 0, JSON.stringify(r1.left));
ok('the saved file parses with both accounts', r1.labels.join(',') === 'B,D', JSON.stringify(r1.labels));

// 2. A corrupt config.json after a good load: keep serving on the last good config, and say so.
out = run(`
  import { saveConfig, loadConfig } from './src/config.mjs';
  import fs from 'node:fs';
  saveConfig({ accounts: [{ label: 'B', kind: 'oauth' }, { label: 'D', kind: 'oauth' }] });
  loadConfig();                                     // fills the cache with a good config
  fs.writeFileSync(process.env.CLAUDE_GW_DATA_DIR + '/config.json', '{"accounts": [{"lab');
  const cfg = loadConfig();
  console.log(JSON.stringify({ labels: cfg.accounts.map((a) => a.label) }));
`, {});
const errRan = run(`
  import { saveConfig, loadConfig } from './src/config.mjs';
  import fs from 'node:fs';
  saveConfig({ accounts: [{ label: 'B', kind: 'oauth' }] });
  fs.writeFileSync(process.env.CLAUDE_GW_DATA_DIR + '/config.json', 'not json at all');
  try { loadConfig(); } catch (e) { console.log('threw:' + e.message); }
`);
const r2 = jsonLine(out);
ok('a corrupt config.json does not take the pool down mid-request', r2.labels.join(',') === 'B,D', JSON.stringify(r2));
ok('and it is reported, not swallowed silently', /config.json unreadable/.test(out), out.slice(0, 120));
ok('a corrupt file with nothing cached fails loudly rather than serving an empty pool',
  /threw:/.test(errRan), errRan.trim().slice(0, 120));

// 3. Hot reload must see an edit that keeps the size and lands in the same file-time tick (a pin B -> C right
//    after another save). Windows file times tick about every 16 ms; an mtime-keyed cache missed this.
//    Fifty back-to-back rounds: with a coarse clock some of them land in one tick, so the old cache missed
//    some nearly every run (measured 10-29); the content-keyed cache must miss none.
out = run(`
  import { saveConfig, loadConfig, CONFIG_PATH } from './src/config.mjs';
  import fs from 'node:fs';
  let missed = 0;
  for (let i = 0; i < 50; i++) {
    saveConfig({ active: 'B', accounts: [{ label: 'B', kind: 'oauth' }, { label: 'C', kind: 'oauth' }] });
    loadConfig();
    fs.writeFileSync(CONFIG_PATH, fs.readFileSync(CONFIG_PATH, 'utf8').replace('"active": "B"', '"active": "C"'));
    if (loadConfig().active !== 'C') missed++;
  }
  console.log(JSON.stringify({ missed }));
`);
const r3 = jsonLine(out);
ok('50 quick same-size edits (pin B -> C) are all picked up', r3.missed === 0, JSON.stringify(r3));

console.log(fail ? `\n${fail} FAILED` : '\nconfig writes are safe under live traffic');
process.exit(fail ? 1 : 0);
