import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import Projections from '@deepseek-ai/dsh-session-projection';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ArchiveStore, trajectoryProjection, pageText, GUIDANCE, renderTranscript } from '../lib/index.js';
import { harness, calls, respond, output, text } from './harness.mjs';

const directory = () => mkdtemp(join(tmpdir(), 'dsh-trajectory-test-'));
const archivePath = (dir, ref) => join(dir, createHash('sha256').update(ref.ownerSessionId).digest('hex'), `${ref.id}.json.gz`);
const activeText = h => JSON.stringify(h.agent.session.deriveMessages());
const modelText = h => JSON.stringify(h.adapter.requests.at(-1).messages.map(({ role, content }) => ({ role, content })));
function strictReplay(h) {
  const artifact = JSON.parse(JSON.stringify({ header: { ...h.agent.session.header, delegationDepth: 0, isSeeded: false }, events: h.events() }));
  const restore = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader(artifact.header, 0), { recovery: 'strict', validation: 'current' });
  for (const event of artifact.events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event));
  assert.equal(restore.finish().events.length, artifact.events.length);
  const replay = Session.create(SessionId(artifact.header.id), artifact.events, artifact.header, 0);
  assert.deepEqual(replay.deriveMessages(), h.agent.session.deriveMessages());
  return replay;
}
async function seed(h, label = 'investigate') {
  const marked = await h.tool('trajectory_anchor', { label }); assert.equal(marked.error, false, marked.raw);
  await h.tool('fixture', { value: 'EXACT_ORIGINAL_汀_🪷\n' + 'raw detail '.repeat(30) });
  return marked.value.anchor;
}
async function compact(h, anchor, summary = 'Finding: problem located. Evidence: path/file.ts; no changes yet. Next: verify.') {
  const result = await h.tool('trajectory_compact', { anchor_id: anchor.id, summary });
  assert.equal(result.error, false, result.raw);
  assert.ok(!result.raw.includes(anchor.id)); assert.ok(!('label' in result.value.archive));
  return { ...result.value, archive: h.state().archives.find(row => row.id === result.value.archive.id) };
}

test('native loop archives exact events; next model request retains summary but no retired anchor or compact call', async () => {
  const dir = await directory(), h = await harness({ archiveDir: dir });
  try {
    const anchor = await seed(h, 'UNIQUE_RETIRED_ANCHOR_LABEL');
    const oldEvents = h.events();
    const result = await compact(h, anchor);
    assert.equal(h.state().anchor, null); assert.equal(h.state().archives.length, 1);
    assert.ok(!activeText(h).includes('EXACT_ORIGINAL_'));
    assert.ok(activeText(h).includes('Finding: problem located'));
    assert.ok(!modelText(h).includes(anchor.id)); assert.ok(!modelText(h).includes(anchor.label));
    assert.ok(!h.adapter.requests.at(-1).messages.some(message => message.content.some(block => block.type === 'tool-call' && block.name === 'trajectory_compact')));
    assert.deepEqual(h.events().slice(0, oldEvents.length), oldEvents);
    const document = await new ArchiveStore(dir).read(result.archive, new AbortController().signal);
    assert.deepEqual(document.events, h.events().slice(result.archive.startSeq, result.archive.endSeq + 1));
    assert.ok(JSON.stringify(document.events).includes('EXACT_ORIGINAL_汀_🪷'));
    assert.equal((await stat(archivePath(dir, result.archive))).mode & 0o777, 0o600);
    strictReplay(h);
    const finalRequest = h.adapter.requests.at(-1);
    assert.ok(!JSON.stringify(finalRequest.messages).includes('EXACT_ORIGINAL_'));
    assert.ok(JSON.stringify(finalRequest.messages).includes('Finding: problem located'));
    const listed = await h.tool('trajectory_read', {});
    assert.equal(listed.value.archives[0].id, result.archive.id);
    assert.ok(!modelText(h).includes(anchor.id)); assert.ok(!modelText(h).includes(anchor.label));
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an active work anchor is retained until summarized; stale IDs cannot compact the next work', async () => {
  const dir = await directory(), h = await harness({ archiveDir: dir });
  try {
    const first = await seed(h, 'first');
    const before = h.events();
    const kept = (await h.tool('trajectory_anchor', { label: 'second' })).value;
    assert.equal(kept.status, 'work_active'); assert.deepEqual(kept.anchor, first);
    assert.ok(activeText(h).includes('EXACT_ORIGINAL_')); assert.equal(h.state().archives.length, 0);
    await compact(h, first, 'First work has been summarized.');
    const second = (await h.tool('trajectory_anchor', { label: 'second' })).value;
    assert.equal(second.status, 'created'); assert.notEqual(second.anchor.id, first.id);
    const stale = await h.tool('trajectory_compact', { anchor_id: first.id, summary: 'wrong' });
    assert.equal(stale.error, true); assert.equal(h.state().anchor.id, second.anchor.id);
    await h.tool('fixture', { value: 'SECOND_RANGE' });
    await compact(h, second.anchor);
    assert.ok(activeText(h).includes('First work has been summarized.')); assert.ok(!activeText(h).includes('SECOND_RANGE'));
    assert.deepEqual(h.events().slice(0, before.length), before); strictReplay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('archive reads suspend work, reuse one review across pages, and restore work after compaction', async () => {
  const dir = await directory(), h = await harness({ archiveDir: dir });
  try {
    const original = await compact(h, await seed(h));
    const old = (await h.tool('trajectory_anchor', { label: 'unrelated work' })).value.anchor;
    const listing = await h.tool('trajectory_read', {});
    assert.equal(listing.value.anchor.id, old.id); assert.equal(h.state().anchor.id, old.id);
    const bytes = await readFile(archivePath(dir, original.archive));
    const first = await h.tool('trajectory_read', { archive_id: original.archive.id, max_chars: 500 });
    assert.equal(first.error, false, first.raw); assert.equal(first.value.anchor.kind, 'review');
    assert.equal(first.value.suspendedWorkAnchor.id, old.id); assert.equal(first.value.anchorReused, false);
    const second = await h.tool('trajectory_read', { archive_id: original.archive.id, offset: first.value.nextOffset, max_chars: 800 });
    assert.equal(second.value.anchor.id, first.value.anchor.id); assert.equal(second.value.anchorReused, true);
    assert.equal(second.value.offset, first.value.nextOffset);
    await compact(h, first.value.anchor, 'Review finding: exact original was verified; continue with the fix.');
    assert.equal(h.state().anchor.id, old.id); assert.equal(h.state().suspendedWorkAnchor, null); assert.equal(h.state().archives.length, 2);
    assert.deepEqual(await readFile(archivePath(dir, original.archive)), bytes);
    const next = await h.tool('trajectory_read', { archive_id: original.archive.id, max_chars: 300, intent: 'recover_detail', focus: 'Recover the original event details for the next user update.' });
    assert.notEqual(next.value.anchor.id, first.value.anchor.id);
    assert.equal(next.value.suspendedWorkAnchor.id, old.id);
    await h.send([respond('The review must retain the user update.')], 'NEW_USER_CONSTRAINT: keep the blue copy.');
    await compact(h, next.value.anchor, 'Read complete. NEW_USER_CONSTRAINT: keep the blue copy.');
    assert.equal(h.state().anchor.id, old.id);
    assert.ok(activeText(h).includes('NEW_USER_CONSTRAINT'));
    await compact(h, old, 'Main work complete. Review finding preserved. NEW_USER_CONSTRAINT: keep the blue copy.');
    assert.equal(h.state().anchor, null); assert.equal(h.state().suspendedWorkAnchor, null);
    assert.ok(activeText(h).includes('Review finding')); strictReplay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('failed reads, checksum failures and invalid pages preserve the active anchor', async () => {
  const dir = await directory(), h = await harness({ archiveDir: dir });
  try {
    const original = await compact(h, await seed(h));
    const anchor = (await h.tool('trajectory_anchor', { label: 'keep me' })).value.anchor;
    for (const args of [{ archive_id: crypto.randomUUID() }, { archive_id: original.archive.id, offset: -1 }, { archive_id: original.archive.id, max_chars: 0 }, { archive_id: original.archive.id, offset: Number.MAX_SAFE_INTEGER }]) {
      assert.equal((await h.tool('trajectory_read', args)).error, true); assert.deepEqual(h.state().anchor, anchor);
    }
    await writeFile(archivePath(dir, original.archive), 'corrupt');
    assert.equal((await h.tool('trajectory_read', { archive_id: original.archive.id })).error, true);
    assert.deepEqual(h.state().anchor, anchor);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('archive write failure leaves original visible and anchor usable', async () => {
  const dir = await directory(), archiveDir = join(dir, 'not-a-directory');
  await writeFile(archiveDir, 'file');
  const h = await harness({ archiveDir });
  try {
    const anchor = await seed(h), original = h.events();
    const result = await h.tool('trajectory_compact', { anchor_id: anchor.id, summary: 'Preserve until archive exists.' });
    assert.equal(result.error, true); assert.deepEqual(h.state().anchor, anchor);
    assert.equal(h.state().archives.length, 0); assert.ok(activeText(h).includes('EXACT_ORIGINAL_'));
    assert.ok(modelText(h).includes(anchor.id));
    assert.deepEqual(h.events().slice(0, original.length), original); strictReplay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('current tool group cannot be split; a nested compact in the anchor root call is rejected', async () => {
  const dir = await directory();
  const h = await harness({ archiveDir: dir, setup: async ctx => {
    ctx.tools.register(defineTool({ name: 'composite', description: 'fixture', parameters: {}, output,
      async execute(_args, exec) {
        const dispatch = (name, args) => ctx.tools.execute({ name, arguments: args, callId: crypto.randomUUID(), rootCallId: exec.rootCallId, parent: exec.token, agent: exec.agent, signal: exec.signal });
        const marked = await dispatch('trajectory_anchor', { label: 'nested phase' });
        assert.equal(marked.isError, false);
        const anchor = ctx.sessionProjections.stateOf(exec.agent.session, 'trajectory').anchor;
        const compacted = await dispatch('trajectory_compact', { anchor_id: anchor.id, summary: 'too early' });
        return { rejected: compacted.isError, anchorId: anchor.id };
      },
    }));
  } });
  try {
    const result = await h.tool('composite', {}); assert.equal(result.error, false, result.raw);
    assert.equal(result.value.rejected, true); assert.equal(h.state().anchor.id, result.value.anchorId);
    await h.tool('fixture', { value: 'nested followup' });
    await compact(h, h.state().anchor); strictReplay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('cold replay and native persistence resume retain the anchor and archive references', async () => {
  const dir = await directory(), options = { archiveDir: join(dir, 'archives'), root: join(dir, 'sessions') };
  let h = await harness(options);
  try {
    const saved = await compact(h, await seed(h));
    const anchor = (await h.tool('trajectory_anchor', { label: 'survive restart' })).value.anchor;
    await h.tool('fixture', { value: 'AFTER_RESTART_KEEP' });
    const review = (await h.tool('trajectory_read', { archive_id: saved.archive.id, max_chars: 500 })).value.anchor;
    const id = h.agent.id; await h.close();
    h = await harness({ ...options, resume: id });
    assert.deepEqual(h.state().anchor, review); assert.deepEqual(h.state().suspendedWorkAnchor, anchor);
    assert.equal(h.state().archives[0].id, saved.archive.id);
    const next = await h.tool('trajectory_read', { archive_id: saved.archive.id, max_chars: 500 });
    assert.equal(next.value.anchor.id, review.id);
    await compact(h, review, 'Resumed review complete.');
    assert.deepEqual(h.state().anchor, anchor); assert.equal(h.state().suspendedWorkAnchor, null);
    await compact(h, anchor, 'Resumed phase preserved.');
    const read = await h.tool('trajectory_read', { archive_id: saved.archive.id, max_chars: 1000 });
    assert.equal(read.error, false, read.raw); assert.equal(read.value.anchor.kind, 'review');
    strictReplay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('forked projections retain inherited archives while anchors remain session-local', async () => {
  const dir = await directory(), h = await harness({ archiveDir: dir });
  const child = new Context(); await child.plugin(Projections); child.sessionProjections.register(trajectoryProjection);
  try {
    await compact(h, await seed(h));
    const parentAnchor = (await h.tool('trajectory_anchor', { label: 'parent phase' })).value.anchor;
    const fork = Session.create(SessionId(crypto.randomUUID()), h.events());
    assert.equal(child.sessionProjections.stateOf(fork, 'trajectory').anchor.id, parentAnchor.id);
    assert.deepEqual(child.sessionProjections.stateOf(fork, 'trajectory').archives, h.state().archives);
    await compact(h, parentAnchor, 'Parent work has progressed while the fork retains its own state.');
    await h.tool('trajectory_anchor', { label: 'new parent anchor' });
    assert.equal(child.sessionProjections.stateOf(fork, 'trajectory').anchor.id, parentAnchor.id);
  } finally { await h.close(); await child.fiber.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('external surface replacement invalidates only a covered anchor', async () => {
  const dir = await directory(), h = await harness({ archiveDir: dir });
  try {
    const anchor = await seed(h), nodes = [...h.agent.session.surface.nodes];
    const first = nodes.indexOf(SessionSeq(anchor.startSeq));
    const covered = nodes.slice(first);
    h.agent.session.append('user/message', createUserMessage({ content: text('external summary'), source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: covered[0], endSeq: covered.at(-1) }, sourceEventSeqs: covered,
    });
    assert.equal(h.state().anchor, null);
    const result = await h.tool('trajectory_compact', { anchor_id: anchor.id, summary: 'stale range' });
    assert.equal(result.error, true); assert.equal(h.state().archives.length, 0);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('scoped plugin provides guidance and tools to its owning agent', async () => {
  const dir = await directory(), h = await harness({ archiveDir: dir, scoped: true });
  try {
    const anchor = await seed(h); assert.equal(h.state().anchor.id, anchor.id);
    assert.ok(JSON.stringify(h.adapter.requests[0].messages).includes('Only one anchor is active at a time'));
    assert.ok(GUIDANCE.includes('no required frequency'));
    assert.equal(h.ctx.tools.schemas().some(t => t.name === 'trajectory_anchor'), false);
    await compact(h, anchor); strictReplay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('raw archive pagination covers Unicode losslessly, without imposing a size threshold', () => {
  const original = 'a🪷汀b'.repeat(100); let offset = 0, restored = '';
  do { const page = pageText(original, offset, 2); restored += page.text; offset = page.nextOffset; } while (offset !== null);
  assert.equal(restored, original);
  assert.equal(pageText(original, 0, Number.MAX_SAFE_INTEGER).text, original);
  assert.throws(() => pageText(original, -1, 10)); assert.throws(() => pageText(original, 0, 0));
});

test('concurrent nested reads serialize and reuse the same review anchor', async () => {
  const dir = await directory();
  const h = await harness({ archiveDir: dir, setup: async ctx => {
    ctx.tools.register(defineTool({ name: 'parallel_reads', description: 'fixture', parameters: { id: { type: 'string', required: true } }, output,
      async execute(args, exec) {
        const results = await Promise.all([0, 100].map(offset => ctx.tools.execute({ name: 'trajectory_read', arguments: { archive_id: args.id, offset, max_chars: 100 }, callId: crypto.randomUUID(), rootCallId: exec.rootCallId, parent: exec.token, agent: exec.agent, signal: exec.signal })));
        return results.map(r => ({ isError: r.isError, value: r.value }));
      },
    }));
  } });
  try {
    const original = await compact(h, await seed(h));
    const reads = await h.tool('parallel_reads', { id: original.archive.id });
    assert.equal(reads.error, false, reads.raw);
    assert.ok(reads.value.every(r => !r.isError));
    assert.equal(reads.value[0].value.anchor.id, reads.value[1].value.anchor.id);
    assert.equal(reads.value[0].value.anchorReused, false); assert.equal(reads.value[1].value.anchorReused, true);
    await compact(h, h.state().anchor, 'Read both pages; keep useful finding.'); strictReplay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('cancellation after archive save cannot replace history or consume the anchor', async () => {
  const dir = await directory(), h = await harness({ archiveDir: dir });
  const originalSave = ArchiveStore.prototype.save;
  try {
    const anchor = await seed(h);
    ArchiveStore.prototype.save = async function (...args) {
      const result = await originalSave.apply(this, args); h.agent.cancel({ kind: 'user' }); return result;
    };
    h.adapter.scripts.push(calls(['trajectory_compact', { anchor_id: anchor.id, summary: 'cancelled before commit' }]));
    h.agent.followup(createUserMessage({ content: text('fixture cancel test'), source: { kind: 'user' } }));
    await h.agent.whenIdle();
    assert.deepEqual(h.state().anchor, anchor); assert.equal(h.state().archives.length, 0);
    assert.ok(activeText(h).includes('EXACT_ORIGINAL_'));
    strictReplay(h);
  } finally { ArchiveStore.prototype.save = originalSave; await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('immutable archive save refuses overwrites and cleans staging files', async () => {
  const dir = await directory(), h = await harness({ archiveDir: dir });
  try {
    const saved = await compact(h, await seed(h)), store = new ArchiveStore(dir), signal = new AbortController().signal;
    const original = await readFile(archivePath(dir, saved.archive)), document = await store.read(saved.archive, signal);
    await assert.rejects(store.save(document, signal), { code: 'EEXIST' });
    assert.deepEqual(await readFile(archivePath(dir, saved.archive)), original);
    const files = await readdir(join(dir, createHash('sha256').update(saved.archive.ownerSessionId).digest('hex')));
    assert.deepEqual(files, [`${saved.archive.id}.json.gz`]);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a read rejected after execution restores the previous anchor', async () => {
  const dir = await directory(), h = await harness({ archiveDir: dir });
  try {
    const saved = await compact(h, await seed(h));
    const previous = (await h.tool('trajectory_anchor', { label: 'preserve through post-policy error' })).value.anchor;
    h.ctx.on('tools/post-execute', (exec, _result, next) => { if (exec.name === 'trajectory_read') throw new Error('fixture post-tool rejection'); return next(); });
    const result = await h.tool('trajectory_read', { archive_id: saved.archive.id, max_chars: 500 });
    assert.equal(result.error, true); assert.deepEqual(h.state().anchor, previous); strictReplay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a failed enclosing PTC call restores the anchor from before a nested read', async () => {
  const dir = await directory();
  const h = await harness({ archiveDir: dir, setup: async ctx => {
    ctx.tools.register(defineTool({ name: 'failed_review', description: 'fixture', parameters: { id: { type: 'string', required: true } }, output,
      async execute(args, exec) {
        const read = await ctx.tools.execute({ name: 'trajectory_read', arguments: { archive_id: args.id, max_chars: 100 }, callId: crypto.randomUUID(), rootCallId: exec.rootCallId, parent: exec.token, agent: exec.agent, signal: exec.signal });
        assert.equal(read.isError, false); throw new Error('fixture outer PTC failure');
      },
    }));
  } });
  try {
    const saved = await compact(h, await seed(h));
    const previous = (await h.tool('trajectory_anchor', { label: 'keep before failed nested read' })).value.anchor;
    const result = await h.tool('failed_review', { id: saved.archive.id });
    assert.equal(result.error, true); assert.deepEqual(h.state().anchor, previous); strictReplay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('compact cleanup preserves sibling tool output and rebases a new anchor in the same group', async () => {
  const dir = await directory(), h = await harness({ archiveDir: dir });
  try {
    const anchor = await seed(h, 'OLD_GROUP_LABEL');
    const before = h.events();
    await h.send([calls(
      ['fixture', { value: 'SIBLING_BEFORE_汀🪷' }],
      ['trajectory_compact', { anchor_id: anchor.id, summary: 'Completed prior work.' }],
      ['fixture', { value: 'SIBLING_AFTER_汀🪷' }],
      ['trajectory_anchor', { label: 'NEW_GROUP_LABEL' }],
    ), respond('continue')]);
    assert.ok(modelText(h).includes('SIBLING_BEFORE_汀🪷'));
    assert.ok(modelText(h).includes('SIBLING_AFTER_汀🪷'));
    assert.ok(modelText(h).includes('NEW_GROUP_LABEL'));
    assert.ok(!modelText(h).includes(anchor.id)); assert.ok(!modelText(h).includes(anchor.label));
    const next = h.state().anchor;
    assert.ok(next && next.id !== anchor.id);
    assert.ok(h.agent.session.surface.nodes.includes(next.startSeq));
    assert.deepEqual(h.events().slice(0, before.length), before);
    strictReplay(h);
    await h.tool('fixture', { value: 'NEXT_PHASE_OUTPUT' });
    await compact(h, next, 'New phase completed too.');
    assert.ok(!modelText(h).includes(next.id)); assert.ok(!modelText(h).includes(next.label));
    assert.ok(!modelText(h).includes('NEXT_PHASE_OUTPUT')); strictReplay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('nested compact removes retired identity without losing surrounding PTC output', async () => {
  const dir = await directory(), h = await harness({ archiveDir: dir, setup: async ctx => {
    ctx.tools.register(defineTool({ name: 'mixed_compact', description: 'fixture', parameters: { anchor_id: { type: 'string', required: true } }, output,
      async execute(args, exec) {
        const result = await ctx.tools.execute({ name: 'trajectory_compact', arguments: { anchor_id: args.anchor_id, summary: 'Nested compaction finding.' },
          callId: crypto.randomUUID(), rootCallId: exec.rootCallId, parent: exec.token, agent: exec.agent, signal: exec.signal });
        assert.equal(result.isError, false);
        return { before: 'PTC_OTHER_BEFORE', compacted: result.value, echoedOldId: args.anchor_id, after: 'PTC_OTHER_AFTER' };
      },
    }));
  } });
  try {
    const anchor = await seed(h, 'NESTED_OLD_LABEL');
    const result = await h.tool('mixed_compact', { anchor_id: anchor.id });
    assert.equal(result.error, false, result.raw);
    assert.ok(modelText(h).includes('PTC_OTHER_BEFORE')); assert.ok(modelText(h).includes('PTC_OTHER_AFTER'));
    assert.ok(modelText(h).includes('Nested compaction finding.'));
    assert.ok(!modelText(h).includes(anchor.id)); assert.ok(!modelText(h).includes(anchor.label));
    assert.equal(h.state().anchor, null); strictReplay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('cold resume repairs an old-format successful compact interrupted before context cleanup', async () => {
  const dir = await directory(), options = { archiveDir: join(dir, 'archives'), root: join(dir, 'sessions') };
  let h = await harness(options);
  try {
    const anchor = await seed(h, 'LEGACY_RETIRED_LABEL');
    const originalAppend = h.agent.session.append.bind(h.agent.session);
    h.agent.session.append = (type, data, ...rest) => {
      if (type === 'user/message' && data.source.kind === 'plugin:dsh-trajectory' && data.source.form === 'summary') {
        const { compactCallId: _oldVersionHasNoRoot, ...source } = data.source;
        data = { ...data, source, content: data.content.map(block => block.type === 'text'
          ? { ...block, text: block.text.replace('[Model-authored trajectory summary]', `[Model-authored trajectory summary: ${anchor.label}]`) } : block) };
      }
      return originalAppend(type, data, ...rest);
    };
    h.ctx.on('agent/pre-step', async (_payload, next) => {
      if (h.state().archives.length) throw new Error('fixture interrupt before next request');
      return next();
    });
    h.adapter.scripts.push(calls(['trajectory_compact', { anchor_id: anchor.id, summary: 'Legacy summary must survive.' }]));
    h.agent.followup(createUserMessage({ content: text('fixture interrupted cleanup'), source: { kind: 'user' } }));
    await h.agent.whenIdle();
    assert.equal(h.state().archives.length, 1);
    const raw = h.events(), id = h.agent.id;
    assert.ok(JSON.stringify(h.agent.session.deriveMessages().map(m => m.content)).includes(anchor.id));
    await h.close(); h = await harness({ ...options, resume: id });
    await h.send([respond('restored')]);
    assert.ok(!modelText(h).includes(anchor.id)); assert.ok(!modelText(h).includes(anchor.label));
    assert.ok(modelText(h).includes('Legacy summary must survive.'));
    assert.deepEqual(h.events().slice(0, raw.length), raw); strictReplay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('old archive-list metadata is cleaned while an explicit raw read remains verbatim', async () => {
  const dir = await directory(), h = await harness({ archiveDir: dir });
  try {
    const anchor = await seed(h, 'OLD_LIST_LABEL'), saved = await compact(h, anchor);
    const originalAppend = h.agent.session.append.bind(h.agent.session);
    h.agent.session.append = (type, data, ...rest) => {
      if (type === 'tool/result' && rest[0]?.surfaceOp === 'append') {
        data = { ...data, message: { ...data.message, content: data.message.content.map(block => {
          if (block.type !== 'text') return block;
          const value = JSON.parse(block.text);
          if (!value.archives) return block;
          return { ...block, text: JSON.stringify({ ...value, archives: h.state().archives }) };
        }) } };
      }
      return originalAppend(type, data, ...rest);
    };
    await h.tool('trajectory_read', {});
    assert.ok(!modelText(h).includes(anchor.id)); assert.ok(!modelText(h).includes(anchor.label));
    h.agent.session.append = originalAppend;
    const read = await h.tool('trajectory_read', { archive_id: saved.archive.id, max_chars: Number.MAX_SAFE_INTEGER });
    assert.equal(read.value.nextUnreadOffset, undefined);
    const document = await new ArchiveStore(dir).read(saved.archive, new AbortController().signal);
    assert.equal(read.value.text, renderTranscript(document));
    assert.ok(read.value.text.includes(anchor.id)); assert.ok(read.value.text.includes('EXACT_ORIGINAL_汀_🪷'));
    assert.ok(!read.value.text.includes('"seq":'));
    await compact(h, h.state().anchor, 'Raw history reviewed.');
    assert.ok(!modelText(h).includes(anchor.id)); assert.ok(!modelText(h).includes(anchor.label)); strictReplay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});
