// SSE pass-through test without spending any quota.
//
// The smoke test could only prove status/body pass-through, because this account's weekly limit is
// exhausted and every real inference call 429s. Streaming is the part most likely to break in a
// proxy (buffering, content-encoding, content-length), so we point `upstream` at a local fake that
// emits SSE slowly, and assert the chunks reach the client incrementally and intact.
//
// Relies on config hot-reload: the gateway re-reads config.json per request, so no restart needed.

import http from 'node:http';
import { loadConfig, saveConfig } from './config.mjs';

const cfg = loadConfig();
const orig = cfg.upstream;
let fail = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `  - ${d}` : ''}`); if (!c) fail++; };

const fake = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const frames = ['event: message_start', 'event: content_block_delta\ndata: {"a":1}', 'event: message_delta', 'event: message_stop'];
  frames.forEach((f, i) => setTimeout(() => res.write(f + '\n\n'), 120 * (i + 1)));
  setTimeout(() => res.end(), 700);
});
await new Promise((r) => fake.listen(8791, '127.0.0.1', r));

cfg.upstream = 'http://127.0.0.1:8791';
saveConfig(cfg);

const t0 = Date.now();
const r = await fetch(`http://${cfg.host}:${cfg.port}/v1/messages?beta=true`, {
  method: 'POST',
  headers: { authorization: `Bearer ${cfg.secret}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'x', messages: [] }),
});

ok('streams as SSE', (r.headers.get('content-type') || '').includes('text/event-stream'), r.headers.get('content-type'));
ok('no content-length on a stream', !r.headers.get('content-length'), `cl=${r.headers.get('content-length')}`);
ok('no content-encoding leak', !r.headers.get('content-encoding'));

const marks = [];
for await (const chunk of r.body) marks.push(Date.now() - t0);

ok('multiple chunks arrived separately (not buffered)', marks.length >= 3, `chunks=${marks.length}`);
ok('chunks arrived over time, not all at once', marks.length >= 2 && marks[marks.length - 1] - marks[0] > 200,
   `first=${marks[0]}ms last=${marks[marks.length - 1]}ms`);
ok('headers did not arrive only after the body', marks[0] < 400, `first=${marks[0]}ms`);

cfg.upstream = orig;
saveConfig(cfg);
ok('upstream restored', loadConfig().upstream === 'https://api.anthropic.com', loadConfig().upstream);

fake.close();
console.log(fail ? `\n${fail} check(s) failed` : '\nstreaming path verified');
process.exit(fail ? 1 : 0);
