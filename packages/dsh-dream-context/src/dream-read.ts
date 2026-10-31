import { z } from 'zod';
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { trajectoryProjection } from '@riversjin/dsh-trajectory';
import { transcript } from './history.js';
import { Recall } from './recall.js';
import type { Store } from './store.js';
import type { Archive, Book, Config, Episode, LegacyArchive, LegacySource, Transcript } from './types.js';

const page = { offset: z.number().int().nonnegative().optional(), max_chars: z.number().int().min(1).max(32_000).optional() };
const pageParameters = { offset: { type: 'integer', minimum: 0 }, max_chars: { type: 'integer', minimum: 1, maximum: 32_000 } };
export const DREAM_READ_TOOLS: ToolSchema[] = [
  { name: 'experience_search', description: 'Read-only search over the memories and episode summaries of this branch; returns real IDs and evidence. Never modifies or activates a memory. Optional limit, default 8.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'], additionalProperties: false } },
  { name: 'experience_read', description: 'Page through an episode archive and its media by episode/evidence ID. Omit episode_id for a compact directory, newest day first (ID, day, whether summarized, first sentence of the summary; legacy sources at the end); the directory pages with offset/max_chars too. Original dates are kept; retry-withdrawn messages are excluded. Each dream has a read budget (calls and characters), and repeating a call with identical arguments returns no new content. Read only when you need detail.',
    parameters: { type: 'object', properties: { episode_id: { type: 'string' }, ...pageParameters }, additionalProperties: false } },
  { name: 'trajectory_read', description: 'Read-only trajectory access inside a dream: omit archive_id to list the inherited trajectory archives, or give an ID to page through its effective text. Opens no anchor and never modifies the daytime session; no compact/release needed.',
    parameters: { type: 'object', properties: { archive_id: { type: 'string' }, ...pageParameters,
      intent: { type: 'string', enum: ['new_content', 'recover_detail', 'reinterpret'] }, focus: { type: 'string' } }, additionalProperties: false } },
];

function json(value: unknown): ContentBlock[] { return [{ type: 'text', text: JSON.stringify(value) }]; }
const firstSentence = (text: string, max = 60) => {
  const head = text.replace(/\s+/g, ' ').trim();
  const cut = head.search(/[。！？!?\n]/u);
  const sentence = cut >= 0 ? head.slice(0, cut + 1) : head;
  return sentence.length > max ? `${sentence.slice(0, max)}…` : sentence;
};
/** Compact directory: newest day first, one line per entry, legacy sources last. */
export function directoryText(episodes: readonly Episode[], legacy: readonly LegacySource[] = [], timeZone?: string): string {
  const days = [...episodes].sort((a, b) => b.day.localeCompare(a.day) || b.startAt - a.startAt)
    .map(e => `${e.id} ${e.day}${e.summary ? ` summarized: ${firstSentence(e.summary)}` : ' not summarized'}`);
  const date = (ms: number) => new Date(ms).toLocaleDateString('sv-SE', timeZone ? { timeZone } : undefined);
  const sources = [...legacy].sort((a, b) => b.originalTime - a.originalTime).map(s => `${s.id} ${date(s.originalTime)}`);
  return [`${days.length} episode day(s), newest first:`, ...days, `${sources.length} legacy source(s):`, ...sources].join('\n');
}
/** Page a line-oriented directory without cutting a line in two unless a single line is wider than the page. */
function readDirectory(text: string, offset: number, width: number, extra: Record<string, unknown>): ContentBlock[] {
  if (offset > text.length) throw new Error('offset exceeds the directory text');
  let end = Math.min(text.length, offset + width);
  if (end < text.length) { const cut = text.lastIndexOf('\n', end); if (cut > offset) end = cut; }
  return json({ ...extra, directory: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, totalChars: text.length });
}
function readPage(source: Transcript, offset: number, width: number, metadata: Record<string, unknown>): ContentBlock[] {
  if (offset > source.text.length) throw new Error('offset exceeds the source text');
  let start = offset, end = Math.min(source.text.length, offset + width);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(source.text[start] ?? '')) start--;
  if (end < source.text.length && /[\uDC00-\uDFFF]/u.test(source.text[end] ?? '')) end++;
  return [...json({ ...metadata, text: source.text.slice(start, end), offset: start, nextOffset: end < source.text.length ? end : null,
    totalChars: source.text.length }), ...(offset === 0 ? source.media : [])];
}

/** Reads are bound to the immutable parent snapshot. No host tool dispatcher,
 * agent registration, anchor mutation or message delivery is reachable here. */
export function dreamReader(parent: Session, book: Book, store: Store, config: Config) {
  const events = parent.snapshotEvents();
  const trajectory = events.reduce(trajectoryProjection.apply, trajectoryProjection.init(parent.header, parent.inheritedEventCount));
  const recall = new Recall(config);
  const presentedEvidence = new Set<string>();
  // Identical calls are answered once; the budget counts only calls that returned new material.
  const answered = new Map<string, { ordinal: number; chars: number }>();
  const used = { calls: 0, chars: 0 };
  const left = () => ({ readsLeft: Math.max(0, config.maxDreamReads - used.calls), charsLeft: Math.max(0, config.maxDreamReadChars - used.chars) });
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  const perform = async (name: string, raw: unknown, signal: AbortSignal): Promise<ContentBlock[]> => {
    if (name === 'experience_search') {
      const args = z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).optional() }).parse(raw);
      const hits = await recall.search(book, args.query, args.limit ?? 8, signal, 'explicit');
      for (const hit of hits) for (const id of hit.evidence) presentedEvidence.add(id);
      return json(hits);
    }
    if (name === 'experience_read') {
      const args = z.object({ episode_id: z.string().optional(), ...page }).parse(raw);
      if (!args.episode_id) return readDirectory(directoryText(book.episodes, book.legacySources ?? [], config.timeZone), args.offset ?? 0, args.max_chars ?? 6_000, left());
      const episode = book.episodes.find(e => e.id === args.episode_id), legacy = book.legacySources?.find(s => s.id === args.episode_id);
      if (!episode && !legacy) throw new Error('Source is not reachable from this branch');
      const source = episode ? transcript(await store.get<Archive>(episode.archive), undefined, events)
        : { text: (await store.get<LegacyArchive>(legacy!.ref)).text, media: [] };
      signal.throwIfAborted();
      const result = readPage(source, args.offset ?? 0, args.max_chars ?? 12_000,
        { episodeId: args.episode_id, originalTime: episode?.startAt ?? legacy!.originalTime, ...left() });
      presentedEvidence.add(args.episode_id);
      return result;
    }
    if (name === 'trajectory_read') {
      const args = z.object({ archive_id: z.string().optional(), ...page,
        intent: z.enum(['new_content', 'recover_detail', 'reinterpret']).optional(), focus: z.string().optional() }).parse(raw);
      if (!args.archive_id) return json({ archives: trajectory.archives.map(a => ({ id: a.id, label: a.label,
        startSeq: a.startSeq, endSeq: a.endSeq, firstEventTime: a.firstEventTime, lastEventTime: a.lastEventTime })), readonly: true });
      const reference = trajectory.archives.find(a => a.id === args.archive_id);
      if (!reference) throw new Error('Archive is not reachable from this branch');
      // Native compaction preserves the complete original event range in the
      // inherited log. Read that same source, applying later retry withdrawals.
      const range = events.filter(e => e.seq >= reference.startSeq && e.seq <= reference.endSeq);
      if (range.length !== reference.eventCount || range[0]?.seq !== reference.startSeq || range.at(-1)?.seq !== reference.endSeq)
        throw new Error('Archive source range is incomplete in this branch');
      const archive: Archive = { version: 1, owner: reference.ownerSessionId, from: reference.startSeq, to: reference.endSeq, events: range };
      return readPage(transcript(archive, undefined, events), args.offset ?? 0, args.max_chars ?? 16_000,
        { archiveId: reference.id, originalTime: reference.firstEventTime, readonly: true, ...left() });
    }
    throw new Error('Only experience_search, experience_read and trajectory_read are available in a dream');
  };
  return { presentedEvidence, used, async read(name: string, raw: unknown, signal: AbortSignal): Promise<ContentBlock[]> {
    signal.throwIfAborted();
    const key = JSON.stringify([name, canonical(raw)]);
    const earlier = answered.get(key);
    if (earlier) return json({ repeated: true, sameAsCall: earlier.ordinal,
      note: `Identical to read #${earlier.ordinal}; the result has not changed. Use that result, or change the arguments (offset, episode_id, ...).`, ...left() });
    if (used.calls >= config.maxDreamReads || used.chars >= config.maxDreamReadChars)
      throw new Error(`Read budget exhausted (${used.calls} calls, about ${used.chars} characters). Return the final JSON from the material you already have.`);
    // Counted before performing so the returned readsLeft already excludes this call; a failed call is not charged.
    used.calls++;
    let result: ContentBlock[];
    try { result = await perform(name, raw, signal); } catch (error) { used.calls--; throw error; }
    used.chars += result.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0);
    answered.set(key, { ordinal: used.calls, chars: used.chars });
    return result;
  } };
}
