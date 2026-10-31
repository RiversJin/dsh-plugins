import { z } from 'zod';
import { unknownMemoryError } from './preferences.js';
import { digest } from './store.js';
import type { Book, Memory } from './types.js';

/** Daytime edits are her own, applied at once. The immutable book keeps every
 * earlier version, and the next dream re-reads whatever she changed by day. */
export const MAX_EDIT_TEXT = 12_000;
const Kind = z.enum(['experience', 'belief', 'intention', 'self']);
const State = z.enum(['active', 'dormant']);
const Reason = z.string().trim().min(1).max(1000);
const Evidence = z.array(z.string().min(1)).max(50);
export const Revision = z.object({
  id: z.string().min(1), text: z.string().trim().min(1).max(MAX_EDIT_TEXT).optional(), kind: Kind.optional(), state: State.optional(),
  evidence: Evidence.optional(), reason: Reason,
}).strict();
export const Addition = z.object({
  text: z.string().trim().min(1).max(MAX_EDIT_TEXT), kind: Kind, state: State.default('active'), evidence: Evidence.default([]), reason: Reason,
}).strict();
export type Revision = z.infer<typeof Revision>;
export type Addition = z.input<typeof Addition>;

export const EDIT_TOOL_DESCRIPTION = 'Revise one of your memories, or add a new one, yourself and right now, without waiting for the night. '
  + 'action "revise": id (copy the full id from a fresh experience_search result; memory_... and legacy_memory_... both work) plus any of text, kind, state, '
  + 'evidence (source IDs to add; existing evidence is kept). action "add": text and kind, optionally state and evidence; today\'s conversation is linked '
  + 'as evidence automatically once the day is captured. reason is required and stays on the record. state "dormant" hides a memory from automatic recall; '
  + 'nothing is ever deleted and the previous version remains in history. Your night self re-reads every daytime edit in the next dream and may refine it. '
  + 'Use experience_note instead when you would rather decide at night, and experience_bias to change only how often a memory surfaces. Do not store secrets, tokens or pairing codes.';

export const EDIT_PROMPT = 'When a memory is wrong or outdated and you already know the correct version, fix it yourself with experience_edit '
  + '(revise its text, kind, state or evidence, or add a new memory); the next dream re-reads daytime edits. ';

function checkEvidence(book: Book, ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.some(id => !book.episodes.some(row => row.id === id) && !book.legacySources?.some(row => row.id === id))) throw new Error('Memory evidence is outside this branch');
  return unique;
}

export function reviseMemory(book: Book, input: Revision, seq: number, now: number): { book: Book; memory: Memory; changed: boolean } {
  const update = Revision.parse(input);
  if (update.text === undefined && update.kind === undefined && update.state === undefined && update.evidence === undefined)
    throw new Error('revise needs at least one of text, kind, state or evidence');
  const next = structuredClone(book);
  const memory = next.memories.find(m => m.id === update.id);
  if (!memory) throw new Error(unknownMemoryError(update.id, next));
  const evidence = update.evidence === undefined ? memory.evidence : [...new Set([...memory.evidence, ...checkEvidence(next, update.evidence)])];
  const changed = (update.text !== undefined && update.text !== memory.text) || (update.kind !== undefined && update.kind !== memory.kind)
    || (update.state !== undefined && update.state !== memory.state) || evidence.length !== memory.evidence.length;
  if (!changed) return { book, memory, changed };
  if (update.text !== undefined) memory.text = update.text;
  if (update.kind !== undefined) memory.kind = update.kind;
  if (update.state !== undefined) memory.state = update.state;
  memory.evidence = evidence;
  memory.revision++; memory.updatedAt = now;
  // Due at the next dream, so the night self sees the edit; reviewedAt stays with the night.
  memory.nextReviewAt = now;
  memory.daytime = { seq, at: now, reason: update.reason };
  return { book: next, memory, changed };
}

export function addMemory(book: Book, input: Addition, seq: number, now: number): { book: Book; memory: Memory } {
  const addition = Addition.parse(input);
  const next = structuredClone(book);
  const evidence = checkEvidence(next, addition.evidence);
  const id = `memory_${digest([book.owner, now, seq, addition.text]).slice(0, 24)}`;
  if (next.memories.some(m => m.id === id)) throw new Error('This memory already exists');
  const memory: Memory = { id, text: addition.text, kind: addition.kind, state: addition.state, evidence, revision: 1, createdAt: now, updatedAt: now,
    nextReviewAt: now, daytime: { seq, at: now, reason: addition.reason } };
  next.memories.push(memory);
  return { book: next, memory };
}

/** A memory she wrote by day before that day was captured names no source yet;
 * the episode that contains the edit becomes its evidence. */
export function linkDaytimeEvidence(book: Book, episode: { id: string; from: number; to: number }): void {
  for (const memory of book.memories) {
    if (!memory.evidence.length && memory.daytime && episode.from <= memory.daytime.seq && memory.daytime.seq <= episode.to) memory.evidence.push(episode.id);
  }
}

export function presentEdit(memory: Memory) {
  return { id: memory.id, revision: memory.revision, kind: memory.kind, state: memory.state, text: memory.text, evidence: memory.evidence,
    ...(memory.evidence.length ? {} : { evidenceNote: 'linked to today\'s conversation when the day is captured tonight' }), reviewedBy: 'your next dream' };
}
