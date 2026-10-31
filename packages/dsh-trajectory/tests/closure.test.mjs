import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { harness, respond } from './harness.mjs';
import { toolFreeTurns } from '../lib/closure.js';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';

async function settled(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(predicate(), 'Expected the native idle callback to finish');
}

test('six tool-free rounds and one hour share one durable reminder; dream requests and restart reuse it', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.UTC(2026, 9, 16, 0) });
  const dir = await mkdtemp(join(tmpdir(), 'trajectory-closure-')), tasks = [];
  const options = { root: join(dir, 'sessions'), archiveDir: join(dir, 'archives'), autoAnchorToolCalls: 2,
    autoAnchorReminderTurns: 5, autoAnchorReminderMinutes: 60,
    setup: async ctx => { ctx.provide('schedule', {
      catalog: async () => tasks,
      create: async (sessionId, request) => { const task = { id: `closure-${tasks.length + 1}`, sessionId, ...request, scheduledAt: new Date(Date.now() + 1000).toISOString() }; tasks.push(task); return task; },
    }); },
  };
  let h = await harness(options);
  try {
    await h.tool('fixture', { value: 'A' }); await h.tool('fixture', { value: 'B' });
    const first = h.state().anchor;
    for (let i = 0; i < 5; i++) await h.send([respond('继续聊天。')]);
    assert.equal(toolFreeTurns(h.events(), first), 5); assert.equal(tasks.length, 0);
    await h.send([respond('聊到第六轮。')]);
    await settled(() => h.events().some(e => e.type === 'user/message' && e.data.source.form === 'closure-request'));
    assert.equal(tasks.length, 1); assert.ok(tasks[0].prompt.includes(first.id));
    mock.timers.setTime(Date.now() + 61 * 60_000);
    await h.send([respond('继续聊一会儿。')]);
    await h.ctx.get('trajectoryClosure').request(h.agent, '到了夜间整理时间。');
    assert.equal(tasks.length, 1);
    const resume = h.agent.session.id;
    await h.close(); h = await harness({ ...options, resume });
    await h.ctx.get('trajectoryClosure').request(h.agent, '重启后继续同一次收束。');
    await h.send([respond('这仍然是同一个锚点。')]); assert.equal(tasks.length, 1);
    await h.tool('trajectory_compact', { anchor_id: first.id, summary: '完成这段共同活动，保留聊天内容。' });
    await h.tool('fixture', { value: 'C' }); await h.tool('fixture', { value: 'D' });
    const second = h.state().anchor; assert.notEqual(second.id, first.id);
    // The one-hour condition independently applies to a fresh identity.
    mock.timers.tick(60 * 60_000);
    await settled(() => tasks.length === 2);
    await h.ctx.get('trajectoryClosure').request(h.agent, '夜间流程共享同一次请求。');
    assert.equal(tasks.length, 2);
    const header = { ...h.agent.session.header, delegationDepth: 0, isSeeded: false };
    const restore = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader(header, 0), { recovery: 'strict', validation: 'current' });
    for (const e of h.events()) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(e));
    assert.equal(restore.finish().events.length, h.events().length);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); mock.timers.reset(); }
});
