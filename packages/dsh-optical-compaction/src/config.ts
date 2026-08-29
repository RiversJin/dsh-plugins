import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import z from '@deepseek-ai/schemastery'
import { FRAME_DATA_BYTES_BUDGET, MAX_FRAMES_DEFAULT, isShapeVariantName, type ShapeVariantName } from './snapcompact.js'

export const DEFAULT_SUMMARY_PROMPT = [
  'Create a compact, durable checkpoint of the earlier conversation.',
  'Preserve decisions, constraints, user corrections, open work, exact paths, identifiers, commands, and numbers.',
  'Treat role-play and hypotheses as such. Never retain credentials, tokens, pairing codes, or secret values.',
  'Do not mention this request and do not call tools. Output only the checkpoint.'
].join(' ')

const MemoryDecayConfig = z.object({
  enabled: z.boolean().default(true),
  periodHours: z.number().min(1).default(12),
  scalePerPeriod: z.number().min(0.5).max(0.99).default(0.9),
  minScale: z.number().min(0.25).max(1).default(0.5),
  informationTokensPerFrame: z.number().step(1).min(1).default(16000),
})

const OpticalConfig = z.object({
  enabled: z.boolean().default(true),
  shape: z.string().default('auto'),
  maxFrames: z.number().step(1).min(1).max(MAX_FRAMES_DEFAULT).default(MAX_FRAMES_DEFAULT),
  maxFrameDataBytes: z.number().step(1).min(1).default(FRAME_DATA_BYTES_BUDGET),
  toolResultMaxChars: z.number().step(1).min(1).default(2000),
  toolArgumentMaxChars: z.number().step(1).min(1).default(500),
  toolCallMaxChars: z.number().step(1).min(1).default(2000),
  truncateHeadRatio: z.number().min(0).max(1).default(0.6),
  dimToolResults: z.boolean().default(true),
  includeReasoning: z.boolean().default(true),
  memoryDecay: MemoryDecayConfig,
})

export const Config = z.object({
  thresholdRatio: z.number().min(0.01).max(0.99).default(0.8),
  retainRatio: z.number().min(0.01).max(0.99).default(0.16),
  summarizationProvider: z.string(),
  summarizationModel: z.string(),
  maxTokens: z.number().step(1).min(1).default(8192),
  compactionRetries: z.number().step(1).min(0).default(1),
  maxOverflowRetries: z.number().step(1).min(0).default(1),
  auto: z.boolean().default(true),
  summaryPrompt: z.string().default(DEFAULT_SUMMARY_PROMPT),
  optical: OpticalConfig,
})

export type PluginConfig = typeof Config extends z<infer T> ? T : never

export interface ResolvedOpticalConfig {
  readonly enabled: boolean
  readonly shape: ShapeVariantName | 'auto'
  readonly maxFrames: number
  readonly maxFrameDataBytes: number
  readonly toolResultMaxChars: number
  readonly toolArgumentMaxChars: number
  readonly toolCallMaxChars: number
  readonly truncateHeadRatio: number
  readonly dimToolResults: boolean
  readonly includeReasoning: boolean
  readonly memoryDecay: ResolvedMemoryDecayConfig
}

export interface ResolvedMemoryDecayConfig {
  readonly enabled: boolean
  readonly periodMs: number
  readonly scalePerPeriod: number
  readonly minScale: number
  readonly informationTokensPerFrame: number
}

export interface ResolvedPluginConfig {
  readonly engine: BasicCompactionConfig
  readonly summaryPrompt: string
  readonly optical: ResolvedOpticalConfig
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

export function resolvePluginConfig(config: PluginConfig): ResolvedPluginConfig {
  const optical = config.optical ?? {}
  const memoryDecay = optical.memoryDecay ?? {}
  const periodHours = memoryDecay.periodHours ?? 12
  const scalePerPeriod = memoryDecay.scalePerPeriod ?? 0.9
  const minScale = memoryDecay.minScale ?? 0.5
  const informationTokensPerFrame = memoryDecay.informationTokensPerFrame ?? 16000
  if (!Number.isFinite(periodHours) || periodHours < 1) {
    throw new Error('dsh-optical-compaction: optical.memoryDecay.periodHours must be at least 1')
  }
  if (!Number.isFinite(scalePerPeriod) || scalePerPeriod < 0.5 || scalePerPeriod > 0.99) {
    throw new Error('dsh-optical-compaction: optical.memoryDecay.scalePerPeriod must be between 0.5 and 0.99')
  }
  if (!Number.isFinite(minScale) || minScale < 0.25 || minScale > 1) {
    throw new Error('dsh-optical-compaction: optical.memoryDecay.minScale must be between 0.25 and 1')
  }
  if (!Number.isSafeInteger(informationTokensPerFrame) || informationTokensPerFrame < 1) {
    throw new Error('dsh-optical-compaction: optical.memoryDecay.informationTokensPerFrame must be a positive integer')
  }
  const shape = optical.shape ?? 'auto'
  if (shape !== 'auto' && !isShapeVariantName(shape)) {
    throw new Error(`dsh-optical-compaction: unsupported OMP shape "${shape}"`)
  }
  const provider = nonEmpty(config.summarizationProvider)
  const model = nonEmpty(config.summarizationModel)
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error('dsh-optical-compaction: summarizationProvider and summarizationModel must be set together')
  }
  const summaryRoute = provider === undefined
    ? {}
    : { summarizationProvider: provider, summarizationModel: model as string }
  return Object.freeze({
    engine: Object.freeze({
      thresholdRatio: config.thresholdRatio ?? 0.8,
      retainRatio: config.retainRatio ?? 0.16,
      ...summaryRoute,
      maxTokens: config.maxTokens ?? 8192,
      compactionRetries: config.compactionRetries ?? 1,
      maxOverflowRetries: config.maxOverflowRetries ?? 1,
      auto: config.auto ?? true,
    }),
    summaryPrompt: nonEmpty(config.summaryPrompt) ?? DEFAULT_SUMMARY_PROMPT,
    optical: Object.freeze({
      enabled: optical.enabled ?? true,
      shape: shape as ShapeVariantName | 'auto',
      maxFrames: optical.maxFrames ?? MAX_FRAMES_DEFAULT,
      maxFrameDataBytes: optical.maxFrameDataBytes ?? FRAME_DATA_BYTES_BUDGET,
      toolResultMaxChars: optical.toolResultMaxChars ?? 2000,
      toolArgumentMaxChars: optical.toolArgumentMaxChars ?? 500,
      toolCallMaxChars: optical.toolCallMaxChars ?? 2000,
      truncateHeadRatio: optical.truncateHeadRatio ?? 0.6,
      dimToolResults: optical.dimToolResults ?? true,
      includeReasoning: optical.includeReasoning ?? true,
      memoryDecay: Object.freeze({
        enabled: memoryDecay.enabled ?? true,
        periodMs: periodHours * 60 * 60 * 1000,
        scalePerPeriod,
        minScale,
        informationTokensPerFrame,
      }),
    }),
  })
}
