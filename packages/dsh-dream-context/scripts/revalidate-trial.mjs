// Re-admit a preserved visible model answer after a parser-only correction.
// No network, model call, source rewrite, or production writes.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Session } from '@deepseek-ai/dsh-session';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection';
import { parseProposal, applyProposal } from '../lib/dream.js';
import { Store, digest } from '../lib/store.js';
import { DEFAULT_CONFIG } from '../lib/types.js';
const [directory, referenceBook] = process.argv.slice(2).map(p => resolve(p));
const store = new Store(join(directory, 'objects'));
let archive, ref;
for (const file of await readdir(store.root)) {
  const value = JSON.parse(await readFile(join(store.root, file), 'utf8'));
  if (value.kind === 'dream-fork') { archive = value; ref = file.slice(0, -5); }
}
assert.ok(archive);
const prefix = await store.get(archive.parentPrefix);
const events = [...prefix.events, ...archive.events];
const restore = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader(archive.header, archive.inheritedEventCount), { recovery: 'strict', validation: 'current' });
for (const event of events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event));
restore.finish();
const session = Session.create(archive.header.id, events, archive.header, archive.inheritedEventCount, [imageOffloadProjection]);
const output = archive.events.findLast(e => e.type === 'assistant/message').data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
const proposal = parseProposal(output);
const base = JSON.parse(await readFile(referenceBook, 'utf8'));
base.memories = []; delete base.dreams;
for (const e of base.episodes) { e.summary = ''; e.revision = 0; }
const next = applyProposal(base, proposal, [archive.episode], Date.now(), DEFAULT_CONFIG);
assert.equal(archive.inheritedMessagesHash, archive.requestPrefixHash);
const prior = Session.create(archive.header.id, prefix.events, archive.header, archive.inheritedEventCount, [imageOffloadProjection]);
const ids = new Set(prior.deriveMessages().map(m => m.id));
assert.ok(archive.supplementedMessageIds.every(id => !ids.has(id)));
const report = { model: archive.model, reasoningEffort: archive.reasoningEffort, originalArchiveComplete: archive.complete,
  formatReadmission: true, additionalModelCalls: 0, nativeStrictReplay: true, prefixPreserved: true,
  inheritedMessages: archive.inheritedMessageCount, supplementChars: archive.supplementChars,
  requestChars: archive.requestChars, usage: archive.usage, archivedAnswerHash: digest(output), archiveRef: ref,
  summaryChars: next.episodes[0].summary.length, memories: next.memories.length, newReasoningArchived: archive.reasoningArchived };
await writeFile(join(directory, 'revalidated-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
await writeFile(join(directory, 'revalidated-book.json'), JSON.stringify(next, null, 2), { mode: 0o600 });
await writeFile(join(directory, 'summary.txt'), next.episodes[0].summary, { mode: 0o600 });
console.log(JSON.stringify(report));
