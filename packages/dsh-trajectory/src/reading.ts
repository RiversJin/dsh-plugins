import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ReadCoverage, ReadRange } from './state.js';

export interface Interval { start: number; end: number; }

/** Half-open UTF-16 offsets, matching the actual archive pages returned. */
export function unreadIntervals(start: number, end: number, covered: readonly Interval[]): Interval[] {
  let cursor = start;
  const gaps: Interval[] = [];
  for (const range of [...covered].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (range.end <= cursor || range.start >= end) continue;
    if (range.start > cursor) gaps.push({ start: cursor, end: Math.min(range.start, end) });
    cursor = Math.max(cursor, range.end);
    if (cursor >= end) break;
  }
  if (cursor < end) gaps.push({ start: cursor, end });
  return gaps;
}

export function rangesForSummary(coverage: readonly ReadCoverage[]): ReadRange[] {
  const result: ReadRange[] = [];
  for (const row of [...coverage].sort((a, b) => a.archiveId.localeCompare(b.archiveId) || a.start - b.start)) {
    const { backingSeq: _seq, format: _format, summaryArchiveId: _summary, ...range } = row;
    const last = result.at(-1);
    if (last && last.workAnchorId === range.workAnchorId && last.archiveId === range.archiveId
      && last.ownerSessionId === range.ownerSessionId && last.sha256 === range.sha256 && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else result.push(range);
  }
  return result;
}

/** Match the actual rendered page, including within a forwarded JSON result.
 * A nested read whose caller omits its page is not recorded as model-visible. */
export function includesPage(content: readonly ContentBlock[], page: { archiveId: string; offset: number; text: string }): boolean {
  function visit(value: unknown, depth: number): boolean {
    if (depth > 8 || value === null) return false;
    if (typeof value === 'string') {
      try { return visit(JSON.parse(value), depth + 1); } catch { return false; }
    }
    if (Array.isArray(value)) return value.some(item => visit(item, depth + 1));
    if (typeof value !== 'object') return false;
    const row = value as Record<string, unknown>;
    if (row.text === page.text && row.offset === page.offset && row.archive !== null && typeof row.archive === 'object'
      && (row.archive as Record<string, unknown>).id === page.archiveId) return true;
    return Object.entries(row).some(([key, item]) => key !== 'text' && visit(item, depth + 1));
  }
  return content.some(block => block.type === 'text' && visit(block.text, 0));
}
