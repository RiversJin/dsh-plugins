import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

/** Minimal cordis-like host: records hooks and the registered tool. */
function host() {
  const hooks = new Map(), tools = [], logs = [];
  const ctx = {
    on(event, fn) { hooks.set(event, fn); return () => hooks.delete(event); },
    tools: { register(def) { tools.push(def); return () => {}; } },
    logger: { info: m => logs.push(['info', m]), warn: m => logs.push(['warn', m]) },
  };
  return { ctx, hooks, tools, logs };
}
const agentFor = (id, origin = 'user') => ({ session: { id, header: { origin } } });
const exec = (agent) => ({ agent, signal: new AbortController().signal });
const notification = (quiet = '1h 0s') => ({
  id: 'm1', role: 'user', content: [{ type: 'text', text: `[Time passing]\nCurrent time: 2026-10-19 11:08:12 (Asia/Singapore)\nTime spent quiet: ${quiet}\nTime since 阿林's last message: 1h 23s` }],
  source: { kind: 'schedule', taskId: 't1', notification: 'time_passing', retain: 'latest' },
});

test('tool lifecycle: show → define → set_template → preview → remove rejected while in use → clear', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tick-plugin-'));
  writeFileSync(join(dir, 'protocol.md'), '1-2 安静、3 翻档案、4 探索、5 写点什么、6 自由格');
  const h = host();
  apply(h.ctx, { dataDir: join(dir, 'state'), fileRoots: [dir], trials: 8 });
  assert.equal(h.tools.length, 1);
  const tool = h.tools[0];
  assert.equal(tool.name, 'tick_template');
  const agent = agentFor('session-a');
  const run = args => tool.execute(args, exec(agent));

  let r = await run({ action: 'show' });
  assert.equal(r.template, null); assert.deepEqual(r.functions, []); assert.ok(r.builtins.some(b => b.name === 'dice'));

  r = await run({ action: 'define', name: 'slot', source: 'n => n <= 2 ? "安静" : n === 6 ? "自由格" : ["翻档案","探索","写点什么"][n - 3]' });
  assert.equal(r.accepted, true); assert.equal(r.now.revision, 1);

  r = await run({ action: 'define', name: 'spin', source: '() => { for(;;){} }' });
  assert.equal(r.accepted, false); assert.match(r.error, /timed out/); assert.equal(r.kept.revision, 1);

  r = await run({ action: 'define', name: 'oops', source: 'not valid js (' });
  assert.equal(r.accepted, false); assert.match(r.error, /syntax error/);

  r = await run({ action: 'set_template', template: '骰子 {{ (n = d(6), n + "=" + slot(n)) }}\n{{file("protocol.md")}}' });
  assert.equal(r.accepted, true); assert.equal(r.now.revision, 2); assert.ok(r.samples.length >= 1);
  assert.equal(r.samples[0].env, 'full'); assert.match(r.samples[0].text, /^骰子 [1-6]=(安静|翻档案|探索|写点什么|自由格)\n1-2 安静/);

  r = await run({ action: 'preview', template: '{{quietMinutes ?? "?"}} 分钟' });
  assert.equal(r.ok, true); assert.equal(r.saved, false); assert.deepEqual(r.samples.map(s => [s.env, s.text]).sort(), [['empty', '? 分钟'], ['full', '60 分钟']], JSON.stringify(r.samples));

  r = await run({ action: 'remove', name: 'slot' });
  assert.equal(r.accepted, false); assert.match(r.error, /slot is not defined/);
  r = await run({ action: 'show' });
  assert.equal(r.revision, 2); assert.equal(r.functions.length, 1);

  r = await run({ action: 'clear' });
  assert.equal(r.accepted, true); assert.equal(r.now.template, null); assert.equal(r.now.functions.length, 1);

  await assert.rejects(tool.execute({ action: 'show' }, exec(agentFor('sub', 'subagent'))), /main session/);
});

test('pre-step appends the render to a time notification and leaves other steps alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tick-plugin-'));
  const h = host();
  apply(h.ctx, { dataDir: join(dir, 'state'), trials: 4 });
  const tool = h.tools[0], preStep = h.hooks.get('agent/pre-step');
  const agent = agentFor('session-b');
  const call = (messages, a = agent) => preStep({ agent: a, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }));

  // No template yet: untouched.
  let decision = await call([notification()]);
  assert.equal(decision.messages[0].content.length, 1);

  await tool.execute({ action: 'set_template', template: '骰子：{{d(6)}}，安静了 {{quietMinutes}} 分钟' }, exec(agent));
  decision = await call([notification('2h 5m')]);
  assert.equal(decision.messages.length, 1);
  const blocks = decision.messages[0].content;
  assert.equal(blocks.length, 2);
  assert.match(blocks[1].text, /^\[Tick template\]\n骰子：[1-6]，安静了 125 分钟$/);
  assert.equal(decision.messages[0].id, 'm1', 'identity and source are preserved for retain: latest');
  assert.equal(decision.messages[0].source.taskId, 't1');

  // A recovered delivery already carrying a render is not rendered twice.
  const again = await call(decision.messages);
  assert.equal(again.messages[0].content.length, 2);

  // Plain user messages, rejected steps and subagents pass through.
  const plain = { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } };
  assert.deepEqual((await call([plain])).messages, [plain]);
  const rejected = await preStep({ agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'reject' }));
  assert.deepEqual(rejected, { kind: 'reject' });
  assert.equal((await call([notification()], agentFor('session-b', 'subagent'))).messages[0].content.length, 1);

  // A render failure at delivery time is reported inline, never thrown.
  await tool.execute({ action: 'set_template', template: '{{file("x", "ok")}}' }, exec(agent)); // file() disabled: fileRoots empty → fails
  const failing = await tool.execute({ action: 'show' }, exec(agent));
  assert.equal(failing.template, '骰子：{{d(6)}}，安静了 {{quietMinutes}} 分钟', 'the failing template was rejected by the dry run; the previous one stays');
  // Force a runtime-only failure: a function that only breaks when the real clock says so is hard to fake, so write a bad state directly.
  const { StateStore } = await import('../lib/index.js');
  const store = new StateStore(join(dir, 'state'));
  const state = await store.load('session-b');
  await store.save({ ...state, template: '{{nosuch()}}', revision: 9 });
  decision = await call([notification()]);
  assert.match(decision.messages[0].content[1].text, /^\[Tick template\] render failed, template revision 9 unchanged: \{\{nosuch\(\)\}\}: nosuch is not defined/);
  assert.ok(h.logs.some(([level, m]) => level === 'warn' && /render failed/.test(m)));
  const after = await store.load('session-b');
  assert.match(after.lastRender.error, /nosuch/);
});
