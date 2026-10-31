import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

export const SOURCE = 'plugin:dsh-dream-context' as const;
export const DAY = 86_400_000;
export type Stage = 'raw' | 'text' | 'image' | 'summary' | 'recalled';
export interface Episode {
  id: string;
  owner: string;
  day: string;
  from: number;
  to: number;
  startAt: number;
  endAt: number;
  archive: string;
  summary: string;
  keepUntil?: number;
  keepReason?: string;
  revision: number;
  /** Verbatim lines she chose to keep longer; set only while the day is still raw. */
  quotes?: Quote[];
  /** Progressive fading state. `step` only grows, so what remains is always a
   * subset of what remained the night before. */
  fade?: FadeState;
}
export interface Quote { text: string; priority: 1 | 2 | 3; }
export interface FadeState {
  /** Deletions applied along the day's fixed deletion sequence. */
  step: number;
  /** Nights this unsummarized day has stayed raw after it became eligible to fade. */
  rawNights: number;
  /** Slot at which rawNights was last counted, so retries within one night count once. */
  countedSlot?: number;
  /** First slot at which the day left the raw window; undefined while raw. */
  fadedAt?: number;
  estimator: string;
}
export interface HistoryState {
  revision: number;
  digest: string;
  /** Last surface node (log seq) shadowed by the composite [往日] message. */
  cutSeq: number;
  displayedEpisodeIds: string[];
  sheetRef?: string;
}
export interface Memory {
  id: string;
  text: string;
  kind: 'experience' | 'belief' | 'intention' | 'self';
  state: 'active' | 'dormant';
  evidence: string[];
  revision: number;
  createdAt: number;
  updatedAt: number;
  reviewedAt?: number;
  nextReviewAt?: number;
  bias?: number;
  biasReason?: string;
  biasUpdatedAt?: number;
  freshAt?: number;
  freshnessBasis?: string;
  provenance?: { migration: string; legacyId: string; sourceId: string };
  /** Her last daytime edit of this record (experience_edit): log position, time and her reason. */
  daytime?: { seq: number; at: number; reason: string };
}
export interface LegacySource { id: string; ref: string; originalTime: number; }
/** A daytime note she left for her next dream. `seq` is the log position of the tool call,
 * which places the note inside one captured day. */
export interface Note { id: string; text: string; createdAt: number; seq: number; about?: string; }
export interface LegacyArchive { version: 1; kind: 'legacy-memory'; text: string; }
export interface Migration {
  version: 1; targetSessionId: string; memories: Memory[]; sources: LegacySource[];
}
export interface ManualRun { id: string; sessionId: string; day: string; resultRef?: string; }
export interface Receipt { id: string; text: string; }
export interface Book {
  version: 1;
  owner: string;
  /** Native event cursor, never a timestamp. Capturing and dreaming are separate. */
  capturedThrough: number;
  lastSlot: number;
  attemptSlot?: number;
  attempts?: number;
  episodes: Episode[];
  memories: Memory[];
  dreams?: string[];
  migrations?: string[];
  legacySources?: LegacySource[];
  /** Pending daytime notes, consumed by the dream that presents them. */
  notes?: Note[];
  manualRuns?: Record<string, 'started' | 'completed' | 'failed'>;
  rebuilds?: Record<string, 'started' | 'completed' | 'failed'>;
  history?: HistoryState;
  lastDreamNotes?: string[];
  lastReceipt?: Receipt;
  anchorHandoff?: { slot: number; taskId: string; anchorIds: string[]; requestedAt: number };
  recallControl?: { mode: 'auto' | 'paused'; changedAt: number; afterSeq: number; reason: string; silenceMinutes?: number; pausedUntil?: number; reminderId?: string };
  health?: {
    failureNights: number;
    lastFailureSlot?: number;
    lastError?: string;
    lastAlertSlot?: number;
    alertTaskId?: string;
  };
}
export interface Archive {
  version: 1;
  owner: string;
  from: number;
  to: number;
  events: SessionEvent[];
}
export interface DreamSource {
  kind: typeof SOURCE;
  form: 'book' | 'episode' | 'recall' | 'dream' | 'dream-feedback' | 'receipt' | 'recall-status' | 'history';
  receiptId?: string;
  ref?: string;
  episodeId?: string;
  stage?: Stage;
  revision?: number;
  injectedAt?: number;
  turn?: number;
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'plugin:dsh-dream-context': DreamSource; }
}
export interface Policy {
  timeZone: string;
  dailyAt: string;
  rawDays: number;
  imageDays: number;
  summaryDays: number;
  maxSummaryDays: number;
}
export const DEFAULT_POLICY: Policy = {
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, dailyAt: '04:00', rawDays: 2, imageDays: 7,
  summaryDays: 21, maxSummaryDays: 30,
};
export interface ProgressiveConfig {
  enabled: boolean;
  /** Whole recent days kept verbatim, chosen newest-first within this many tokens. */
  rawTokens: number;
  /** Total budget for faded excerpts, split geometrically by rank. */
  fadeBudgetTokens: number;
  fadeRatio: number;
  /** A rank whose allotment falls below this keeps no excerpt. */
  minDayTokens: number;
  /** Share of a day's first allotment her quotes may occupy. */
  quoteShare: number;
  /** Nights an unsummarized eligible day may stay raw before fading without a summary. */
  maxRawNights: number;
  photoSheet: boolean;
  /** Speaker labels in faded excerpts. */
  labels: { user: string; self: string };
}
export interface RebuildRun { id: string; sessionId: string; fromDay?: string; }
export interface Config extends Policy {
  dataDir: string;
  progressive: ProgressiveConfig;
  /** One authorized first rebuild: backfill archives, then replace the old history. */
  rebuild?: RebuildRun | null;
  auto: boolean;
  /** Shadow writes its own dream book; it never serves recall or ages history. */
  shadow: boolean;
  /** Allow age-based history replacement independently of recall and tools. */
  historyCompression: boolean;
  /** Immutable one-time import committed to its named native session. */
  migrationRef: string;
  /** Supply contextual queries to the existing layered-memory recall hook. */
  legacyQueryHelper: boolean;
  /** Earliest automatic run, as an epoch timestamp; manual runs remain explicit. */
  notBefore: number;
  quietMinutes: number;
  maxDreamsPerNight: number;
  /** Earliest companion day eligible for new summaries; older objects stay intact. */
  startDay: string;
  backlogAlerts: boolean;
  notifications: boolean;
  manualRun?: ManualRun | null;
  maxRequestChars: number;
  maxOutputTokens: number;
  /** Budget for one model request round. Each dream may use `1 + MAX_DREAM_CORRECTIONS` rounds
   * in total (reads and correction rounds included), never the whole nightly batch. */
  timeoutMs: number;
  /** Read-tool budget for one dream: successful calls and returned characters. Repeated identical
   * calls are answered from the first result and do not count. */
  maxDreamReads: number;
  maxDreamReadChars: number;
  maxImageFrames: number;
  recallMaxChars: number;
  recallResults: number;
  recallMinScore: number;
  freshnessMaxBonus: number;
  freshnessHalfLifeDays: number;
  embeddingUrl: string;
  embeddingCacheDir: string;
  embeddingModel: string;
  reviewDays: number;
  randomReviewCount: number;
  dreamSupplementChars: number;
  queryApiUrl: string;
  queryModel: string;
  queryApiKeyEnv: string;
  queryTimeoutMs: number;
  queryMaxChars: number;
}
export const DEFAULT_PROGRESSIVE: ProgressiveConfig = {
  enabled: false, rawTokens: 40_000, fadeBudgetTokens: 30_000, fadeRatio: 0.75, minDayTokens: 300,
  quoteShare: 0.5, maxRawNights: 3, photoSheet: true, labels: { user: '用户', self: '我' },
};
export const DEFAULT_CONFIG: Config = {
  ...DEFAULT_POLICY, dataDir: '', progressive: DEFAULT_PROGRESSIVE, rebuild: null, auto: true, shadow: false, historyCompression: true, migrationRef: '', legacyQueryHelper: false, notBefore: 0, quietMinutes: 10,
  maxDreamsPerNight: 3, startDay: '', backlogAlerts: false, notifications: false, maxRequestChars: 1_000_000, maxOutputTokens: 12_000,
  timeoutMs: 300_000, maxDreamReads: 10, maxDreamReadChars: 60_000, maxImageFrames: 8,
  recallMaxChars: 2400, recallResults: 2, recallMinScore: 0.62, freshnessMaxBonus: 0.15, freshnessHalfLifeDays: 30,
  embeddingUrl: '', embeddingCacheDir: '', embeddingModel: 'ritrieve_zh_v1-chunks-v1',
  reviewDays: 7, randomReviewCount: 3, dreamSupplementChars: 24000,
  queryApiUrl: '', queryModel: 'deepseek-flash', queryApiKeyEnv: 'DEEPSEEK_API_KEY',
  queryTimeoutMs: 3000, queryMaxChars: 8000,
};
export interface Transcript { text: string; media: ContentBlock[]; }
export function emptyBook(owner: string): Book {
  return { version: 1, owner, capturedThrough: -1, lastSlot: 0, episodes: [], memories: [] };
}
