import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ArchiveStore, renderTranscript } from '../lib/index.js';
import { harness, output, calls, respond } from './harness.mjs';

async function seed(h) {
  const anchor = (await h.tool('trajectory_anchor', { label: 'shared recollection' })).value.anchor;
  await h.tool('fixture', { value: 'SHARED_ORIGINAL_汀_🪷 ' + 'warm lamplight '.repeat(80) });
  const saved = await h.tool('trajectory_compact', { anchor_id: anchor.id, summary: 'A shared recollection of lamplight remains available.' });
  const archive = h.state().archives.find(row => row.id === saved.value.archive.id);
  const work = (await h.tool('trajectory_anchor', { label: 'current conversation' })).value.anchor;
  return { archive, work };
}
function replay(h) {
  const header = { ...h.agent.session.header, delegationDepth: 0, isSeeded: false };
  const restore = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader(header, 0), { recovery: 'strict', validation: 'current' });
  for (const event of h.events()) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event));
  assert.equal(restore.finish().events.length, h.events().length);
  const cold = Session.create(SessionId(h.agent.id), h.events(), header, 0);
  assert.deepEqual(h.ctx.sessionProjections.stateOf(cold, 'trajectory'), h.state());
}
const visible = h => JSON.stringify(h.agent.session.deriveMessages());

test('release keeps supplied text and restores work; reminders preserve the current anchor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-reading-')), h = await harness({ archiveDir: dir });
  try {
    const { archive, work } = await seed(h);
    const read = (await h.tool('trajectory_read', { archive_id: archive.id, max_chars: Number.MAX_SAFE_INTEGER })).value;
    assert.equal(read.status, 'read'); assert.ok(read.text.includes('SHARED_ORIGINAL_'));
    assert.equal(h.state().readCoverage.length, 1); assert.equal(h.state().pendingReads.length, 0);
    const before = h.events();
    const released = await h.tool('trajectory_release', { anchor_id: read.anchor.id });
    assert.equal(released.error, false); assert.equal(released.value.anchor.id, work.id);
    assert.ok(visible(h).includes('SHARED_ORIGINAL_')); assert.deepEqual(h.events().slice(0, before.length), before);
    const repeated = (await h.tool('trajectory_read', { archive_id: archive.id, max_chars: 500 })).value;
    assert.equal(repeated.status, 'already_read'); assert.equal(repeated.anchor.id, work.id);
    assert.equal(repeated.text, undefined); assert.equal(repeated.readRanges[0].format, 'raw');
    assert.ok(JSON.stringify(h.adapter.requests.at(-1).messages).includes('Ranges already supplied in this work'));
    const retained = (await h.tool('trajectory_anchor', { label: 'another label' })).value;
    assert.equal(retained.status, 'work_active'); assert.equal(retained.anchor.id, work.id);
    assert.equal(h.state().readCoverage.length, 1);
    await h.tool('trajectory_compact', { anchor_id: work.id, summary: 'This work and its recollection are summarized.' });
    const nextWork = (await h.tool('trajectory_anchor', { label: 'a new shared activity' })).value.anchor;
    assert.equal(h.state().readCoverage.length, 0);
    const fresh = (await h.tool('trajectory_read', { archive_id: archive.id, max_chars: 500 })).value;
    assert.equal(fresh.status, 'read'); assert.equal(fresh.suspendedWorkAnchor.id, nextWork.id);
    replay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('summary receipts survive native resume and permit focused detail recovery and reinterpretation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-reading-'));
  const options = { archiveDir: join(dir, 'archives'), root: join(dir, 'sessions') };
  let h = await harness(options);
  try {
    const { archive, work } = await seed(h);
    const read = (await h.tool('trajectory_read', { archive_id: archive.id, max_chars: 500 })).value;
    const summary = (await h.tool('trajectory_compact', { anchor_id: read.anchor.id, summary: 'We have revisited the opening; continue the present conversation.' })).value;
    assert.equal(summary.anchor.id, work.id);
    assert.equal(h.state().readCoverage[0].format, 'summary');
    assert.equal(h.state().readCoverage[0].summaryArchiveId, summary.archive.id);
    const id = h.agent.id, state = structuredClone(h.state());
    await h.close(); h = await harness({ ...options, resume: id }); assert.deepEqual(h.state(), state);
    const same = (await h.tool('trajectory_read', { archive_id: archive.id, max_chars: 500 })).value;
    assert.equal(same.status, 'already_read'); assert.equal(same.anchor.id, work.id);
    assert.equal(same.readRanges[0].summaryArchiveId, summary.archive.id);
    for (const [intent, focus] of [['recover_detail', 'Recover the exact opening of this recollection.'], ['reinterpret', 'Consider what the opening means for the current conversation.']]) {
      const revisit = (await h.tool('trajectory_read', { archive_id: archive.id, max_chars: 500, intent, focus })).value;
      assert.equal(revisit.status, 'read'); assert.equal(revisit.intent, intent); assert.equal(revisit.focus, focus);
      assert.equal(revisit.text, read.text); assert.equal(revisit.anchor.kind, 'review');
      await h.tool('trajectory_release', { anchor_id: revisit.anchor.id });
    }
    assert.equal(h.state().anchor.id, work.id); replay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('overlapping requests supply unread gaps and retain actual Unicode page boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-reading-')), h = await harness({ archiveDir: dir });
  try {
    const { archive } = await seed(h);
    const read = (offset, max_chars) => h.tool('trajectory_read', { archive_id: archive.id, offset, max_chars }).then(r => r.value);
    await read(0, 100); await read(200, 100);
    const gap1 = await read(0, 400), gap2 = await read(gap1.nextOffset, 400 - gap1.nextOffset);
    assert.equal(gap1.offset, 100); assert.equal(gap1.text.length, 100); assert.equal(gap1.nextOffset, 200);
    assert.equal(gap2.offset, 300); assert.equal(gap2.text.length, 100); assert.equal(gap2.nextOffset, 400);
    const repeated = await read(0, 400); assert.equal(repeated.status, 'already_read'); assert.equal(repeated.nextUnreadOffset, 400);
    const document = await new ArchiveStore(dir).read(archive, new AbortController().signal);
    const original = renderTranscript(document), lotus = original.indexOf('🪷'); assert.ok(lotus > 400);
    const unicode = await read(lotus + 1, 1); assert.equal(unicode.text, '🪷'); assert.equal(unicode.offset, lotus);
    assert.ok(h.state().readCoverage.some(row => row.start === lotus && row.end === lotus + 2));
    assert.equal((await read(lotus, 2)).status, 'already_read');
    await h.tool('trajectory_compact', { anchor_id: h.state().anchor.id, summary: 'The opening ranges and the lotus have been revisited.' });
    assert.ok(h.state().readCoverage.some(row => row.start === 0 && row.end === 400 && row.format === 'summary'));
    assert.equal((await read(0, 500)).offset, 400);
    const anchor = structuredClone(h.state().anchor);
    assert.equal((await read(original.length, 100)).status, 'end_of_archive');
    assert.deepEqual(h.state().anchor, anchor); replay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('forwarded nested pages acquire coverage when the durable root result is visible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-reading-'));
  const h = await harness({ archiveDir: dir, setup: async ctx => {
    ctx.tools.register(defineTool({ name: 'forward_read', description: 'Forward a page to the current conversation.',
      parameters: { id: { type: 'string', required: true } }, output,
      async execute(args, exec) {
        const marked = await ctx.tools.execute({ name: 'trajectory_anchor', arguments: { label: 'work started inside PTC' },
          callId: crypto.randomUUID(), rootCallId: exec.rootCallId, parent: exec.token, agent: exec.agent, signal: exec.signal });
        assert.equal(marked.isError, false);
        const result = await ctx.tools.execute({ name: 'trajectory_read', arguments: { archive_id: args.id, max_chars: 300 },
          callId: crypto.randomUUID(), rootCallId: exec.rootCallId, parent: exec.token, agent: exec.agent, signal: exec.signal });
        assert.equal(result.isError, false); return { work: marked.value.anchor, read: result.value };
      },
    }));
  } });
  try {
    const { archive, work } = await seed(h);
    await h.tool('trajectory_compact', { anchor_id: work.id, summary: 'Previous work summarized before beginning PTC work.' });
    const forwarded = await h.tool('forward_read', { id: archive.id }); assert.equal(forwarded.error, false);
    assert.equal(forwarded.value.work.startSeq, forwarded.value.read.anchor.startSeq);
    assert.equal(h.state().readCoverage.length, 1); assert.equal(h.state().pendingReads.length, 0);
    await h.tool('trajectory_release', { anchor_id: h.state().anchor.id });
    const same = (await h.tool('trajectory_read', { archive_id: archive.id, max_chars: 300 })).value;
    assert.equal(same.status, 'already_read'); assert.equal(same.anchor.id, forwarded.value.work.id); replay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a work anchor and read in one native group resume at the review summary with the same work identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-reading-'));
  const options = { archiveDir: join(dir, 'archives'), root: join(dir, 'sessions') };
  let h = await harness(options);
  try {
    const { archive, work } = await seed(h);
    await h.tool('trajectory_compact', { anchor_id: work.id, summary: 'Earlier work has been summarized.' });
    await h.send([calls(
      ['trajectory_anchor', { label: 'work and review begun together' }],
      ['trajectory_read', { archive_id: archive.id, max_chars: 500 }],
      ['fixture', { value: 'SIBLING_CONTEXT' }],
    ), respond('The original text is available for a later summary.')]);
    const review = h.state().anchor, parent = h.state().suspendedWorkAnchor;
    assert.equal(review.kind, 'review'); assert.equal(review.startSeq, parent.startSeq);
    const summary = (await h.tool('trajectory_compact', { anchor_id: review.id, summary: 'Review complete; the current work continues with SIBLING_CONTEXT.' })).value;
    const summaryEvent = h.events().findLast(e => e.type === 'user/message' && e.data.source?.form === 'summary');
    assert.equal(summary.anchor.id, parent.id); assert.equal(summary.anchor.startSeq, summaryEvent.seq);
    assert.equal(h.state().readCoverage[0].workAnchorId, parent.id);
    assert.equal(h.state().readCoverage[0].format, 'summary');
    const id = h.agent.id, state = structuredClone(h.state());
    await h.close(); h = await harness({ ...options, resume: id }); assert.deepEqual(h.state(), state);
    const same = (await h.tool('trajectory_read', { archive_id: archive.id, max_chars: 500 })).value;
    assert.equal(same.status, 'already_read'); assert.equal(same.anchor.id, parent.id);
    const completed = await h.tool('trajectory_compact', { anchor_id: parent.id, summary: 'The work beginning with the review summary has now been summarized.' });
    assert.equal(completed.error, false, completed.raw); assert.equal(h.state().anchor, null);
    const finalArchive = h.state().archives.find(row => row.id === completed.value.archive.id);
    const document = await new ArchiveStore(options.archiveDir).read(finalArchive, new AbortController().signal);
    assert.ok(JSON.stringify(document.events).includes('SIBLING_CONTEXT'));
    assert.equal((await h.tool('trajectory_anchor', { label: 'next work' })).value.status, 'created');
    replay(h);
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});
