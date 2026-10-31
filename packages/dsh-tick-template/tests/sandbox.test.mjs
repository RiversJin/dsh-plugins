import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox, dryRun, parseNotification, durationMinutes, formatDate, StateStore, emptyState } from '../lib/index.js';

const limits = { timeoutMs: 50, maxRenderChars: 500, maxFileChars: 40, maxSourceChars: 120, maxTemplateChars: 400, maxFunctions: 5 };
const root = mkdtempSync(join(tmpdir(), 'tick-'));
mkdirSync(join(root, 'ops'));
writeFileSync(join(root, 'ops', 'protocol.md'), '1-2 安静、3 翻档案、4 探索、5 写点什么、6 自由格');
writeFileSync(join(root, 'ops', 'long.md'), 'x'.repeat(100));
const NOW = Date.parse('2026-10-19T11:08:12+08:00');

/** Fixed random sequence so dice are predictable. */
const seeded = (...values) => { let i = 0; return () => values[i++ % values.length]; };

test('builtins render inside {{ }} and literal braces escape', () => {
  const sandbox = new Sandbox(limits, [root], 'Asia/Singapore', seeded(0.99, 0.0, 0.5));
  const text = sandbox.render({ template: '骰子：{{d(6)}} / {{dice(2, 6)}} / {{pick("a","b","c")}} \\{{raw}} {{weekday()}} {{date("HH:mm")}}', functions: {} }, {}, NOW);
  assert.equal(text, '骰子：6 / 5 / c {{raw}} 周一 11:08');
});

test('env facts are exposed as globals and via env', () => {
  const sandbox = new Sandbox(limits, [], 'Asia/Singapore');
  const env = parseNotification('[Time passing]\nCurrent time: 2026-10-19 11:08:12 (Asia/Singapore)\nTime spent quiet: 1h 0s\nTime since the previous time notification: 15h 46m 41s\nTime since 阿林\'s last message: 1h 23s');
  assert.deepEqual(env, { clock: '2026-10-19 11:08:12 (Asia/Singapore)', quietMinutes: 60, sincePreviousMinutes: 946, sinceHumanMinutes: 60 });
  assert.equal(durationMinutes('2d 3s'), 2880);
  assert.equal(durationMinutes('nothing'), undefined);
  const text = sandbox.render({ template: '{{quietMinutes}}|{{env.sinceHumanMinutes >= 60 ? "久" : "刚"}}|{{typeof sincePreviousMinutes}}', functions: {} }, env, NOW);
  assert.equal(text, '60|久|number');
  assert.equal(sandbox.render({ template: '[{{quietMinutes}}]', functions: {} }, {}, NOW), '[]');
});

test('file() reads only under the roots and truncates', () => {
  const sandbox = new Sandbox(limits, [root], 'Asia/Singapore');
  assert.equal(sandbox.render({ template: '{{file("ops/protocol.md")}}', functions: {} }, {}, NOW), '1-2 安静、3 翻档案、4 探索、5 写点什么、6 自由格');
  assert.match(sandbox.render({ template: '{{file("ops/long.md")}}', functions: {} }, {}, NOW), /^x{40}\n…\(truncated at 40 chars\)$/);
  assert.throws(() => sandbox.render({ template: '{{file("../etc/passwd")}}', functions: {} }, {}, NOW), /outside the allowed roots/);
  assert.throws(() => sandbox.render({ template: '{{file("/etc/passwd")}}', functions: {} }, {}, NOW), /outside the allowed roots/);
  assert.equal(sandbox.render({ template: '{{file("ops/missing.md", "无")}}', functions: {} }, {}, NOW), '无');
  assert.throws(() => sandbox.render({ template: '{{file("ops/missing.md")}}', functions: {} }, {}, NOW), /cannot read/);
  assert.throws(() => new Sandbox(limits, [], 'Asia/Singapore').render({ template: '{{file("x")}}', functions: {} }, {}, NOW), /disabled/);
});

test('user functions compose with builtins and each other', () => {
  const sandbox = new Sandbox(limits, [], 'Asia/Singapore', seeded(0.5));
  const program = { template: '今天{{mood()}}，格子 {{slot(d(6))}}', functions: {
    mood: { source: '() => pick("静", "闹", "懒")', definedAt: 0 },
    slot: { source: 'n => n <= 2 ? "安静" : n === 6 ? "自由格" : "行动"', definedAt: 0 },
  } };
  assert.equal(sandbox.render(program, {}, NOW), '今天闹，格子 行动');
  const verdict = dryRun(sandbox, program, 10, NOW);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.trials, 10);
  assert.deepEqual(verdict.samples, [{ env: 'full', text: '今天闹，格子 行动' }]);
});

test('dry run rejects loops, throws, non-functions, oversize and builtin shadowing', () => {
  const sandbox = new Sandbox(limits, [], 'Asia/Singapore');
  const reject = (functions, template = '{{1}}') => dryRun(sandbox, { template, functions }, 5, NOW);
  let v = reject({ spin: { source: '() => { while (true) {} }', definedAt: 0 } });
  assert.equal(v.ok, false); assert.match(v.error, /spin\(\).*timed out/s);
  v = reject({ boom: { source: '() => { throw new Error("nope") }', definedAt: 0 } });
  assert.equal(v.ok, false); assert.match(v.error, /boom\(\): nope/);
  v = reject({ notfn: { source: '42', definedAt: 0 } });
  assert.equal(v.ok, false); assert.match(v.error, /must evaluate to a function/);
  v = reject({ dice: { source: '() => 1', definedAt: 0 } });
  assert.equal(v.ok, false); assert.match(v.error, /builtin/);
  v = reject({ big: { source: '() => "y".repeat(10000)', definedAt: 0 } });
  assert.equal(v.ok, false); assert.match(v.error, /returned 10000 chars/);
  v = reject({ 'bad name': { source: '() => 1', definedAt: 0 } });
  assert.equal(v.ok, false); assert.match(v.error, /must match/);
  v = reject({ multi: { source: '() =>\n 1', definedAt: 0 } });
  assert.equal(v.ok, false); assert.match(v.error, /one line only/);
  v = reject({}, '{{"z".repeat(600)}}');
  assert.equal(v.ok, false); assert.match(v.error, /rendered 600 chars/);
  v = reject({}, '{{nosuch()}}');
  assert.equal(v.ok, false); assert.match(v.error, /\{\{nosuch\(\)\}\}: nosuch is not defined/);
  v = reject({}, '{{d(6)');
  assert.equal(v.ok, true, 'an unclosed marker is literal text');
  v = reject({}, '{{while(true){}}}');
  assert.equal(v.ok, false); assert.match(v.error, /Unexpected token|timed out/);
  // Six functions exceed maxFunctions 5.
  v = reject(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, { source: '() => 1', definedAt: 0 }])));
  assert.equal(v.ok, false); assert.match(v.error, /limit 5/);
});

test('functions with arguments are compiled but not probed; sparse env must not break them', () => {
  const sandbox = new Sandbox(limits, [], 'Asia/Singapore');
  const ok = dryRun(sandbox, { template: '{{greet("阿林")}}', functions: { greet: { source: 'who => `${who}，${quietMinutes ?? "?"} 分钟没说话`', definedAt: 0 } } }, 6, NOW);
  assert.equal(ok.ok, true);
  assert.ok(ok.samples.some(sample => sample.env === 'empty' && sample.text === '阿林，? 分钟没说话'), JSON.stringify(ok.samples));
  assert.ok(ok.samples.some(sample => sample.env === 'full' && sample.text === '阿林，60 分钟没说话'), JSON.stringify(ok.samples));
  const bad = dryRun(sandbox, { template: '{{late()}}', functions: { late: { source: '() => quietMinutes.toFixed(0)', definedAt: 0 } } }, 6, NOW);
  assert.equal(bad.ok, false, 'undefined quietMinutes in the sparse probe must surface');
});

test('formatDate honours the zone', () => {
  assert.equal(formatDate(NOW, 'Asia/Singapore', 'YYYY-MM-DD HH:mm:ss ddd'), '2026-10-19 11:08:12 周一');
  assert.equal(formatDate(NOW, 'UTC', 'HH'), '03');
});

test('state store round-trips and starts empty', async () => {
  const store = new StateStore(join(root, 'state'));
  const empty = await store.load('session-a');
  assert.deepEqual(empty, emptyState('session-a'));
  await store.save({ ...empty, revision: 1, template: '{{d(6)}}', functions: { f: { source: '() => 1', definedAt: 5 } }, updatedAt: 9 });
  const back = await store.load('session-a');
  assert.equal(back.revision, 1); assert.equal(back.template, '{{d(6)}}'); assert.equal(back.functions.f.source, '() => 1');
  await assert.rejects(store.load('../evil'), /unsafe session id/);
});
