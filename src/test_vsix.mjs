// The VS Code status bar's .vsix is built in Node (src/vsix.mjs; it replaced vscode/pack.py so npm installs need no
// Python). `code --install-extension` is unforgiving, so the layout and bytes are pinned here.
// Built into a scratch folder (.probe/vsixtest), never into vscode/; `code` itself is never run (--print only).
//
//   node src/test_vsix.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildVsix, readZipEntries } from './vsix.mjs';

const DIR = path.resolve('.probe', 'vsixtest');
let fail = 0;
const ok = (name, cond, got = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  - ${String(got).split('\n')[0]}`}`);
  if (!cond) fail++;
};

const srcBytes = (name) => fs.readFileSync(path.join('vscode', name));
const pkg = JSON.parse(srcBytes('package.json').toString('utf8'));

fs.rmSync(DIR, { recursive: true, force: true });
const file = buildVsix(DIR);
const buf = fs.readFileSync(file);
const entries = readZipEntries(buf);
const named = Object.fromEntries(entries.map((e) => [e.name, e.data]));

// 1. The file is named the way `code` expects and it is really on disk.
ok(`buildVsix wrote ${pkg.name}-${pkg.version}.vsix`,
  file.endsWith(`${pkg.name}-${pkg.version}.vsix`) && fs.existsSync(file), file);

// 2. Exactly the four entries, in the order VS Code reads them.
const want = ['extension.vsixmanifest', '[Content_Types].xml', 'extension/package.json', 'extension/extension.js'];
ok('the zip holds exactly the four entries, in that order',
  entries.length === want.length && want.every((n, i) => entries[i].name === n),
  entries.map((e) => e.name).join(' | '));

// 3. The extension's own files are byte-identical to the sources - not re-serialized, not re-encoded.
ok('extension/package.json is byte-identical to vscode/package.json',
  named['extension/package.json'] && named['extension/package.json'].equals(srcBytes('package.json')));
ok('extension/extension.js is byte-identical to vscode/extension.js',
  named['extension/extension.js'] && named['extension/extension.js'].equals(srcBytes('extension.js')));

// 4. The manifest carries the identity VS Code installs by and the engine range it refuses to load without.
const manifest = (named['extension.vsixmanifest'] || Buffer.alloc(0)).toString('utf8');
ok('the manifest has Id, Version, Publisher and the engine range',
  manifest.includes('Id="claude-gw-status"') && manifest.includes(`Version="${pkg.version}"`)
  && manifest.includes('Publisher="local"') && manifest.includes(`Value="${pkg.engines.vscode}"`),
  manifest.split('\n')[3]);

// 5. [Content_Types].xml must declare every extension we put in the zip.
const ctypes = (named['[Content_Types].xml'] || Buffer.alloc(0)).toString('utf8');
ok('[Content_Types].xml covers .json, .js and .vsixmanifest',
  ctypes.includes('Extension=".json"') && ctypes.includes('Extension=".js"')
  && ctypes.includes('Extension=".vsixmanifest"'), ctypes.split('\n')[1]);

// 6. Truncated/corrupted data must be caught by the CRC check, not handed back silently.
const bad = Buffer.from(buf);
const dataStart = 30 + bad.readUInt16LE(26) + bad.readUInt16LE(28);
bad[dataStart + 2] ^= 0xff;
let threw = '';
try { readZipEntries(bad); } catch (e) { threw = e.message; }
ok('a flipped byte inside the first entry throws', threw !== '', threw);

// 7. The CLI reaches the build in one command, and --print hands over the install line without touching VS Code.
const pr = spawnSync(process.execPath, ['src/cli.mjs', 'install-extension', '--print'], { encoding: 'utf8' });
const lines = (pr.stdout || '').split(/\r?\n/).filter((l) => l !== '');
ok('cla-gw install-extension --print exits 0', pr.status === 0, pr.stderr);
ok('its first line is a .vsix that exists',
  lines.length >= 2 && lines[0].endsWith('.vsix') && fs.existsSync(lines[0]), lines[0]);
ok('its second line is the code command', (lines[1] || '').startsWith('code --install-extension'), lines[1]);

fs.rmSync(DIR, { recursive: true, force: true });

console.log(fail ? `\n${fail} FAILED` : '\nthe .vsix has the right layout and bytes, and installs in one command');
process.exit(fail ? 1 : 0);
