// The npm package must carry everything `cla-gw` needs at run time, and nothing private. Packs the real tarball,
// installs it into a scratch prefix and runs the installed `cla-gw` from there, so a file missing from
// package.json's "files" fails here instead of on a user's machine. Never touches the global install, the live
// data folder or the running gateway.
//
//   node src/test_package.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('.probe', 'packagetest');
// A space on purpose: Windows installs global packages under the user's profile, and "C:\Users\John Smith" broke
// cli.mjs once (it took its folder from the URL path, so the space arrived as %20).
const PREFIX = path.join(DIR, 'npm prefix');
const NPM_FLAGS = `--cache "${path.join(DIR, 'cache')}" --no-audit --no-fund --loglevel=error`;
let fail = 0;
const ok = (name, cond, got = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  - ${String(got).split('\n')[0]}`}`);
  if (!cond) fail++;
};
// One command string through the shell on every platform: npm is npm.cmd on Windows, which Node refuses to spawn
// without a shell, and every path is quoted so a repo folder with spaces still works.
const sh = (cmd) => spawnSync(cmd, {
  shell: true, encoding: 'utf8', env: { ...process.env, CLAUDE_GW_DATA_DIR: path.join(DIR, 'data') },
});

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

// 1. What goes into the tarball.
const packed = sh(`npm pack --json --pack-destination "${DIR}" ${NPM_FLAGS}`);
let info = null;
try { info = JSON.parse(packed.stdout)[0]; } catch { }
ok('npm pack succeeds', packed.status === 0 && info, packed.stderr || packed.stdout);
if (!info) process.exit(1);
const files = info.files.map((f) => f.path.replace(/\\/g, '/'));
for (const need of ['package.json', 'README.md', 'LICENSE', 'src/cli.mjs', 'src/gw.mjs', 'src/statusline.mjs',
  'src/vault.mjs', 'src/activate.mjs', 'src/vsix.mjs', 'commands/switch.md', 'vscode/extension.js', 'vscode/package.json']) {
  ok(`the package carries ${need}`, files.includes(need), files.join(' '));
}
for (const [what, bad] of [['the private notes (HANDOFF.md, COSTING-PLAN.md)', /^(HANDOFF|COSTING-PLAN)\.md$/],
  ['the README images (docs/)', /^docs\//], ['built .vsix files', /\.vsix$/], ['scratch folders (.probe/)', /^\.probe\//],
  ['the test suites (src/test_*.mjs)', /^src\/test_/]]) {
  ok(`the package leaves out ${what}`, !files.some((f) => bad.test(f)), files.filter((f) => bad.test(f)).join(' '));
}
ok('package.json is publishable (not "private")', !pkg.private);
ok('the bin points at a file in the package', files.includes(pkg.bin['cla-gw']), pkg.bin['cla-gw']);

// 2. Every relative import of every packed module resolves inside the package.
const missing = [];
for (const f of files.filter((x) => x.endsWith('.mjs'))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
    if (!files.includes(target)) missing.push(`${f} -> ${m[1]}`);
  }
}
ok('every relative import in the package resolves to a packed file', missing.length === 0, missing.join(', '));

// 3. Install the tarball like a user would, then run the installed command.
const tgz = path.join(DIR, info.filename);
const inst = sh(`npm install -g --prefix "${PREFIX}" "${tgz}" ${NPM_FLAGS}`);
ok('npm install -g of the tarball succeeds', inst.status === 0, inst.stderr || inst.stdout);
const bin = process.platform === 'win32' ? path.join(PREFIX, 'cla-gw.cmd') : path.join(PREFIX, 'bin', 'cla-gw');
ok('the install puts a cla-gw command on the prefix', fs.existsSync(bin), bin);
const root = process.platform === 'win32' ? path.join(PREFIX, 'node_modules', pkg.name)
  : path.join(PREFIX, 'lib', 'node_modules', pkg.name);
ok('the package lands as a real copy, not a link back to this checkout', fs.existsSync(root) && !fs.lstatSync(root).isSymbolicLink(), root);

// npm ships files byte for byte. A checkout made with core.autocrlf=true has CRLF, and "#!/usr/bin/env node\r"
// makes the installed cla-gw fail on Linux with "env: 'node\r': No such file or directory".
const shebang = fs.existsSync(root) ? fs.readFileSync(path.join(root, 'src', 'cli.mjs'), 'utf8').split('\n')[0] : '';
ok('the installed cli.mjs starts with a clean "#!/usr/bin/env node" line', shebang === '#!/usr/bin/env node', JSON.stringify(shebang));
const withCr = files.filter((f) => /\.(mjs|js|json|md)$/.test(f) && fs.existsSync(path.join(root, f))
  && fs.readFileSync(path.join(root, f)).includes(13));
ok('no installed text file has CRLF line endings', withCr.length === 0, withCr.join(' '));

const sl = sh(`"${bin}" statusline`);
const want = path.join(root, 'src', 'statusline.mjs').replace(/\\/g, '/');
ok('the installed cla-gw runs and points the status line at its own copy', sl.status === 0 && sl.stdout.includes(want), sl.stderr || sl.stdout);

const ext = sh(`"${bin}" install-extension --print`);
const vsix = (ext.stdout || '').split(/\r?\n/)[0].trim();
ok('the installed cla-gw builds the VS Code extension from the packed files', ext.status === 0 && vsix.endsWith('.vsix') && fs.existsSync(vsix), ext.stderr || ext.stdout);

fs.rmSync(DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
