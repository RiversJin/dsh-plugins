import { randomInt } from 'node:crypto';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { eventMessage, retryWithdrawnSeqs } from './history.js';
import { Recall } from './recall.js';
import { DAY, type Book, type Config, type Episode, type Memory } from './types.js';

/** Actual spoken text only: no tool results, injected recollections or reasoning. */
export function spoken(events: readonly SessionEvent[]): { role: 'user' | 'assistant'; text: string }[] {
  const withdrawn = retryWithdrawnSeqs(events);
  return events.flatMap(event => {
    const m = eventMessage(event);
    if (withdrawn.has(event.seq) || event.surfaceOp !== 'append' || !m || (m.role !== 'assistant' && !(m.role === 'user' && m.source.kind === 'user'))) return [];
    const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    return text ? [{ role: m.role as 'user' | 'assistant', text }] : [];
  });
}

/** Select locally first; only selected records enter the dream request. */
export async function selectReview(book: Book, episode: Episode | undefined, events: readonly SessionEvent[], config: Config,
  signal: AbortSignal, random: (max: number) => number = randomInt): Promise<Memory[]> {
  const chosen = new Map<string, Memory>();
  const queries = spoken(events).filter(m => m.role === 'user').slice(-4).map(m => m.text.slice(0, 1200));
  const recall = new Recall({ ...config, recallMinScore: Math.min(config.recallMinScore, 0.2) });
  for (const query of queries) for (const hit of await recall.search(book, query, 8, signal, 'explicit')) {
    if (hit.kind !== 'memory') continue;
    const memory = book.memories.find(m => m.id === hit.id)!;
    chosen.set(memory.id, memory);
  }
  const now = Date.now();
  const due = book.memories.filter(m => (m.nextReviewAt ?? m.updatedAt + config.reviewDays * DAY) <= now)
    .sort((a, b) => (a.nextReviewAt ?? a.updatedAt + config.reviewDays * DAY) - (b.nextReviewAt ?? b.updatedAt + config.reviewDays * DAY));
  for (const memory of due) chosen.set(memory.id, memory);
  // Sample without replacement. Recent reviews are ineligible for this small
  // extra sample; they can still enter through relatedness or an explicit due date.
  const pool = book.memories.filter(m => !chosen.has(m.id) && (m.reviewedAt ?? 0) < now - DAY);
  for (let i = 0; i < config.randomReviewCount && pool.length; i++) {
    const memory = pool.splice(random(pool.length), 1)[0]!;
    chosen.set(memory.id, memory);
  }
  const result: Memory[] = [];
  let chars = 0;
  for (const memory of chosen.values()) {
    const size = JSON.stringify(memory).length;
    if (chars + size > config.dreamSupplementChars) continue;
    result.push(memory); chars += size;
  }
  return result;
}
