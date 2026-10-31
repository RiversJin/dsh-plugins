import { DAY, type Episode, type Policy, type Stage } from './types.js';

function local(time: number, zone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(time).map(part => [part.type, part.value]));
}
function calendarDate(time: number, zone: string): number {
  const p = local(time, zone);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
}
function atLocal(date: number, clock: string, zone: string): number {
  const [hours, minutes] = clock.split(':').map(Number);
  const target = date + hours! * 3_600_000 + minutes! * 60_000;
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const p = local(instant, zone);
    const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    const next = instant + target - wall;
    if (next === instant) break;
    instant = next;
  }
  return instant;
}
/** Most recent completed 04:00 boundary, including missed-night catch-up. */
export function slotAt(now: number, policy: Policy): number {
  const date = calendarDate(now, policy.timeZone);
  const today = atLocal(date, policy.dailyAt, policy.timeZone);
  return today <= now ? today : atLocal(date - DAY, policy.dailyAt, policy.timeZone);
}
export function dayKey(time: number, policy: Policy): string {
  const p = local(slotAt(time, policy), policy.timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}
export function ageDays(episode: Episode, now: number, policy: Policy): number {
  return (calendarDate(slotAt(now, policy), policy.timeZone)
    - calendarDate(slotAt(episode.endAt, policy), policy.timeZone)) / DAY;
}
export function desiredStage(episode: Episode, now: number, policy: Policy): Stage {
  const age = ageDays(episode, now, policy);
  if (age < policy.rawDays) return 'raw';
  if (age < policy.imageDays) return 'image';
  if (!episode.summary) return 'raw'; // A missed dream never discards unsummarized context.
  if (age < policy.summaryDays || (episode.keepUntil !== undefined && now < episode.keepUntil)) return 'summary';
  return 'recalled';
}
export function validatePolicy(policy: Policy): void {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(policy.dailyAt)) throw new Error('dailyAt must be HH:MM');
  new Intl.DateTimeFormat('en', { timeZone: policy.timeZone }).format();
  if (![policy.rawDays, policy.imageDays, policy.summaryDays, policy.maxSummaryDays].every(Number.isSafeInteger)
    || policy.rawDays < 1 || policy.summaryDays < 1 || policy.summaryDays > policy.maxSummaryDays) throw new Error('Require 0 < rawDays and 0 < summaryDays <= maxSummaryDays');
}
