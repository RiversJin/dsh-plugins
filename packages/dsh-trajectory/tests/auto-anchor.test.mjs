import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { ArchiveStore } from '../lib/index.js';
import { anchorSpan } from '../lib/auto-anchor.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { harness, calls, respond, output, text } from './harness.mjs';

function replay(h) {
  const header = { ...h.agent.session.header, delegationDepth: 0, isSeeded: false };
  const restore = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader(header, 0), { recovery: 'strict', validation: 'current' });
  for (const event of h.events()) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event));
  const raw = restore.finish();
  const session = Session.create(SessionId(header.id), raw.events, raw.header, 0);
  assert.deepEqual(session.deriveMessages(), h.agent.session.deriveMessages());
}

test('two completed calls create one retrospective anchor, then model-authored compaction archives both whole groups', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trajectory-auto-'));
  const h = await harness({ archiveDir: dir, autoAnchorToolCalls: 2, scoped: true });
  try {
    await h.tool('fixture', { value: 'FIRST_WORK_RESULT' });
    assert.equal(h.state().anchor, null);
    await h.tool('trajectory_read', {});
    assert.equal(h.state().anchor, null);
    const before = h.events();
    await h.tool('fixture', { value: 'SECOND_WORK_RESULT' });
    const anchor = h.state().anchor;
    const first = h.events().find(e => e.type === 'assistant/message' && e.data.message.content.some(b => b.type === 'tool-call' && b.name === 'fixture'));
    assert.equal(anchor.startSeq, first.seq);
    assert.deepEqual(h.events().slice(0, before.length), before);
    assert.ok(JSON.stringify(h.adapter.requests.at(-1).messages).includes(anchor.id));
    await h.tool('fixture', { value: 'THIRD_WORK_RESULT' });
    assert.deepEqual(h.state().anchor, anchor);
    const compacted = await h.tool('trajectory_compact', { anchor_id: anchor.id, summary: 'Three tool results completed; retain the findings.' });
    assert.equal(compacted.error, false, compacted.raw);
    assert.equal(h.state().anchor, null);
    const archive = h.state().archives[0];
    const doc = await new ArchiveStore(dir).read(archive, new AbortController().signal);
    assert.deepEqual(doc.events, h.events().slice(archive.startSeq, archive.endSeq + 1));
    for (const value of ['FIRST_WORK_RESULT', 'SECOND_WORK_RESULT', 'THIRD_WORK_RESULT']) assert.ok(JSON.stringify(doc.events).includes(value));
    await h.tool('fixture', { value: 'NEXT_WORK_FIRST' });
    assert.equal(h.state().anchor, null);
    await h.tool('fixture', { value: 'NEXT_WORK_SECOND' });
    assert.notEqual(h.state().anchor.id, anchor.id);
    assert.ok(h.state().anchor.startSeq > archive.endSeq);
    replay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('two sibling calls share one complete anchor boundary', async () => {
  const h = await harness({ autoAnchorToolCalls: 2 });
  try {
    await h.send([calls(['fixture', { value: 'A' }], ['fixture', { value: 'B' }]), respond('done')]);
    const group = h.events().find(e => e.type === 'assistant/message' && e.data.message.content.filter(b => b.type === 'tool-call').length === 2);
    assert.equal(h.state().anchor.startSeq, group.seq);
    replay(h);
  } finally { await h.close(); }
});

test('a persisted first call counts after resume and old calls before activation stay outside the anchor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trajectory-auto-resume-'));
  const options = { archiveDir: join(dir, 'archives'), root: join(dir, 'sessions') };
  let h = await harness(options);
  try {
    await h.tool('fixture', { value: 'OLD_ONE' });
    await h.tool('fixture', { value: 'OLD_TWO' });
    const resume = h.agent.session.id;
    await h.close(); h = await harness({ ...options, resume, autoAnchorToolCalls: 2 });
    await h.tool('fixture', { value: 'NEW_ONE' });
    assert.equal(h.state().anchor, null);
    const expected = h.events().findLast(e => e.type === 'assistant/message' && e.data.message.content.some(b => b.type === 'tool-call' && b.name === 'fixture')).seq;
    await h.close(); h = await harness({ ...options, resume, autoAnchorToolCalls: 2 });
    await h.tool('fixture', { value: 'NEW_TWO' });
    assert.equal(h.state().anchor.startSeq, expected);
    replay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('existing work and review anchors keep their identities during tool work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trajectory-auto-review-'));
  const h = await harness({ archiveDir: dir, autoAnchorToolCalls: 2 });
  try {
    const marked = await h.tool('trajectory_anchor', { label: 'chosen by model' });
    await h.tool('fixture', { value: 'A' }); await h.tool('fixture', { value: 'B' });
    assert.deepEqual(h.state().anchor, marked.value.anchor);
    await h.tool('trajectory_compact', { anchor_id: marked.value.anchor.id, summary: 'The completed work.' });
    const work = (await h.tool('trajectory_anchor', { label: 'next work' })).value.anchor;
    await h.tool('trajectory_read', { archive_id: h.state().archives[0].id, max_chars: 500 });
    const review = h.state().anchor;
    await h.tool('fixture', { value: 'C' }); await h.tool('fixture', { value: 'D' });
    assert.deepEqual(h.state().anchor, review);
    assert.deepEqual(h.state().suspendedWorkAnchor, work);
    replay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('PTC leaf dispatches count separately while their completed root stays one whole group', async () => {
  const h = await harness({ autoAnchorToolCalls: 2, setup: async ctx => {
    // Use the native durable PTC event vocabulary inside a real root tool.
    ctx.tools.register(defineTool({ name: 'composite', description: 'Two successful native dispatches', parameters: {}, output,
      async execute(_args, exec) {
        for (const value of ['A', 'B']) {
          const subCallId = ToolCallId(crypto.randomUUID());
          const data = { rootCallId: exec.rootCallId, parentCallId: exec.callId, subCallId, name: 'fixture', arguments: { value } };
          exec.agent.session.append('tool/ptc-dispatch-start', data);
          const result = await ctx.tools.execute({ name: 'fixture', arguments: { value }, callId: subCallId, rootCallId: exec.rootCallId, parent: exec.token, agent: exec.agent, signal: exec.signal });
          exec.agent.session.append('tool/ptc-dispatch', { ...data, isError: result.isError, content: result.content });
        }
        return 'done';
      } }));
  } });
  try {
    await h.tool('composite', {});
    const group = h.events().find(e => e.type === 'assistant/message' && e.data.message.content.some(b => b.type === 'tool-call' && b.name === 'composite'));
    assert.equal(h.state().anchor.startSeq, group.seq);
    const notice = h.events().find(e => e.type === 'user/message' && e.data.source.form === 'auto-anchor-notice');
    assert.ok(JSON.stringify(notice.data.content).includes('after 2 tool calls'));
    replay(h);
  } finally { await h.close(); }
});

test('a completed human conversation round without tool work separates two tool stretches', async () => {
  const h = await harness({ autoAnchorToolCalls: 2 });
  try {
    await h.tool('fixture', { value: 'INCIDENTAL_ONE' });
    assert.equal(h.state().anchor, null);
    await h.send([respond('just talking')], 'a plain human message');
    await h.send([respond('still talking')], 'another plain human message');
    await h.tool('fixture', { value: 'INCIDENTAL_TWO' });
    assert.equal(h.state().anchor, null, 'chat between two incidental calls must not be swept into one anchor');
    await h.tool('fixture', { value: 'WORK_CONTINUES' });
    const anchor = h.state().anchor;
    assert.ok(anchor);
    const second = h.events().find(e => e.type === 'assistant/message' && JSON.stringify(e.data.message.content).includes('INCIDENTAL_TWO'));
    assert.equal(anchor.startSeq, second.seq);
    const chat = h.events().find(e => e.type === 'user/message' && JSON.stringify(e.data.content).includes('a plain human message'));
    assert.ok(anchor.startSeq > chat.seq);
    replay(h);
  } finally { await h.close(); }
});

test('non-human quiet turns and human turns with tool work keep one stretch', async () => {
  const h = await harness({ autoAnchorToolCalls: 3 });
  try {
    await h.tool('fixture', { value: 'STRETCH_ONE' });
    h.adapter.scripts.push(respond('quiet tick'));
    h.agent.followup(createUserMessage({ content: text('[Time passing]'), source: { kind: 'schedule', taskId: 'tick' } })); await h.agent.whenIdle();
    await h.tool('fixture', { value: 'TWO' });
    assert.equal(h.state().anchor, null);
    await h.tool('fixture', { value: 'THREE' });
    const first = h.events().find(e => e.type === 'assistant/message' && JSON.stringify(e.data.message.content).includes('STRETCH_ONE'));
    assert.equal(h.state().anchor.startSeq, first.seq);
    replay(h);
  } finally { await h.close(); }
});

test('the notice reports the span an automatic anchor covers', async () => {
  const h = await harness({ autoAnchorToolCalls: 2 });
  try {
    await h.tool('fixture', { value: 'SPAN_ONE' });
    await h.tool('fixture', { value: 'SPAN_TWO' });
    const notice = h.events().find(e => e.type === 'user/message' && e.data.source.form === 'auto-anchor-notice');
    const body = notice.data.content[0].text;
    const span = anchorSpan(h.events(), h.agent.session.surface.nodes, h.state().anchor.startSeq);
    // The first human request precedes the first counted tool group, so only the second lies inside.
    assert.equal(span.userMessages, 1);
    const counted = Number(/It covers (\d+) context messages from /u.exec(body)?.[1]);
    // The notice was written before the notice itself and this turn's reply joined the surface.
    assert.ok(counted >= 6 && counted <= span.messages, body);
    assert.ok(body.includes(`including ${span.userMessages} user messages`), body);
    assert.ok(body.includes('replaces everything in this range'), body);
    assert.ok(JSON.stringify(h.adapter.requests.at(-1).messages).includes('including 1 user messages'));
    replay(h);
  } finally { await h.close(); }
});
