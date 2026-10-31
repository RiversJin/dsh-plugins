import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { Session, SessionId, SessionLogOffset, buildForkSeed } from '@deepseek-ai/dsh-session';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import LocalAttachments from '@deepseek-ai/dsh-attachment-local';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Projections from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import * as Dream from '../lib/index.js';
import { DEFAULT_CONFIG, DAY } from '../lib/types.js';
import { ageDays, desiredStage, slotAt } from '../lib/policy.js';
import { applyProposal } from '../lib/dream.js';
import { capture, compressionTranscript, episodeNodes, sourceOf, transcript } from '../lib/history.js';

import { at, blocks, respond, harness, visible, strictReplay } from './harness.mjs';

test('native nightly dream leaves yesterday verbatim, then chooses cheaper text, authored summary and recallable history', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness();
  try {
    await h.say('今天一起去公园散步。下次想再看看那棵树。');
    const original = [...h.agent.session.snapshotEvents()];
    mock.timers.setTime(at(2, 4));
    const dreamed = await h.service.run(h.agent);
    assert.equal(dreamed.dreams, 1); assert.deepEqual(dreamed.transitions, []);
    let book = await h.service.load(h.agent.session);
    assert.equal(book.episodes.length, 1);
    const e = book.episodes[0];
    assert.match(visible(h.agent.session), /今天一起去公园散步/);
    assert.equal(visible(h.agent.session).includes('夜间记忆整理'), false);
    assert.deepEqual(h.agent.session.snapshotEvents().slice(0, original.length), original);
    const request = h.adapter.requests.find(r => r.purpose === 'compaction');
    assert.equal(request.model, 'same-self'); assert.notEqual(request.sessionId, h.agent.id);
    assert.deepEqual(request.tools.map(t => t.name), ['experience_search', 'experience_read', 'trajectory_read']);
    const forkArchive = await h.service.store.get(book.dreams[0]);
    assert.equal(forkArchive.inheritedMessagesHash, forkArchive.requestPrefixHash);
    assert.equal(forkArchive.supplementalDay, false);
    assert.equal(request.system, undefined);
    assert.match(JSON.stringify(request.messages.slice(0, -1)), /今天一起去公园散步/);
    const prefixArchive = await h.service.store.get(forkArchive.parentPrefix);
    const nativeFork = Session.create(SessionId(forkArchive.header.id), [...prefixArchive.events, ...forkArchive.events], forkArchive.header, SessionLogOffset(forkArchive.inheritedEventCount));
    strictReplay(nativeFork);
    assert.equal(nativeFork.snapshotEvents().at(-1).data.reason.kind, 'completed');
    assert.equal(h.ctx.agents.list().length, 1);
    assert.ok(book.memories[0].evidence.includes(e.id));
    strictReplay(h.agent.session);
    assert.equal((await h.service.run(h.agent)).dreams, 0);

    mock.timers.setTime(at(3, 4));
    const choice = await h.service.run(h.agent);
    const text = h.agent.session.deriveMessages().find(m => m.source.kind === Dream.SOURCE && m.source.stage === 'text');
    assert.match(JSON.stringify(text.content), /今天一起去公园散步/);
    assert.ok(choice.transitions.some(line => /text \d+, image \d+ tokens; text selected/.test(line)));
    const decided = h.agent.session.snapshotEvents().length;
    assert.deepEqual(await h.service.age(h.agent, book, Date.now(), new AbortController().signal), []);
    assert.equal(h.agent.session.snapshotEvents().length, decided);
    strictReplay(h.agent.session);

    mock.timers.setTime(at(8, 4));
    const reviewed = await h.service.run(h.agent);
    assert.equal(reviewed.dreams, 0);
    mock.timers.setTime(at(9, 4));
    assert.equal((await h.service.run(h.agent)).dreams, 1);
    const reviewedBook = await h.service.load(h.agent.session);
    assert.equal(reviewedBook.episodes.length, 1);
    assert.equal(reviewedBook.memories[0].revision, 1);
    assert.equal(reviewedBook.memories[0].reviewedAt, at(9, 4));
    assert.match(visible(h.agent.session), /我们一起在公园散步，聊起雨后的气味/);
    assert.equal(h.agent.session.deriveMessages().some(m => m.source.kind === Dream.SOURCE && m.source.stage === 'image'), false);
    strictReplay(h.agent.session);

    mock.timers.setTime(at(22, 4));
    await h.service.run(h.agent);
    assert.equal(visible(h.agent.session).includes(e.summary), false);
    book = await h.service.load(h.agent.session);
    assert.equal(book.episodes[0].id, e.id);
    const archive = await h.service.store.get(e.archive);
    assert.deepEqual(archive.events, original.slice(e.from, e.to + 1));
    const result = await h.tool('experience_read', { episode_id: e.id, max_chars: 80 });
    assert.match(result.content[0].text, /公园散步/);
    assert.match(result.content[0].text, /nextOffset=80/);
    const rest = await h.tool('experience_read', { episode_id: e.id, offset: 80, max_chars: 80 }, '接着看看原来的后半段。');
    const firstPage = result.content[0].text.split('\n[nextOffset=')[0];
    const secondPage = rest.content[0].text.split('\n[nextOffset=')[0];
    assert.equal(firstPage + secondPage, transcript(archive).text);
    const state = await h.service.load(h.agent.session);
    assert.equal(state.episodes[0].startAt, e.startAt);
    const requestAfterRecall = h.adapter.requests.at(-1);
    assert.equal(JSON.stringify(requestAfterRecall.messages).includes('夜间记忆整理'), false);
    assert.equal(requestAfterRecall.messages.some(m => m.source?.kind === Dream.SOURCE && m.source.form === 'book'), false);
    strictReplay(h.agent.session);
    await h.restart();
    assert.equal((await h.service.load(h.agent.session)).episodes[0].id, e.id);
    await h.say('公园散步');
    const recalled = JSON.stringify(h.adapter.requests.at(-1).messages);
    assert.match(recalled, /与眼前话题相关的已有记忆/);
    strictReplay(h.agent.session);
  } finally { await h.close(); mock.timers.reset(); }
});

test('current memory revision is searchable, and an earlier native fork retains its own version', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness();
  try {
    await h.say('我们去公园散步，下次还想来。');
    mock.timers.setTime(at(2, 4)); await h.service.run(h.agent);
    const old = await h.service.load(h.agent.session);
    const events = h.agent.session.snapshotEvents();
    const forkId = SessionId(randomUUID());
    const fork = Session.create(forkId, buildForkSeed(events, events.length - 1), {
      ...h.agent.session.header, id: forkId, parentSession: h.agent.id, createdAt: Date.now(), isSeeded: true,
    }, SessionLogOffset(events.length));
    const e = old.episodes[0], m = old.memories[0];
    const updated = applyProposal(old, { episodes: [], memories: [{ id: m.id, text: '公园散步安排在周末，我们现在喜欢清晨去。', kind: 'experience', state: 'active', evidence: [e.id] }] }, [], at(3), h.service.config);
    await h.agent.runMaintenance(async () => h.service.save(h.agent, updated));
    const hits = await h.service.recall.search(await h.service.load(h.agent.session), '公园散步');
    const hit = hits.find(row => row.id === m.id);
    assert.equal(hit.revision, 2); assert.match(hit.text, /清晨/);
    assert.equal((await h.service.load(fork)).memories[0].revision, 1);
    assert.equal((await h.service.load(fork)).owner, fork.id);
    const resting = applyProposal(updated, { episodes: [], memories: [{ id: m.id, text: '清晨的公园散步约定已经一起完成，留作回忆。', kind: 'experience', state: 'dormant', evidence: [e.id] }] }, [], at(4), h.service.config);
    await h.agent.runMaintenance(async () => h.service.save(h.agent, resting));
    const automatic = await h.service.recall.search(await h.service.load(h.agent.session), '公园散步');
    assert.deepEqual(automatic.map(row => row.id), [e.id]);
    const searched = await h.tool('experience_search', { query: '公园散步' });
    const explicit = JSON.parse(searched.content[0].text).find(row => row.id === m.id);
    assert.equal(explicit.state, 'dormant');
    assert.equal(explicit.revision, 3);
    assert.equal((await h.service.load(h.agent.session)).memories[0].state, 'dormant');
    assert.equal((await h.service.load(fork)).memories[0].revision, 1);
    strictReplay(h.agent.session); strictReplay(fork);
  } finally { await h.close(); mock.timers.reset(); }
});

test('a model-authored retention extension keeps just that episode longer', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness();
  try {
    await h.say('这周的公园散步约定还在延续。');
    mock.timers.setTime(at(2, 4)); await h.service.run(h.agent);
    const book = await h.service.load(h.agent.session), e = book.episodes[0];
    const updated = applyProposal(book, { episodes: [{ id: e.id, summary: e.summary, keepUntil: at(30), keepReason: '共同的安排还在继续，想多留一阵。' }], memories: [] }, [], at(2), h.service.config);
    await h.agent.runMaintenance(async () => h.service.save(h.agent, updated));
    mock.timers.setTime(at(22, 4)); await h.service.run(h.agent);
    assert.match(visible(h.agent.session), /我们一起在公园散步/);
    mock.timers.setTime(at(31, 4)); await h.service.run(h.agent);
    assert.equal(visible(h.agent.session).includes(e.summary), false);
    strictReplay(h.agent.session);
  } finally { await h.close(); mock.timers.reset(); }
});

test('calendar uses the 04:00 boundary and full-day tier ages', () => {
  const p = DEFAULT_CONFIG;
  assert.equal(slotAt(at(2, 3), p), at(1, 4));
  assert.equal(slotAt(at(2, 4), p), at(2, 4));
  const e = { endAt: at(1, 23), summary: '一次共同经历' };
  assert.equal(ageDays(e, at(4, 4), p), 3);
  assert.equal(desiredStage(e, at(3, 3), p), 'raw');
  assert.equal(desiredStage(e, at(3, 4), p), 'image');
  assert.equal(desiredStage(e, at(8, 4), p), 'summary');
  assert.equal(desiredStage(e, at(21, 4), p), 'summary');
  assert.equal(desiredStage(e, at(22, 4), p), 'recalled');
  assert.equal(p.maxSummaryDays, 30);
});

test('04:00 scheduler consolidates a new day and revises the same memory the following night', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness();
  try {
    await h.say('公园散步，以后也想一起去。');
    mock.timers.setTime(at(2, 4)); await h.service.tick();
    let book = await h.service.load(h.agent.session);
    const memory = book.memories[0];
    assert.ok(memory);
    await h.service.tick();
    assert.equal(h.adapter.requests.filter(r => r.purpose === 'compaction').length, 1);
    mock.timers.setTime(at(2, 12));
    await h.say('公园散步我们改到清晨吧，也想看看日出。');
    h.adapter.proposal = meta => ({
      episodes: [{ id: meta.requiredEpisode, summary: '今天把公园散步改到清晨，想一起看看日出。' }],
      memories: [{ id: memory.id, text: '我们想在清晨去公园散步，一起看日出。', kind: 'experience', state: 'active', evidence: [...memory.evidence, meta.requiredEpisode] }],
    });
    mock.timers.setTime(at(3, 4)); await h.service.tick();
    book = await h.service.load(h.agent.session);
    assert.equal(book.memories.length, 1);
    assert.equal(book.memories[0].id, memory.id);
    assert.equal(book.memories[0].revision, 2);
    assert.equal(book.episodes.length, 2);
    assert.equal(book.memories[0].evidence.length, 2);
    await h.say('公园散步');
    assert.match(JSON.stringify(h.adapter.requests.at(-1).messages), /清晨去公园散步/);
    strictReplay(h.agent.session);
  } finally { await h.close(); mock.timers.reset(); }
});

test('independent query helper reads recent dialogue, disables thinking, and routes a contextual query into recall', async () => {
  const { createServer } = await import('node:http');
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness();
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ recall: true, queries: ['公园散步'] }) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const beforeEnv = process.env.DREAM_TEST_QUERY_KEY;
  process.env.DREAM_TEST_QUERY_KEY = 'local-test-only';
  try {
    await h.say('我们一起去公园散步，记得那棵树。');
    mock.timers.setTime(at(2, 4)); await h.service.run(h.agent);
    h.service.config.queryApiUrl = `http://127.0.0.1:${server.address().port}`;
    h.service.config.queryApiKeyEnv = 'DREAM_TEST_QUERY_KEY';
    await h.say('后来我们还有没有再去看它？');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].thinking.type, 'disabled');
    const input = JSON.parse(requests[0].messages[1].content);
    assert.equal(input[0].role, 'user');
    assert.match(input[0].text, /公园散步/);
    assert.equal(input.at(-1).text, '后来我们还有没有再去看它？');
    assert.equal(h.service.planner.lastMode, 'deepseek');
    const model = h.adapter.requests.at(-1);
    assert.match(JSON.stringify(model.messages), /与眼前话题相关的已有记忆/);
    const revision = (await h.service.load(h.agent.session)).memories[0].revision;
    await h.say('那段公园散步的回忆呢？');
    const recalls = h.adapter.requests.at(-1).messages.filter(m => m.source?.form === 'recall');
    assert.equal(recalls.length, 0);
    assert.equal((await h.service.load(h.agent.session)).memories[0].revision, revision);
    strictReplay(h.agent.session);
  } finally {
    if (beforeEnv === undefined) delete process.env.DREAM_TEST_QUERY_KEY; else process.env.DREAM_TEST_QUERY_KEY = beforeEnv;
    await new Promise(resolve => server.close(resolve)); await h.close(); mock.timers.reset();
  }
});

test('night review selects due memories plus a small random sample, including dormant records', async () => {
  const { selectReview } = await import('../lib/review.js');
  mock.timers.enable({ apis: ['Date'], now: at(10) });
  try {
    const book = Dream.emptyBook('sample-review');
    book.memories = Array.from({ length: 8 }, (_, i) => ({ id: `memory-${i}`, text: `第 ${i + 1} 次共同散步的记忆。`,
      kind: 'experience', state: i === 2 ? 'dormant' : 'active', evidence: ['episode-walk'], revision: 1,
      createdAt: at(1), updatedAt: at(9), nextReviewAt: i === 0 ? at(9) : at(20) }));
    const before = structuredClone(book);
    const selected = await selectReview(book, { id: 'episode-walk' }, [], DEFAULT_CONFIG, new AbortController().signal, () => 0);
    assert.deepEqual(selected.map(m => m.id), ['memory-0', 'memory-1', 'memory-2', 'memory-3']);
    assert.equal(selected[2].state, 'dormant');
    assert.deepEqual(book, before);
  } finally { mock.timers.reset(); }
});

test('a later dream inherits existing optical images and the continuing dialogue without repeating the day', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness();
  try {
    let priced = 0;
    h.adapter.imageRequestPricing = () => ({ priceImages: images => images.map(() => {
      priced++; return { visualTokens: 1200, text: '[request image handle]' };
    }) });
    await h.say('今天在公园散步，看到了那棵树。'.repeat(2000));
    mock.timers.setTime(at(2, 4)); await h.service.run(h.agent);
    mock.timers.setTime(at(4, 4)); const choice = await h.service.run(h.agent);
    const image = h.agent.session.deriveMessages().flatMap(m => m.content).find(b => b.type === 'image');
    assert.ok(image);
    assert.ok(priced > 0);
    assert.ok(choice.transitions.some(line => /image selected/.test(line)));
    const saved = await h.ctx.attachments.readImage(image.attachment);
    assert.ok(saved); assert.ok(image.attachment.width > 0);
    await h.say('今天又去看了那棵树，叶子已经开始变黄了。');
    mock.timers.setTime(at(5, 4)); await h.service.run(h.agent);
    const request = h.adapter.requests.at(-1);
    assert.equal(request.purpose, 'compaction');
    assert.ok(request.messages.flatMap(m => m.content).some(b => b.type === 'image' && b.attachment.attachmentId === image.attachment.attachmentId));
    const book = await h.service.load(h.agent.session);
    const archive = await h.service.store.get(book.dreams.at(-1));
    assert.equal(archive.supplementalDay, false);
    assert.equal(archive.inheritedMessagesHash, archive.requestPrefixHash);
    assert.match(JSON.stringify(request.messages.slice(0, -1)), /叶子已经开始变黄/);
    strictReplay(h.agent.session);
  } finally { await h.close(); mock.timers.reset(); }
});

test('a dream reads compacted archives on demand and continues within its own native session', async () => {
  const Trajectory = await import(process.env.DREAM_TRAJECTORY_MODULE ?? '@riversjin/dsh-trajectory');
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ historyCompression: false });
  const requested = (...calls) => [...calls.flatMap(([name, args], index) => [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) } },
  ]), { type: 'finish', reason: { kind: 'tool-calls' } }];
  try {
    await h.ctx.plugin(Trajectory, { archiveDir: join(h.root, 'trajectory') });
    await h.tool('trajectory_anchor', { label: '一起散步' });
    await h.say('公园树下的木牌写着「雨后留香」，我们想下次再来看看。');
    const anchor = h.ctx.sessionProjections.stateOf(h.agent.session, 'trajectory').anchor;
    await h.tool('trajectory_compact', { anchor_id: anchor.id, summary: '我们在公园散步，下次还想再来。' });
    const before = h.agent.session.snapshotEvents();
    const archived = { version: 1, owner: h.agent.id, from: 0, to: before.length - 1, events: before };
    const material = compressionTranscript(archived, h.agent.session, h.agent.session.surface.nodes);
    assert.match(material.text, /我们在公园散步，下次还想再来/);
    assert.equal(material.text.includes('雨后留香'), false);
    assert.deepEqual(h.agent.session.snapshotEvents(), before);
    // A later cleanup/replacement keeps the summary attached to its source day.
    const copy = strictReplay(h.agent.session);
    const summarySeq = copy.surface.nodes.find(seq => copy.eventAt(seq).type === 'user/message'
      && copy.eventAt(seq).data.source.form === 'summary');
    const summaryMessage = copy.eventAt(summarySeq).data;
    const replacement = copy.append('user/message', createUserMessage({ content: summaryMessage.content, source: summaryMessage.source }), {
      surfaceOp: { op: 'replace', startSeq: summarySeq, endSeq: summarySeq }, sourceEventSeqs: [summarySeq],
    });
    const selected = episodeNodes(copy, { id: 'existing-day', from: archived.from, to: archived.to });
    assert.ok(selected.includes(replacement.seq));
    assert.equal(compressionTranscript(archived, copy, selected).text, material.text);
    strictReplay(copy);
    let episodeId, nextOffset;
    h.adapter.dreamNext.push(options => {
      const text = options.messages.findLast(m => m.source?.form === 'dream').content[0].text;
      episodeId = JSON.parse(text.split('现有记忆与本次范围：\n')[1].split('\n\n本日原文')[0]).requiredEpisode;
      assert.equal(JSON.stringify(options.messages).includes('雨后留香'), false);
      const calls = requested(['trajectory_read', {}], ['experience_read', { episode_id: episodeId, max_chars: 20 }]);
      calls.at(-1).replayState = { response: { continuation: 'archive-read-round' } };
      return [
        { type: 'block-start', index: 2, blockType: 'reasoning' },
        { type: 'block-end', index: 2, block: { type: 'reasoning', text: '查阅散步记录。' } }, ...calls,
      ];
    }, options => {
      const previous = options.messages.findLast(m => m.role === 'assistant');
      assert.ok(previous.content.some(b => b.type === 'reasoning' && b.text === '查阅散步记录。'));
      assert.deepEqual(previous.source.replayState, { response: { continuation: 'archive-read-round' } });
      const results = options.messages.filter(m => m.role === 'tool').slice(-2).map(m => JSON.parse(m.content[0].text));
      assert.equal(results[0].archives.length, 1);
      nextOffset = results[1].nextOffset; assert.ok(nextOffset > 0);
      return requested(['trajectory_read', { archive_id: results[0].archives[0].id }],
        ['experience_read', { episode_id: episodeId, offset: nextOffset }]);
    }, options => {
      const results = options.messages.filter(m => m.role === 'tool').slice(-2);
      assert.ok(results.every(m => !m.isError));
      assert.match(JSON.stringify(results), /雨后留香/);
      return requested(['experience_search', { query: '公园散步' }]);
    });
    mock.timers.setTime(at(2, 4));
    assert.equal((await h.service.run(h.agent)).dreams, 1);
    const book = await h.service.load(h.agent.session), artifact = await h.service.store.get(book.dreams.at(-1));
    assert.equal(artifact.supplementChars, 0); assert.deepEqual(artifact.supplementedMessageIds, []);
    assert.equal(artifact.inheritedMessagesHash, artifact.requestPrefixHash);
    assert.equal(artifact.requests.length, 4);
    assert.equal(JSON.stringify(artifact.events).includes('查阅散步记录。'), false);
    assert.equal(JSON.stringify(artifact.events).includes('archive-read-round'), false);
    assert.equal(artifact.events.filter(e => e.type === 'tool/call').length, 5);
    assert.ok(artifact.events.filter(e => e.type === 'tool/result').every(e => !e.data.message.isError));
    assert.deepEqual(h.agent.session.snapshotEvents().slice(0, before.length), before);
    assert.equal(h.ctx.sessionProjections.stateOf(h.agent.session, 'trajectory').anchor, null);
    assert.equal(h.ctx.agents.list().length, 1);
    const prefix = await h.service.store.get(artifact.parentPrefix);
    strictReplay(Session.create(SessionId(artifact.header.id), [...prefix.events, ...artifact.events], artifact.header, SessionLogOffset(artifact.inheritedEventCount)));
    strictReplay(h.agent.session);
  } finally { await h.close(); mock.timers.reset(); }
});

test('two authored JSON sections retain the original summary and memory text', async () => {
  const { parseProposal } = await import('../lib/dream.js');
  const episodes = [{ id: 'episode-walk', summary: '我们一起在公园散步，记住了雨后的气味。' }];
  const memories = [{ text: '想再一起看看那棵树。', kind: 'intention', state: 'active', evidence: ['episode-walk'] }];
  assert.deepEqual(parseProposal(`${JSON.stringify({ episodes })}\n\n${JSON.stringify({ memories })}`), { episodes, memories });
});

test('prose and Markdown around JSON sections preserve authored strings and identifiers', async () => {
  const { parseProposal } = await import('../lib/dream.js');
  const episodes = [{ id: 'episode-walk', summary: '我记下了「{雨后}」和他说的 "下次再来"。\n原话继续保留。' }];
  const memories = [{ text: '想再一起看看那棵树。', kind: 'intention', state: 'active', evidence: ['episode-walk'] }];
  assert.deepEqual(parseProposal(`日记写完，落笔归档。\n\n${JSON.stringify({ episodes, memories })}\n整理完毕。`), { episodes, memories });
  assert.deepEqual(parseProposal(`经历总结：\n\x60\x60\x60json\n${JSON.stringify({ episodes })}\n\x60\x60\x60\n长期记忆：\n\x60\x60\x60json\n${JSON.stringify({ memories })}\n\x60\x60\x60\n整理完毕。`), { episodes, memories });
});

test('a narrated final JSON response commits once and survives native session restart', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness();
  const summary = '雨后我们一起散步，约好下次再看那棵树。';
  try {
    await h.say('今天一起在公园散步。');
    let authored;
    h.adapter.dreamNext.push(options => {
      const text = options.messages.findLast(m => m.source?.form === 'dream').content[0].text;
      const meta = JSON.parse(text.split('现有记忆与本次范围：\n')[1].split('\n\n本日原文')[0]);
      authored = `日记写完，落笔归档。\n\n${JSON.stringify({ episodes: [{ id: meta.requiredEpisode, summary }], memories: [{ text: '想再一起看看那棵树。', kind: 'intention', state: 'active', evidence: [meta.requiredEpisode] }] })}\n整理完毕。`;
      return respond(authored);
    });
    mock.timers.setTime(at(2, 4));
    assert.equal((await h.service.run(h.agent)).dreams, 1);
    const before = await h.service.load(h.agent.session);
    assert.equal(before.episodes[0].summary, summary);
    assert.equal(before.memories.length, 1);
    const fork = await h.service.store.get(before.dreams[0]);
    assert.equal(fork.complete, true);
    assert.equal(fork.events.findLast(e => e.type === 'assistant/message').data.message.content[0].text, authored);
    await h.restart();
    assert.equal((await h.service.run(h.agent)).dreams, 0);
    const after = await h.service.load(h.agent.session);
    assert.deepEqual(after.episodes, before.episodes);
    assert.deepEqual(after.memories, before.memories);
    assert.deepEqual(after.dreams, before.dreams);
    strictReplay(h.agent.session);
  } finally { await h.close(); mock.timers.reset(); }
});

test('night scheduler queues main-model closure once, resumes after its real compaction and keeps the dream anchor-free', async () => {
  const Trajectory = await import(process.env.DREAM_TRAJECTORY_MODULE ?? '@riversjin/dsh-trajectory');
  const { unclosedDreamAnchors } = await import('../lib/history.js');
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ quietMinutes: 10 });
  const tasks = [];
  h.ctx.provide('schedule', {
    catalog: async () => tasks,
    create: async (sessionId, request) => { const task = { id: 'dream-anchor-handoff', sessionId, ...request }; tasks.push(task); return task; },
  });
  try {
    await h.ctx.plugin(Trajectory, { archiveDir: join(h.root, 'trajectory'), autoAnchorToolCalls: 2 });
    if (process.env.DREAM_TRAJECTORY_MODULE) {
      await h.tool('experience_recall', { action: 'status' });
      await h.tool('experience_search', { query: '公园散步' });
    } else await h.tool('trajectory_anchor', { label: '一起回顾公园散步' });
    await h.say('今天散步时看见了新叶，想留住这段经历。');
    const first = unclosedDreamAnchors(h.agent.session)[0];
    assert.equal(first.kind, 'work');
    mock.timers.setTime(at(2, 4));
    const before = h.agent.session.snapshotEvents();
    const deferred = await h.service.run(h.agent);
    assert.match(deferred.deferred, /等待本人收束锚点/);
    assert.equal(deferred.dreams, 0);
    assert.deepEqual(h.agent.session.snapshotEvents().slice(0, before.length), before);
    assert.equal(tasks.length, 1); assert.equal(tasks[0].sessionId, h.agent.id);
    assert.ok(tasks[0].prompt.includes(first.id));
    assert.equal((await h.service.load(h.agent.session)).attempts ?? 0, 0);
    await h.restart(); await h.service.run(h.agent);
    assert.equal(tasks.length, 1);
    assert.equal(h.adapter.requests.filter(r => r.purpose === 'compaction').length, 0);
    mock.timers.setTime(Date.now() + 1000);
    h.adapter.next.push([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name: 'trajectory_compact', arguments: JSON.stringify({ anchor_id: first.id, summary: '我们一起在公园散步，看到了新叶，想下次再来。' }) } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ], respond('已完成收束。'));
    h.agent.followup(createUserMessage({ content: blocks(tasks[0].prompt), source: { kind: 'schedule' } }));
    await h.agent.whenIdle();
    assert.ok(h.adapter.requests.some(r => r.purpose !== 'compaction' && r.messages.some(m => m.source.kind === 'schedule')));
    assert.deepEqual(unclosedDreamAnchors(h.agent.session), []);
    // Completion immediately unlocks the next scheduler check, even with the
    // normal ten-minute quiet period and a just-finished main-model turn.
    await h.service.tick();
    assert.equal(h.adapter.requests.filter(r => r.purpose === 'compaction').length, 1);
    assert.deepEqual(unclosedDreamAnchors(h.agent.session), []);
    const book = await h.service.load(h.agent.session);
    assert.equal(book.anchorHandoff, undefined); assert.equal(book.lastSlot, at(2, 4));
    const dreamArchive = await h.service.store.get(book.dreams.at(-1));
    const prefix = await h.service.store.get(dreamArchive.parentPrefix);
    const fork = Session.create(SessionId(dreamArchive.header.id), [...prefix.events, ...dreamArchive.events], dreamArchive.header, SessionLogOffset(dreamArchive.inheritedEventCount));
    assert.deepEqual(unclosedDreamAnchors(fork), []);
    strictReplay(fork);
    await h.tool('trajectory_anchor', { label: '醒来后新的散步计划' }, '今天我们再安排一次散步。');
    assert.notEqual(unclosedDreamAnchors(h.agent.session)[0].id, first.id);
    strictReplay(h.agent.session);
  } finally { await h.close(); mock.timers.reset(); }
});

test('shadow nights write editable memories while daytime recall and every history tier stay with the existing system', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ shadow: true, notBefore: at(2, 4) });
  try {
    await h.say('今天一起去公园散步，下次也想一起去。');
    const original = h.agent.session.deriveMessages();
    await h.service.tick();
    assert.equal(h.adapter.requests.filter(r => r.purpose === 'compaction').length, 0);
    assert.equal((await h.service.load(h.agent.session)).episodes.length, 0);
    mock.timers.setTime(at(2, 4));
    await h.service.tick();
    let book = await h.service.load(h.agent.session);
    assert.equal(book.memories.length, 1);
    assert.equal(book.dreams.length, 1);
    const memory = book.memories[0];
    h.service.planner.plan = () => { throw new Error('Shadow daytime must never request a query plan'); };
    let searches = 0;
    h.service.recall.search = async () => { searches++; return []; };
    await h.say('公园散步');
    assert.equal(searches, 0);
    const request = h.adapter.requests.at(-1);
    assert.equal((request.tools ?? []).some(t => ['experience_search', 'experience_read'].includes(t.name)), false);
    assert.equal(JSON.stringify(request.messages).includes('与眼前话题相关的已有记忆'), false);
    assert.equal(request.messages.some(m => m.source?.kind === Dream.SOURCE), false);
    assert.match(JSON.stringify(request.messages), /影子模式/);
    h.adapter.proposal = meta => ({
      episodes: meta.requiredEpisode ? [{ id: meta.requiredEpisode, summary: '记起一起散步的轻松。' }] : [],
      memories: [{ id: memory.id, text: '我想继续记住一起散步的轻松。', kind: 'experience', state: 'active', evidence: memory.evidence }],
    });
    for (const day of [4, 9, 16, 23]) {
      mock.timers.setTime(at(day, 4));
      assert.deepEqual((await h.service.run(h.agent)).transitions, []);
      assert.deepEqual(await h.service.age(h.agent, book, Date.now(), new AbortController().signal), []);
      assert.deepEqual(h.agent.session.deriveMessages().slice(0, original.length), original);
    }
    book = await h.service.load(h.agent.session);
    assert.equal(book.memories[0].id, memory.id);
    assert.ok(book.memories[0].revision > 1);
    strictReplay(h.agent.session);
    await h.restart();
    assert.deepEqual((await h.service.load(h.agent.session)).memories, book.memories);
  } finally { await h.close(); mock.timers.reset(); }
});

test('shadow query helper enriches existing recall, labels the query, and clears the whole expired block in the dream fork', { skip: !process.env.DREAM_LEGACY_RECALL_MODULE }, async () => {
  const { registerRecall } = await import(process.env.DREAM_LEGACY_RECALL_MODULE);
  const { createServer } = await import('node:http');
  const requests = [], searches = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ recall: true, queries: ['公园 那棵树 散步'] }) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ shadow: true, legacyQueryHelper: true, queryApiUrl: `http://127.0.0.1:${server.address().port}`, queryApiKeyEnv: 'DREAM_TEST_QUERY_KEY' });
  const previousKey = process.env.DREAM_TEST_QUERY_KEY;
  process.env.DREAM_TEST_QUERY_KEY = 'local-test-only';
  try {
    await h.say('一起去公园散步，看看那棵树。');
    const logger = { info() {}, debug() {}, warn(message) { throw new Error(message); } };
    registerRecall(h.ctx, { tools: true, recall: { enabled: true, maxResults: 2, scoreThreshold: 0.6, timeoutMs: 3000, maxCharsPerMemory: 1000, maxTotalRecallChars: 2000 } }, {
      l1: { search: async (query, limit, options) => { searches.push({ query, limit, options }); return [{ id: 'park', type: 'experience', content: '曾一起在公园看树，记得雨后的气味。', score: 0.9 }]; } },
    }, logger, { get: () => ({ enabled: true, recall: true }) }, { get: () => 'auto', resolvedRecall: () => true }, h.root);
    await h.say('后来还去看过它吗？');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].thinking.type, 'disabled');
    assert.match(JSON.stringify(JSON.parse(requests[0].messages[1].content)), /那棵树/);
    assert.equal(searches[0].query, '公园 那棵树 散步');
    assert.equal(searches[0].limit, 2);
    assert.equal(searches[0].options.strictThreshold, true);
    const request = h.adapter.requests.at(-1);
    const recall = request.messages.find(m => m.source?.kind === 'plugin:memory' && m.source.form === 'recall');
    assert.match(JSON.stringify(recall.content), /本次检索词/);
    assert.match(JSON.stringify(recall.content), /曾一起在公园看树/);
    assert.equal(request.messages.at(-1).content[0].text, '后来还去看过它吗？');
    assert.equal(request.messages.some(m => m.source?.kind === Dream.SOURCE), false);
    // Existing cooldown still owns admission, including helper API spending.
    await h.say('还记得雨后的气味吗？');
    assert.equal(requests.length, 1);
    mock.timers.setTime(at(2, 4));
    const report = await h.service.run(h.agent);
    assert.equal(report.dreams, 1);
    const dreamRequest = h.adapter.requests.findLast(r => r.purpose === 'compaction');
    assert.equal(JSON.stringify(dreamRequest.messages).includes('本次检索词'), false);
    assert.equal(dreamRequest.messages.some(m => m.source?.kind === 'plugin:memory'), false);
    const book = await h.service.load(h.agent.session);
    const archive = await h.service.store.get(book.dreams[0]);
    const prefix = await h.service.store.get(archive.parentPrefix);
    assert.ok(prefix.events.some(e => e.type === 'user/message' && e.data.id === recall.id && e.data.content.length));
    const fork = Session.create(SessionId(archive.header.id), [...prefix.events, ...archive.events], archive.header, SessionLogOffset(archive.inheritedEventCount));
    strictReplay(fork);
    await h.say('今天一起去散步。');
    assert.equal(h.agent.session.deriveMessages().some(m => m.id === recall.id), false);
    strictReplay(h.agent.session);
  } finally {
    if (previousKey === undefined) delete process.env.DREAM_TEST_QUERY_KEY; else process.env.DREAM_TEST_QUERY_KEY = previousKey;
    await new Promise(resolve => server.close(resolve)); await h.close(); mock.timers.reset();
  }
});

test('each completed dream gets a fresh deadline even when the nightly batch lasts longer than one deadline', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ shadow: true, timeoutMs: 1000 });
  try {
    await h.say('今天一起在公园散步。');
    mock.timers.setTime(at(2));
    await h.say('今天一起看日出。');
    const original = h.agent.session.snapshotEvents();
    const stream = h.adapter.stream.bind(h.adapter);
    h.adapter.stream = async function* (options) {
      if (options.purpose === 'compaction') {
        await new Promise(resolve => setTimeout(resolve, 650));
        options.signal.throwIfAborted();
      }
      yield* stream(options);
    };
    mock.timers.setTime(at(3, 4));
    const started = performance.now();
    const report = await h.service.run(h.agent);
    assert.ok(performance.now() - started > h.service.config.timeoutMs);
    assert.equal(report.dreams, 2);
    const book = await h.service.load(h.agent.session);
    assert.equal(book.episodes.filter(e => e.summary).length, 2);
    assert.equal(book.attempts, 2);
    assert.equal(book.lastSlot, at(3, 4));
    assert.deepEqual(h.agent.session.snapshotEvents().slice(0, original.length), original);
    for (const ref of book.dreams) assert.equal((await h.service.store.get(ref)).complete, true);
    const calls = h.adapter.requests.filter(r => r.purpose === 'compaction');
    assert.notEqual(calls[0].signal, calls[1].signal);
    strictReplay(h.agent.session);
    await h.restart();
    assert.deepEqual(await h.service.load(h.agent.session), book);
  } finally { await h.close(); mock.timers.reset(); }
});

test('the chosen start day leaves older archives intact and summarizes only subsequent days', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(8) });
  const h = await harness({ shadow: true, backlogAlerts: true });
  try {
    await h.say('今天一起在公园散步。');
    mock.timers.setTime(at(9, 4));
    const archived = await capture(h.agent.session, await h.service.load(h.agent.session), h.service.store, Date.now(), h.service.config);
    await h.service.save(h.agent, archived);
    const oldEpisode = structuredClone(archived.episodes[0]);
    h.service.config.startDay = '2026-01-09';
    mock.timers.setTime(at(9)); await h.say('今天一起看日出。');
    mock.timers.setTime(at(10, 4));
    assert.equal((await h.service.run(h.agent)).dreams, 1);
    const book = await h.service.load(h.agent.session);
    assert.deepEqual(book.episodes[0], oldEpisode);
    assert.deepEqual(book.episodes.filter(e => e.summary).map(e => e.day), ['2026-01-09']);
    assert.equal((await h.service.run(h.agent)).dreams, 0);
    await h.service.warnBacklog(h.agent);
    assert.equal(book.health?.lastAlertSlot, undefined);
    mock.timers.setTime(at(10)); await h.say('今天一起看清晨的树。');
    mock.timers.setTime(at(11, 4));
    assert.equal((await h.service.run(h.agent)).dreams, 1);
    assert.deepEqual((await h.service.load(h.agent.session)).episodes[0], oldEpisode);
    mock.timers.setTime(at(11)); await h.say('今天也一起去看树。');
    mock.timers.setTime(at(20, 4));
    assert.equal((await h.service.run(h.agent)).dreams, 1);
    assert.ok((await h.service.load(h.agent.session)).episodes.find(e => e.day === '2026-01-11')?.summary);
    strictReplay(h.agent.session);
  } finally { await h.close(); mock.timers.reset(); }
});

test('a backlog notice uses the original session reminder route and survives restart without duplicate delivery', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ shadow: true });
  const tasks = [];
  h.ctx.provide('schedule', {
    catalog: async () => tasks,
    create: async (sessionId, request) => { const task = { id: 'schedule-notice', sessionId, ...request }; tasks.push(task); return task; },
  });
  try {
    await h.say('今天一起散步。');
    const slot = at(2, 4);
    // A positive notification-delivery fixture; no failed model response is introduced.
    await h.service.queueBacklogWarning(h.agent, '待整理状态提醒；原文已保留。', slot);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].sessionId, h.agent.id);
    assert.equal(tasks[0].after_seconds, 5);
    assert.match(tasks[0].prompt, /请简短告知用户/);
    assert.equal((await h.service.load(h.agent.session)).health.alertTaskId, 'schedule-notice');
    await h.restart();
    await h.service.queueBacklogWarning(h.agent, '待整理状态提醒；原文已保留。', slot);
    assert.equal(tasks.length, 1);
    assert.equal((await h.service.load(h.agent.session)).health.lastAlertSlot, slot);
    strictReplay(h.agent.session);
  } finally { await h.close(); mock.timers.reset(); }
});

test('recall and experience tools stay available with history compression disabled across all age tiers and restart', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ historyCompression: false });
  try {
    await h.say('今天一起去公园散步，下次再看那棵树。');
    const original = h.agent.session.deriveMessages();
    mock.timers.setTime(at(2, 4));
    assert.equal((await h.service.run(h.agent)).dreams, 1);
    const book = await h.service.load(h.agent.session), episode = book.episodes[0];
    await h.say('公园散步');
    const request = h.adapter.requests.at(-1);
    for (const name of ['experience_search', 'experience_read']) assert.ok(request.tools.some(t => t.name === name));
    assert.match(JSON.stringify(request.messages), /本记忆库不按天数替换或移除对话/);
    assert.ok(request.messages.some(m => m.source?.kind === Dream.SOURCE && m.source.form === 'recall'));
    const search = await h.tool('experience_search', { query: '2026-01-01' });
    assert.match(JSON.stringify(search.content), new RegExp(episode.id));
    assert.match(JSON.stringify(search.content), /我们一起在公园散步/);
    const read = await h.tool('experience_read', { episode_id: episode.id });
    assert.match(JSON.stringify(read.content), /今天一起去公园散步/);
    for (const day of [4, 9, 16, 23]) {
      mock.timers.setTime(at(day, 4));
      assert.deepEqual((await h.service.run(h.agent)).transitions, []);
      assert.deepEqual(await h.service.age(h.agent, await h.service.load(h.agent.session), Date.now(), new AbortController().signal), []);
      assert.deepEqual(h.agent.session.deriveMessages().slice(0, original.length), original);
      assert.equal(h.agent.session.snapshotEvents().some(e => sourceOf(e)?.form === 'episode'), false);
    }
    strictReplay(h.agent.session);
    await h.restart();
    await h.say('公园散步');
    assert.ok(h.adapter.requests.at(-1).messages.some(m => m.source?.kind === Dream.SOURCE && m.source.form === 'recall'));
    assert.deepEqual(h.agent.session.deriveMessages().slice(0, original.length), original);
    strictReplay(h.agent.session);
  } finally { await h.close(); mock.timers.reset(); }
});

test('old and new recall share one contextual helper request while retaining both stores', { skip: !process.env.DREAM_LEGACY_RECALL_MODULE }, async () => {
  const { registerRecall } = await import(process.env.DREAM_LEGACY_RECALL_MODULE);
  const { createServer } = await import('node:http');
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ recall: true, queries: ['公园散步'] }) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ historyCompression: false, legacyQueryHelper: true, queryApiKeyEnv: 'DREAM_TEST_QUERY_KEY' });
  const previousKey = process.env.DREAM_TEST_QUERY_KEY;
  process.env.DREAM_TEST_QUERY_KEY = 'local-test-only';
  try {
    await h.say('今天一起去公园散步。');
    mock.timers.setTime(at(2, 4));
    await h.service.run(h.agent);
    h.service.config.queryApiUrl = `http://127.0.0.1:${server.address().port}`;
    const logger = { info() {}, debug() {}, warn(message) { throw new Error(message); } };
    registerRecall(h.ctx, { tools: true, recall: { enabled: true, maxResults: 2, scoreThreshold: 0.6, timeoutMs: 3000, maxCharsPerMemory: 1000, maxTotalRecallChars: 2000 } }, {
      l1: { search: async query => { assert.equal(query, '公园散步'); return [{ id: 'park', type: 'experience', content: '旧库也记得公园里的树。', score: 0.9 }]; } },
    }, logger, { get: () => ({ enabled: true, recall: true }) }, { get: () => 'auto', resolvedRecall: () => true }, h.root);
    await h.say('还记得那次吗？');
    assert.equal(requests.length, 1);
    const request = h.adapter.requests.at(-1);
    assert.ok(request.messages.some(m => m.source?.kind === Dream.SOURCE && m.source.form === 'recall'));
    assert.ok(request.messages.some(m => m.source?.kind === 'plugin:memory' && m.source.form === 'recall'));
    assert.match(JSON.stringify(request.messages), /旧库也记得公园里的树/);
    assert.match(JSON.stringify(request.messages), /公园散步是我们愿意再次一起做的事情/);
    strictReplay(h.agent.session);
  } finally {
    if (previousKey === undefined) delete process.env.DREAM_TEST_QUERY_KEY; else process.env.DREAM_TEST_QUERY_KEY = previousKey;
    await new Promise(resolve => server.close(resolve)); await h.close(); mock.timers.reset();
  }
});

test('one-time native migration preserves legacy evidence, supports reading and revision, and survives restart and fork', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ historyCompression: false });
  try {
    await h.say('今天我们去公园散步。');
    mock.timers.setTime(at(2, 4));
    await h.service.run(h.agent);
    const before = await h.service.load(h.agent.session), original = h.agent.session.deriveMessages();
    const source = { id: 'legacy_source_park', ref: await h.service.store.put({ version: 1, kind: 'legacy-memory', text: '旧记忆原文：以前也一起在公园散步。\n原始消息：下次再来看看树。' }), originalTime: at(1) - DAY };
    const migrated = { id: 'legacy_memory_park', text: '我们以前也喜欢一起在公园散步。', kind: 'experience', state: 'active', evidence: [source.id], revision: 1, createdAt: at(1) - DAY, updatedAt: at(1), nextReviewAt: at(3), provenance: { migration: 'trial', legacyId: 'park', sourceId: source.id } };
    h.service.config.migrationRef = await h.service.store.put({ version: 1, targetSessionId: h.agent.id, memories: [migrated], sources: [source] });
    // Resume goes through the same serial agent/created and maintenance path as production.
    await h.restart();
    let book = await h.service.load(h.agent.session);
    assert.equal(book.memories.length, before.memories.length + 1);
    assert.deepEqual(book.episodes, before.episodes);
    assert.deepEqual(h.agent.session.deriveMessages().slice(0, original.length), original);
    const hits = await h.tool('experience_search', { query: '公园散步' });
    assert.match(JSON.stringify(hits.content), /legacy_memory_park/);
    const read = await h.tool('experience_read', { episode_id: source.id });
    assert.match(JSON.stringify(read.content), /旧记忆原文/);
    assert.match(JSON.stringify(read.content), /下次再来看看树/);
    book = applyProposal(book, { episodes: [], memories: [{ ...migrated, id: migrated.id, text: '我想继续记住我们在公园散步的轻松。', reviewAfterDays: 7 }] }, [], Date.now(), h.service.config);
    assert.deepEqual(book.memories.find(x => x.id === migrated.id).provenance, migrated.provenance);
    await h.agent.runMaintenance(() => h.service.save(h.agent, book));
    await h.restart();
    assert.deepEqual((await h.service.load(h.agent.session)).memories, book.memories);
    const originalEvents = h.agent.session.snapshotEvents(), forkId = SessionId(randomUUID());
    const events = buildForkSeed(originalEvents, originalEvents.length - 1);
    const fork = Session.create(forkId, events, { ...h.agent.session.header, id: forkId, parentSession: h.agent.id, isSeeded: true }, SessionLogOffset(events.length));
    assert.deepEqual((await h.service.load(fork)).memories, book.memories);
    strictReplay(h.agent.session);
  } finally { await h.close(); mock.timers.reset(); }
});

test('history-only legacy mode keeps conversation search and registers no old long-term-memory tools or auto recall', { skip: !process.env.DREAM_LEGACY_RECALL_MODULE }, async () => {
  const legacyRoot = new URL('../', new URL(`file://${process.env.DREAM_LEGACY_RECALL_MODULE}`));
  const { registerMemoryTools } = await import(new URL('tools/index.js', legacyRoot));
  const { registerRecall } = await import(process.env.DREAM_LEGACY_RECALL_MODULE);
  const h = await harness({ historyCompression: false });
  try {
    const config = { historyOnly: true, tools: true, recall: { enabled: true, maxResults: 2, timeoutMs: 3000, includePersona: false, includeSceneNav: false }, archive: { enabled: true, autoRecall: false } };
    let oldSearches = 0;
    const stores = { l1: { search: async () => { oldSearches++; return []; } }, l0: { search: async () => [{ role: 'user', content: '原来的公园散步对话仍可搜索。', timestamp: at(1) }] }, archive: { search: () => [] }, scenes: {}, persona: {} };
    const live = { get: () => ({ enabled: true, recall: true }) }, modes = { get: () => 'auto', resolvedRecall: () => true };
    const logger = { info() {}, debug() {}, warn() {} };
    registerMemoryTools(h.ctx, config, stores, logger, modes, live);
    registerRecall(h.ctx, config, stores, logger, live, modes, h.root);
    const found = await h.tool('conversation_search', { query: '公园散步' });
    assert.match(JSON.stringify(found.content), /原来的公园散步对话仍可搜索/);
    const request = h.adapter.requests.at(-1), names = request.tools.map(x => x.name);
    for (const name of ['experience_search', 'experience_read', 'conversation_search']) assert.ok(names.includes(name));
    for (const name of ['memory_commit', 'memory_forget', 'memory_search', 'memory_read_scene']) assert.equal(names.includes(name), false);
    assert.equal(oldSearches, 0);
    assert.equal(request.messages.some(m => m.source?.kind === 'plugin:memory'), false);
  } finally { await h.close(); }
});

test('prepared embeddings are reused after a cold restart without re-embedding memory text', async () => {
  const { createServer } = await import('node:http');
  const { Recall } = await import('../lib/recall.js');
  const root = await mkdtemp(join(tmpdir(), 'dream-vectors-')), requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body); requests.push(value.input);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: value.input.map((text, index) => ({ index, embedding: [1, 0, 0] })) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = { ...DEFAULT_CONFIG, embeddingUrl: `http://127.0.0.1:${server.address().port}`, embeddingCacheDir: root };
    const book = { version: 1, owner: 'cache', episodes: [], memories: [{ id: 'park', text: '公园散步', kind: 'experience', state: 'active', evidence: [], revision: 1, createdAt: at(1), updatedAt: at(1) }] };
    await new Recall(config).warm(book, new AbortController().signal);
    assert.deepEqual(requests, [['公园散步']]);
    const cold = new Recall(config), hits = await cold.search(book, '公园散步');
    assert.equal(hits[0].id, 'park'); assert.equal(cold.lastMode, 'hybrid');
    assert.equal(requests.length, 1);
    await cold.search(book, '想起那次散步');
    assert.deepEqual(requests[1], ['想起那次散步']);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('native K3 dream selects both tiers before admission and retains the exact parent prefix', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ historyCompression: false }, { provider: 'kimi-coding', model: 'k3-256k' });
  try {
    await h.say('今天一起在公园散步，准备晚间整理。');
    const originalMeasure = h.ctx.tokenMeter.measure.bind(h.ctx.tokenMeter);
    let pressure = 240_000;
    const meter = mock.method(h.ctx.tokenMeter, 'measure', (...args) => ({ ...originalMeasure(...args), totalTokens: pressure }));
    // This is a successful large-context fixture; no rejected model call/sample.
    h.service.config.dreamSupplementChars = 60_000;
    mock.timers.setTime(at(2, 4));
    const book = await capture(h.agent.session, await h.service.load(h.agent.session), h.service.store, Date.now(), h.service.config);
    book.memories.push({ id: 'memory_context', text: '一起散步。'.repeat(2500), kind: 'experience', state: 'active', evidence: [book.episodes[0].id], revision: 1, createdAt: at(1), updatedAt: at(1) });
    await h.agent.runMaintenance(() => h.service.save(h.agent, book));
    assert.equal((await h.service.run(h.agent)).dreams, 1);
    const large = h.adapter.requests.filter(r => r.purpose === 'compaction').at(-1);
    assert.equal(large.model, 'k3');
    assert.equal(h.agent.session.requestHeader().config.model, 'k3-256k');
    let result = await h.service.load(h.agent.session);
    let fork = await h.service.store.get(result.dreams.at(-1));
    assert.equal(fork.inheritedMessagesHash, fork.requestPrefixHash);
    assert.ok(fork.estimatedInputTokens > 246048);
    pressure = 100_000;
    mock.timers.setTime(at(2, 12)); await h.say('今天也去公园散步了。');
    mock.timers.setTime(at(3, 4));
    assert.equal((await h.service.run(h.agent)).dreams, 1);
    assert.equal(h.adapter.requests.filter(r => r.purpose === 'compaction').at(-1).model, 'k3-256k');
    result = await h.service.load(h.agent.session); fork = await h.service.store.get(result.dreams.at(-1));
    assert.equal(fork.inheritedMessagesHash, fork.requestPrefixHash);
    strictReplay(h.agent.session); meter.mock.restore();
  } finally { await h.close(); mock.timers.reset(); }
});

test('one authorized day reruns after the nightly allowance and publishes one durable passive receipt', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ notifications: true, historyCompression: false, quietMinutes: 10 });
  try {
    await h.say('今天一起在公园散步。');
    mock.timers.setTime(at(2, 4));
    const book = await capture(h.agent.session, await h.service.load(h.agent.session), h.service.store, Date.now(), h.service.config);
    book.lastSlot = slotAt(Date.now(), h.service.config); book.attemptSlot = book.lastSlot; book.attempts = 3;
    await h.agent.runMaintenance(() => h.service.save(h.agent, book));
    const original = h.agent.session.snapshotEvents();
    const manual = { id: 'authorized-january-1', sessionId: h.agent.id, day: '2026-01-01' };
    h.service.config.manualRun = manual;
    await h.service.tick();
    let result = await h.service.load(h.agent.session);
    assert.equal(result.manualRuns[manual.id], 'completed');
    assert.equal(result.attempts, 3); assert.equal(result.lastSlot, book.lastSlot);
    assert.equal(result.episodes[0].revision, 1); assert.ok(result.episodes[0].summary);
    assert.equal(h.adapter.requests.filter(r => r.purpose === 'compaction').length, 1);
    assert.deepEqual(h.agent.session.snapshotEvents().slice(0, original.length), original);
    const receipts = () => h.agent.session.snapshotEvents().filter(e => sourceOf(e)?.form === 'receipt');
    assert.equal(receipts().length, 1);
    assert.match(receipts()[0].data.content[0].text, /整理日期：2026-01-01\n状态：已完成并保存/);
    assert.match(receipts()[0].data.content[0].text, /记忆变化：新增 1 条，修订 0 条/);
    assert.equal(receipts()[0].data.content[0].text.includes('same-self'), false);
    assert.equal(h.adapter.requests.filter(r => r.purpose !== 'compaction').length, 1);
    strictReplay(h.agent.session);
    await h.restart(); await h.service.tick();
    assert.equal(receipts().length, 1);
    assert.equal(h.adapter.requests.filter(r => r.purpose === 'compaction').length, 1);
    await h.say('昨晚整理完成了吗？');
    const request = h.adapter.requests.at(-1);
    assert.ok(request.messages.some(m => m.source.form === 'receipt' && m.content[0].text.includes('已完成并保存')));
    strictReplay(h.agent.session);
  } finally { await h.close(); mock.timers.reset(); }
});

test('native inherited full memory remains revisable and a finished response can be committed without a second call', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ notifications: true, historyCompression: false, dreamSupplementChars: 1000, randomReviewCount: 0 });
  try {
    await h.say('今天一起在公园散步。');
    mock.timers.setTime(at(2, 4));
    const book = await capture(h.agent.session, await h.service.load(h.agent.session), h.service.store, Date.now(), h.service.config);
    const e = book.episodes[0];
    const memory = { id: 'memory_walk', text: '公园散步让我想起雨后的树木，我们约定再来看它。'.repeat(100), kind: 'experience', state: 'active', evidence: [e.id], revision: 1, createdAt: at(1), updatedAt: at(1) };
    book.memories.push(memory); book.lastSlot = slotAt(Date.now(), h.service.config); book.attemptSlot = book.lastSlot; book.attempts = 3;
    await h.agent.runMaintenance(() => h.service.save(h.agent, book));
    await h.tool('experience_search', { query: '公园散步' });
    h.adapter.proposal = meta => ({ episodes: [{ id: meta.requiredEpisode, summary: '我们一起散步，也想起先前的约定。' }], memories: [{ id: memory.id, text: '我们还想一起回公园看雨后的树。', kind: 'experience', state: 'active', evidence: [e.id] }] });
    const { dream } = await import('../lib/dream.js');
    let generated;
    await h.agent.runMaintenance(async signal => { generated = await dream(h.ctx, h.agent, book, e, h.service.store, h.service.config, signal); });
    const ref = generated.dreams.at(-1), fork = await h.service.store.get(ref);
    assert.equal(fork.selectedMemoryIds.includes(memory.id), false);
    assert.equal(generated.memories[0].revision, 2);
    assert.equal((await h.service.load(h.agent.session)).episodes[0].summary, '');
    const manual = { id: 'commit-finished-response', sessionId: h.agent.id, day: e.day, resultRef: ref };
    assert.equal((await h.service.run(h.agent, Date.now(), manual)).dreams, 1);
    const restored = await h.service.load(h.agent.session);
    assert.equal(restored.memories[0].revision, 2);
    assert.equal(restored.episodes[0].summary, generated.episodes[0].summary);
    assert.equal(restored.manualRuns[manual.id], 'completed');
    const recovered = await h.service.store.get(restored.dreams.at(-1));
    assert.equal(recovered.recoveredFrom, ref); assert.equal(recovered.complete, true);
    assert.equal(h.adapter.requests.filter(r => r.purpose === 'compaction').length, 1);
    assert.equal((await h.service.store.get(ref)).complete, true);
    strictReplay(h.agent.session);
    await h.restart();
    assert.equal((await h.service.run(h.agent, Date.now(), manual)).dreams, 0);
    assert.equal(h.adapter.requests.filter(r => r.purpose === 'compaction').length, 1);
  } finally { await h.close(); mock.timers.reset(); }
});

test('persistent bias and independent freshness rank relevant memories while explicit dates and search retain their meaning', async () => {
  const { Recall } = await import('../lib/recall.js');
  const { applyBiasAdjustments, memoryFreshness } = await import('../lib/preferences.js');
  mock.timers.enable({ apis: ['Date'], now: at(100) });
  try {
    const book = Dream.emptyBook('bias-ranking');
    book.episodes = [{ id: 'old-day', day: '2026-01-10', endAt: at(10), summary: '' }, { id: 'new-day', day: '2026-04-10', endAt: at(100), summary: '' }];
    book.memories = [
      { id: 'old', text: '公园散步', kind: 'experience', state: 'active', evidence: ['old-day'], revision: 1, createdAt: at(90), updatedAt: at(90) },
      { id: 'new', text: '公园散步', kind: 'experience', state: 'active', evidence: ['new-day'], revision: 1, createdAt: at(100), updatedAt: at(100) },
    ];
    const recall = new Recall(DEFAULT_CONFIG);
    assert.equal((await recall.search(book, '公园散步'))[0].id, 'new');
    const changed = applyBiasAdjustments(book, [{ id: 'old', bias: 0.2, reason: '这份约定值得我长久记得。' }], Date.now());
    const ranked = await recall.search(changed, '公园散步');
    assert.equal(ranked[0].id, 'old'); assert.equal(ranked[0].relevance, ranked[1].relevance);
    assert.equal(ranked[0].freshAt, at(10)); assert.equal(ranked[0].bias, 0.2);
    assert.equal((await recall.search(changed, '2026-04-10 公园散步'))[0].id, 'new');
    const explicit = await recall.search(changed, '公园散步', 8, undefined, 'explicit');
    assert.equal(explicit[0].score, explicit[1].score); assert.equal(explicit[0].freshness, 0);
    const oldFresh = memoryFreshness(changed, changed.memories[0]);
    const revised = applyProposal(changed, { episodes: [], memories: [{ id: 'old', text: '公园散步是我们仍珍惜的约定。', kind: 'experience', state: 'active', evidence: ['old-day'] }] }, [], at(101), DEFAULT_CONFIG);
    assert.deepEqual(memoryFreshness(revised, revised.memories[0]), oldFresh);
    const progressed = applyProposal(revised, { episodes: [], memories: [{ id: 'old', text: '我们今天又去散步了，这份约定还在继续。', kind: 'experience', state: 'active', evidence: ['old-day', 'new-day'] }] }, [], at(101), DEFAULT_CONFIG);
    assert.equal(memoryFreshness(progressed, progressed.memories[0]).at, at(100));
    mock.timers.setTime(at(1000));
    assert.equal((await recall.search(changed, '公园散步'))[0].id, 'old');
    assert.equal(changed.memories[0].bias, 0.2); assert.equal(book.memories[0].bias, undefined);
  } finally { mock.timers.reset(); }
});

test('native daytime bias batches preserve original text and evidence, remain idempotent and survive restart', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ historyCompression: false });
  try {
    await h.say('我们今天一起在公园散步。'); mock.timers.setTime(at(2, 4)); await h.service.run(h.agent);
    let book = await h.service.load(h.agent.session);
    book.memories.push({ ...book.memories[0], id: 'memory_second', text: '散步后顺路看了花。' });
    await h.agent.runMaintenance(() => h.service.save(h.agent, book));
    const original = structuredClone(book), events = h.agent.session.snapshotEvents();
    const updates = [{ id: book.memories[0].id, bias: 0.3, reason: '这份共同的约定对我重要。' }, { id: 'memory_second', bias: -0.2, reason: '留存这段经历，但近期不用经常想起。' }];
    await h.tool('experience_bias', { updates });
    book = await h.service.load(h.agent.session);
    for (let i = 0; i < 2; i++) {
      assert.equal(book.memories[i].bias, updates[i].bias); assert.equal(book.memories[i].text, original.memories[i].text);
      assert.deepEqual(book.memories[i].evidence, original.memories[i].evidence);
      assert.equal(book.memories[i].revision, original.memories[i].revision + 1);
      assert.equal(book.memories[i].freshAt, book.episodes[0].endAt);
    }
    assert.deepEqual(h.agent.session.snapshotEvents().slice(0, events.length), events);
    await h.tool('experience_bias', { updates });
    assert.deepEqual((await h.service.load(h.agent.session)).memories, book.memories);
    await h.restart(); assert.deepEqual((await h.service.load(h.agent.session)).memories, book.memories);
    const results = await h.tool('experience_search', { query: '公园散步' });
    assert.match(results.content[0].text, /"bias":0.3/); strictReplay(h.agent.session);
  } finally { await h.close(); mock.timers.reset(); }
});

test('native daytime bias rejects an unknown ID by name, applies nothing, and points at the real ID', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ historyCompression: false });
  try {
    await h.say('我们今天一起在公园散步。'); mock.timers.setTime(at(2, 4)); await h.service.run(h.agent);
    let book = await h.service.load(h.agent.session);
    const real = book.memories[0].id;
    book.memories.push({ ...book.memories[0], id: 'legacy_memory_567e0bca70aa2b03c70cb284', text: '迁移来的旧约定。' });
    await h.agent.runMaintenance(() => h.service.save(h.agent, book));
    const before = structuredClone((await h.service.load(h.agent.session)).memories);
    const mistyped = 'legacy_memory_567e0bca90cdaf189e0b1d7a';
    const rejected = await h.tool('experience_bias', { updates: [{ id: real, bias: 0.4, reason: '先改一条真的。' }, { id: mistyped, bias: -0.9, reason: '凭印象敲的 ID。' }] }, undefined, { expectError: true });
    assert.equal(rejected.isError, true);
    const text = rejected.content[0].text;
    assert.match(text, /Unknown memory ID "legacy_memory_567e0bca90cdaf189e0b1d7a"/);
    assert.match(text, /experience_search/); assert.match(text, /legacy_memory_\.\.\./);
    assert.match(text, /Similar current IDs: legacy_memory_567e0bca70aa2b03c70cb284/);
    assert.deepEqual((await h.service.load(h.agent.session)).memories, before);
    await h.tool('experience_bias', { updates: [{ id: 'legacy_memory_567e0bca70aa2b03c70cb284', bias: -0.6, reason: '旧版表述，降低自动召回。' }] });
    book = await h.service.load(h.agent.session);
    assert.equal(book.memories.find(m => m.id === 'legacy_memory_567e0bca70aa2b03c70cb284').bias, -0.6);
    strictReplay(h.agent.session);
  } finally { await h.close(); mock.timers.reset(); }
});

test('native dream batches can adjust sampled biases without rewriting memory text or refreshing original dates', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ historyCompression: false });
  try {
    await h.say('我们一起在公园散步。'); mock.timers.setTime(at(2, 4)); await h.service.run(h.agent);
    let book = await h.service.load(h.agent.session);
    book.memories.push({ ...book.memories[0], id: 'memory_second', text: '我们散步后看了公园里的花。' });
    for (const m of book.memories) m.nextReviewAt = at(2);
    await h.agent.runMaintenance(() => h.service.save(h.agent, book));
    const before = structuredClone(book);
    mock.timers.setTime(at(2, 12)); await h.say('今天又一起去公园散步了。');
    h.adapter.proposal = meta => ({ episodes: [{ id: meta.requiredEpisode, summary: '我们又一起散步。' }], memories: [],
      biasAdjustments: meta.memories.map((m, i) => ({ id: m.id, bias: i ? -0.2 : 0.4, reason: i ? '近期少主动浮现。' : '这段共同经历对我重要。' })) });
    mock.timers.setTime(at(3, 4)); assert.equal((await h.service.run(h.agent)).dreams, 1);
    book = await h.service.load(h.agent.session);
    assert.equal(book.memories[0].bias, 0.4); assert.equal(book.memories[1].bias, -0.2);
    for (let i = 0; i < 2; i++) { assert.equal(book.memories[i].text, before.memories[i].text); assert.equal(book.memories[i].freshAt, before.episodes[0].endAt); assert.deepEqual(book.memories[i].evidence, before.memories[i].evidence); }
    assert.equal((await h.service.store.get(book.dreams.at(-1))).complete, true); strictReplay(h.agent.session);
  } finally { await h.close(); mock.timers.reset(); }
});

test('author-chosen silence survives restart and resumes at its deadline without reminders', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ historyCompression: false });
  try {
    await h.say('我们一起在公园散步。'); mock.timers.setTime(at(2, 4)); await h.service.run(h.agent);
    let helperCalls = 0;
    h.service.planner.plan = async () => { helperCalls++; return { recall: true, queries: ['公园散步'] }; };
    await h.tool('experience_recall', { action: 'pause', silence_minutes: 120, reason: '我想专注完成眼前的事情。' });
    const baseline = helperCalls;
    const notices = () => h.agent.session.snapshotEvents().filter(e => e.type === 'user/message' && sourceOf(e)?.form === 'recall-status');
    const paused = (await h.service.load(h.agent.session)).recallControl;
    assert.equal(paused.silenceMinutes, 120); assert.equal(paused.pausedUntil, Date.now() + 120 * 60_000);
    assert.equal(paused.reminderId, undefined);
    for (let i = 0; i < 6; i++) await h.say('继续眼前的事情。');
    mock.timers.setTime(Date.now() + 31 * 60_000);
    await h.restart(); await h.say('继续处理。');
    assert.equal(helperCalls, baseline); assert.equal(notices().length, 0);
    const status = JSON.parse((await h.tool('experience_recall', { action: 'status' })).content[0].text);
    assert.equal(status.mode, 'paused'); assert.equal(status.remainingMinutes, 89);
    await h.tool('experience_search', { query: '公园散步' }); assert.equal(helperCalls, baseline);
    await h.tool('experience_recall', { action: 'pause', silence_minutes: 0.5, reason: '再专注半分钟就好。' });
    const renewed = (await h.service.load(h.agent.session)).recallControl;
    assert.equal(renewed.pausedUntil, Date.now() + 30_000);
    await h.restart(); mock.timers.setTime(renewed.pausedUntil - 1); await h.say('马上完成。');
    assert.equal(helperCalls, baseline); assert.equal(notices().length, 0);
    mock.timers.setTime(renewed.pausedUntil); await h.restart();
    await h.say('我们在公园散步的经历。'); assert.equal(helperCalls, baseline + 1);
    assert.ok(h.adapter.requests.at(-1).messages.some(m => m.source.form === 'recall'));
    assert.equal(notices().length, 0);
    const effective = h.service.recallStatus(h.agent, await h.service.load(h.agent.session));
    assert.equal(effective.mode, 'auto'); assert.equal(effective.expired, true); assert.equal(effective.remainingMinutes, 0);
    await h.tool('experience_recall', { action: 'pause', silence_minutes: 60, reason: '重新专注。' });
    await h.tool('experience_recall', { action: 'resume', reason: '提前恢复联想。' });
    assert.equal((await h.service.load(h.agent.session)).recallControl.mode, 'auto');
    assert.equal(notices().length, 0);
    strictReplay(h.agent.session);
  } finally { await h.close(); mock.timers.reset(); }
});

test('query helper can preserve a focused conversation by choosing to skip automatic recall for that turn', async () => {
  const { createServer } = await import('node:http');
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness(); let request;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; request = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ recall: false, queries: [] }) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previousKey = process.env.DREAM_TEST_QUERY_KEY; process.env.DREAM_TEST_QUERY_KEY = 'local-test-only';
  try {
    await h.say('我们一起在公园散步。'); mock.timers.setTime(at(2, 4)); await h.service.run(h.agent);
    h.service.config.queryApiUrl = `http://127.0.0.1:${server.address().port}`; h.service.config.queryApiKeyEnv = 'DREAM_TEST_QUERY_KEY';
    await h.say('我想专心写完眼前这段话，所需材料都在这里。');
    assert.match(request.messages[0].content, /专注讨论/); assert.match(request.messages[0].content, /亲密交流/); assert.equal(h.service.planner.lastMode, 'deepseek');
    assert.equal(h.adapter.requests.at(-1).messages.some(m => m.source.form === 'recall'), false);
    assert.equal((await h.service.load(h.agent.session)).recallControl, undefined);
    strictReplay(h.agent.session);
  } finally {
    if (previousKey === undefined) delete process.env.DREAM_TEST_QUERY_KEY; else process.env.DREAM_TEST_QUERY_KEY = previousKey;
    await new Promise(resolve => server.close(resolve)); await h.close(); mock.timers.reset();
  }
});

test('autonomous time-notification actions become episodes while the clock body leaves dream input', async () => {
  const realNow = Date.now; let now = at(1); Date.now = () => now;
  const h = await harness({ historyCompression: false, quietMinutes: 10 });
  try {
    const previousActive = h.service.lastActive.get(h.agent.id);
    now += 30 * 60_000;
    h.agent.followup(createUserMessage({ content: blocks('[Time passing]\nCurrent time: CLOCK_FIXTURE'), source: {
      kind: 'schedule', taskId: 'clock', notification: 'time_passing', retain: 'latest', issuedAt: now,
    } }));
    await h.agent.whenIdle();
    assert.equal(h.service.lastActive.get(h.agent.id), previousActive);
    now = at(2, 5);
    const book = await capture(h.agent.session, await h.service.load(h.agent.session), h.service.store, now, h.service.config);
    assert.equal(book.episodes.length, 1);
    const archive = await h.service.store.get(book.episodes[0].archive);
    const text = transcript(archive).text;
    assert.ok(text.includes('我也记得公园里雨后的气味。'));
    assert.equal(text.includes('CLOCK_FIXTURE'), false);
    await h.service.tick(now);
    const request = h.adapter.requests.findLast(request => request.purpose === 'compaction');
    assert.ok(request);
    assert.equal(request.messages.some(message => message.role === 'user' && message.source.kind === 'schedule'), false);
    assert.ok(visible(h.agent.session).includes('CLOCK_FIXTURE'));
    strictReplay(h.agent.session);
  } finally { await h.close(); Date.now = realNow; }
});

test('native daytime edit revises a memory in place, adds one without a source yet, and hands both to the next dream', async () => {
  mock.timers.enable({ apis: ['Date'], now: at(1) });
  const h = await harness({ historyCompression: false });
  try {
    await h.say('我们今天一起在公园散步。'); mock.timers.setTime(at(2, 4)); await h.service.run(h.agent);
    let book = await h.service.load(h.agent.session);
    const original = structuredClone(book.memories[0]);
    mock.timers.setTime(at(2, 12));
    const rejected = await h.tool('experience_edit', { action: 'revise', id: 'memory_000000000000000000000000', text: '改错对象。', reason: '凭印象敲的 ID。' }, undefined, { expectError: true });
    assert.match(rejected.content[0].text, /Unknown memory ID "memory_000000000000000000000000"/);
    assert.deepEqual((await h.service.load(h.agent.session)).memories, [original]);
    const outside = await h.tool('experience_edit', { action: 'revise', id: original.id, evidence: ['episode_nope'], reason: '补证据。' }, undefined, { expectError: true });
    assert.match(outside.content[0].text, /Memory evidence is outside this branch/);
    const revised = await h.tool('experience_edit', { action: 'revise', id: original.id, text: '公园散步是我们愿意再次一起做的事情；那棵树在东门。', reason: '当时说的是东门那棵树。' });
    assert.match(revised.content[0].text, /revised/);
    book = await h.service.load(h.agent.session);
    let memory = book.memories.find(m => m.id === original.id);
    assert.equal(memory.text, '公园散步是我们愿意再次一起做的事情；那棵树在东门。');
    assert.equal(memory.revision, original.revision + 1);
    assert.equal(memory.createdAt, original.createdAt); assert.equal(memory.reviewedAt, original.reviewedAt);
    assert.deepEqual(memory.evidence, original.evidence);
    assert.equal(memory.nextReviewAt, at(2, 12)); assert.equal(memory.daytime.reason, '当时说的是东门那棵树。');
    const same = await h.tool('experience_edit', { action: 'revise', id: original.id, text: memory.text, reason: '再说一遍。' });
    assert.match(same.content[0].text, /unchanged/);
    assert.equal((await h.service.load(h.agent.session)).memories.find(m => m.id === original.id).revision, original.revision + 1);
    const added = await h.tool('experience_edit', { action: 'add', text: '阿林说的温水是指晾到不烫嘴的白开水。', kind: 'belief', reason: '他今天解释了。' });
    assert.match(added.content[0].text, /linked to today/);
    book = await h.service.load(h.agent.session);
    assert.equal(book.memories.length, 2);
    const fresh = book.memories[1];
    assert.ok(fresh.id.startsWith('memory_')); assert.deepEqual(fresh.evidence, []); assert.equal(fresh.state, 'active'); assert.equal(fresh.revision, 1);
    const hits = await h.service.recall.search(book, '温水是指不烫嘴的白开水', 8, new AbortController().signal, 'explicit');
    assert.ok(hits.some(hit => hit.id === fresh.id));
    await h.tool('experience_edit', { action: 'revise', id: original.id, state: 'dormant', reason: '最近不想老想起散步。' });
    assert.equal((await h.service.load(h.agent.session)).memories.find(m => m.id === original.id).state, 'dormant');

    mock.timers.setTime(at(3, 4));
    h.adapter.proposal = meta => ({ episodes: [{ id: meta.requiredEpisode, summary: '白天改了记忆，也补了温水的意思。' }], memories: [] });
    assert.equal((await h.service.run(h.agent)).dreams, 1);
    h.adapter.proposal = undefined;
    book = await h.service.load(h.agent.session);
    memory = book.memories.find(m => m.id === fresh.id);
    const today = book.episodes.find(e => e.from <= fresh.daytime.seq && fresh.daytime.seq <= e.to);
    assert.ok(today); assert.deepEqual(memory.evidence, [today.id]);
    const request = h.adapter.requests.filter(r => r.purpose === 'compaction').at(-1);
    const text = request.messages.findLast(m => m.source?.kind === Dream.SOURCE && m.source.form === 'dream').content.find(b => b.type === 'text').text;
    const meta = JSON.parse(text.split('现有记忆与本次范围：\n')[1].split('\n\n本日原文')[0]);
    assert.deepEqual(meta.memories.map(m => m.id).sort(), [original.id, fresh.id].sort());
    assert.equal(meta.memories.find(m => m.id === original.id).daytime.reason, '最近不想老想起散步。');
    strictReplay(h.agent.session);
  } finally { await h.close(); mock.timers.reset(); }
});
