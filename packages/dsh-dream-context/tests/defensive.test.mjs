import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { at, harness, respond, strictReplay } from './harness.mjs';
import { directoryText } from '../lib/dream-read.js';

const requested = (...calls) => [...calls.flatMap(([name, args], index) => [
  { type: 'block-start', index, blockType: 'tool-call' },
  { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) } },
]), { type: 'finish', reason: { kind: 'tool-calls' } }];
const dreamMeta = options => {
  const text = options.messages.findLast(m => m.source?.form === 'dream').content[0].text;
  return JSON.parse(text.split('现有记忆与本次范围：\n')[1].split('\n\n本日原文')[0]);
};
const toolResults = (options, count) => options.messages.filter(m => m.role === 'tool').slice(-count).map(m => ({ isError: m.isError, body: m.content[0].text }));
const authored = meta => JSON.stringify({
  episodes: [{ id: meta.requiredEpisode, summary: '我们一起在公园散步，聊起雨后的气味。' }],
  memories: [{ text: '公园散步是我们愿意再次一起做的事情。', kind: 'experience', state: 'active', evidence: [meta.requiredEpisode] }],
});

test('the dream directory is compact and paged, identical reads are answered once, and the read budget ends with a usable hint', async () => {
  const long = '第一句很长。第二句不该出现。';
  const text = directoryText([
    { id: 'episode_old', day: '2026-01-01', startAt: 1, summary: long },
    { id: 'episode_new', day: '2026-01-02', startAt: 2 },
  ], [{ id: 'legacy_a', ref: 'x', originalTime: Date.UTC(2025, 11, 31, 12) }], 'Asia/Singapore');
  assert.deepEqual(text.split('\n'), ['2 episode day(s), newest first:', 'episode_new 2026-01-02 not summarized', 'episode_old 2026-01-01 summarized: 第一句很长。', '1 legacy source(s):', 'legacy_a 2025-12-31']);

  mock.timers.enable({ apis: ['Date'], now: at(1) });
  let h;
  try {
    h = await harness({ historyCompression: false, maxDreamReads: 4 });
    await h.say('今天我们在公园散步，木牌上写着「雨后留香」。');
    mock.timers.setTime(at(1, 13));
    await h.say('下次还想再来看看那棵树。');
    let episodeId;
    const guarded = fn => options => { try { return fn(options); } catch (error) { console.error('scripted round failed:', error); throw error; } };
    h.adapter.dreamNext.push(guarded(options => {
      episodeId = dreamMeta(options).requiredEpisode;
      // Same directory twice, with keys in a different order; an unknown search key and a limit are tolerated.
      return requested(['experience_read', { max_chars: 40, offset: 0 }], ['experience_read', { offset: 0, max_chars: 40 }],
        ['experience_search', { query: '公园散步', limit: 1, foo: 'ignored' }]);
    }), guarded(options => {
      const [first, same, search] = toolResults(options, 3);
      assert.equal(first.isError, false); assert.equal(same.isError, false); assert.equal(search.isError, false);
      const page = JSON.parse(first.body);
      assert.ok(page.directory.startsWith('1 episode day(s)'));
      assert.equal(page.directory.includes('\n'), page.directory.trim().split('\n').length > 1);
      assert.ok(page.nextOffset > 0 && page.nextOffset <= 40, JSON.stringify(page));
      assert.equal(page.directory.at(-1) !== '\n' && page.directory.split('\n').every(line => line.length), true);
      assert.equal(page.readsLeft, 3);
      const again = JSON.parse(same.body);
      assert.equal(again.repeated, true); assert.equal(again.sameAsCall, 1); assert.equal(again.readsLeft, 3);
      assert.ok(JSON.parse(search.body).length <= 1);
      // The search counted too; the directory tail and the day read exhaust the budget of four distinct calls.
      return requested(['experience_read', { offset: page.nextOffset }], ['experience_read', { episode_id: episodeId, max_chars: 30 }]);
    }), guarded(options => {
      const [rest, day] = toolResults(options, 2);
      const restPage = JSON.parse(rest.body);
      assert.equal(restPage.nextOffset, null); assert.match(restPage.directory, /0 legacy source\(s\)/);
      assert.equal(day.isError, false); assert.equal(JSON.parse(day.body).readsLeft, 0);
      return requested(['experience_read', { episode_id: episodeId, offset: 30 }]);
    }), guarded(options => {
      const [over] = toolResults(options, 1);
      assert.equal(over.isError, true); assert.match(over.body, /Read budget exhausted \(4 calls/);
      return respond(authored(dreamMeta(options)));
    }));
    mock.timers.setTime(at(2, 4));
    assert.equal((await h.service.run(h.agent)).dreams, 1);
    const book = await h.service.load(h.agent.session), artifact = await h.service.store.get(book.dreams.at(-1));
    assert.equal(artifact.complete, true); assert.equal(artifact.requests.length, 4);
    assert.equal(artifact.events.filter(e => e.type === 'tool/call').length, 6);
    strictReplay(h.agent.session);
  } finally { await h?.close(); mock.timers.reset(); }
});

test('invented memory IDs get one validation feedback round inside the same dream, and the round allowance outlives one request deadline', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  let h;
  try {
    h = await harness({ historyCompression: false, notifications: true, timeoutMs: 1000 });
    await h.say('今天我们在公园散步，雨后的气味很好。');
    const stream = h.adapter.stream.bind(h.adapter);
    h.adapter.stream = async function* (options) {
      if (options.purpose === 'compaction') { await new Promise(resolve => setTimeout(resolve, 600)); options.signal.throwIfAborted(); }
      yield* stream(options);
    };
    h.adapter.dreamNext.push(options => {
      const meta = dreamMeta(options);
      return respond(JSON.stringify({ episodes: [{ id: meta.requiredEpisode, summary: '散步。' }],
        memories: [{ id: 'memory_made_up_20260101', text: '自拟 ID 的记忆。', kind: 'experience', state: 'active', evidence: [meta.requiredEpisode] }] }));
    }, options => {
      const feedback = options.messages.at(-1);
      assert.equal(feedback.source.form, 'dream-feedback');
      assert.match(feedback.content[0].text, /本次结果尚未提交/);
      assert.match(feedback.content[0].text, /Dream revision was not among the presented current records/);
      assert.match(feedback.content[0].text, /memories\[0\]\.id = "memory_made_up_20260101" 在当前记忆库中不存在/);
      assert.equal(options.messages.filter(m => m.role === 'assistant' && m.content.some(b => b.text?.includes('memory_made_up'))).length, 1);
      return respond(authored(dreamMeta(options)));
    });
    mock.timers.setTime(at(2, 4));
    const started = performance.now();
    assert.equal((await h.service.run(h.agent)).dreams, 1);
    assert.ok(performance.now() - started > h.service.config.timeoutMs);
    const book = await h.service.load(h.agent.session), artifact = await h.service.store.get(book.dreams.at(-1));
    assert.equal(artifact.complete, true); assert.equal(artifact.corrections, 1);
    assert.deepEqual(artifact.submissionFailures, [{ step: 1, reason: 'Dream revision was not among the presented current records', feedbackSent: true }]);
    assert.equal(book.memories.length, 1); assert.equal(book.memories[0].id.startsWith('memory_made_up'), false);
    assert.match(book.lastReceipt.text, /已完成并保存/);
    strictReplay(h.agent.session);
  } finally { await h?.close(); mock.timers.reset(); }
});

test('after the correction allowance the night fails as a validation failure, and repeated same-reason failures each get a receipt', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  let h;
  try {
    h = await harness({ historyCompression: false, notifications: true, maxDreamsPerNight: 3 });
    await h.say('今天我们在公园散步。');
    const wrong = options => {
      const meta = dreamMeta(options);
      return respond(JSON.stringify({ episodes: [{ id: meta.requiredEpisode, summary: '散步。' }],
        memories: [{ id: 'memory_made_up_1', text: '自拟。', kind: 'experience', state: 'active', evidence: [meta.requiredEpisode] }] }));
    };
    h.adapter.dreamNext.push(wrong, wrong, wrong, wrong, wrong, wrong);
    mock.timers.setTime(at(2, 4));
    await assert.rejects(h.service.run(h.agent), /validation failed after 2 correction rounds/);
    let book = await h.service.load(h.agent.session);
    assert.equal(book.health.lastError, '提交内容未通过校验'); assert.equal(book.attempts, 1);
    assert.equal(book.episodes.filter(e => e.summary).length, 0); assert.equal(book.memories.length, 0);
    await assert.rejects(h.service.run(h.agent), /validation failed after 2 correction rounds/);
    book = await h.service.load(h.agent.session);
    assert.equal(book.attempts, 2);
    const receipts = h.agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source?.form === 'receipt');
    assert.equal(receipts.length, 2);
    for (const receipt of receipts) assert.match(receipt.data.content[0].text, /状态：未完成\n原因：提交内容未通过校验/);
    assert.equal(h.adapter.requests.filter(r => r.purpose === 'compaction').length, 6);
    strictReplay(h.agent.session);
  } finally { await h?.close(); mock.timers.reset(); }
});

test('a pause written without a deadline expires a day after it was set instead of silencing recall forever', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ historyCompression: false });
  try {
    await h.say('我们一起在公园散步。'); mock.timers.setTime(at(2, 4)); await h.service.run(h.agent);
    let helperCalls = 0;
    h.service.planner.plan = async () => { helperCalls++; return { recall: true, queries: ['公园散步'] }; };
    // The 0.2.0 experience_recall wrote this shape: a reminder id, no pausedUntil.
    const book = await h.service.load(h.agent.session);
    const changedAt = Date.now();
    book.recallControl = { mode: 'paused', changedAt, afterSeq: h.agent.session.snapshotEvents().length - 1, reason: '专注一会儿。', reminderId: 'reminder-legacy' };
    await h.service.save(h.agent, book);
    const status = async () => JSON.parse((await h.tool('experience_recall', { action: 'status' })).content[0].text);
    mock.timers.setTime(changedAt + 23 * 60 * 60_000);
    let seen = await status();
    assert.equal(seen.mode, 'paused'); assert.equal(seen.pausedUntil, changedAt + 24 * 60 * 60_000); assert.equal(seen.expired, false);
    assert.equal(Math.round(seen.remainingMinutes), 60);
    await h.say('公园散步那次。'); assert.equal(helperCalls, 0);
    mock.timers.setTime(changedAt + 25 * 60 * 60_000);
    await h.restart();
    seen = await status();
    assert.equal(seen.mode, 'auto'); assert.equal(seen.expired, true);
    // The status call above already ran with recall active; the next request plans again.
    const resumed = helperCalls;
    await h.say('我们在公园散步的经历。'); assert.equal(helperCalls, resumed + 1);
    assert.ok(h.adapter.requests.slice(-2).some(request => request.messages.some(m => m.source.form === 'recall')));
    strictReplay(h.agent.session);
  } finally { mock.timers.reset(); await h.close(); }
});
