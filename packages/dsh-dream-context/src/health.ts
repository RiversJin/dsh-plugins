import { type Book, type Config } from './types.js';
import { ageDays, dayKey, slotAt } from './policy.js';

/** Older archives remain reachable but no longer create a backfill obligation. */
export function pendingEpisodes(book: Book, now: number, config: Config) {
  const slot = slotAt(now, config);
  const today = dayKey(slot, config);
  return book.episodes.filter(e => !e.summary && e.day >= config.startDay && e.day < today)
    .sort((a, b) => b.endAt - a.endAt);
}

/** Count distinct failed nights, not timer retries or multiple calls that night. */
export function recordFailure(book: Book, slot: number, error: unknown): void {
  const health = book.health ??= { failureNights: 0 };
  if (health.lastFailureSlot !== slot || health.failureNights === 0) health.failureNights++;
  health.lastFailureSlot = slot;
  const text = error instanceof Error ? error.message : '';
  health.lastError = /deadline|timed? ?out|Timeout/i.test(text) ? '单段整理超时'
    : /context|room|capacity/i.test(text) ? '上下文容量不足'
    : /validation|校验/i.test(text) ? '提交内容未通过校验' : '模型请求或整理结果未完成';
}

export function backlogWarning(book: Book, now: number, config: Config): string | undefined {
  const pending = pendingEpisodes(book, now, config), oldest = pending.at(-1);
  if (!oldest || (book.health?.failureNights ?? 0) < 2 || ageDays(oldest, now, config) <= 3) return;
  return `夜间记忆整理已连续 ${book.health!.failureNights} 个整理夜出现失败，近期有 ${pending.length} 天尚未总结，最早是 ${oldest.day}，积压已超过三天。最近原因：${book.health?.lastError ?? '整理未完成'}。已完成的记忆与原始对话仍保留。${config.shadow ? '当前仍为影子模式。' : ''}`;
}
