// Replay the submission step of a stored dream-fork offline: parse, validate and
// apply its final response against the book it was authored from. Reads the live
// object store; anything written lands in a scratch directory.
//
// usage: node scripts/replay-dream-fork.mjs <objects-dir> <scratch-dir> <parent-session.v4.jsonl(.zstd)> <fork-ref>...
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import LocalAttachments from '@deepseek-ai/dsh-attachment-local';
import * as ImageOffload from '@deepseek-ai/dsh-compaction-image-offload';
import { Store } from '../lib/store.js';
import { bookRef } from '../lib/history.js';
import { DEFAULT_CONFIG } from '../lib/types.js';
import { recoverDream } from '../lib/dream.js';

const [, , objectsDir, scratchDir, logPath, ...refs] = process.argv;
if (!objectsDir || !scratchDir || !logPath || !refs.length) throw new Error('usage: replay-dream-fork.mjs <objects> <scratch> <parent-log> <fork-ref>...');
// The fork header is a seeded fork header; the parent prefix must be rebuilt under the parent's own header.
const rawLog = logPath.endsWith('.zstd') ? execFileSync('zstdcat', ['-q', logPath], { maxBuffer: 4 * 1024 * 1024 * 1024 }).toString('utf8') : readFileSync(logPath, 'utf8');
const lines = rawLog.split('\n').filter(Boolean);
const restore = sessionFormatCatalog.createRestore(JSON.parse(lines[0]), { recovery: 'strict', validation: 'current' });
for (const line of lines.slice(1)) restore.decodeRow(JSON.parse(line));
const parent = restore.finish();
process.env.DSH_HOME = join(scratchDir, 'dsh-home');
const ctx = new Context();
for (const plugin of [LlmRuntime, SessionStore, Projections, TokenMeter, SystemPrompt, Tools, AgentRegistry, LocalAttachments, ImageOffload]) await ctx.plugin(plugin);

class ScratchStore extends Store {
  constructor(live, scratch) { super(scratch); this.live = new Store(live); }
  async get(ref) { try { return await this.live.get(ref); } catch { return super.get(ref); } }
}
const store = new ScratchStore(objectsDir, join(scratchDir, 'objects'));
const config = { ...DEFAULT_CONFIG, timeZone: 'Asia/Singapore', startDay: '2026-10-14', summaryDays: 21 };

for (const ref of refs) {
  const saved = await store.get(ref);
  const base = await store.get(saved.parentPrefix);
  if (parent.header.id !== saved.parent) throw new Error(`fork ${ref} belongs to ${saved.parent}, log is ${parent.header.id}`);
  const session = Session.create(SessionId(saved.parent), base.events, parent.header, SessionLogOffset(parent.inheritedEventCount), ctx.sessions.messageProjections);
  const book = await store.get(bookRef(session));
  const episode = book.episodes.find(e => e.id === saved.episode);
  const reply = [...saved.events].reverse().find(e => e.type === 'assistant/message');
  const text = reply?.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? '';
  console.log(`\n== ${ref.slice(0, 12)} episode ${episode?.day} finish=${saved.finish?.kind} selected=${saved.selectedMemoryIds?.length} readEvidence=${saved.readEvidence?.length ?? 0}`);
  try {
    const next = await recoverDream(ctx, { id: saved.parent, session }, book, episode, store, config, ref, new AbortController().signal);
    console.log('  would have applied: memories', book.memories.length, '->', next.memories.length);
  } catch (error) {
    console.log('  REJECTED:', error.message);
    try {
      const proposal = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
      const known = new Set(book.memories.map(m => m.id));
      const selected = new Set(saved.selectedMemoryIds ?? []);
      console.log('  bias ids:', (proposal.biasAdjustments ?? []).map(b => `${b.id}${selected.has(b.id) ? '' : ' (NOT sampled)'}`));
      console.log('  memory ids:', proposal.memories.map(m => m.id === undefined ? '(new)' : `${m.id}${known.has(m.id) ? '' : ' (UNKNOWN)'}${selected.has(m.id) ? ' sampled' : ''}`));
      console.log('  episode ids:', proposal.episodes.map(e => e.id));
      console.log('  top-level keys:', Object.keys(proposal));
    } catch (e) { console.log('  (reply is not plain JSON:', e.message, ')'); console.log(text.slice(0, 400)); }
  }
}
await ctx.fiber.dispose();
