import type { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  BlockAssembler,
  createUserMessage,
  type ContentBlock,
  type Message as DshMessage,
  type TokenUsage,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { ResolvedPluginConfig } from './config.js'
import {
  compact,
  createFileOps,
  estimateImageContextTokens,
  getPreservedArchive,
  historyBlocks,
  resolveShape,
  type Api,
  type ImageContent,
  type Message as SnapMessage,
  type ShapeTarget,
  type TextContent,
} from './snapcompact.js'

interface SummarizationInput {
  readonly system?: string
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly DshMessage[]
}

type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
} & ({ rawOutput: ContentBlock[]; llmStreamCall: true } | { rawOutput?: ContentBlock[]; llmStreamCall?: never })

const PRESERVE_PREFIX = 'dsh-snapcompact-preserve-v1\n'
const SNAPCOMPACT_MODEL = 'dsh-optical-compaction/omp-snapcompact-18.0.10'
// dsh-compaction-basic adds a fixed preamble and compacted-summary tags after
// summarize() returns. Budget them here so the hybrid decision cannot mistake
// an almost-equal optical payload for a real reduction.
const CHECKPOINT_FRAMING_TOKEN_ALLOWANCE = 128
// K3 accepted DSH's 20-image wire payload but failed to recover even a clear
// nearby concept from that many dense transcript pages. Eight stratified pages
// stayed within the empirically useful scanning range while covering every
// occupied 12-hour bucket in the long-session fixture.
const KIMI_DENSE_FRAME_LIMIT = 8

/** Optical compaction is useful exactly while it frees model context. */
export function opticalReducesContext(sourceTokens: number, opticalTokens: number): boolean {
  return opticalTokens < sourceTokens
}

/** Effective frame cap combines configuration, DSH transport limits, and
 * reader-specific perceptual limits. Context-window size alone is insufficient:
 * K3's 1M route can afford 20 images in tokens but does not reliably scan 20
 * dense transcript pages. */
export function effectiveFrameLimit(configured: number, host: number, provider: string): number {
  const readerLimit = provider.toLowerCase().includes('kimi') ? KIMI_DENSE_FRAME_LIMIT : host
  return Math.max(1, Math.min(configured, host, readerLimit))
}

/** Grow the visual working set with effective source information, while the
 * transport/reader cap remains authoritative. Automatic compaction pressure is
 * still owned by dsh-compaction-basic; this only sizes a compaction that is
 * already running (including an explicit /compact). */
export function informationFrameLimit(
  maximum: number,
  sourceTokens: number,
  informationTokensPerFrame: number,
): number {
  if (!Number.isFinite(sourceTokens) || sourceTokens <= 0) return 1
  return Math.max(1, Math.min(maximum, Math.ceil(sourceTokens / informationTokensPerFrame)))
}

interface ImageDimensions {
  readonly width: number
  readonly height: number
}

function withoutImages(blocks: readonly ContentBlock[], images: ImageDimensions[]): ContentBlock[] {
  const kept: ContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'image') {
      images.push({ width: block.attachment.width, height: block.attachment.height })
    } else if (block.type === 'tool-result') {
      kept.push({ ...block, content: withoutImages(block.content, images) })
    } else {
      kept.push(block)
    }
  }
  return kept
}

function estimateMessageTokens(
  message: DshMessage,
  tokenMeter: TokenMeter,
  api: Api | undefined,
): number {
  const images: ImageDimensions[] = []
  const textMessage = { ...message, content: withoutImages(message.content, images) }
  return tokenMeter.estimateMessage(textMessage)
    + images.reduce((total, image) => total + estimateImageContextTokens(api, image.width, image.height), 0)
}

/** Old checkpoints predate cumulative information accounting. Their readable
 * and already-retired character counts still provide a conservative one-time
 * bridge, after which the exact counter is persisted. */
function priorInformationTokens(archive: ReturnType<typeof getPreservedArchive>): number {
  if (archive === undefined) return 0
  if (archive.informationTokens !== undefined) return archive.informationTokens
  return Math.max(1, Math.ceil((archive.totalChars + archive.truncatedChars) / 3))
}

function pngDimensions(data: string): ImageDimensions {
  const png = Buffer.from(data, 'base64')
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (png.length < 24 || signature.some((byte, index) => png[index] !== byte)) {
    throw new Error('dsh-optical-compaction: renderer returned an invalid PNG frame')
  }
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (width === 0 || height === 0) {
    throw new Error(`dsh-optical-compaction: renderer returned invalid PNG dimensions ${width}x${height}`)
  }
  return { width, height }
}

function estimateOpticalCheckpointTokens(
  summary: string,
  history: readonly (TextContent | ImageContent)[],
  tokenMeter: TokenMeter,
  api: Api | undefined,
): number {
  const textBlocks: ContentBlock[] = [
    { type: 'text', text: summary },
    ...history
      .filter((block): block is TextContent => block.type === 'text')
      .map(block => ({ type: 'text' as const, text: block.text })),
  ]
  const textMessage = createUserMessage({
    content: textBlocks,
    source: { kind: 'plugin', plugin: 'dsh-optical-compaction' },
  })
  const imageTokens = history.reduce((total, block) => {
    if (block.type !== 'image') return total
    const dimensions = pngDimensions(block.data)
    return total + estimateImageContextTokens(api, dimensions.width, dimensions.height)
  }, 0)
  return tokenMeter.estimateMessage(textMessage) + imageTokens + CHECKPOINT_FRAMING_TOKEN_ALLOWANCE
}

function conversationTarget(agent: Agent): { provider: string; model: string } | undefined {
  const routed = agent.session.requestHeader()?.config
  if (routed !== undefined && routed.provider.length > 0 && routed.model.length > 0) {
    return { provider: routed.provider, model: routed.model }
  }
  if (agent.options.provider === undefined || agent.options.model === undefined) return undefined
  if (agent.options.provider.length === 0 || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason
}

function finishError(finish: { kind: string; failure?: { message: string; code: string } }): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure?.message ?? 'semantic fallback failed')
      if (finish.failure?.code !== undefined) {
        ;(error as Error & { code?: string }).code = finish.failure.code
      }
      return error
    }
    case 'max-tokens':
      return new Error('dsh-optical-compaction: semantic fallback reached maxTokens')
    case 'tool-calls':
      return new Error('dsh-optical-compaction: semantic fallback unexpectedly requested a tool')
    default:
      return new Error(`dsh-optical-compaction: unsupported finish reason "${finish.kind}"`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePreserveBlock(blocks: readonly ContentBlock[] | undefined): Record<string, unknown> | undefined {
  if (blocks === undefined) return undefined
  for (const block of blocks) {
    if (block.type !== 'text' || !block.text.startsWith(PRESERVE_PREFIX)) continue
    try {
      const parsed: unknown = JSON.parse(block.text.slice(PRESERVE_PREFIX.length))
      if (isRecord(parsed) && getPreservedArchive(parsed) !== undefined) return parsed
    } catch {
      // A malformed old raw-output payload is treated like a non-Snapcompact checkpoint.
    }
  }
  return undefined
}

function checkpointSummary(message: DshMessage): string | undefined {
  const text = message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  if (text.length === 0) return undefined
  const framed = /<compacted-summary>\s*([\s\S]*?)\s*<\/compacted-summary>/.exec(text)
  return (framed?.[1] ?? text).trim() || undefined
}

function priorArchive(
  messages: readonly DshMessage[],
  agent: Agent,
): { messages: readonly DshMessage[]; previousSummary?: string; previousPreserveData?: Record<string, unknown> } {
  let previousSummary: string | undefined
  let previousPreserveData: Record<string, unknown> | undefined
  const kept: DshMessage[] = []

  for (const message of messages) {
    if (!isCompactCheckpointSource(message.source)) {
      kept.push(message)
      continue
    }
    if (!('compactionId' in message.source) || typeof message.source.compactionId !== 'string') {
      kept.push(message)
      continue
    }
    const compactionId = message.source.compactionId
    const event = [...agent.session.events].reverse().find(candidate =>
      candidate.type === 'compaction/summary' && candidate.data.compactionId === compactionId
    )
    if (event?.type === 'compaction/summary') {
      previousPreserveData = parsePreserveBlock(event.data.rawOutput)
    }
    if (previousPreserveData === undefined) previousSummary = checkpointSummary(message)
  }

  return {
    messages: kept,
    ...(previousSummary === undefined ? {} : { previousSummary }),
    ...(previousPreserveData === undefined ? {} : { previousPreserveData }),
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed)) return parsed
    return { value: parsed }
  } catch {
    return { raw }
  }
}

function toolResultText(block: Extract<ContentBlock, { type: 'tool-result' }>): TextContent[] {
  const out: TextContent[] = []
  const visit = (content: readonly ContentBlock[]): void => {
    for (const nested of content) {
      if (nested.type === 'text') out.push({ type: 'text', text: nested.text })
      else if (nested.type === 'reasoning') out.push({ type: 'text', text: nested.text })
      else if (nested.type === 'tool-result') visit(nested.content)
    }
  }
  visit(block.content)
  return out
}

/** Translate DSH's provider-neutral blocks into OMP's serialization vocabulary. */
export function toSnapcompactMessages(
  messages: readonly DshMessage[],
  timestamps: ReadonlyMap<string, number> = new Map(),
): SnapMessage[] {
  const out: SnapMessage[] = []
  for (const message of messages) {
    const timestamp = timestamps.get(message.id)
    if (message.role === 'assistant') {
      const content: Extract<SnapMessage, { role: 'assistant' }>['content'] = []
      for (const block of message.content) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text })
        else if (block.type === 'reasoning') content.push({ type: 'thinking', thinking: block.text })
        else if (block.type === 'tool-call') {
          content.push({
            type: 'toolCall',
            id: block.id,
            name: block.name,
            arguments: parseArguments(block.arguments),
          })
        }
      }
      if (content.length > 0) out.push({ role: 'assistant', content, ...(timestamp === undefined ? {} : { timestamp }) })
      continue
    }

    const userText: TextContent[] = []
    for (const block of message.content) {
      if (block.type === 'text') userText.push({ type: 'text', text: block.text })
      else if (block.type === 'reasoning') userText.push({ type: 'text', text: block.text })
      else if (block.type === 'tool-result') {
        out.push({
          role: 'toolResult',
          toolCallId: block.toolCallId,
          content: toolResultText(block),
          ...(block.isError === undefined ? {} : { isError: block.isError }),
          ...(timestamp === undefined ? {} : { timestamp }),
        })
      }
    }
    if (userText.length > 0) {
      out.push({ role: 'user', content: userText, ...(timestamp === undefined ? {} : { timestamp }) })
    }
  }
  return out
}

function messageTimestamps(messages: readonly DshMessage[], agent: Agent): ReadonlyMap<string, number> {
  const wanted = new Set(messages.map(message => message.id))
  const timestamps = new Map<string, number>()
  for (const event of agent.session.events) {
    const message = agent.session.deriveEventMessage(event)
    if (message !== null && wanted.has(message.id)) timestamps.set(message.id, event.time)
  }
  return timestamps
}

export function ompApiForProvider(provider: string): Api | undefined {
  const normalized = provider.toLowerCase()
  if (normalized.includes('bedrock')) return 'bedrock-converse-stream'
  if (normalized.includes('anthropic')) return 'anthropic-messages'
  if (normalized.includes('azure')) return 'azure-openai-responses'
  if (normalized.includes('codex')) return 'openai-codex-responses'
  if (normalized.includes('openai')) return 'openai-responses'
  if (normalized.includes('vertex')) return 'google-vertex'
  if (normalized.includes('gemini-cli')) return 'google-gemini-cli'
  if (normalized.includes('google') || normalized.includes('gemini')) return 'google-generative-ai'
  return undefined
}

function withoutFramePayloads(preserveData: Record<string, unknown>): Record<string, unknown> {
  const archive = getPreservedArchive(preserveData)
  if (archive === undefined) return preserveData
  return {
    ...preserveData,
    snapcompact: {
      ...archive,
      // DSH stores visible PNGs in its content-addressed attachment service.
      // OMP only needs the kept source and counters to unfold/re-render later.
      frames: [],
    },
  }
}

async function materializeHistoryBlocks(
  context: Context,
  blocks: readonly (TextContent | ImageContent)[],
): Promise<ContentBlock[]> {
  const imageBlocks = blocks.filter((block): block is ImageContent => block.type === 'image')
  const references = await context.attachments.saveImages(imageBlocks.map((block, index) => ({
    data: Buffer.from(block.data, 'base64'),
    mediaType: 'image/png' as const,
    name: `snapcompact-frame-${String(index + 1).padStart(3, '0')}.png`,
  })))
  let imageIndex = 0
  return blocks.map(block => {
    if (block.type === 'text') return { type: 'text' as const, text: block.text }
    const attachment = references[imageIndex]
    imageIndex += 1
    if (attachment === undefined) throw new Error('dsh-optical-compaction: attachment result count mismatch')
    return { type: 'image' as const, attachment }
  })
}

/** DSH compaction backend carrying OMP Snapcompact through DSH's durable seams. */
export class OpticalCompactionEngine extends BasicCompactionEngine {
  constructor(
    private readonly opticalContext: Context,
    private readonly pluginConfig: ResolvedPluginConfig,
  ) {
    super(opticalContext, pluginConfig.engine)
  }

  private async semanticFallback(
    reason: string,
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    this.opticalContext.logger.warn(`dsh-optical-compaction: semantic fallback (${reason})`)
    const configuredProvider = this.pluginConfig.engine.summarizationProvider
    const configuredModel = this.pluginConfig.engine.summarizationModel
    const target = conversationTarget(agent)
    const provider = configuredProvider === undefined || configuredProvider.length === 0
      ? target?.provider
      : configuredProvider
    const model = configuredModel === undefined || configuredModel.length === 0
      ? target?.model
      : configuredModel
    if (provider === undefined || model === undefined) {
      throw new Error('dsh-optical-compaction: semantic fallback has no provider/model route')
    }
    const maxTokens = this.pluginConfig.engine.maxTokens ?? 8192
    const messages = [
      ...input.messages,
      createUserMessage({
        content: [{ type: 'text', text: this.pluginConfig.summaryPrompt }],
        source: { kind: 'plugin', plugin: 'dsh-optical-compaction' },
      }),
    ]
    const assembler = new BlockAssembler()
    for await (const chunk of this.opticalContext.llm.stream({
      provider,
      model,
      messages,
      ...(input.system === undefined ? {} : { system: input.system }),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(signal === undefined ? {} : { signal }),
    })) {
      assembler.push(chunk)
    }
    const error = finishError(assembler.finish)
    if (error !== undefined) throw error
    const rawOutput = assembler.blocks()
    const summary = rawOutput.filter(
      (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text',
    )
    if (!summary.some(block => block.text.trim().length > 0)) {
      throw new Error('dsh-optical-compaction: semantic fallback produced no text')
    }
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider,
      model,
      maxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    }
  }

  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const config = this.pluginConfig.optical
    if (!config.enabled) return this.semanticFallback('Snapcompact mode disabled', input, agent, signal)

    const target = conversationTarget(agent)
    if (target === undefined) return this.semanticFallback('conversation route is unknown', input, agent, signal)
    const modelInfo = await this.opticalContext.llm.resolveModelInfo(target.provider, target.model, signal)
    if (modelInfo.inputModalities?.includes('image') !== true) {
      return this.semanticFallback(`${target.provider}/${target.model} does not declare image input`, input, agent, signal)
    }

    const prior = priorArchive(input.messages, agent)
    const tokenMeter = (this.opticalContext as Context & { tokenMeter: TokenMeter }).tokenMeter
    const api = ompApiForProvider(target.provider)
    const sourceMultimodalTokens = input.messages.reduce(
      (total, message) => total + estimateMessageTokens(message, tokenMeter, api),
      0,
    )
    const previousArchive = getPreservedArchive(prior.previousPreserveData)
    const newInformationTokens = prior.messages.reduce(
      (total, message) => total + estimateMessageTokens(message, tokenMeter, api),
      0,
    )
    const accumulatedInformationTokens = priorInformationTokens(previousArchive) + newInformationTokens
    const modelTarget: ShapeTarget = { ...(api === undefined ? {} : { api }), id: target.model }
    const readerFrameLimit = effectiveFrameLimit(
      config.maxFrames,
      this.opticalContext.attachments.imageLimits.maxImagesPerMessage,
      target.provider,
    )
    const frameLimit = config.memoryDecay.enabled
      ? informationFrameLimit(
          readerFrameLimit,
          accumulatedInformationTokens,
          config.memoryDecay.informationTokensPerFrame,
        )
      : readerFrameLimit
    const forcedShape = config.shape === 'auto' ? undefined : resolveShape(modelTarget, config.shape)
    const messages = toSnapcompactMessages(prior.messages, messageTimestamps(prior.messages, agent))

    throwIfAborted(signal)
    const result = await compact({
      firstKeptEntryId: input.messages[0]?.id ?? agent.session.id,
      messagesToSummarize: messages,
      turnPrefixMessages: [],
      tokensBefore: accumulatedInformationTokens,
      ...(prior.previousSummary === undefined ? {} : { previousSummary: prior.previousSummary }),
      ...(prior.previousPreserveData === undefined ? {} : { previousPreserveData: prior.previousPreserveData }),
      fileOps: createFileOps(),
    }, {
      model: modelTarget,
      ...(forcedShape === undefined ? {} : { shape: forcedShape }),
      maxFrames: frameLimit,
      maxFrameDataBytes: config.maxFrameDataBytes,
      toolResultMaxChars: config.toolResultMaxChars,
      toolArgMaxChars: config.toolArgumentMaxChars,
      toolCallMaxChars: config.toolCallMaxChars,
      truncateHeadRatio: config.truncateHeadRatio,
      dimToolResults: config.dimToolResults,
      // OMP suppresses replayed thinking for Claude-family readers.
      includeThinking: config.includeReasoning && !/claude/i.test(target.model),
      memoryDecay: config.memoryDecay,
    })
    throwIfAborted(signal)

    const archive = getPreservedArchive(result.preserveData)
    if (archive === undefined || result.preserveData === undefined) {
      throw new Error('dsh-optical-compaction: OMP returned no preserved archive')
    }
    if (archive.frames.length === 0 && archive.truncatedChars > 0) {
      return this.semanticFallback(
        `visual archive retired every older frame while fitting the ${config.maxFrameDataBytes}-byte payload budget`,
        input,
        agent,
        signal,
      )
    }
    const visible = historyBlocks(archive)
    const opticalTokens = estimateOpticalCheckpointTokens(result.summary, visible, tokenMeter, api)
    const savingsRatio = sourceMultimodalTokens === 0
      ? -Infinity
      : (sourceMultimodalTokens - opticalTokens) / sourceMultimodalTokens
    if (!opticalReducesContext(sourceMultimodalTokens, opticalTokens)) {
      return this.semanticFallback(
        `optical checkpoint does not reduce model context `
          + `(${opticalTokens} estimated tokens >= ${sourceMultimodalTokens} source tokens)`,
        input,
        agent,
        signal,
      )
    }
    this.opticalContext.logger.info(
      `dsh-optical-compaction: optical selected (estimated model context ${opticalTokens} tokens vs `
        + `${sourceMultimodalTokens} source tokens; ${(savingsRatio * 100).toFixed(1)}% reduction; `
        + `${archive.frames.length}/${frameLimit} dynamic frames, ${archive.truncatedChars} chars retired)`,
    )
    const history = await materializeHistoryBlocks(this.opticalContext, visible)
    const preserveData = withoutFramePayloads(result.preserveData)
    const summary: ContentBlock[] = [{ type: 'text', text: result.summary }, ...history]

    this.opticalContext.logger.info(
      `dsh-optical-compaction: ${result.shortSummary ?? `archived ${archive.totalChars} chars`}`,
    )
    return {
      summary,
      rawOutput: [{ type: 'text', text: PRESERVE_PREFIX + JSON.stringify(preserveData) }],
      provider: 'local',
      model: SNAPCOMPACT_MODEL,
    }
  }
}
