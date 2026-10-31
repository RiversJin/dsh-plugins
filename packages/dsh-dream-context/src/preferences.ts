import { z } from 'zod';
import type { Session } from '@deepseek-ai/dsh-session';
import { DAY, type Book, type Memory } from './types.js';

export const BiasAdjustment = z.object({ id: z.string().min(1), bias: z.number().min(-1).max(1), reason: z.string().trim().min(1).max(1000) }).strict();
export const BiasAdjustments = z.array(BiasAdjustment).min(1).max(100);
export type BiasAdjustment = z.infer<typeof BiasAdjustment>;

/** An absent source date falls back to the record's creation time, labeled as such. */
export function memoryFreshness(book: Book, memory: Memory): { at: number; basis: string } {
  if (memory.freshAt !== undefined) return { at: memory.freshAt, basis: memory.freshnessBasis ?? 'source' };
  const dates = memory.evidence.flatMap(id => {
    const episode = book.episodes.find(e => e.id === id);
    if (episode) return [{ at: episode.endAt, basis: 'experience' }];
    const source = book.legacySources?.find(s => s.id === id);
    return source ? [{ at: source.originalTime, basis: 'source-record' }] : [];
  }).filter(row => Number.isFinite(row.at) && row.at > 0);
  return dates.sort((a, b) => b.at - a.at)[0] ?? { at: memory.createdAt, basis: 'memory-created' };
}

export function freshnessBonus(at: number, now: number, maximum: number, halfLifeDays: number): number {
  if (!Number.isFinite(at) || at <= 0) return 0;
  return maximum * 2 ** (-Math.max(0, now - at) / (DAY * halfLifeDays));
}

export const UNKNOWN_MEMORY_PREFIX = 'Unknown memory ID ';
/** Name the missing ID and point at the only reliable source of IDs. 2026-10-26
 * a retyped legacy_memory_... ID with a wrong tail was rejected with a generic
 * message and read as "migrated memories ignore bias"; they do not. */
export function unknownMemoryError(id: string, book: Book): string {
  const shown = JSON.stringify(id.slice(0, 256));
  const prefix = id.slice(0, 8);
  const near = book.memories.filter(m => m.id !== id && prefix.length >= 8 && m.id.includes(prefix)).map(m => m.id).slice(0, 3);
  return `${UNKNOWN_MEMORY_PREFIX}${shown}: no memory in this branch has this exact ID, so nothing in this batch was applied. `
    + 'Copy the full id from a fresh experience_search result instead of retyping it; memory_... and legacy_memory_... (migrated) IDs are both accepted and respond to bias alike.'
    + (near.length ? ` Similar current IDs: ${near.join(', ')}.` : '');
}

/** Absolute setters make repeated calls idempotent; the immutable book is the audit history. */
export function applyBiasAdjustments(book: Book, input: BiasAdjustment[], now: number, alreadyRevised = new Set<string>()): Book {
  const updates = BiasAdjustments.parse(input), next = structuredClone(book), seen = new Set<string>();
  for (const update of updates) {
    if (seen.has(update.id)) throw new Error('Bias batch repeats a memory ID');
    seen.add(update.id);
    const memory = next.memories.find(m => m.id === update.id);
    if (!memory) throw new Error(unknownMemoryError(update.id, next));
    if ((memory.bias ?? 0) === update.bias && memory.biasReason === update.reason) continue;
    const fresh = memoryFreshness(next, memory);
    memory.freshAt = fresh.at; memory.freshnessBasis = fresh.basis;
    memory.bias = update.bias; memory.biasReason = update.reason; memory.biasUpdatedAt = now;
    memory.updatedAt = now;
    if (!alreadyRevised.has(memory.id)) memory.revision++;
  }
  return next;
}

/** Count actual user conversation rounds; reminders, schedules and tool steps do not count. */
export function userTurnsSince(session: Session, afterSeq: number, incomingTurn?: number): number {
  const turns = new Set<number>();
  let turn: number | undefined;
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start') turn = event.data.turn;
    if (event.seq > afterSeq && turn !== undefined && event.type === 'user/message' && event.data.source.kind === 'user') turns.add(turn);
  }
  if (incomingTurn !== undefined) turns.add(incomingTurn);
  return turns.size;
}

/** A pause written before deadlines existed (no pausedUntil) was meant as a
 * short focus break, not a permanent switch; treat it as expired one day after
 * it was set. 2026-10-15 such a pause silenced recall for three days unnoticed. */
export const LEGACY_PAUSE_MS = 24 * 60 * 60_000;
export function pauseDeadline(control: NonNullable<Book['recallControl']>): number {
  return control.pausedUntil ?? control.changedAt + LEGACY_PAUSE_MS;
}
export function recallPaused(book: Book, now: number): boolean {
  const control = book.recallControl;
  return control?.mode === 'paused' && now < pauseDeadline(control);
}

export function pauseRecall(book: Book, session: Session, now: number, reason: string, silenceMinutes: number): Book {
  const pausedUntil = now + Math.round(silenceMinutes * 60_000);
  if (!Number.isFinite(silenceMinutes) || silenceMinutes <= 0 || !Number.isSafeInteger(pausedUntil) || pausedUntil <= now)
    throw new Error('pause requires silence_minutes: a positive duration in minutes. Choose how long to pause; it resumes automatically without a reminder.');
  const next = structuredClone(book), afterSeq = session.snapshotEvents().length - 1;
  next.recallControl = { mode: 'paused', changedAt: now, afterSeq, reason, silenceMinutes, pausedUntil };
  return next;
}
