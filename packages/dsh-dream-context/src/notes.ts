import type { Book, Episode, Note } from './types.js';
import { digest } from './store.js';

/** Daytime notes are raw material for the next dream, never memories themselves. */
export const MAX_NOTE_CHARS = 2000;
export const MAX_PENDING_NOTES = 40;

export const NOTE_TOOL_DESCRIPTION = 'Leave yourself a short note during the day about something you want to remember. '
  + 'The note is not a memory yet: it is shown to you during the next nightly dream, where you decide whether it becomes a new memory, '
  + 'a revision of an existing one, part of the day summary, or nothing. Notes are consumed by the dream that sees them. '
  + 'Use action "add" with text (optionally "about": an existing memory ID from experience_search), "list" to see pending notes, '
  + 'or "withdraw" with id to drop one before the dream. Do not store secrets, tokens or pairing codes.';

export const NOTE_INSTRUCTIONS = 'daytimeNotes are notes you left during the day with experience_note. Each shows the episode it was written in '
  + '(episodeId), its time, and optionally the memory you said it was about. Decide for every note whether it becomes a new memory, a revision '
  + 'of an existing memory, material for that day\'s summary, or is dropped. Cite the note\'s episodeId as evidence, never the note id. '
  + 'These notes are consumed by this dream: whatever you do not carry over will not be shown again.';

export function addNote(book: Book, text: string, seq: number, now: number, about?: string): { book: Book; note: Note } {
  const body = text.trim();
  if (!body) throw new Error('A note needs text');
  if (body.length > MAX_NOTE_CHARS) throw new Error(`A note may hold at most ${MAX_NOTE_CHARS} characters`);
  const next = structuredClone(book);
  const pending = next.notes ?? [];
  if (pending.length >= MAX_PENDING_NOTES) throw new Error(`Already ${MAX_PENDING_NOTES} notes are waiting for the next dream; withdraw one or wait`);
  if (about !== undefined && !next.memories.some(m => m.id === about)) throw new Error('about must be an existing memory ID from experience_search');
  const note: Note = { id: `note_${digest([book.owner, now, seq, body]).slice(0, 16)}`, text: body, createdAt: now, seq, ...(about === undefined ? {} : { about }) };
  if (pending.some(row => row.id === note.id)) throw new Error('This note already exists');
  next.notes = [...pending, note];
  return { book: next, note };
}

export function withdrawNote(book: Book, id: string): Book {
  const next = structuredClone(book);
  const index = (next.notes ?? []).findIndex(row => row.id === id);
  if (index < 0) throw new Error('No pending note has this id');
  next.notes!.splice(index, 1);
  return next;
}

export function episodeOf(book: Book, note: Note): Episode | undefined {
  return book.episodes.find(e => e.from <= note.seq && note.seq <= e.to);
}

/** Notes whose day has already been captured as an episode. A note written after
 * the last capture waits for the dream that handles its own day. */
export function presentableNotes(book: Book): { note: Note; episode: Episode }[] {
  return (book.notes ?? []).flatMap(note => {
    const episode = episodeOf(book, note);
    return episode ? [{ note, episode }] : [];
  });
}

export function presentNotes(book: Book, rows: readonly { note: Note; episode: Episode }[], timeZone: string) {
  return rows.map(({ note, episode }) => ({
    id: note.id, episodeId: episode.id, day: episode.day,
    at: new Date(note.createdAt).toLocaleString('sv-SE', { timeZone }),
    text: note.text, ...(note.about && book.memories.some(m => m.id === note.about) ? { about: note.about } : {}),
  }));
}

export function consumeNotes(book: Book, ids: readonly string[]): Book {
  if (!ids.length || !book.notes?.length) return book;
  const gone = new Set(ids);
  const next = structuredClone(book);
  next.notes = next.notes!.filter(row => !gone.has(row.id));
  if (!next.notes.length) delete next.notes;
  return next;
}

export function listNotes(book: Book, timeZone: string) {
  const notes = book.notes ?? [];
  return { pending: notes.length, limit: MAX_PENDING_NOTES, notes: notes.map(note => {
    const episode = episodeOf(book, note);
    return { id: note.id, at: new Date(note.createdAt).toLocaleString('sv-SE', { timeZone }), text: note.text,
      ...(note.about ? { about: note.about } : {}), waitsFor: episode ? 'next dream' : 'the dream after its day is captured' };
  }) };
}
