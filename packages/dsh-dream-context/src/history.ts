import { createDeveloperMessage, createUserMessage, type ContentBlock, type Message } from '@deepseek-ai/dsh-llm';
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session';
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { trajectoryProjection } from '@riversjin/dsh-trajectory';
import { serializeConversation, toSnapcompactMessages } from '@riversjin/dsh-optical-compaction';
import { dayKey, slotAt } from './policy.js';
import { linkDaytimeEvidence } from './edits.js';
import { digest, Store } from './store.js';
import { DAY, SOURCE, type Archive, type Book, type DreamSource, type Episode, type Policy, type Stage, type Transcript } from './types.js';

export function eventMessage(event: SessionEvent) {
  if (event.type === 'user/message') return event.data;
  if (event.type === 'system/message' || event.type === 'assistant/message' || event.type === 'developer/message' || event.type === 'tool/result') return event.data.message;
  return null;
}

/** Retry is a withdrawal, unlike compaction. Exact native provenance identifies
 * the superseded surface nodes; replayed inputs have their own new identities.
 * The authority may extend past an archive boundary (a later retry still wins). */
export function retryWithdrawnSeqs(events: readonly SessionEvent[]): ReadonlySet<number> {
  const withdrawn = new Set<number>();
  for (const event of events) {
    const source = eventMessage(event)?.source as { kind: string; form?: string } | undefined;
    if (source?.kind === 'plugin:dsh-retry' && source.form === 'reset') {
      for (const seq of event.sourceEventSeqs ?? []) withdrawn.add(seq);
    }
  }
  return withdrawn;
}
export function sourceOf(event: SessionEvent): DreamSource | undefined {
  const source = eventMessage(event)?.source;
  return source?.kind === SOURCE ? source : undefined;
}
export function bookRef(session: Session): string | undefined {
  for (const event of [...session.snapshotEvents()].reverse()) {
    const source = sourceOf(event);
    if (source?.form === 'book') return source.ref;
  }
  return undefined;
}
export function publishBook(session: Session, ref: string): void {
  session.append('user/message', createUserMessage({
    content: [], source: { kind: SOURCE, form: 'book', ref },
  }), { surfaceOp: 'append' });
}

export const ANCHOR_DREAM_GUIDANCE = '锚点不可以跨梦境存在。进入夜间整理前，先由你自己收束当前锚点；复查锚点可先收束或释放，再收束底层工作锚点。未完事项写入你自己的收束总结，醒来后需要继续时重新开锚点。到做梦时间仍有锚点时，系统会向你的主会话投递收束请求；请实际调用工具并确认成功，锚点清空后系统自动继续夜间整理。系统不会替你代写收束。';

export function unclosedDreamAnchors(session: Session) {
  const state = session.snapshotEvents().reduce(trajectoryProjection.apply, trajectoryProjection.init(session.header, session.inheritedEventCount));
  return [state.anchor, state.suspendedWorkAnchor].filter(anchor => anchor !== null);
}

/** Idle maintenance may append native user replacements. Empty developer
 * replacements are admitted only inside an actual step, before model input. */
export function hideMetadata(session: Session, turn: number, step: number): void {
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)!;
    const source = sourceOf(event);
    if (event.type !== 'user/message' || !source || !(source.form === 'book' || source.stage === 'recalled'
      || ((source.form === 'recall' || source.form === 'recall-status') && source.turn !== turn))) continue;
    session.append('developer/message', { turn, step, message: createDeveloperMessage({ content: [], source }) }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
    });
  }
}

interface TurnGroup { day: string; events: SessionEvent[]; }

/** Group complete turns into days. A turn crossing 04:00 stays whole. Turns a
 * human or an acted-upon clock notice started decide the day; every other
 * turn (her reminders, system notices, subagent reports) joins the next such
 * turn's day, so no event before a day's end is left outside its archive. */
export function groupTurns(events: readonly SessionEvent[], afterSeq: number, until: number, policy: Policy & { startDay: string; maxSummaryDays: number },
  options: { now: number; days?: (day: string) => boolean; honourStart?: boolean }): { groups: TurnGroup[]; consumedThrough: number } {
  let open: SessionEvent[] = [], orphans: SessionEvent[] = [];
  const groups = new Map<string, TurnGroup>();
  let consumedThrough = afterSeq;
  for (const event of events) {
    if (event.seq <= afterSeq) continue;
    if (event.type === 'turn/start') open = [event];
    else if (open.length) open.push(event);
    if (event.type !== 'turn/end' || !open.length) continue;
    if (event.time >= until) { open = []; continue; }
    const human = open.find(row => row.type === 'user/message' && row.data.source.kind === 'user' && row.surfaceOp === 'append');
    const clock = open.find(row => {
      if (row.type !== 'user/message' || row.surfaceOp !== 'append') return false;
      const source = row.data.source as { kind: string; notification?: string };
      return source.kind === 'schedule' && source.notification === 'time_passing';
    });
    const action = open.some(row => row.type === 'tool/call' || (row.type === 'assistant/message' && row.data.message.content.length > 0));
    const entry = human ?? (clock && action ? clock : undefined);
    const turn = open; open = [];
    if (!entry) { orphans.push(...turn); continue; }
    const first = orphans[0] ?? turn[0]!;
    const key = dayKey(entry.time, policy);
    const admitted = (options.days ? options.days(key) : true)
      && (options.honourStart === false || ((policy.startDay || first.time >= options.now - policy.maxSummaryDays * DAY) && (!policy.startDay || key >= policy.startDay)));
    if (admitted) {
      const group = groups.get(key);
      const rows = [...orphans, ...turn];
      if (group) group.events.push(...rows); else groups.set(key, { day: key, events: rows });
    }
    consumedThrough = Math.max(consumedThrough, event.seq);
    orphans = [];
  }
  // Trailing orphan turns wait for the next day's entry turn.
  return { groups: [...groups.values()], consumedThrough };
}

async function appendEpisodes(session: Session, book: Book, groups: readonly TurnGroup[], store: Store): Promise<void> {
  const events = session.snapshotEvents();
  for (const { day, events: selected } of groups) {
    const from = selected[0]!.seq, to = selected.at(-1)!.seq;
    // Include inter-turn native events, too. The archive remains an exact range.
    const range = events.slice(from, to + 1);
    const archive: Archive = { version: 1, owner: session.id, from, to, events: range };
    const ref = await store.put(archive);
    const id = `episode_${digest([session.id, from, to]).slice(0, 24)}`;
    if (!book.episodes.some(row => row.id === id || (row.from <= to && row.to >= from))) {
      book.episodes.push({
        id, owner: session.id, day, from, to, startAt: selected[0]!.time, endAt: selected.at(-1)!.time,
        archive: ref, summary: '', revision: 0,
      });
      linkDaytimeEvidence(book, { id, from, to });
    }
  }
}

/** Capture only complete conversational turns; a turn crossing 04:00 stays whole.
 * Store the complete native events, including tools and attachments. */
export async function capture(session: Session, original: Book, store: Store, now: number, policy: Policy & { startDay: string; maxSummaryDays: number }): Promise<Book> {
  const book = structuredClone(original);
  const { groups, consumedThrough } = groupTurns(session.snapshotEvents(), book.capturedThrough, slotAt(now, policy), policy, { now });
  await appendEpisodes(session, book, groups, store);
  book.capturedThrough = Math.max(book.capturedThrough, consumedThrough);
  book.owner = session.id;
  return book;
}

/** Backfill archives for days that predate the capture cursor or the start day.
 * Leaves the cursor alone and never creates a summary obligation by itself. */
export async function archiveRange(session: Session, original: Book, store: Store, now: number, policy: Policy & { startDay: string; maxSummaryDays: number },
  fromDay: string, toDay: string): Promise<{ book: Book; added: string[] }> {
  const book = structuredClone(original);
  const existing = new Set(book.episodes.map(e => e.day));
  const { groups } = groupTurns(session.snapshotEvents(), -1, slotAt(now, policy), policy,
    { now, honourStart: false, days: day => day >= fromDay && day <= toDay && !existing.has(day) });
  await appendEpisodes(session, book, groups, store);
  book.episodes.sort((a, b) => a.from - b.from);
  book.owner = session.id;
  return { book, added: book.episodes.map(e => e.day).filter(day => !existing.has(day)).sort() };
}

/** Recollections/time snapshots are not new experiences. Tool output is quoted
 * evidence; original media is retained separately from rasterized text. */
export function transcript(archive: Archive, messageIds?: ReadonlySet<string>, authority: readonly SessionEvent[] = archive.events): Transcript {
  const lines: string[] = [];
  const media: ContentBlock[] = [];
  const seen = new Set<string>();
  const recallCalls = new Set<string>();
  const withdrawn = retryWithdrawnSeqs(authority);
  for (const event of archive.events) {
    const message = eventMessage(event);
    for (const block of message?.content ?? []) {
      if (block.type === 'tool-call' && ['experience_read', 'experience_search', 'trajectory_read', 'memory_search', 'conversation_search'].includes(block.name)) recallCalls.add(block.id);
    }
  }
  for (const event of archive.events) {
    const message = eventMessage(event);
    if (withdrawn.has(event.seq) || !message || (messageIds && !messageIds.has(message.id)) || message.role === 'system' || message.role === 'developer') continue;
    if (message.role === 'tool' && recallCalls.has(message.toolCallId)) continue;
    const externalSource = message.source as { kind: string; form?: string };
    if (message.role === 'user' && message.source.kind !== 'user'
      && !(externalSource.kind === 'plugin:dsh-trajectory' && externalSource.form === 'summary')) continue;
    if (event.surfaceOp !== 'append' && externalSource.kind !== 'plugin:dsh-trajectory') continue;
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text);
      else if (block.type === 'tool-call' && !recallCalls.has(block.id)) parts.push(`[tool ${block.name}] ${block.arguments}`);
      else if (block.type === 'image' || block.type === 'file') {
        const hash = digest(block);
        if (!seen.has(hash)) { media.push(block); seen.add(hash); }
        parts.push(`[${block.type}: ${hash.slice(0, 16)}]`);
      }
    }
    if (parts.length) lines.push(`#${event.seq} ${new Date(event.time).toISOString()} ${message.role}\n${parts.join('\n')}`);
  }
  return { text: lines.join('\n\n'), media };
}

export function episodeNodes(session: Session, episode: Episode): number[] {
  const events = session.snapshotEvents();
  const replacement = session.surface.nodes.filter(seq => {
    const source = sourceOf(events[seq]!);
    return source?.form === 'episode' && source.episodeId === episode.id;
  });
  if (replacement.length) return replacement;
  const bounds = new Map<number, [number, number]>();
  const origins = (seq: number): [number, number] => {
    const cached = bounds.get(seq);
    if (cached) return cached;
    const event = events[seq]!;
    const sources = event.surfaceOp !== 'append' ? event.sourceEventSeqs?.filter(n => n < seq) : undefined;
    const ranges = sources?.length ? sources.map(origins) : [[seq, seq] as [number, number]];
    const range: [number, number] = [Math.min(...ranges.map(r => r[0])), Math.max(...ranges.map(r => r[1]))];
    bounds.set(seq, range);
    return range;
  };
  const nodes: number[] = [];
  for (const seq of session.surface.nodes) {
    if (eventMessage(events[seq]!)?.role === 'system') continue;
    const [from, to] = origins(seq);
    if (to < episode.from || from > episode.to) continue;
    // A replacement spanning days cannot be split or counted twice.
    if (from < episode.from || to > episode.to) return [];
    nodes.push(seq);
  }
  return nodes;
}

/** Read archived originals only for nodes still on the effective surface.
 * Later replacements (including authored summaries) win over their raw source. */
export function compressionTranscript(archive: Archive, session: Session, nodes: readonly number[]): Transcript {
  const originals = new Map(archive.events.map(event => [event.seq, event]));
  const visible = new Map(session.deriveMessages().map(message => [message.id, message]));
  const messages: Message[] = [], media: ContentBlock[] = [];
  const timestamps = new Map<string, number>();
  const seen = new Set<string>();
  for (const seq of nodes) {
    const event = session.eventAt(SessionSeq(seq))!;
    const current = eventMessage(event);
    if (!current) continue;
    // Derivation also respects attachment offloading and empty removals.
    const projected = visible.get(current.id);
    if (!projected) continue;
    const original = eventMessage(originals.get(SessionSeq(seq)) ?? event);
    if (!original || original.id !== current.id) throw new Error('Archive/surface identity mismatch');
    const message = projected;
    if (message.role === 'system' || message.role === 'developer') continue;
    const source = message.source as { kind: string; form?: string };
    if (message.role === 'user' && source.kind !== 'user'
      && !(source.kind === 'plugin:dsh-trajectory' && source.form === 'summary')
      && !(source.kind === SOURCE && source.form === 'episode')) continue;
    const content: ContentBlock[] = [];
    for (const block of message.content) {
      if (block.type === 'image' || block.type === 'file') {
        const hash = digest(block);
        if (!seen.has(hash)) { media.push(block); seen.add(hash); }
        content.push({ type: 'text', text: `[${block.type}: ${hash.slice(0, 16)}]` });
      } else content.push(block);
    }
    messages.push({ ...message, content });
    timestamps.set(message.id, event.time);
  }
  // Share the old optical serializer and its configured defaults: arguments
  // 500 chars, each call/result 2000 chars, 60/40 head/tail, dim result body.
  const text = serializeConversation(toSnapcompactMessages(messages, timestamps));
  return { text, media };
}
export function existingStage(session: Session, episode: Episode): Stage {
  const events = session.snapshotEvents();
  for (const seq of episodeNodes(session, episode)) {
    const stage = sourceOf(events[seq]!)?.stage;
    if (stage) return stage;
  }
  return 'raw';
}
export function replacementAllowed(session: Session, nodes: number[]): boolean {
  if (!nodes.length) return false;
  const surface = session.surface.nodes;
  const at = surface.indexOf(SessionSeq(nodes[0]!));
  if (at < 0 || nodes.some((seq, i) => surface[at + i] !== seq)) return false;
  const trajectory = session.snapshotEvents().reduce(trajectoryProjection.apply, trajectoryProjection.init(session.header, session.inheritedEventCount));
  for (const anchor of [trajectory.anchor, trajectory.suspendedWorkAnchor]) {
    if (anchor && nodes.some(seq => seq >= anchor.startSeq)) return false;
  }
  for (const seq of nodes) {
    const event = session.eventAt(SessionSeq(seq))!;
    const message = eventMessage(event);
    if (message?.role === 'system') return false;
    // A legacy checkpoint may cover far more than this day's range and carry
    // visual history absent from the day's raw transcript. Keep it intact.
    if (String(message?.source.kind) === 'compact-checkpoint') return false;
    // Completed trajectory summaries are original authored material; active
    // anchors were protected above. Their native archive references persist.
    if (sourceOf(event)?.form === 'book') return false;
  }
  return toolPairingBalancedBefore(session, SessionSeq(nodes[0]!))
    && toolPairingBalancedAfter(session, SessionSeq(nodes.at(-1)!));
}
export function replaceEpisode(session: Session, episode: Episode, nodes: number[], stage: Stage, content: ContentBlock[]): void {
  if (!replacementAllowed(session, nodes)) throw new Error(`Episode ${episode.id} changed or is owned by another projection`);
  const source: DreamSource = { kind: SOURCE, form: 'episode', episodeId: episode.id, stage, revision: episode.revision };
  const intent = { surfaceOp: { op: 'replace' as const, startSeq: SessionSeq(nodes[0]!), endSeq: SessionSeq(nodes.at(-1)!) }, sourceEventSeqs: nodes.map(SessionSeq) };
  if (stage === 'recalled') {
    session.append('user/message', createUserMessage({ content: [], source }), intent);
  } else {
    session.append('user/message', createUserMessage({ content, source }), intent);
  }
}
