import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { eventMessage } from './history.js';
import type { Quote } from './types.js';

/** Plugin-owned estimator so a host upgrade can never change what stays visible. */
export const ESTIMATOR = 'chars/1.7 v1';
export const estimateTokens = (text: string): number => Math.ceil(text.length / 1.7);

export interface Labels { user: string; self: string; }
export const DEFAULT_LABELS: Labels = { user: '用户', self: '我' };

export interface Photo { n: number; seq: number; time: number; attachment: ImageAttachmentRef; }
export interface Segment {
  kind: 'user' | 'ai' | 'traj' | 'tool';
  sentences: string[];
  pinned: boolean[];
  /** Tool name for tool segments. */
  label?: string;
}
export interface Round { key: string; time: number; segments: Segment[]; photos: number; weight: number; }
export interface Material { rounds: Round[]; photos: Photo[]; }
export type Deletion = { t: 'seg'; r: number; s: number } | { t: 'sent'; r: number; s: number; i: number } | { t: 'round'; r: number };

const APPLIED = new Set(['plugin:dsh-trajectory', 'plugin:dsh-retry']);

/** The day's effective view: archive appends, with her trajectory summaries and
 * retry withdrawals folded in from the live log. Other replacements (old
 * compaction checkpoints, recall rewrites, cleanup) are ignored and their
 * originals kept, so fading always starts from what was actually said. */
export function effectiveEvents(archive: readonly SessionEvent[], live: readonly SessionEvent[], from: number, to: number): SessionEvent[] {
  const items: SessionEvent[] = [];
  const inRange = (seq: number) => seq >= from && seq <= to;
  const later = live.filter(event => event.seq > to && event.surfaceOp !== undefined && event.surfaceOp !== 'append'
    && (event.sourceEventSeqs ?? []).some(inRange));
  for (const event of [...archive, ...later]) {
    const op = event.surfaceOp;
    if (op === undefined) continue;
    if (op === 'append') { items.push(event); continue; }
    const kind = eventMessage(event)?.source.kind;
    if (!kind || !APPLIED.has(kind)) continue;
    const sources = new Set(event.sourceEventSeqs ?? []);
    let at = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (sources.has(items[i]!.seq)) { items.splice(i, 1); at = i; }
    }
    if (at < 0) continue;
    items.splice(at, 0, event);
  }
  return items;
}

const SENTENCE_END = /[。！？!?…]/u;
export function sentences(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of text.replace(/\r/g, '')) {
    if (ch === '\n') { if (current.trim()) out.push(current.trim()); current = ''; continue; }
    current += ch;
    if (SENTENCE_END.test(ch)) continue;
    const previous = current.slice(0, -1);
    if (previous.length > 0 && SENTENCE_END.test(previous.at(-1)!) && !SENTENCE_END.test(ch)) {
      // A new sentence has begun; close the previous one at its last delimiter.
      const closed = previous.trim();
      if (closed) out.push(closed);
      current = ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(s => /[\p{L}\p{N}]/u.test(s) || out.length === 1);
}

function segment(kind: Segment['kind'], text: string, label?: string): Segment | undefined {
  const parts = kind === 'tool' ? [text] : sentences(text);
  if (!parts.length) return undefined;
  return { kind, sentences: parts, pinned: parts.map(() => false), ...(label === undefined ? {} : { label }) };
}

/** Rounds of conversation: one human message with the replies that follow it.
 * Her trajectory summaries stand on their own. Tool results, reasoning, and
 * injected context never enter the excerpt; images become numbered photo marks. */
export function material(events: readonly SessionEvent[], quotes: readonly Quote[] = []): Material {
  const rounds: Round[] = [];
  const photos: Photo[] = [];
  let current: Round | undefined;
  const open = (key: string, time: number) => { current = { key, time, segments: [], photos: 0, weight: 0 }; rounds.push(current); return current; };
  for (const event of events) {
    const message = eventMessage(event);
    if (!message || message.role === 'system' || message.role === 'developer' || message.role === 'tool') continue;
    const source = message.source as { kind: string; form?: string };
    if (message.role === 'user') {
      if (source.kind === 'plugin:dsh-trajectory' && source.form === 'summary') {
        // Keep her words only; the plugin's framing lines are not conversation.
        const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
          .split('\n').filter(line => !/^\[(Model-authored trajectory summary|Conversation continuity:|Review continuity:|Ranges supplied|Original trajectory archive:)/u.test(line)).join('\n');
        const seg = segment('traj', text);
        if (seg) { open(`traj:${event.seq}`, event.time).segments.push(seg); current = undefined; }
        continue;
      }
      if (source.kind !== 'user') continue;
      const round = open(`u:${event.seq}`, event.time);
      const parts: string[] = [];
      for (const block of message.content) {
        if (block.type === 'text') parts.push(block.text);
        else if (block.type === 'image') {
          const photo = { n: photos.length + 1, seq: event.seq, time: event.time, attachment: block.attachment };
          photos.push(photo); round.photos++;
          parts.push(`[照片 #${photo.n}]`);
        } else if (block.type === 'file') parts.push('[文件]');
      }
      // QQ relays describe attached images in prose; the photo mark already says it.
      const spoken = parts.join('\n').replace(/^- Image: attached as native visual input.*$/gmu, '').replace(/\[图片\]/gu, '');
      const seg = segment('user', spoken);
      if (seg) round.segments.push(seg);
      continue;
    }
    // assistant
    const round = current ?? open(`a:${event.seq}`, event.time);
    const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const seg = segment('ai', text);
    if (seg) round.segments.push(seg);
    for (const block of message.content) {
      if (block.type === 'tool-call') { const tool = segment('tool', `[工具 ${block.name}]`, block.name); if (tool) round.segments.push(tool); }
    }
  }
  const kept = rounds.filter(round => round.segments.length > 0);
  for (const round of kept) {
    const user = round.segments.find(s => s.kind === 'user');
    const userChars = user ? user.sentences.join('').length : 0;
    round.weight = (round.photos > 0 ? 2 : 0) + (round.segments[0]?.kind === 'traj' ? 1 : 1 / (1 + userChars / 80));
  }
  pin(kept, quotes);
  return { rounds: kept, photos };
}

const normalize = (text: string): string => text.normalize('NFKC').replace(/[\s​]+/g, '')
  .replace(/[，,]/g, ',').replace(/[。.]/g, '.').replace(/[！!]/g, '!').replace(/[？?]/g, '?').replace(/[：:]/g, ':')
  .replace(/[；;]/g, ';').replace(/[“”"「」『』]/g, '"').replace(/[‘’']/g, "'").replace(/[（(]/g, '(').replace(/[）)]/g, ')')
  .replace(/[—–\-~～]+/g, '-').replace(/…+|\.{3,}/g, '…');

/** Pin every sentence a quote touches. Quotes that match nothing are reported, not fatal. */
export function pin(rounds: readonly Round[], quotes: readonly Quote[]): Quote[] {
  const missing: Quote[] = [];
  for (const quote of quotes) {
    const wanted = normalize(quote.text);
    if (!wanted) { missing.push(quote); continue; }
    let found = false;
    search: for (const round of rounds) for (const seg of round.segments) {
      if (seg.kind === 'tool') continue;
      const norm = seg.sentences.map(normalize);
      for (let i = 0; i < norm.length && !found; i++) {
        let joined = '';
        for (let j = i; j < norm.length; j++) {
          joined += norm[j];
          if (!joined.includes(wanted)) { if (joined.length > wanted.length + norm[i]!.length) break; continue; }
          // Drop leading sentences the quote does not actually need.
          let start = i;
          while (start < j && norm.slice(start + 1, j + 1).join('').includes(wanted)) start++;
          for (let k = start; k <= j; k++) seg.pinned[k] = true;
          found = true; break search;
        }
      }
    }
    if (!found) missing.push(quote);
  }
  return missing;
}

/** The fixed deletion sequence. Earlier entries go first: tool marks, the
 * middles of long replies, the middles of her summaries, whole unpinned rounds
 * from the lightest, the middles of the user's messages in pinned rounds, the
 * remaining unpinned sentences there, and finally her quotes from low priority. */
export function deletionSequence(rounds: readonly Round[], quotes: readonly Quote[] = []): Deletion[] {
  const out: Deletion[] = [];
  const alive = rounds.map(r => r.segments.map(s => s.sentences.map(() => true)));
  rounds.forEach((round, r) => round.segments.forEach((seg, s) => { if (seg.kind === 'tool') { out.push({ t: 'seg', r, s }); alive[r]![s]![0] = false; } }));
  const trimMiddles = (kind: Segment['kind']) => {
    for (;;) {
      let best: { r: number; s: number; chars: number } | undefined;
      rounds.forEach((round, r) => round.segments.forEach((seg, s) => {
        if (seg.kind !== kind) return;
        const live = alive[r]![s]!;
        const interior = seg.sentences.map((_, i) => i).filter(i => live[i] && !seg.pinned[i] && i !== 0 && i !== seg.sentences.length - 1);
        if (!interior.length) return;
        const chars = seg.sentences.reduce((sum, text, i) => sum + (live[i] ? text.length : 0), 0);
        if (!best || chars > best.chars) best = { r, s, chars };
      }));
      if (!best) return;
      const seg = rounds[best.r]!.segments[best.s]!, live = alive[best.r]![best.s]!;
      const interior = seg.sentences.map((_, i) => i).filter(i => live[i] && !seg.pinned[i] && i !== 0 && i !== seg.sentences.length - 1);
      const i = interior[Math.floor(interior.length / 2)]!;
      live[i] = false; out.push({ t: 'sent', r: best.r, s: best.s, i });
    }
  };
  trimMiddles('ai');
  trimMiddles('traj');
  const pinnedRound = (round: Round) => round.segments.some(seg => seg.pinned.some(Boolean));
  const density = rounds.map((round, r) => rounds.filter((other, o) => o !== r && Math.abs(other.time - round.time) <= 30 * 60_000).length);
  const order = rounds.map((round, r) => r).filter(r => !pinnedRound(rounds[r]!))
    .sort((a, b) => rounds[a]!.weight - rounds[b]!.weight || density[b]! - density[a]! || a - b);
  for (const r of order) { out.push({ t: 'round', r }); alive[r]!.forEach(seg => seg.fill(false)); }
  for (const kind of ['user'] as const) {
    rounds.forEach((round, r) => round.segments.forEach((seg, s) => {
      if (seg.kind !== kind || !pinnedRound(round)) return;
      const live = alive[r]![s]!;
      for (let i = seg.sentences.length - 1; i >= 1; i--) if (live[i] && !seg.pinned[i]) { live[i] = false; out.push({ t: 'sent', r, s, i }); }
    }));
  }
  rounds.forEach((round, r) => round.segments.forEach((seg, s) => {
    const live = alive[r]![s]!;
    seg.sentences.forEach((_, i) => { if (live[i] && !seg.pinned[i]) { live[i] = false; out.push({ t: 'sent', r, s, i }); } });
  }));
  // Quotes last, lowest priority first, then in the order she gave them.
  const ranked = quotes.map((quote, index) => ({ quote, index })).sort((a, b) => a.quote.priority - b.quote.priority || a.index - b.index);
  const normalizedRanked = ranked.map(({ quote }) => normalize(quote.text));
  const pinnedOrder: { r: number; s: number; i: number; rank: number }[] = [];
  rounds.forEach((round, r) => round.segments.forEach((seg, s) => seg.sentences.forEach((text, i) => {
    if (!seg.pinned[i]) return;
    const norm = normalize(text);
    let rank = normalizedRanked.findIndex(q => norm.includes(q) || q.includes(norm));
    if (rank < 0) rank = normalizedRanked.length;
    pinnedOrder.push({ r, s, i, rank });
  })));
  pinnedOrder.sort((a, b) => a.rank - b.rank || a.r - b.r || a.s - b.s || a.i - b.i);
  for (const { r, s, i } of pinnedOrder) out.push({ t: 'sent', r, s, i });
  return out;
}

export interface Rendered { text: string; retainedChars: number; totalChars: number; }

/** Apply the first `step` deletions and render. Gaps are marked so a faded day
 * never reads as a continuous conversation. */
export function render(rounds: readonly Round[], sequence: readonly Deletion[], step: number, labels: Labels = DEFAULT_LABELS): Rendered {
  const alive = rounds.map(r => r.segments.map(s => s.sentences.map(() => true)));
  for (const deletion of sequence.slice(0, Math.max(0, Math.min(step, sequence.length)))) {
    if (deletion.t === 'round') alive[deletion.r]!.forEach(seg => seg.fill(false));
    else if (deletion.t === 'seg') alive[deletion.r]![deletion.s]!.fill(false);
    else alive[deletion.r]![deletion.s]![deletion.i] = false;
  }
  const lines: string[] = [];
  let skipped = 0, retained = 0, total = 0;
  rounds.forEach((round, r) => {
    const parts: string[] = [];
    round.segments.forEach((seg, s) => {
      const live = alive[r]![s]!;
      total += seg.sentences.reduce((sum, text) => sum + text.length, 0);
      if (!live.some(Boolean)) return;
      let body = '', gap = false;
      seg.sentences.forEach((text, i) => {
        if (!live[i]) { gap = true; return; }
        if (gap && body) body += '…';
        else if (gap && !body) body = '…';
        body += seg.pinned[i] ? `「${text}」` : text;
        retained += text.length;
        gap = false;
      });
      if (gap) body += '…';
      const label = seg.kind === 'user' ? `${labels.user}：` : seg.kind === 'ai' ? `${labels.self}：` : seg.kind === 'traj' ? '[我的收束] ' : '';
      parts.push(label + body);
    });
    if (!parts.length) { skipped++; return; }
    if (skipped) { lines.push(`（此处略去 ${skipped} 轮）`); skipped = 0; }
    lines.push(...parts);
  });
  if (skipped) lines.push(`（此处略去 ${skipped} 轮）`);
  return { text: lines.join('\n'), retainedChars: retained, totalChars: total };
}

/** Smallest step within the allotment, never below the previous step. */
export function chooseStep(rounds: readonly Round[], sequence: readonly Deletion[], allot: number, previous: number, labels?: Labels): number {
  // Fast approximate pass on retained characters, then exact confirmation.
  let chars = render(rounds, sequence, previous, labels).retainedChars;
  let step = previous;
  const charsOf = (d: Deletion): number => {
    if (d.t === 'sent') return rounds[d.r]!.segments[d.s]!.sentences[d.i]!.length;
    if (d.t === 'seg') return rounds[d.r]!.segments[d.s]!.sentences.join('').length;
    return rounds[d.r]!.segments.reduce((sum, seg) => sum + seg.sentences.join('').length, 0);
  };
  while (step < sequence.length && Math.ceil(chars / 1.7) > allot) { chars -= charsOf(sequence[step]!); step++; }
  while (step < sequence.length && estimateTokens(render(rounds, sequence, step, labels).text) > allot) step++;
  return step;
}
