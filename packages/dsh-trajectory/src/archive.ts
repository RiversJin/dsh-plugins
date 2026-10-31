import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, link, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { z } from 'zod';
import { anchorSchema, type Anchor, type ArchiveRef } from './state.js';

const compress = promisify(gzip), decompress = promisify(gunzip);
const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');
const documentSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), ownerSessionId: z.string(),
  anchor: anchorSchema, createdAt: z.number(),
  surfaceSeqs: z.array(z.number().int().nonnegative()),
  // Native events are retained losslessly; replay validation belongs to DSH.
  events: z.array(z.object({ seq: z.number().int().nonnegative(), time: z.number(), type: z.string() }).passthrough()),
});
export interface ArchiveDocument {
  version: 1; id: string; ownerSessionId: string; anchor: Anchor; createdAt: number;
  surfaceSeqs: number[]; events: readonly SessionEvent[];
}

/** Immutable, synced archives; no retention policy or deletion is performed. */
export class ArchiveStore {
  constructor(readonly directory: string) {}

  private path(ownerSessionId: string, id: string): string {
    z.string().uuid().parse(id);
    return join(this.directory, sha256(ownerSessionId), `${id}.json.gz`);
  }

  async save(document: ArchiveDocument, signal: AbortSignal): Promise<ArchiveRef> {
    signal.throwIfAborted();
    const body = Buffer.from(JSON.stringify(document));
    const data = await compress(body);
    const directory = join(this.directory, sha256(document.ownerSessionId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = this.path(document.ownerSessionId, document.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); }
      finally { await handle.close(); }
      signal.throwIfAborted();
      await link(temporary, target); // Fail rather than overwrite an existing archive.
      for (const path of [directory, this.directory, dirname(this.directory)]) {
        const dirHandle = await open(path, 'r');
        try { await dirHandle.sync(); } finally { await dirHandle.close(); }
      }
      signal.throwIfAborted();
      const stored = await readFile(target, { signal });
      if (sha256(stored) !== sha256(data)) throw new Error('Trajectory archive verification failed; history was not changed.');
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
    const first = document.events[0], last = document.events.at(-1);
    if (!first || !last) throw new Error('Cannot archive an empty trajectory.');
    return {
      id: document.id, ownerSessionId: document.ownerSessionId, anchorId: document.anchor.id, label: document.anchor.label,
      startSeq: first.seq, endSeq: last.seq, createdAt: document.createdAt,
      firstEventTime: first.time, lastEventTime: last.time, eventCount: document.events.length,
      messageCount: document.surfaceSeqs.length, sha256: sha256(data), bytes: data.length,
    };
  }

  async read(reference: ArchiveRef, signal: AbortSignal): Promise<ArchiveDocument> {
    const data = await readFile(this.path(reference.ownerSessionId, reference.id), { signal });
    if (sha256(data) !== reference.sha256) throw new Error('Trajectory archive checksum mismatch; current anchor was preserved.');
    const body = await decompress(data); signal.throwIfAborted();
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    const valid = documentSchema.parse(parsed);
    if (valid.id !== reference.id || valid.ownerSessionId !== reference.ownerSessionId
      || valid.anchor.id !== reference.anchorId || valid.events.length !== reference.eventCount
      || valid.events[0]?.seq !== reference.startSeq || valid.events.at(-1)?.seq !== reference.endSeq
      || valid.events.some((event, index) => event.seq !== reference.startSeq + index)) {
      throw new Error('Trajectory archive identity or range mismatch; current anchor was preserved.');
    }
    return parsed as ArchiveDocument;
  }
}

/** Character pages never split a UTF-16 surrogate pair; nextOffset is exact. */
export function pageText(text: string, offset: number, count: number): { text: string; offset: number; nextOffset: number | null; totalChars: number } {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new Error('offset must be an integer within the archive text.');
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('max_chars must be a positive safe integer.');
  let start = offset, end = Math.min(text.length, offset + count);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!)) start--;
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end]!)) end++;
  return { text: text.slice(start, end), offset: start, nextOffset: end < text.length ? end : null, totalChars: text.length };
}
