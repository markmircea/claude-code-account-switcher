// When something else holds the gateway's port, `cla-gw status` and `cla-gw start` must say so. Before 10-31 any
// reply was taken for the gateway's own status: a 401 page printed "RUNNING (uptime NaNs)", then crashed with
// "Cannot read properties of undefined (reading 'join')". Uses a scratch CLAUDE_GW_DATA_DIR (.probe/porttest) and
// fake servers on a free port, so the running gateway and your config are never touched.
//
//   node src/test_port_conflict.mjs

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const DIR = path.resolve('.probe', 'porttest');
let fail = 0;
const ok = (name, cond, got = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  - ${String(got).split('\n')[0]}`}`);
  if (!cond) fail++;
};
// Asynchronous on purpose: the fake servers live in this process, and a blocking spawnSync would freeze them, so
// the CLI's request would time out and look like "nothing on the port".
const cli = (...args) => new Promise((resolve) => {
  execFile(process.execPath, ['src/cli.mjs', ...args], {
    env: { ...process.env, CLAUDE_GW_DATA_DIR: DIR }, encoding: 'utf8', timeout: 30000,
  }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}` }));
});
const serve = (status, body) => new Promise((resolve) => {
  const s = http.createServer((req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); });
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const close = (s) => new Promise((resolve) => s.close(resolve));

fs.rmSync(DIR, { recursive: true, force: true });
await cli('ls');   // writes a default config.json into the scratch folder
const cfgPath = path.join(DIR, 'config.json');

// 1. Another program answers on the port with an error page.
const other = await serve(401, { error: 'unauthorized' });
const port = other.address().port;
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.port = port;
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

let r = await cli('status');
ok('status does not take another program\'s 401 for the gateway', !/RUNNING on/.test(r.out), r.out);
ok('status does not crash', !/cla-gw error|Cannot read properties/.test(r.out), r.out);
ok('status says the gateway is not running and something else holds the port',
  /NOT RUNNING/.test(r.out) && /something else answers/.test(r.out) && r.out.includes(`:${port}`), r.out);
r = await cli('start');
ok('start refuses, explains, and exits 1 instead of starting a gateway that cannot bind',
  r.code === 1 && /not started: something else answers/.test(r.out), `${r.code} ${r.out}`);
ok('start wrote no pid file', !fs.existsSync(path.join(DIR, 'gateway.pid')));
await close(other);

// 2. A real gateway's reply still reads as running (the normal path is unchanged).
const gw = await serve(200, { uptimeMs: 5000, active: 'A', pool: ['A'], disabled: [], stats: { requests: 3, errors: 0, byAccount: { A: 3 } } });
cfg.port = gw.address().port;
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
r = await cli('status');
ok('a gateway reply still shows RUNNING with its uptime', /RUNNING on .* \(uptime 5s\)/.test(r.out), r.out);
await close(gw);

// 3. Nothing on the port: plain NOT RUNNING, no talk of another program.
r = await cli('status');
ok('nothing on the port: plain NOT RUNNING', /gateway: NOT RUNNING/.test(r.out) && !/something else/.test(r.out), r.out);

fs.rmSync(DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
