import assert from 'node:assert/strict';
import test from 'node:test';
import { renderTranscript } from '../lib/index.js';

const SOURCE = 'plugin:dsh-trajectory';
const base = 1_792_942_150_000;
const model = { kind: 'model', provider: 'kimi-coding', model: 'k3-256k', replayState: { response: { kind: 'pi-ai', version: 2, stopReason: 'toolUse' },
  blocks: [{ type: 'reasoning', thinkingSignature: 'SIGNATURE_BASE64_NOISE' }, { type: 'tool-call' }] } };
const events = [
  { type: 'step/start', seq: 100, time: base, data: { turn: 1, step: 1 } },
  { type: 'request/header', seq: 101, time: base, data: { header: { config: { model: 'k3-256k' }, tools: [{ name: 'edit', description: 'TOOL_SCHEMA_NOISE' }] } } },
  { type: 'assistant/message', seq: 102, time: base + 1000, data: { turn: 1, step: 1, message: { role: 'assistant', id: 'm1', source: model, content: [
    { type: 'reasoning', text: 'Check the quote before answering.' }, { type: 'text', text: '（先查原文）' },
    { type: 'tool-call', id: 'call_1', name: 'edit', arguments: '{"file":"/tmp/a.md","mode":"general"}' }] } } },
  { type: 'tool/call', seq: 103, time: base + 1000, data: { turn: 1, step: 1, callId: 'call_1', name: 'edit', arguments: '{"file":"/tmp/a.md","mode":"general"}' } },
  { type: 'tool/result', seq: 104, time: base + 1200, data: { turn: 1, step: 1, message: { role: 'tool', id: 'm2', source: { kind: 'tool', callId: 'call_1' }, toolCallId: 'call_1', isError: true,
    content: [{ type: 'text', text: 'Error: [E_BAD_PAYLOAD] missing edits' }] } } },
  { type: 'step/end', seq: 105, time: base + 1200, data: { turn: 1, step: 1 } },
  { type: 'developer/message', seq: 106, time: base + 1300, data: { turn: 1, step: 2, message: { role: 'developer', id: 'm3', content: [],
    source: { kind: SOURCE, form: 'anchor', anchor: { id: '07dfa7e2-7c19-4e8e-b676-1d0e1e05926b', label: '自动锚点 · edit', kind: 'work', startSeq: 102, createdAt: base }, suspendedWorkAnchor: null } } } },
  { type: 'user/message', seq: 107, time: base + 1300, data: { role: 'user', id: 'm4', content: [{ type: 'text', text: 'An automatic work anchor has now been created.' }], source: { kind: SOURCE, form: 'auto-anchor-notice', anchorId: '07dfa7e2-7c19-4e8e-b676-1d0e1e05926b' } } },
  { type: 'user/message', seq: 108, time: base + 2000, data: { role: 'user', id: 'm5', content: [{ type: 'text', text: '异议！那句不是我说的。' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 109, time: base + 3000, data: { turn: 2, step: 1, message: { role: 'assistant', id: 'm6', source: model, content: [{ type: 'text', text: '收到，查证结果如下。' }] } } },
];
const document = { version: 1, id: 'b089545f-8179-4bdd-8586-fe25494f52d6', ownerSessionId: 'session-x', createdAt: base + 4000,
  anchor: { id: '07dfa7e2-7c19-4e8e-b676-1d0e1e05926b', label: '自动锚点 · edit', kind: 'work', startSeq: 102, createdAt: base },
  surfaceSeqs: [102, 104, 106, 107, 108, 109, 250], events };

test('transcript keeps messages, reasoning, calls, error marks and anchors; drops provider and request noise', () => {
  const text = renderTranscript(document);
  for (const expected of ['## 102 ', '· assistant', '[thinking]\nCheck the quote before answering.', '（先查原文）',
    '[tool call edit call_1]\n{"file":"/tmp/a.md","mode":"general"}', '## 104 ', 'tool result edit call_1 · ERROR', 'Error: [E_BAD_PAYLOAD] missing edits',
    'work anchor "自动锚点 · edit" 07dfa7e2-7c19-4e8e-b676-1d0e1e05926b from seq 102', 'user-role message from plugin:dsh-trajectory/auto-anchor-notice',
    '## 108 ', '· user\n异议！那句不是我说的。', '收到，查证结果如下。', '## 250 · (message rewritten after this range']) {
    assert.ok(text.includes(expected), `missing ${JSON.stringify(expected)} in:\n${text}`);
  }
  for (const noise of ['SIGNATURE_BASE64_NOISE', 'replayState', 'TOOL_SCHEMA_NOISE', 'step/start', 'k3-256k', '"seq": 103']) assert.ok(!text.includes(noise), `unexpected ${noise}`);
  assert.equal(text.indexOf('## 102 ') < text.indexOf('## 104 ') && text.indexOf('## 104 ') < text.indexOf('## 108 '), true);
  assert.equal(renderTranscript(document), text);
  assert.ok(text.startsWith('Trajectory archive b089545f-8179-4bdd-8586-fe25494f52d6 · anchor "自动锚点 · edit" (work, 07dfa7e2-7c19-4e8e-b676-1d0e1e05926b)\n7 context messages'));
});
