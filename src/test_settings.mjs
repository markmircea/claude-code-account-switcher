// What activate/deactivate do to ~/.claude/settings.json. Besides the three env keys, activate adds the
// terminal status line - the only place a terminal chat shows which account is serving it - and two rules
// keep that from hurting anyone:
//
//   * a status line of the user's own is never replaced, and deactivate never removes it;
//   * ours, left behind by another copy (a moved checkout, the old linked install), is repointed at this one.
//
// Run as a child process per case, with CLAUDE_CONFIG_DIR and CLAUDE_GW_DATA_DIR pointed at scratch dirs, so
// the real settings.json is never read or written.
//
//   node src/test_settings.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('.probe', 'settings');
const CLAUDE = path.join(DIR, 'claude');
const SETTINGS = path.join(CLAUDE, 'settings.json');
let fail = 0;
const ok = (name, cond, got = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  - ${got}`}`);
  if (!cond) fail++;
};
const run = (script) => {
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE, CLAUDE_GW_DATA_DIR: path.join(DIR, 'data') }, encoding: 'utf8',
  });
  if (p.status !== 0) throw new Error(p.stderr || p.stdout);
  return JSON.parse((p.stdout || '').split('\n').filter((l) => l.startsWith('{')).pop());
};
const CFG = `{ host: '127.0.0.1', port: 8790, secret: 'abc123' }`;
const apply = (opts = '{}') => run(`
  import { applySettingsEnv } from './src/activate.mjs';
  console.log(JSON.stringify(applySettingsEnv(${CFG}, false, ${opts})));
`);
const remove = () => run(`
  import { removeSettingsEnv } from './src/activate.mjs';
  console.log(JSON.stringify(removeSettingsEnv()));
`);
const ours = run(`
  import { statusLineWanted } from './src/activate.mjs';
  console.log(JSON.stringify(statusLineWanted()));
`);
const fresh = (doc) => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(CLAUDE, { recursive: true });
  if (doc) fs.writeFileSync(SETTINGS, JSON.stringify(doc, null, 2));
};
const read = () => JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));

ok('our status line runs this copy of statusline.mjs',
  ours.type === 'command' && ours.command.endsWith(`${path.resolve('src', 'statusline.mjs').replace(/\\/g, '/')}"`), ours.command);

// 1. No status line yet: activate adds ours next to the env keys, and keeps everything else in the file.
fresh({ theme: 'dark' });
let r = apply();
let doc = read();
ok('an empty slot gets our status line', r.changed.includes('statusLine') && doc.statusLine?.command === ours.command, JSON.stringify(doc.statusLine));
ok('the env keys still go in', doc.env?.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8790', JSON.stringify(doc.env));
ok('other settings are kept', doc.theme === 'dark', JSON.stringify(doc));

// 2. Run again: nothing to change, so the file is not rewritten (live sessions watch it).
const before = fs.statSync(SETTINGS).mtimeMs;
r = apply();
ok('a second activate changes nothing', r.changed.length === 0 && r.statusLine === 'current', JSON.stringify(r));
ok('and does not rewrite the file', fs.statSync(SETTINGS).mtimeMs === before);

// 3. No settings.json at all (a fresh machine): it is created with both.
fresh(null);
r = apply();
ok('a missing settings.json is created with the status line', read().statusLine?.command === ours.command, JSON.stringify(r));

// 4. The user's own status line is kept, by activate and by deactivate.
const theirs = { type: 'command', command: 'bash ~/.claude/my-status.sh', padding: 0 };
fresh({ statusLine: theirs });
r = apply();
ok('activate keeps a status line of the user\'s own', JSON.stringify(read().statusLine) === JSON.stringify(theirs) && r.statusLine === 'theirs', JSON.stringify(read().statusLine));
r = remove();
ok('deactivate keeps it too', JSON.stringify(read().statusLine) === JSON.stringify(theirs) && !r.removed.includes('statusLine'), JSON.stringify(r));
ok('while still removing the env keys', !('ANTHROPIC_BASE_URL' in (read().env || {})), JSON.stringify(read().env));

// 5. Ours from another copy (moved checkout, old linked install, Windows path) is repointed here.
for (const old of ['node "/home/u/old/claude-gw/src/statusline.mjs"', 'node "C:/Users/u/claude-gw/src/statusline.mjs"']) {
  fresh({ statusLine: { type: 'command', command: old } });
  r = apply();
  ok(`a stale gateway status line is repointed (${old.slice(6, 14)}...)`, read().statusLine?.command === ours.command && r.changed.includes('statusLine'), JSON.stringify(read().statusLine));
}

// 6. --no-statusline: the env keys only.
fresh({});
r = apply('{ statusLine: false }');
ok('--no-statusline leaves the slot empty', !read().statusLine && r.statusLine === 'none', JSON.stringify(read()));

// 7. deactivate removes ours along with the env keys, and leaves the rest.
fresh({ theme: 'dark' });
apply();
r = remove();
doc = read();
ok('deactivate removes our status line', !doc.statusLine && r.removed.includes('statusLine'), JSON.stringify(doc));
ok('and the env keys', r.removed.includes('ANTHROPIC_BASE_URL') && !('ANTHROPIC_CUSTOM_HEADERS' in (doc.env || {})), JSON.stringify(r));
ok('and keeps the rest', doc.theme === 'dark', JSON.stringify(doc));

// 8. A settings.json that does not parse is refused, not overwritten.
fresh(null);
fs.writeFileSync(SETTINGS, '{"theme": "dark",');
let threw = '';
try { apply(); } catch (e) { threw = e.message; }
ok('a broken settings.json is refused', /not valid JSON/.test(threw), threw.slice(0, 120));
ok('and left as it was', fs.readFileSync(SETTINGS, 'utf8') === '{"theme": "dark",');

fs.rmSync(DIR, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED` : '\nsettings.json: env keys and status line behave');
process.exit(fail ? 1 : 0);
