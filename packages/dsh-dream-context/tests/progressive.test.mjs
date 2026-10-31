import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import * as Dream from '../lib/index.js';
import { sentences, material, deletionSequence, render, chooseStep, effectiveEvents, pin } from '../lib/fade.js';
import { allotment } from '../lib/progressive.js';
import { sourceOf } from '../lib/history.js';
import { at, blocks, harness, visible, strictReplay } from './harness.mjs';

const progressive = (extra = {}) => ({ enabled: true, rawTokens: 30, fadeBudgetTokens: 600, fadeRatio: 0.5, minDayTokens: 20, labels: { user: '阿林', self: '小禾' }, ...extra });
const historyMessage = session => session.deriveMessages().filter(m => m.source.kind === Dream.SOURCE && m.source.form === 'history');
const dayBlock = (session, day) => historyMessage(session)[0]?.content.filter(b => b.type === 'text').map(b => b.text).find(text => text.startsWith(`## ${day}`));
const fragments = text => text.split('\n').slice(1).filter(line => !line.startsWith('（此处略去') && !line.startsWith('【'))
  .flatMap(line => line.replace(/[「」]/g, '').split('…')).map(s => s.trim()).filter(Boolean);

test('deletion sequence fades a day in a fixed order and every later step is a subset of the earlier one', () => {
  assert.deepEqual(sentences('早安。今天周三……真的上班！\n再睡会儿吧'), ['早安。', '今天周三……', '真的上班！', '再睡会儿吧']);
  const say = (seq, role, text, time = at(1, 9) + seq * 60_000) => ({ seq, time, type: role === 'user' ? 'user/message' : 'assistant/message', surfaceOp: 'append',
    data: role === 'user' ? { id: `m${seq}`, role, source: { kind: 'user' }, content: blocks(text) } : { message: { id: `m${seq}`, role, source: { kind: 'model' }, content: [...blocks(text), { type: 'tool-call', id: `c${seq}`, name: 'bash', arguments: '{}' }] } } });
  const events = [
    say(1, 'user', '早上好呀。'), say(2, 'assistant', '早安。第一句。第二句很长很长。第三句。最后一句。'),
    say(3, 'user', '我们去公园吧，顺便看看那棵树。'), say(4, 'assistant', '好呀。我记得那棵树。走吧。'),
    say(5, 'user', '嗯。'), say(6, 'assistant', '到了。'),
  ];
  const quotes = [{ text: '我记得那棵树', priority: 3 }];
  const built = material(events, quotes);
  assert.equal(built.rounds.length, 3);
  assert.ok(built.rounds[1].segments[1].pinned[1]);
  const sequence = deletionSequence(built.rounds, quotes);
  assert.equal(sequence.filter(d => d.t === 'seg').length, 3);
  assert.deepEqual(sequence.slice(0, 3).map(d => d.t), ['seg', 'seg', 'seg']);
  const labels = { user: '阿林', self: '小禾' };
  const full = render(built.rounds, sequence, 0, labels);
  assert.match(full.text, /阿林：早上好呀。\n小禾：早安。第一句。/);
  assert.match(full.text, /「我记得那棵树。」/);
  let previous = fragments(`x\n${full.text}`);
  for (let step = 1; step <= sequence.length; step++) {
    const current = fragments(`x\n${render(built.rounds, sequence, step, labels).text}`);
    for (const piece of current) assert.ok(previous.some(p => p.includes(piece)), `step ${step}: "${piece}" was not retained before`);
    previous = current;
  }
  const trimmed = render(built.rounds, sequence, 6, labels).text;
  assert.match(trimmed, /小禾：早安。…最后一句。/);
  const last = render(built.rounds, sequence, sequence.length - 1, labels).text;
  assert.equal(last.includes('「我记得那棵树。」'), true);
  assert.match(last, /（此处略去 \d 轮）/);
  assert.equal(render(built.rounds, sequence, sequence.length, labels).text, '（此处略去 3 轮）');
  const step = chooseStep(built.rounds, sequence, 12, 0);
  assert.ok(step > 0 && render(built.rounds, sequence, step, labels).text.length / 1.7 <= 12);
  assert.equal(chooseStep(built.rounds, sequence, 10_000, 5), 5);
  assert.deepEqual(pin(material(events).rounds, [{ text: '不存在的话', priority: 1 }]).length, 1);
  const retried = [...events, { seq: 7, time: at(1, 10), type: 'developer/message', surfaceOp: { op: 'replace', startSeq: 5, endSeq: 6 }, sourceEventSeqs: [5, 6],
    data: { message: { id: 'r7', role: 'developer', source: { kind: 'plugin:dsh-retry', form: 'reset' }, content: [] } } }];
  assert.equal(material(effectiveEvents(retried, retried, 1, 7)).rounds.length, 2);
  const config = { progressive: { fadeBudgetTokens: 30000, fadeRatio: 0.75 } };
  assert.deepEqual([0, 1, 2, 8].map(rank => allotment(config, rank)), [7500, 5625, 4218, 750]);
});

test('nightly composite keeps the newest day raw, fades older days by rank and never lets faded text grow back', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  let h;
  try {
    h = await harness({ progressive: progressive(), summaryDays: 4 });
    const days = ['一', '二', '三', '四', '五', '六'];
    const talk = async day => {
      await h.say(`第${day}天早上好。今天想去公园看那棵树，顺便买早餐。你记得上次的约定吗？`);
      await h.say(`第${day}天晚上回来了。晚安。`);
    };
    mock.timers.setTime(at(1, 9)); await talk(days[0]);
    mock.timers.setTime(at(2, 4));
    let report = await h.service.run(h.agent);
    assert.equal(report.dreams, 1);
    assert.equal(historyMessage(h.agent.session).length, 0, 'the only completed day stays raw');
    mock.timers.setTime(at(2, 9)); await talk(days[1]);
    mock.timers.setTime(at(3, 4)); report = await h.service.run(h.agent);
    assert.equal(historyMessage(h.agent.session).length, 1);
    assert.ok(report.transitions.some(line => /history revision 1: 1 raw day\(s\), 1 faded day\(s\)/.test(line)), report.transitions.join('|'));
    const shown = visible(h.agent.session);
    assert.match(shown, /\[往日\]/);
    assert.match(shown, /## 01-01 周四 · 已淡化/);
    assert.match(shown, /【我写下的当天记忆（修订 1）】/);
    assert.match(shown, /第二天早上好。今天想去公园看那棵树/, 'the newest completed day remains verbatim');
    const first = h.agent.session.deriveMessages().findIndex(m => m.source.kind === Dream.SOURCE && m.source.form === 'history');
    assert.equal(h.agent.session.deriveMessages().slice(0, first).every(m => m.role === 'system' || m.source.kind !== 'user'), true, 'no raw user message precedes the composite');
    let book = await h.service.load(h.agent.session);
    assert.equal(book.history.revision, 1); assert.equal(book.history.displayedEpisodeIds.length, 1);
    assert.equal(book.episodes[0].fade.fadedAt, at(3, 4)); assert.equal(book.episodes[1].fade, undefined);
    const day1Nights = [dayBlock(h.agent.session, '01-01')];
    strictReplay(h.agent.session);

    // A quiet night changes nothing: same plan, same revision, no new node.
    mock.timers.setTime(at(4, 4));
    report = await h.service.run(h.agent);
    assert.equal((await h.service.load(h.agent.session)).history.revision, 1);
    assert.equal(h.agent.session.snapshotEvents().filter(e => sourceOf(e)?.form === 'history').length, 1, 'no new composite on a quiet night');

    for (const [index, day] of days.slice(2).entries()) {
      mock.timers.setTime(at(4 + index, 9)); await talk(day);
      mock.timers.setTime(at(5 + index, 4)); report = await h.service.run(h.agent);
      assert.equal(historyMessage(h.agent.session).length, 1, 'exactly one composite');
      const block = dayBlock(h.agent.session, '01-01');
      if (block) {
        const earlier = fragments(day1Nights.at(-1));
        for (const piece of fragments(block)) assert.ok(earlier.some(p => p.includes(piece)), `night ${5 + index}: "${piece}" reappeared`);
        day1Nights.push(block);
      }
      strictReplay(h.agent.session);
    }
    book = await h.service.load(h.agent.session);
    const steps = book.episodes.map(e => e.fade?.step ?? 0);
    assert.ok(steps[0] >= steps[1] && steps[1] >= steps[2], `older days fade further: ${steps}`);
    assert.ok(day1Nights.length >= 3 && day1Nights.at(-1).length < day1Nights[0].length, 'day one kept shrinking');
    assert.equal(dayBlock(h.agent.session, '01-01'), undefined, 'rank beyond the budget with an expired summary leaves the composite');
    assert.ok(book.episodes[0].summary, 'the day itself is still in the book');
    assert.match(visible(h.agent.session), /第六天早上好/);
    await h.restart();
    const again = await h.service.run(h.agent);
    assert.equal((await h.service.load(h.agent.session)).history.revision, book.history.revision);
    assert.equal(again.transitions.some(line => /deferred/.test(line)), false);
    const page = await h.tool('experience_read', { episode_id: book.episodes[0].id, max_chars: 200 });
    assert.match(page.content[0].text, /第一天早上好/);
    const request = h.adapter.requests.at(-1);
    assert.equal(request.messages.filter(m => m.source?.kind === Dream.SOURCE && m.source.form === 'history').length, 1);
    strictReplay(h.agent.session);
  } finally { await h?.close(); mock.timers.reset(); }
});

test('her quotes are pinned verbatim and fade last, unusable quotes are reported in the receipt', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  let h;
  try {
    h = await harness({ progressive: progressive({ fadeBudgetTokens: 100 }), notifications: true });
    h.adapter.proposal = meta => meta.requiredEpisode === null ? { episodes: [], memories: [] } : {
      episodes: [{ id: meta.requiredEpisode, summary: '公园的那棵树，和一句我想留住的话。' }], memories: [],
      quotes: [{ episodeId: meta.requiredEpisode, text: '树叶的影子落在你手背上', priority: 3 }, { episodeId: meta.requiredEpisode, text: '从未说过的话', priority: 1 }, { nope: true }],
    };
    mock.timers.setTime(at(1, 9));
    await h.say('今天去公园了。走到那棵树下的时候，树叶的影子落在你手背上，我看了很久。后来我们买了早餐，聊了很多别的事情，关于工作，关于下周的安排，还有天气。');
    await h.say('晚上回来了，有点累。明天见。');
    mock.timers.setTime(at(2, 4)); await h.service.run(h.agent);
    let book = await h.service.load(h.agent.session);
    assert.deepEqual(book.episodes[0].quotes, [{ text: '树叶的影子落在你手背上', priority: 3 }]);
    const receipt = h.agent.session.deriveMessages().find(m => m.source.kind === Dream.SOURCE && m.source.form === 'receipt');
    assert.match(receipt.content[0].text, /1 条格式不合要求/);
    assert.match(receipt.content[0].text, /1 条原话未在当天对话中找到/);
    mock.timers.setTime(at(2, 9)); await h.say('新的一天。');
    mock.timers.setTime(at(3, 4)); await h.service.run(h.agent);
    const block = dayBlock(h.agent.session, '01-01');
    assert.match(block, /阿林：今天去公园了。「走到那棵树下的时候，树叶的影子落在你手背上，我看了很久。」…/);
    assert.match(block, /（此处略去 1 轮）/);
    assert.equal(block.includes('关于下周的安排'), false, 'unpinned middle sentences went first');
    // Quotes for a day that already started fading are ignored, so nothing grows back.
    const faded = book.episodes[0].id;
    h.adapter.proposal = meta => ({ episodes: [{ id: meta.requiredEpisode, summary: '新的一天的总结。' }], memories: [], quotes: [{ episodeId: faded, text: '关于下周的安排', priority: 2 }] });
    mock.timers.setTime(at(3, 9)); await h.say('又一天。');
    mock.timers.setTime(at(4, 4)); await h.service.run(h.agent);
    book = await h.service.load(h.agent.session);
    assert.equal(book.episodes[0].quotes.length, 1);
    assert.equal(dayBlock(h.agent.session, '01-01').includes('关于下周的安排'), false);
    strictReplay(h.agent.session);
  } finally { await h?.close(); mock.timers.reset(); }
});

test('a day whose dream keeps failing stays raw for a few nights and then fades without a summary', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  let h;
  const failing = async function* () { throw new Error('model unavailable'); };
  try {
    h = await harness({ progressive: progressive({ maxRawNights: 2 }), maxDreamsPerNight: 1 });
    mock.timers.setTime(at(1, 9)); await h.say('第一天的对话，没有总结成功。');
    mock.timers.setTime(at(2, 4)); h.adapter.dreamNext.push(failing);
    await assert.rejects(h.service.run(h.agent), /model unavailable|did not finish/);
    mock.timers.setTime(at(2, 9)); await h.say('第二天的对话。');
    mock.timers.setTime(at(3, 4)); await h.service.run(h.agent);
    let book = await h.service.load(h.agent.session);
    assert.equal(book.episodes[0].summary, ''); assert.equal(book.episodes[1].summary.length > 0, true);
    assert.equal(historyMessage(h.agent.session).length, 0, 'an unsummarized day holds the whole window raw');
    assert.equal(book.episodes[0].fade.rawNights, 1);
    mock.timers.setTime(at(3, 9)); await h.say('第三天的对话。');
    mock.timers.setTime(at(4, 4)); const report = await h.service.run(h.agent);
    book = await h.service.load(h.agent.session);
    assert.equal(book.episodes[0].fade.rawNights, 2);
    assert.ok(report.transitions.some(line => /未能形成总结，已按原文淡化/.test(line)), report.transitions.join('|'));
    const block = dayBlock(h.agent.session, '01-01');
    assert.match(block, /第一天的对话/);
    assert.equal(block.includes('【我写下的当天记忆'), false);
    strictReplay(h.agent.session);
  } finally { await h?.close(); mock.timers.reset(); }
});

test('one authorized rebuild archives pre-start days and replaces a legacy compaction checkpoint', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  let h;
  try {
    h = await harness({ progressive: progressive(), startDay: '2026-01-03' });
    mock.timers.setTime(at(1, 9)); await h.say('第一天：旧检查点之前的对话。');
    mock.timers.setTime(at(2, 9)); await h.say('第二天：没有归档的对话。');
    mock.timers.setTime(at(3, 9)); await h.say('第三天：起点之后的对话。');
    mock.timers.setTime(at(4, 4)); await h.service.run(h.agent);
    let book = await h.service.load(h.agent.session);
    assert.deepEqual(book.episodes.map(e => e.day), ['2026-01-03']);
    // A legacy checkpoint shadows day one.
    const events = h.agent.session.snapshotEvents();
    const dayOne = h.agent.session.surface.nodes.filter(seq => { const e = events[seq]; return e.time >= at(1, 9) && e.time < at(2, 4) && (e.type === 'user/message' || e.type === 'assistant/message'); });
    const surface = h.agent.session.surface.nodes, shadowedSeqs = surface.slice(surface.indexOf(dayOne[0]), surface.indexOf(dayOne.at(-1)) + 1);
    const start = h.agent.session.append('compaction/start', { compactionId: 'legacy-1', turn: null }).seq;
    const summary = h.agent.session.append('compaction/summary', { compactionId: 'legacy-1', summary: blocks('[legacy checkpoint]'), llmStreamCall: false,
      shadowedRange: { start: dayOne[0], end: dayOne.at(-1) }, shadowedSeqs, shadowedTokenCount: 10, provider: 'mock', model: 'same-self' }).seq;
    h.agent.session.append('user/message', createUserMessage({ content: blocks('[legacy checkpoint]'), source: { kind: 'compact-checkpoint', compactionId: 'legacy-1' } }),
      { surfaceOp: { op: 'replace', startSeq: dayOne[0], endSeq: dayOne.at(-1) }, sourceEventSeqs: [start, summary, ...shadowedSeqs] });
    h.agent.session.append('compaction/end', { compactionId: 'legacy-1', turn: null });
    assert.match(visible(h.agent.session), /legacy checkpoint/);
    h.service.config.rebuild = { id: 'rebuild-1', sessionId: h.agent.id };
    // The authorized rebuild runs on the next quiet daytime tick, without waiting for the next 04:00 slot.
    mock.timers.setTime(at(4, 12));
    await h.service.tick(at(4, 12));
    book = await h.service.load(h.agent.session);
    assert.equal(book.rebuilds['rebuild-1'], 'completed');
    assert.equal(book.lastSlot, at(4, 4), 'a daytime rebuild does not consume the night');
    assert.equal(book.episodes.filter(e => e.summary).length, 1);
    mock.timers.setTime(at(5, 4));
    const report = await h.service.run(h.agent);
    assert.equal(report.transitions.some(line => /rebuild rebuild-1/.test(line)), false, 'the night after does not rebuild again');
    book = await h.service.load(h.agent.session);
    assert.equal(book.rebuilds['rebuild-1'], 'completed');
    assert.deepEqual(book.episodes.map(e => e.day), ['2026-01-01', '2026-01-02', '2026-01-03']);
    const shown = visible(h.agent.session);
    assert.equal(shown.includes('legacy checkpoint'), false);
    assert.match(shown, /## 01-01 周四 · 已淡化[\s\S]*旧检查点之前的对话/);
    assert.match(shown, /## 01-02 周五 · 已淡化/);
    assert.match(shown, /第三天：起点之后的对话/);
    assert.equal(historyMessage(h.agent.session).length, 1);
    const page = await h.tool('experience_read', { episode_id: book.episodes[1].id, max_chars: 200 });
    assert.match(page.content[0].text, /没有归档的对话/);
    await h.restart();
    const again = await h.service.run(h.agent);
    assert.equal(again.transitions.some(line => /rebuild rebuild-1/.test(line)), false);
    assert.deepEqual((await h.service.load(h.agent.session)).episodes.map(e => e.day), ['2026-01-01', '2026-01-02', '2026-01-03']);
    strictReplay(h.agent.session);
  } finally { await h?.close(); mock.timers.reset(); }
});

test('photos from faded days gather on one contact sheet and reminder turns join the day archive', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  let h;
  try {
    h = await harness({ progressive: progressive() });
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(400, 300); const g = canvas.getContext('2d'); g.fillStyle = '#4477aa'; g.fillRect(0, 0, 400, 300);
    const [photo] = await h.ctx.attachments.saveImages([{ data: canvas.toBuffer('image/png'), mediaType: 'image/png', name: 'tree.png' }]);
    mock.timers.setTime(at(1, 9));
    h.agent.followup(createUserMessage({ content: [{ type: 'text', text: '看，这棵树。' }, { type: 'image', attachment: photo }], source: { kind: 'user' } }));
    await h.agent.whenIdle();
    await h.say('拍得还行吧。');
    // A reminder she scheduled herself starts a turn with no human message.
    mock.timers.setTime(at(2, 6));
    h.agent.followup(createUserMessage({ content: blocks('[提醒] 记得问问那棵树的事。'), source: { kind: 'schedule' } }));
    await h.agent.whenIdle();
    const reminderSeq = h.agent.session.snapshotEvents().findLast(e => e.type === 'user/message' && e.data.source.kind === 'schedule').seq;
    mock.timers.setTime(at(2, 9)); await h.say('第二天，树的事问过了。');
    mock.timers.setTime(at(3, 4)); await h.service.run(h.agent);
    let book = await h.service.load(h.agent.session);
    assert.equal(book.episodes.length, 2);
    assert.ok(book.episodes[1].from <= reminderSeq && reminderSeq <= book.episodes[1].to, 'the reminder turn belongs to day two');
    mock.timers.setTime(at(3, 9)); await h.say('第三天。');
    mock.timers.setTime(at(4, 4)); await h.service.run(h.agent);
    const composite = historyMessage(h.agent.session)[0];
    const image = composite.content.find(b => b.type === 'image');
    assert.ok(image, 'contact sheet attached');
    assert.ok(image.attachment.width <= 1536 && image.attachment.height <= 300);
    assert.match(JSON.stringify(composite.content), /\[照片印象\][^"]*01-01 #1/);
    assert.match(dayBlock(h.agent.session, '01-01'), /\[照片 #1\]/);
    book = await h.service.load(h.agent.session);
    assert.equal(book.history.sheetRef, image.attachment.attachmentId);
    const archive = await h.service.store.get(book.episodes[1].archive);
    assert.ok(archive.events.some(e => e.seq === reminderSeq));
    strictReplay(h.agent.session);
  } finally { await h?.close(); mock.timers.reset(); }
});
