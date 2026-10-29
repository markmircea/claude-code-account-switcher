// Token capture and pricing for the cost feature.
//
// WHY THIS FILE EXISTS. The cost feature shipped green — 38 checks in test_quota_surface passed — while
// having priced **0 of 2,002** successful responses. Cause: scanUsage matched /"usage"\s*:\s*\{[^{}]*\}/,
// which cannot match a usage object containing a nested object, and every usage object the API sends now
// contains several (cache_creation, server_tool_use, output_tokens_details, iterations). The test passed
// because its fixture was a hand-written FLAT usage object — the one shape the broken regex could read.
//
// So: the fixtures in src/fixtures/usage_frames.jsonl are copied VERBATIM out of captured traffic
// (.probe/panel_run*.jsonl, the extension panel probe). Do not hand-write a fixture here. If you change
// scanUsage, it has to parse what was really sent.
//
//   node src/test_costing.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newUsage, scanUsage, usageCost, priceFor, ratesInPlay, PRICES_AS_OF, classifyCostRows } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let fail = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `  - ${d}` : ''}`); if (!c) fail++; };

const FIXTURES = fs.readFileSync(path.join(HERE, 'fixtures', 'usage_frames.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log(`${FIXTURES.length} captured usage objects from real traffic\n`);

const scan = (text) => scanUsage(newUsage(), text);

// --- 1. the fields the API actually sends ---
const a = scan(FIXTURES[0].text);   // message_start side, 1-hour cache write
ok('nested usage parses (input / output / cache read)',
  a.in === 2 && a.out === 8 && a.cr === 15787, JSON.stringify({ in: a.in, out: a.out, cr: a.cr }));
ok('cache write total parses', a.cw === 12019, `cw=${a.cw}`);
ok('cache write TTL split parses (5m vs 1h price differently: 1.25x vs 2x)',
  a.w1h === 12019 && a.w5 === 0, JSON.stringify({ w5: a.w5, w1h: a.w1h }));
ok('pricing multipliers are readable (speed, inference_geo)',
  a.speed === 'standard' && a.geo === 'global', JSON.stringify({ speed: a.speed, geo: a.geo }));

const b = scan(FIXTURES[1].text);   // final delta: thinking + server tools + nested iterations array
ok('the final message_delta output count wins (cumulative, must never be summed)',
  b.out === 10, `out=${b.out}`);
ok('server-side tool counts parse (billed per search, not per token)',
  b.search === 0 && b.fetch === 0, JSON.stringify({ search: b.search, fetch: b.fetch }));
ok('thinking tokens parse', b.think === 0, `think=${b.think}`);
ok('a nested `iterations` array does not leak its tokens into the totals',
  b.in === 2 && b.out === 10 && b.cw === 12019, JSON.stringify({ in: b.in, out: b.out, cw: b.cw }));

// --- 2. the regression itself, pinned ---
const oldRegex = (text) => { let hits = 0; for (const m of String(text).matchAll(/"usage"\s*:\s*\{[^{}]*\}/g)) hits++; return hits; };
ok('the old flat regex still finds NOTHING in real traffic (this is the bug, kept visible)',
  FIXTURES.every((f) => oldRegex(f.text) === 0), FIXTURES.map((f) => oldRegex(f.text)).join(','));
ok('the new scanner counts exactly one usage object per fixture',
  FIXTURES.map((f) => scan(f.text).objects).join(',') === '1,1,1,1',
  FIXTURES.map((f) => scan(f.text).objects).join(','));

// --- 3. frames arrive in pieces ---
const feed = (text, size) => { const acc = newUsage(); for (let i = 0; i < text.length; i += size) scanUsage(acc, text.slice(i, i + size)); return acc; };
for (const size of [7, 37, 200]) {
  const s = feed(FIXTURES[1].text, size);
  ok(`a frame cut into ${size}-char chunks still parses`, s.in === 2 && s.out === 10 && s.cw === 12019 && s.cr === 15787,
    JSON.stringify({ in: s.in, out: s.out, cw: s.cw, cr: s.cr }));
}
ok('a half-received frame is carried, not dropped, and the carry is not logged',
  (() => { const acc = newUsage(); scanUsage(acc, FIXTURES[1].text.slice(0, 60)); if (!acc.carry) return false;
    scanUsage(acc, FIXTURES[1].text.slice(60)); return acc.out === 10 && !('carry' in JSON.parse(JSON.stringify(acc))); })());
ok('a never-closing usage object cannot grow the carry without bound',
  (() => { const acc = newUsage(); for (let i = 0; i < 400; i++) scanUsage(acc, '"usage":{"x":"' + 'y'.repeat(1000));
    return acc.carry.length <= 128 * 1024; })(), `carry=${(scanUsage(newUsage(), 'x').carry || '').length}`);

// --- 4. braces that live inside strings ---
ok('braces inside a string do not derail the parse (a tool_result full of code)',
  (() => { const t = '{"content":"if (x) { return }{","is_error":false}]},"usage":{"input_tokens":11,"output_tokens":3}';
    const u = scan(t); return u.in === 11 && u.out === 3; })());

// --- 5. zero usage is zero, not a priced response ---
const z = scan(FIXTURES[2].text);
ok('an all-zero usage frame leaves the totals at zero (the caller must not count it as priced)',
  z.in === 0 && z.out === 0 && z.cw === 0 && z.cr === 0 && !((z.in || z.out || z.cw || z.cr) > 0),
  JSON.stringify(z));

// --- 6. the log record must not carry scanner internals ---
ok('usage object serializes cleanly into the log (no carry/objects keys)',
  (() => { const keys = Object.keys(JSON.parse(JSON.stringify(scan(FIXTURES[0].text))));
    return !keys.includes('carry') && !keys.includes('objects'); })());

// ---------------------------------------------------------------------------
// Pricing: per exact model id, dated, and never guessed.
// The old table was three families with opus at Opus 4.1 rates (15/75/18.75/1.5) while this pool runs
// claude-opus-5-5 (4/20/5/8 + 0.20 hits). Against the captured frame above that is not a rounding
// error - it is ~2.5x the money. These numbers come from platform.claude.com pricing, 2026-10-23.
const USD = (u, m, cfg) => usageCost(u, m, cfg).usd;
const money = (v) => Math.round(v * 1e7) / 1e7;
const realUsage = { in: a.in, out: a.out, cw: a.cw, cr: a.cr, w5: a.w5, w1h: a.w1h, search: a.search };

ok('exact-model rates are the ones actually published for the model in use',
  (() => { const p = priceFor('claude-opus-5-5', {});
    return p.exact === true && p.in === 4 && p.out === 20 && p.w5 === 5 && p.w1h === 8 && p.cr === 0.2; })(),
  JSON.stringify(priceFor('claude-opus-5-5', {})));
ok('the captured frame priced at opus-5-5 rates',
  Math.abs(USD(realUsage, 'claude-opus-5-5', {}) - 0.0994774) < 1e-9, `${USD(realUsage, 'claude-opus-5-5', {})}`);
ok('the old family table would have overstated that same response by >2x (kept visible)',
  (() => { const old = (2 * 15 + 8 * 75 + 12019 * 18.75 + 15787 * 1.5) / 1e6;
    return old / USD(realUsage, 'claude-opus-5-5', {}) > 2; })(),
  `old $${((2 * 15 + 8 * 75 + 12019 * 18.75 + 15787 * 1.5) / 1e6).toFixed(4)} vs new $${USD(realUsage, 'claude-opus-5-5', {}).toFixed(4)}`);
ok('a date-suffixed model id maps to its row (claude-opus-4-5-20251101)',
  (() => { const p = priceFor('claude-opus-4-5-20251101', {});
    return p.model === 'claude-opus-4-5' && p.in === 5 && p.cr === 0.5; })());

// An unknown model must produce NO number. A guess is how a $0.04 request gets reported as $0.15.
for (const m of ['x', '', null, 'claude-something-new']) {
  const c = usageCost({ in: 1000, out: 100 }, m, {});
  ok(`unknown model "${m}" is unpriced, not guessed`,
    c.usd === null && c.exact === false && !!c.unpriced, JSON.stringify({ usd: c.usd, unpriced: c.unpriced }));
}

// Cache writes: 5m is 1.25x base input, 1h is 2x. The TTL split is in the response and has to be used.
const w5only = { in: 0, out: 0, cw: 1000, cr: 0, w5: 1000, w1h: 0 };
const w1only = { in: 0, out: 0, cw: 1000, cr: 0, w5: 0, w1h: 1000 };
ok('a 1-hour cache write costs 1.6x a 5-minute one on opus-5-5 (8 vs 5 per Mtok)',
  USD(w1only, 'claude-opus-5-5', {}) / USD(w5only, 'claude-opus-5-5', {}) === 1.6,
  `${USD(w5only, 'claude-opus-5-5', {})} -> ${USD(w1only, 'claude-opus-5-5', {})}`);
const noSplit = usageCost({ in: 0, out: 0, cw: 1000, cr: 0 }, 'claude-opus-5-5', {});
ok('when the response gives no TTL split, the 5m price is used and the assumption is named',
  Math.abs(noSplit.usd - 0.005) < 1e-12 && noSplit.applied.some((s) => s.includes('5m')), JSON.stringify(noSplit.applied));

// Charges that are not tokens at all.
const searched = usageCost({ in: 1e6, out: 0, cw: 0, cr: 0, search: 3 }, 'claude-opus-5-5', {});
ok('web search bills per search ($10/1,000) on top of tokens',
  Math.abs(searched.toolUsd - 0.03) < 1e-12 && Math.abs(searched.usd - 4.03) < 1e-12, JSON.stringify({ tokens: searched.tokenUsd, tool: searched.toolUsd }));

// Multipliers the response itself declares.
const fast = usageCost({ in: 1000, out: 1000, cw: 0, cr: 0, speed: 'fast' }, 'claude-opus-5-5', {});
const std = usageCost({ in: 1000, out: 1000, cw: 0, cr: 0, speed: 'standard' }, 'claude-opus-5-5', {});
ok('fast mode prices at the fast list (opus-5-5 8/40, i.e. 2x)', Math.abs(fast.usd / std.usd - 2) < 1e-9,
  `${std.usd} -> ${fast.usd}`);
const us = usageCost({ in: 1000, out: 1000, cw: 0, cr: 0, geo: 'us' }, 'claude-opus-5-5', {});
ok('inference_geo "us" is 1.1x', Math.abs(us.usd / std.usd - 1.1) < 1e-9, `${std.usd} -> ${us.usd}`);
ok('fast mode and data residency stack',
  Math.abs(usageCost({ in: 1000, out: 1000, speed: 'fast', geo: 'us' }, 'claude-opus-5-5', {}).usd / std.usd - 2.2) < 1e-9);
const bigPrompt = { in: 60000, out: 10, cw: 50000, cr: 0, w5: 50000, w1h: 0 };
ok('haiku-5-5 pays the long-context row for the WHOLE request past 100k prompt tokens',
  usageCost(bigPrompt, 'claude-haiku-5-5', {}).applied.some((s) => s.includes('long-context')));

// config.json overrides still win, per model and per family.
ok('config prices override per exact model', USD({ in: 1e6, out: 0 }, 'claude-opus-5-5', { prices: { 'claude-opus-5-5': { in: 1 } } }) === 1);
ok('config prices override per family', USD({ in: 1e6, out: 0 }, 'claude-opus-5-5', { prices: { opus: { in: 2 } } }) === 2);
ok('config can supply rates for a model the table does not know',
  USD({ in: 1e6, out: 1e6 }, 'claude-brand-new', { prices: { 'claude-brand-new': { in: 7, out: 35, cr: 0.7 } } }) === 42);
ok('a half-filled override is reported incomplete rather than priced with a default for output',
  (() => { const c = usageCost({ in: 1e6, out: 1e6 }, 'claude-brand-new', { prices: { 'claude-brand-new': { in: 7 } } });
    return c.usd === null && c.incomplete === true; })());

// The rates behind a total have to be nameable, or the total cannot be checked.
ok('ratesInPlay names only the models actually seen',
  ratesInPlay({}, ['claude-opus-5-5', 'claude-haiku-4-5']).map((r) => r.model).join(',') === 'claude-opus-5-5,claude-haiku-4-5',
  ratesInPlay({}, ['claude-opus-5-5', 'claude-haiku-4-5']).map((r) => r.model).join(','));
ok('the table carries its date, because rates move', /^\d{4}-\d{2}-\d{2}$/.test(PRICES_AS_OF), PRICES_AS_OF);

// classifyCostRows is the honesty layer of `cla-gw cost` / the hover: it decides what a total means.
// The rule that matters: a served response with neither `usage` nor `usageMiss` was written before
// capture existed. Counting it in the denominator turns a ten-day capture failure into a healthy-looking
// 15%; dropping it makes the day look complete. So it is counted apart, and the total becomes `>=`.
const T = 1_800_000_000_000;
const lrows = [
  { path: '/v1/messages', status: 200, ts: T - 3000 },                                     // pre-capture
  { path: '/v1/messages', status: 200, ts: T - 2000, usage: newUsage(), costUsd: 1.0 },     // priced
  { path: '/v1/messages', status: 200, ts: T - 1000, usageMiss: 'no-usage-object' },        // seen, missed
  { path: '/v1/messages', status: 200, ts: T, usage: newUsage(), usagePartial: 1, costUsd: 0.5 },
  { path: '/v1/messages', status: 429, ts: T },                                            // refused: bills nothing
  { path: '/v1/messages/count_tokens', status: 200, ts: T, usage: newUsage() },            // free: never costable
  { path: '/v1/messages', status: 200, ts: T, usage: newUsage(), unpriced: 'claude-opus-6-0' },
];
const cls = classifyCostRows(lrows);
ok('pre-capture records are a named blind spot, not coverage', cls.blind.length === 1, `blind=${cls.blind.length}`);
ok('a refused response is not billable traffic', cls.served.length === 5 && !cls.served.some((l) => l.status === 429),
  `served=${cls.served.length}`);
ok('count_tokens is never costable', !cls.costable.some((l) => l.path.includes('count_tokens')), `costable=${cls.costable.length}`);
ok('a served response that produced no usage still counts in coverage',
  cls.costable.length === 4 && cls.missed.length === 1, `costable=${cls.costable.length} missed=${cls.missed.length}`);
ok('captureFrom gives the date capture begins from, not a count of lost history',
  cls.captureFrom === T - 2000, String(cls.captureFrom));
ok('partial or unpriced or blind => the printed total must carry a floor marker', cls.floor === true);
ok('a fully covered window prints without the marker', classifyCostRows([lrows[1]]).floor === false);
ok('unpriced models are listed by model with a count', cls.unpriced.get('claude-opus-6-0') === 1,
  JSON.stringify([...cls.unpriced]));

console.log(fail ? `\n${fail} FAILED` : '\ntoken capture verified against captured traffic');
process.exit(fail ? 1 : 0);
