import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { at, harness, respond, strictReplay } from './harness.mjs';
import { addNote, withdrawNote, consumeNotes, MAX_PENDING_NOTES } from '../lib/notes.js';

const dreamMeta = options => {
  const text = options.messages.findLast(m => m.source?.form === 'dream').content[0].text;
  return { text, known: JSON.parse(text.split('现有记忆与本次范围：\n')[1].split('\n\n本日原文')[0]) };
};
const parse = message => JSON.parse(message.content[0].text);

test('notes are validated locally: text, size, pending limit and the named memory', () => {
  const book = { version: 1, owner: 'o', capturedThrough: -1, lastSlot: 0, episodes: [{ id: 'ep', from: 0, to: 10 }], memories: [{ id: 'memory_a' }] };
  assert.throws(() => addNote(book, '   ', 3, 1), /needs text/);
  assert.throws(() => addNote(book, 'x'.repeat(2001), 3, 1), /at most 2000/);
  assert.throws(() => addNote(book, 'ok', 3, 1, 'memory_missing'), /existing memory ID/);
  let { book: next, note } = addNote(book, '  想起要记住这件事  ', 3, 1, 'memory_a');
  assert.equal(note.text, '想起要记住这件事'); assert.equal(note.about, 'memory_a'); assert.match(note.id, /^note_[0-9a-f]{16}$/);
  assert.equal(book.notes, undefined, 'the original book is untouched');
  for (let i = 1; i < MAX_PENDING_NOTES; i++) next = addNote(next, `note ${i}`, 3 + i, 1 + i).book;
  assert.throws(() => addNote(next, 'one too many', 99, 99), /withdraw one or wait/);
  assert.throws(() => withdrawNote(next, 'note_nope'), /No pending note/);
  const fewer = withdrawNote(next, note.id);
  assert.equal(fewer.notes.length, MAX_PENDING_NOTES - 1);
  const emptied = consumeNotes(fewer, fewer.notes.map(n => n.id));
  assert.equal(emptied.notes, undefined); assert.equal(fewer.notes.length, MAX_PENDING_NOTES - 1);
});

test('a daytime note waits for its day, is presented to that dream with its episode, makes its memory revisable, and is consumed once', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  let h;
  try {
    h = await harness({ historyCompression: false, notifications: true });
    await h.say('今天我们在公园散步，木牌上写着「雨后留香」。');
    mock.timers.setTime(at(1, 13));
    const added = parse(await h.tool('experience_note', { action: 'add', text: '阿林说下次想带相机来拍那棵树。' }, '这个我想记下来。'));
    assert.match(added.id, /^note_/); assert.equal(added.pending, 1);
    const dropped = parse(await h.tool('experience_note', { action: 'add', text: '随手写的，待会儿撤回。' }, '再记一条。'));
    let listed = parse(await h.tool('experience_note', { action: 'list' }, '看看便签。'));
    assert.equal(listed.pending, 2); assert.equal(listed.notes[0].waitsFor, 'the dream after its day is captured');
    listed = parse(await h.tool('experience_note', { action: 'withdraw', id: dropped.id }, '撤回那条。'));
    assert.equal(listed.withdrawn, dropped.id); assert.equal(listed.pending, 1);

    let seen, memoryId;
    h.adapter.dreamNext.push(options => {
      const { text, known } = dreamMeta(options);
      seen = known.daytimeNotes;
      assert.match(text, /daytimeNotes are notes you left during the day/);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].id, added.id); assert.equal(seen[0].episodeId, known.requiredEpisode); assert.equal(seen[0].day, known.day);
      assert.equal(seen[0].text, '阿林说下次想带相机来拍那棵树。'); assert.equal(seen[0].about, undefined);
      return respond(JSON.stringify({
        episodes: [{ id: known.requiredEpisode, summary: '公园散步，他想带相机再来。' }],
        memories: [{ text: '阿林想带相机再去公园拍那棵树。', kind: 'intention', state: 'active', evidence: [known.requiredEpisode] }],
      }));
    });
    mock.timers.setTime(at(2, 4));
    assert.equal((await h.service.run(h.agent)).dreams, 1);
    let book = await h.service.load(h.agent.session);
    assert.equal(book.notes, undefined, 'the presented note is consumed');
    assert.match(book.lastReceipt.text, /已完成并保存/); assert.match(book.lastReceipt.text, /处理白天便签 1 条/);
    let artifact = await h.service.store.get(book.dreams.at(-1));
    assert.deepEqual(artifact.noteIds, [added.id]); assert.equal(artifact.complete, true);
    memoryId = book.memories.find(m => m.kind === 'intention').id;

    // A note left after the dream waits for the next day's dream and may name the new memory.
    mock.timers.setTime(at(2, 15));
    await h.say('今天真的带相机去了，拍到了。');
    const about = parse(await h.tool('experience_note', { action: 'add', text: '相机已经带去了，这个意图完成了。', about: memoryId }, '记一下。'));
    listed = parse(await h.tool('experience_note', { action: 'list' }, '看看便签。'));
    assert.equal(listed.pending, 1); assert.equal(listed.notes[0].about, memoryId);
    assert.equal(listed.notes[0].waitsFor, 'the dream after its day is captured');

    h.adapter.dreamNext.push(options => {
      const { known } = dreamMeta(options);
      assert.equal(known.daytimeNotes.length, 1); assert.equal(known.daytimeNotes[0].id, about.id);
      assert.equal(known.daytimeNotes[0].about, memoryId);
      assert.ok(known.memories.some(m => m.id === memoryId), 'the named memory is presented so she may revise it');
      const current = known.memories.find(m => m.id === memoryId);
      return respond(JSON.stringify({
        episodes: [{ id: known.requiredEpisode, summary: '带相机去了公园，拍到了那棵树。' }],
        memories: [{ id: memoryId, text: current.text, kind: current.kind, state: 'dormant', evidence: [...current.evidence, known.requiredEpisode] }],
      }));
    });
    mock.timers.setTime(at(3, 4));
    assert.equal((await h.service.run(h.agent)).dreams, 1);
    book = await h.service.load(h.agent.session);
    assert.equal(book.notes, undefined);
    assert.equal(book.memories.find(m => m.id === memoryId).state, 'dormant');
    artifact = await h.service.store.get(book.dreams.at(-1));
    assert.deepEqual(artifact.noteIds, [about.id]); assert.equal(artifact.corrections, 0);
    strictReplay(h.agent.session);
  } finally { await h?.close(); mock.timers.reset(); }
});

test('a failed dream keeps its notes for the next attempt', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  let h;
  try {
    h = await harness({ historyCompression: false, notifications: true });
    await h.say('今天聊了很多。');
    const added = parse(await h.tool('experience_note', { action: 'add', text: '别忘了这件事。' }, '记一下。'));
    const wrong = options => respond(JSON.stringify({ episodes: [{ id: dreamMeta(options).known.requiredEpisode, summary: '总结。' }],
      memories: [{ text: '便签当证据。', kind: 'experience', state: 'active', evidence: [added.id] }] }));
    h.adapter.dreamNext.push(wrong, wrong, wrong);
    mock.timers.setTime(at(2, 4));
    await assert.rejects(h.service.run(h.agent), /validation failed after 2 correction rounds/);
    const book = await h.service.load(h.agent.session);
    assert.equal(book.notes.length, 1); assert.equal(book.notes[0].id, added.id);
    const feedback = h.agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.message?.source?.form === 'dream-feedback');
    assert.equal(feedback.length, 0, 'feedback lives in the fork, not the parent session');
    assert.equal(book.dreams, undefined);
  } finally { await h?.close(); mock.timers.reset(); }
});
