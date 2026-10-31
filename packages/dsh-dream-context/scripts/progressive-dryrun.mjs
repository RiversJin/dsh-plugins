// Offline rehearsal of the progressive composite against a real session log.
// Reads the live log and dream objects; writes nothing back. New archives for
// the backfill go to a scratch object directory.
//
// usage: node scripts/progressive-dryrun.mjs <session.v4.jsonl(.zstd)> <objects-dir> <out-dir> [now-iso]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import LocalAttachments from '@deepseek-ai/dsh-attachment-local';
import * as ImageOffload from '@deepseek-ai/dsh-compaction-image-offload';
import { Store } from '../lib/store.js';
import { archiveRange, bookRef } from '../lib/history.js';
import { DEFAULT_CONFIG, DEFAULT_PROGRESSIVE } from '../lib/types.js';
import { planHistory, composeHistory, replaceRange, contactSheet } from '../lib/progressive.js';
import { estimateTokens } from '../lib/fade.js';
import { dayKey, slotAt } from '../lib/policy.js';

const [, , logPath, objectsDir, outDir, nowIso] = process.argv;
if (!logPath || !objectsDir || !outDir) throw new Error('usage: progressive-dryrun.mjs <log> <objects> <out> [now]');
mkdirSync(outDir, { recursive: true });
const raw = logPath.endsWith('.zstd') ? execFileSync('zstdcat', ['-q', logPath], { maxBuffer: 4 * 1024 * 1024 * 1024 }).toString('utf8') : readFileSync(logPath, 'utf8');
const lines = raw.split('\n').filter(Boolean);
const restore = sessionFormatCatalog.createRestore(JSON.parse(lines[0]), { recovery: 'strict', validation: 'current' });
for (const line of lines.slice(1)) restore.decodeRow(JSON.parse(line));
const artifact = restore.finish();
const rows = artifact.events;
// Message projections (image offload, retry, ...) come from the same plugins the live profile loads.
process.env.DSH_HOME = process.env.DRYRUN_HOME ?? join(outDir, 'dsh-home');
const ctx = new Context();
for (const plugin of [LlmRuntime, SessionStore, Projections, TokenMeter, SystemPrompt, Tools, AgentRegistry, LocalAttachments, ImageOffload]) await ctx.plugin(plugin);
const session = Session.create(SessionId(artifact.header.id), rows, artifact.header, SessionLogOffset(artifact.inheritedEventCount), ctx.sessions.messageProjections);
const now = nowIso ? Date.parse(nowIso) : Date.now();

class ScratchStore extends Store {
  constructor(live, scratch) { super(scratch); this.live = new Store(live); }
  async get(ref) { try { return await this.live.get(ref); } catch { return super.get(ref); } }
}
const store = new ScratchStore(objectsDir, join(outDir, 'objects'));
const ref = bookRef(session);
if (!ref) throw new Error('session has no dream book');
const book = await store.get(ref);
const config = { ...DEFAULT_CONFIG, timeZone: 'Asia/Singapore', startDay: '2026-10-14', summaryDays: 21,
  progressive: { ...DEFAULT_PROGRESSIVE, enabled: true, labels: { user: '用户', self: '我' } } };

const firstDay = process.env.DRYRUN_FROM_DAY ?? dayKey(rows.find(e => e.time > 0).time, config);
const toDay = dayKey(slotAt(now, config) - 86_400_000, config);
const filled = await archiveRange(session, book, store, now, config, firstDay, toDay);
console.log(`backfilled ${filled.added.length} day(s): ${filled.added[0]} .. ${filled.added.at(-1)}`);

const plan = await planHistory(session, filled.book, store, now, config, { labels: config.progressive.labels });
// DRYRUN_SHEET=1 renders the photo contact sheet too (needs DSH_HOME/attachments to hold the photos; the
// default scratch home has none, so point DRYRUN_HOME at a copy of the real home for this check).
let sheetInfo;
if (process.env.DRYRUN_SHEET) {
  const inputs = plan.faded.filter(v => v.excerpt !== undefined).map(v => ({ day: v.episode.day, rank: v.rank, photos: v.photos }));
  const built = await contactSheet(ctx, inputs, new AbortController().signal);
  if (built) { writeFileSync(join(outDir, 'sheet.png'), built.png); writeFileSync(join(outDir, 'sheet-legend.txt'), built.legend); }
  sheetInfo = { photos: inputs.reduce((n, i) => n + i.photos.length, 0), rendered: built !== undefined, pngBytes: built?.png.length ?? 0, legend: built?.legend };
}
const content = composeHistory(plan, config, undefined, now);
const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n\n');
writeFileSync(join(outDir, 'composite.md'), text);
const range = replaceRange(session, filled.book, plan.firstSeq, plan.cutSeq, true);
const report = {
  now: new Date(now).toISOString(), book: ref, backfilled: filled.added,
  rawDays: plan.raw.map(e => e.day), cutSeq: plan.cutSeq, firstSeq: plan.firstSeq,
  replace: range.range ? { startSeq: range.range.startSeq, endSeq: range.range.endSeq, shadowedNodes: range.range.shadowed.length } : { deferred: range.defer },
  compositeTokens: estimateTokens(text),
  days: plan.faded.map(v => ({ day: v.episode.day, rank: v.rank, allot: v.allot, step: v.step, summary: v.summary,
    excerptTokens: v.excerpt === undefined ? 0 : estimateTokens(v.excerpt), retained: Math.round(v.retainedRatio * 100), photos: v.photos.length })),
  notes: plan.notes, ...(sheetInfo ? { sheet: sheetInfo } : {}),
};
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.table(report.days);
console.log(JSON.stringify({ sheet: report.sheet, rawDays: report.rawDays, cutSeq: report.cutSeq, replace: report.replace, compositeTokens: report.compositeTokens, notes: report.notes }, null, 2));
await ctx.fiber.dispose();
