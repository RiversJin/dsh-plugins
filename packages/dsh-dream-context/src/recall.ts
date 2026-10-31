import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './store.js';
import { dayKey } from './policy.js';
import { memoryFreshness, freshnessBonus } from './preferences.js';
import { DAY, type Book, type Config } from './types.js';

export type SearchMode = 'automatic' | 'explicit';
export interface Hit { id: string; kind: 'episode' | 'memory'; text: string; evidence: string[]; score: number; relevance: number; bias: number; freshness: number; freshAt: number; freshnessBasis: string; dateMatch: boolean; revision: number; state?: 'active' | 'dormant'; }
export const compareHits = (a: Hit, b: Hit): number => Number(b.dateMatch) - Number(a.dateMatch) || (a.dateMatch && b.dateMatch ? Number(b.kind === 'episode') - Number(a.kind === 'episode') : 0) || b.score - a.score || Number(b.kind === 'memory') - Number(a.kind === 'memory') || a.id.localeCompare(b.id);
export function tokens(text: string): Set<string> {
  const normalized = text.normalize('NFKC').toLowerCase();
  const out = new Set(normalized.match(/[a-z0-9_]+/g) ?? []);
  for (const group of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = [...group];
    if (chars.length === 1) out.add(chars[0]!);
    for (let i = 0; i < chars.length - 1; i++) out.add(chars[i]! + chars[i + 1]!);
  }
  return out;
}
export function corpus(book: Book, mode: SearchMode = 'automatic'): Hit[] {
  return [
    ...book.memories.filter(row => mode === 'explicit' || row.state === 'active').map(row => ({ id: row.id, kind: 'memory' as const,
      text: row.provenance ? `[迁移旧记忆，原记录创建于 ${new Date(row.createdAt).toISOString()}；不是今天新发生的事]\n${row.text}` : row.text, evidence: row.evidence, score: 0, relevance: 0, bias: row.bias ?? 0, freshness: 0, freshAt: memoryFreshness(book, row).at, freshnessBasis: memoryFreshness(book, row).basis, dateMatch: false, revision: row.revision, state: row.state })),
    ...book.episodes.filter(row => row.summary).map(row => ({ id: row.id, kind: 'episode' as const,
      text: `${row.day} ${row.summary}`, evidence: [row.id], score: 0, relevance: 0, bias: 0, freshness: 0, freshAt: row.endAt, freshnessBasis: 'experience', dateMatch: false, revision: row.revision })),
  ];
}
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

/** The authoritative corpus comes from the branch's current book, never old
 * revisions or dream transcripts. Retrieval itself does not strengthen memory. */
export class Recall {
  private readonly vectors = new Map<string, number[]>();
  lastMode: 'lexical' | 'hybrid' = 'lexical';
  lastEmbeddingError: string | undefined;
  constructor(private readonly config: Config) {}
  private vectorKey(text: string): string { return digest([this.config.embeddingUrl, this.config.embeddingModel, text]); }
  /** Explicit preparation uses the same content-keyed cache as bounded recall. */
  async warm(book: Book, signal: AbortSignal): Promise<void> {
    if (this.config.embeddingUrl) await this.embed(corpus(book, 'explicit').map(row => row.text), signal);
  }
  private async embed(texts: string[], signal: AbortSignal): Promise<void> {
    if (this.config.embeddingCacheDir) await Promise.all(texts.map(async text => {
      const key = this.vectorKey(text);
      if (this.vectors.has(key)) return;
      try {
        const value: unknown = JSON.parse(await readFile(join(this.config.embeddingCacheDir, `${key}.json`), 'utf8'));
        if (Array.isArray(value) && value.length && value.every(x => typeof x === 'number' && Number.isFinite(x))) this.vectors.set(key, value as number[]);
      } catch { /* An absent cache entry is computed below. */ }
    }));
    const missing = [...new Set(texts.filter(text => !this.vectors.has(this.vectorKey(text))))];
    for (let start = 0; start < missing.length; start += 32) {
      signal.throwIfAborted();
      const batch = missing.slice(start, start + 32);
      const response = await fetch(this.config.embeddingUrl.replace(/\/$/, '') + '/embeddings', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ model: this.config.embeddingModel, input: batch }),
      });
      if (!response.ok) throw new Error(`Embedding HTTP ${response.status}`);
      const result = await response.json() as { data: Array<{ index: number; embedding: number[] }> };
      if (result.data.length !== batch.length || new Set(result.data.map(row => row.index)).size !== batch.length) throw new Error('Embedding batch incomplete');
      for (const row of result.data) {
        if (!batch[row.index] || !row.embedding.length || !row.embedding.every(Number.isFinite)) throw new Error('Invalid embedding');
        const key = this.vectorKey(batch[row.index]!);
        this.vectors.set(key, row.embedding);
        if (this.config.embeddingCacheDir) {
          await mkdir(this.config.embeddingCacheDir, { recursive: true, mode: 0o700 });
          const file = join(this.config.embeddingCacheDir, `${key}.json`), temp = `${file}.${randomUUID()}.tmp`;
          await writeFile(temp, JSON.stringify(row.embedding), { mode: 0o600 });
          await rename(temp, file);
        }
      }
    }
  }
  async search(book: Book, query: string, limit = this.config.recallResults, signal?: AbortSignal, mode: SearchMode = 'automatic'): Promise<Hit[]> {
    const candidates = corpus(book, mode);
    this.lastMode = 'lexical'; this.lastEmbeddingError = undefined;
    const words = tokens(query);
    if (!words.size) return [];
    for (const row of candidates) {
      const terms = tokens(row.text);
      const overlap = [...words].filter(word => terms.has(word)).length;
      row.relevance = overlap / words.size;
    }
    if (this.config.embeddingUrl && candidates.length) {
      try {
        const timeout = AbortSignal.timeout(4000);
        const fused = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const texts = [query, ...candidates.map(row => row.text)];
        await this.embed(texts, fused);
        const key = (text: string): string => this.vectorKey(text);
        const q = this.vectors.get(key(query))!;
        for (const row of candidates) row.relevance = Math.max(row.relevance, cosine(q, this.vectors.get(key(row.text))!));
        this.lastMode = 'hybrid';
        if (this.vectors.size > 10_000) this.vectors.clear();
      } catch (error) { signal?.throwIfAborted(); this.lastEmbeddingError = String(error); }
    }
    // Explicit temporal cues address an experience even without shared nouns.
    // They refer to its original day, never its retrieval or update timestamp.
    const explicitDate = query.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
    const relativeDays = /前天/.test(query) ? 2 : /昨天|昨日/.test(query) ? 1 : /今天|今日/.test(query) ? 0 : undefined;
    const day = explicitDate ?? (relativeDays === undefined ? undefined : dayKey(Date.now() - relativeDays * DAY, this.config));
    if (day) {
      const matching = new Set(book.episodes.filter(row => row.day === day).map(row => row.id));
      for (const row of candidates) if (row.evidence.some(id => matching.has(id))) row.dateMatch = true;
    }
    for (const row of candidates) {
      row.freshness = mode === 'automatic' ? freshnessBonus(row.freshAt, Date.now(), this.config.freshnessMaxBonus, this.config.freshnessHalfLifeDays) : 0;
      row.score = row.relevance + (mode === 'automatic' ? row.bias + row.freshness : 0);
    }
    // Bias/freshness cannot admit unrelated memories. Explicit dates retain priority.
    // Active search remains relevance-driven and includes dormant memories.
    return candidates.filter(row => row.dateMatch || row.relevance >= this.config.recallMinScore)
      .sort(compareHits).slice(0, limit);
  }
}

export function recallText(hits: Hit[], maxChars: number): string {
  let result = '';
  for (const hit of hits) {
    const header = `[${hit.id} v${hit.revision}; ${hit.evidence.join(', ')}]\n`;
    const room = maxChars - result.length - header.length - 2;
    if (room <= 0) break;
    result += `${header}${hit.text.slice(0, room)}\n\n`;
  }
  return result.trim();
}
