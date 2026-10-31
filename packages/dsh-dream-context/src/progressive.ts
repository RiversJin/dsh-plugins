import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session';
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { ESTIMATOR, DEFAULT_LABELS, chooseStep, deletionSequence, effectiveEvents, estimateTokens, material, render, type Labels, type Material, type Photo } from './fade.js';
import { eventMessage, sourceOf, unclosedDreamAnchors } from './history.js';
import { ageDays, dayKey, slotAt } from './policy.js';
import { digest, type Store } from './store.js';
import { SOURCE, type Archive, type Book, type Config, type Episode } from './types.js';

export interface DayView {
  episode: Episode;
  rank: number;
  allot: number;
  step: number;
  excerpt?: string;
  retainedRatio: number;
  summary: boolean;
  photos: Photo[];
}
export interface HistoryPlan {
  raw: Episode[];
  faded: DayView[];
  /** Log seq of the last original node the composite replaces. */
  cutSeq: number;
  /** Log seq of the first faded day's first event; nothing before it is touched. */
  firstSeq: number;
  book: Book;
  notes: string[];
}
export interface PlanOptions { labels?: Labels; initial?: boolean; }

export const allotment = (config: Config, rank: number): number =>
  Math.floor(config.progressive.fadeBudgetTokens * (1 - config.progressive.fadeRatio) * config.progressive.fadeRatio ** rank);

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
export function dayLabel(day: string, timeZone: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!, 12));
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  return `${day.slice(5)} 周${WEEKDAY[index < 0 ? date.getUTCDay() : index]}`;
}

function summaryCurrent(episode: Episode, now: number, config: Config): boolean {
  if (!episode.summary) return false;
  return ageDays(episode, now, config) < config.summaryDays || (episode.keepUntil !== undefined && now < episode.keepUntil);
}

/** Decide which days stay raw, which fade at what rank, and how far each has
 * faded. Mutates and returns the book's episodes' fade state. Pure apart from
 * archive reads; nothing touches the session here. */
export async function planHistory(session: Session, book: Book, store: Store, now: number, config: Config, options: PlanOptions = {}): Promise<HistoryPlan> {
  const next = structuredClone(book);
  const slot = slotAt(now, config);
  const live = session.snapshotEvents();
  const labels = options.labels ?? DEFAULT_LABELS;
  const notes: string[] = [];
  const episodes = next.episodes.filter(e => e.endAt < slot && e.owner === session.id).sort((a, b) => a.from - b.from);
  const materials = new Map<string, Material>();
  const loadMaterial = async (episode: Episode): Promise<Material> => {
    const cached = materials.get(episode.id);
    if (cached) return cached;
    const archive = await store.get<Archive>(episode.archive);
    const built = material(effectiveEvents(archive.events, live, episode.from, episode.to), episode.quotes ?? []);
    materials.set(episode.id, built);
    return built;
  };
  const eligible = (episode: Episode) => Boolean(episode.summary) || (config.startDay !== '' && episode.day < config.startDay)
    || (episode.fade?.rawNights ?? 0) >= config.progressive.maxRawNights;

  // Raw window: a contiguous newest suffix. The token budget alone decides the
  // window start; an ineligible (unsummarized) day further back holds everything
  // after it raw, and each such night counts toward maxRawNights.
  const unfaded = episodes.filter(e => e.fade?.fadedAt === undefined);
  const rawSizes = new Map<string, number>();
  for (const episode of unfaded) {
    const built = await loadMaterial(episode);
    rawSizes.set(episode.id, estimateTokens(render(built.rounds, [], 0, labels).text));
  }
  const budgetStart = forcedWindowStart(unfaded, rawSizes, config);
  for (let i = 0; i < budgetStart; i++) {
    const episode = unfaded[i]!;
    if (episode.summary || (config.startDay !== '' && episode.day < config.startDay)) continue;
    const fade = episode.fade ?? { step: 0, rawNights: 0, estimator: ESTIMATOR };
    if (fade.countedSlot !== slot) { fade.rawNights++; fade.countedSlot = slot; }
    episode.fade = fade;
  }
  const forced = unfaded.findIndex(e => !eligible(e));
  const rawFrom = forced >= 0 ? Math.min(budgetStart, forced) : budgetStart;
  const raw = unfaded.slice(rawFrom);
  for (let i = 0; i < rawFrom; i++) {
    const episode = unfaded[i]!;
    const fade = episode.fade ?? { step: 0, rawNights: 0, estimator: ESTIMATOR };
    fade.fadedAt = slot;
    episode.fade = fade;
    if (!episode.summary && !(config.startDay !== '' && episode.day < config.startDay)) notes.push(`${episode.day} 未能形成总结，已按原文淡化。`);
  }

  // Faded days, newest first, ranked by position among days with any material.
  const fadedEpisodes = episodes.filter(e => e.fade?.fadedAt !== undefined).sort((a, b) => b.from - a.from);
  const faded: DayView[] = [];
  let rank = 0;
  for (const episode of fadedEpisodes) {
    const built = await loadMaterial(episode);
    const hasMaterial = built.rounds.length > 0;
    const allot = hasMaterial ? allotment(config, rank) : 0;
    const summary = summaryCurrent(episode, now, config);
    if (hasMaterial) rank++;
    if (allot < config.progressive.minDayTokens && !summary) continue;
    const view: DayView = { episode, rank: hasMaterial ? rank - 1 : rank, allot, step: episode.fade!.step, retainedRatio: 0, summary, photos: [] };
    if (allot >= config.progressive.minDayTokens) {
      const sequence = deletionSequence(built.rounds, episode.quotes ?? []);
      const step = Math.max(episode.fade!.step, chooseStep(built.rounds, sequence, allot, episode.fade!.step, labels));
      const rendered = render(built.rounds, sequence, step, labels);
      episode.fade!.step = step;
      view.step = step;
      view.excerpt = rendered.text;
      view.retainedRatio = rendered.totalChars ? rendered.retainedChars / rendered.totalChars : 0;
      view.photos = built.photos;
    }
    faded.push(view);
  }
  faded.sort((a, b) => a.episode.from - b.episode.from);
  const lastFaded = fadedEpisodes[0];
  const cutSeq = !lastFaded ? -1 : raw.length ? raw[0]!.from - 1 : lastFaded.to;
  const firstSeq = fadedEpisodes.length ? Math.min(...fadedEpisodes.map(e => e.from)) : -1;
  return { raw, faded, cutSeq, firstSeq, book: next, notes };
}

/** Index where the raw window would start on the token budget alone (newest day always included). */
function forcedWindowStart(unfaded: readonly Episode[], sizes: Map<string, number>, config: Config): number {
  let start = unfaded.length, cumulative = 0;
  for (let i = unfaded.length - 1; i >= 0; i--) {
    cumulative += sizes.get(unfaded[i]!.id) ?? 0;
    if (i === unfaded.length - 1 || cumulative <= config.progressive.rawTokens) start = i; else break;
  }
  return start;
}

interface Origins { min: number; max: number; }
function originOf(session: Session): (seq: number) => Origins {
  const events = session.snapshotEvents();
  const cache = new Map<number, Origins>();
  const origins = (seq: number): Origins => {
    const cached = cache.get(seq);
    if (cached) return cached;
    const event = events[seq]!;
    // Only surface-bearing sources count: a checkpoint also lists its own
    // compaction/start and compaction/summary events, which never had a position.
    const sources = event.surfaceOp !== 'append' ? event.sourceEventSeqs?.filter(n => n < seq && events[n]?.surfaceOp !== undefined) : undefined;
    const ranges = sources?.length ? sources.map(origins) : [{ min: seq, max: seq }];
    const range = { min: Math.min(...ranges.map(r => r.min)), max: Math.max(...ranges.map(r => r.max)) };
    cache.set(seq, range);
    return range;
  };
  return origins;
}

export interface ReplaceRange { startSeq: SessionSeq; endSeq: SessionSeq; shadowed: SessionSeq[]; }

/** The composite replaces one contiguous surface run: from the current composite
 * (or the first node after the leading system/instructions head) through the
 * last node that originates at or before the cut. Nodes straddling the cut,
 * open anchors, unbalanced tool pairs and newer compaction checkpoints defer. */
export function replaceRange(session: Session, book: Book, firstSeq: number, cutSeq: number, initial: boolean): { range?: ReplaceRange; defer?: string } {
  const surface = session.surface.nodes;
  const events = session.snapshotEvents();
  const origin = originOf(session);
  let startIdx = surface.findIndex(seq => sourceOf(events[seq]!)?.form === 'history');
  if (startIdx < 0) {
    // Skip the system head and leading instructions, then never shadow
    // anything that predates the first archived day.
    let head = 0;
    while (head < surface.length) {
      const message = eventMessage(events[surface[head]!]!);
      if (message?.role === 'system' || (message?.source.kind as string | undefined) === 'agent-instructions') head++; else break;
    }
    startIdx = surface.findIndex((seq, index) => index >= head && origin(seq).max >= firstSeq);
    if (startIdx < 0) return {};
  }
  let endIdx = -1;
  for (let i = surface.length - 1; i >= startIdx; i--) {
    const seq = surface[i]!;
    if (sourceOf(events[seq]!)?.form === 'history') { endIdx = Math.max(endIdx, i); continue; }
    if (origin(seq).max <= cutSeq) { endIdx = i; break; }
  }
  if (endIdx < startIdx) return {};
  const shadowed = surface.slice(startIdx, endIdx + 1);
  for (const seq of shadowed) {
    const event = events[seq]!;
    const source = sourceOf(event);
    if (source?.form === 'history') continue;
    const range = origin(seq);
    if (range.min <= cutSeq && range.max > cutSeq) return { defer: `node ${seq} straddles the day boundary` };
    if (range.max > cutSeq) return { defer: `node ${seq} after the cut sits inside the range` };
    if (eventMessage(event)?.role === 'system' && surface.indexOf(seq) === 0) return { defer: 'range reaches the system head' };
    if (!initial && String(eventMessage(event)?.source.kind) === 'compact-checkpoint' && book.history !== undefined
      && seq > (surface.find(s => sourceOf(events[s]!)?.form === 'history') ?? -1)) return { defer: 'a newer compaction checkpoint covers faded history' };
  }
  for (const anchor of unclosedDreamAnchors(session)) if (anchor.startSeq <= cutSeq) return { defer: 'an open trajectory anchor starts inside faded history' };
  const first = shadowed[0]!, last = shadowed.at(-1)!;
  if (!toolPairingBalancedBefore(session, first) || !toolPairingBalancedAfter(session, last)) return { defer: 'tool pairing is not balanced at the range edges' };
  return { range: { startSeq: first, endSeq: last, shadowed: [...shadowed] } };
}

export interface SheetInput { day: string; rank: number; photos: Photo[]; }
export interface Sheet { ref: ImageAttachmentRef; legend: string; }

/** One contact sheet for every remembered photo: newest first, smaller with age. */
export async function contactSheet(ctx: Context, inputs: readonly SheetInput[], signal: AbortSignal): Promise<{ png: Buffer; legend: string } | undefined> {
  const entries = inputs.flatMap(input => input.photos.map(photo => ({ ...input, photo })))
    .sort((a, b) => b.photo.time - a.photo.time);
  if (!entries.length) return undefined;
  const canvasModule = await import('@napi-rs/canvas');
  const WIDTH = 1536, GAP = 8, LABEL = 16, MAX_HEIGHT = 1536;
  const placed: { x: number; y: number; w: number; h: number; image: unknown; label: string }[] = [];
  let x = 0, y = 0, rowHeight = 0;
  for (const entry of entries) {
    signal.throwIfAborted();
    const edge = Math.max(64, Math.round(192 * 0.85 ** entry.rank));
    let image: Awaited<ReturnType<typeof canvasModule.loadImage>>;
    try { image = await canvasModule.loadImage(Buffer.from((await ctx.attachments.readImage(entry.photo.attachment, signal)).data)); }
    catch { continue; }
    const scale = Math.min(1, edge / Math.max(image.width, image.height));
    const w = Math.max(1, Math.round(image.width * scale)), h = Math.max(1, Math.round(image.height * scale));
    if (x + w > WIDTH) { x = 0; y += rowHeight + LABEL + GAP; rowHeight = 0; }
    if (y + h + LABEL > MAX_HEIGHT) break;
    placed.push({ x, y, w, h, image, label: `${entry.day.slice(5)} #${entry.photo.n}` });
    x += w + GAP; rowHeight = Math.max(rowHeight, h);
  }
  if (!placed.length) return undefined;
  const height = Math.min(MAX_HEIGHT, y + rowHeight + LABEL);
  const canvas = canvasModule.createCanvas(WIDTH, height);
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, WIDTH, height);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.fillStyle = '#333333'; g.font = '12px sans-serif'; g.textBaseline = 'top';
  for (const item of placed) {
    g.drawImage(item.image as Parameters<typeof g.drawImage>[0], item.x, item.y, item.w, item.h);
    g.fillText(item.label, item.x, item.y + item.h + 2);
  }
  const legend = placed.map(item => item.label).join('、');
  return { png: canvas.toBuffer('image/png'), legend };
}

export function composeHistory(plan: HistoryPlan, config: Config, sheet: Sheet | undefined, now: number): ContentBlock[] {
  const content: ContentBlock[] = [];
  const header = ['[往日]', '以下是较早的日子，按时间从旧到新。原文随着日子变旧逐渐淡去：句子中间的省略用“…”标出，整段跳过的轮次用“（此处略去 N 轮）”标出，「」里是我自己选择多记一阵的原话。',
    '淡去的部分不是没有发生过；需要原话、照片或工具记录时，用 experience_read 按经历 ID 取回；需要回忆某件事时用 experience_search。'];
  content.push({ type: 'text', text: header.join('\n') });
  if (sheet) {
    content.push({ type: 'text', text: `[照片印象] 这些日子里收到的照片缩略图，越旧越小；标签是“日期 #编号”，与各日原文中的 [照片 #编号] 对应：${sheet.legend}。` });
    content.push({ type: 'image', attachment: sheet.ref });
  }
  for (const view of plan.faded) {
    const episode = view.episode;
    const lines: string[] = [];
    const ratio = view.excerpt === undefined ? 0 : Math.round(view.retainedRatio * 100);
    lines.push(`## ${dayLabel(episode.day, config.timeZone)} · ${view.excerpt === undefined ? '只剩记忆' : `已淡化，保留约 ${Math.max(1, ratio)}%`} · ${episode.id}`);
    if (view.summary) lines.push(`【我写下的当天记忆（修订 ${episode.revision}）】\n${episode.summary}`);
    if (view.excerpt !== undefined) lines.push(view.excerpt);
    content.push({ type: 'text', text: lines.join('\n') });
  }
  if (!plan.faded.length) content.push({ type: 'text', text: '（目前没有需要淡化呈现的日子。）' });
  content.push({ type: 'text', text: `[往日结束 · ${dayKey(now, config)} 整理]` });
  return content;
}

export interface ApplyResult { changed: boolean; deferred?: string; book: Book; transitions: string[]; }

/** Rebuild the composite for tonight. Idempotent for the same plan. */
export async function applyProgressive(ctx: Context, agent: Agent, book: Book, store: Store, now: number, config: Config, signal: AbortSignal, options: PlanOptions = {}): Promise<ApplyResult> {
  const plan = await planHistory(agent.session, book, store, now, config, options);
  const transitions = [...plan.notes];
  if (plan.cutSeq < 0) return { changed: false, book: plan.book, transitions };
  const { range, defer } = replaceRange(agent.session, book, plan.firstSeq, plan.cutSeq, options.initial === true || book.history === undefined);
  if (!range) {
    if (defer) transitions.push(`history deferred: ${defer}`);
    return { changed: false, ...(defer === undefined ? {} : { deferred: defer }), book: plan.book, transitions };
  }
  const displayed = plan.faded.map(view => view.episode.id);
  const fingerprint = digest({ cut: plan.cutSeq, days: plan.faded.map(v => [v.episode.id, v.step, v.summary, v.episode.revision, v.excerpt?.length ?? -1]) });
  if (book.history?.digest === fingerprint && book.history.cutSeq === plan.cutSeq && range.shadowed.length === 1
    && sourceOf(agent.session.eventAt(range.startSeq)!)?.form === 'history') {
    return { changed: false, book: plan.book, transitions };
  }
  let sheet: Sheet | undefined;
  const route = agent.session.requestHeader()?.config ?? agent.options;
  const modelInfo = route.provider && route.model ? await ctx.llm.resolveModelInfo(route.provider, route.model, signal) : undefined;
  if (config.progressive.photoSheet && modelInfo?.inputModalities?.includes('image') === true) {
    const inputs = plan.faded.filter(v => v.excerpt !== undefined).map(v => ({ day: v.episode.day, rank: v.rank, photos: v.photos }));
    const built = await contactSheet(ctx, inputs, signal);
    if (built) {
      const [ref] = await ctx.attachments.saveImages([{ data: built.png, mediaType: 'image/png', name: `history-photos-${dayKey(now, config)}.png` }]);
      if (ref) sheet = { ref, legend: built.legend };
    }
  }
  const content = composeHistory(plan, config, sheet, now);
  signal.throwIfAborted();
  const revision = (book.history?.revision ?? 0) + 1;
  agent.session.append('user/message', createUserMessage({ content, source: { kind: SOURCE, form: 'history', revision } }), {
    surfaceOp: { op: 'replace', startSeq: range.startSeq, endSeq: range.endSeq }, sourceEventSeqs: range.shadowed,
  });
  plan.book.history = { revision, digest: fingerprint, cutSeq: plan.cutSeq, displayedEpisodeIds: displayed, ...(sheet ? { sheetRef: sheet.ref.attachmentId } : {}) };
  transitions.push(`history revision ${revision}: ${plan.raw.length} raw day(s), ${plan.faded.length} faded day(s) shown, cut at seq ${plan.cutSeq}, ${estimateTokens(content.filter(b => b.type === 'text').map(b => b.text).join('\n'))} estimated tokens`);
  return { changed: true, book: plan.book, transitions };
}
