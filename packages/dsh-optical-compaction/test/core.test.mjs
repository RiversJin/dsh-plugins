import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DIM_OFF,
  DIM_ON,
  NEWLINE_GLYPH,
  OpticalCompactionEngine,
  SHAPE_VARIANTS,
  compact,
  createFileOps,
  estimateImageContextTokens,
  frameDataBytes,
  frames,
  geometry,
  getPreservedArchive,
  historyBlocks,
  idealShapeVariant,
  normalize,
  render,
  renderMany,
  resolvePluginConfig,
  resolveShape,
  resolveShapeForText,
  scanRenderability,
  serializeConversation,
  toSnapcompactMessages,
} from '../lib/index.js'
import {
  effectiveFrameLimit,
  informationFrameLimit,
  ompApiForProvider,
  opticalReducesContext,
  withManualToolResultPruning,
} from '../lib/engine.js'

function pricedShape(name, frameSize = 128) {
  return {
    ...SHAPE_VARIANTS[name],
    frameSize,
    frameTokenEstimate: 100,
  }
}

function pngDimensions(base64) {
  const data = Buffer.from(base64, 'base64')
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

test('normalizes whitespace, line breaks, symbols, emoji, ANSI, and CJK like OMP', () => {
  const text = `  A\t  B\n\nC — ✅ 🎉 \u001b[31mred\u001b[0m 中文  `
  const normalized = normalize(text, { shape: pricedShape('8on16-bw') })
  assert.equal(normalized.includes('\u001b'), false)
  assert.equal(normalized.includes(NEWLINE_GLYPH), true)
  assert.match(normalized, /A B/)
  assert.match(normalized, /C - \[OK\]/)
  assert.equal(normalized.includes('🎉'), false)
  assert.match(normalized, /中文/)
  assert.equal(scanRenderability('plain ASCII').isSafe, true)
})

test('resolves OMP provider/model shapes and CJK-heavy Silver fallback', () => {
  assert.equal(ompApiForProvider('kimi-coding'), undefined)
  assert.equal(ompApiForProvider('openai-codex'), 'openai-codex-responses')
  assert.equal(ompApiForProvider('unknown-provider'), undefined)
  assert.equal(resolveShape({ api: 'anthropic-messages', id: 'claude-sonnet-4-6' }).cellWidth, 11)
  assert.equal(resolveShape({ api: 'google-generative-ai', id: 'gemini-3.5-pro' }).frameSize, 2048)
  assert.equal(resolveShape({ api: 'openai-responses', id: 'gpt-5.5' }).imageDetail, 'original')
  assert.deepEqual(idealShapeVariant('claude-opus-4-7'), { variant: '11on16-bw', frameSize: 1932 })
  assert.deepEqual(idealShapeVariant('anthropic/claude-4.7-opus'), { variant: '11on16-bw', frameSize: 1932 })
  assert.equal(resolveShapeForText('中文测试内容中文测试内容', { id: 'kimi-k3' }).font, 'silver')
  assert.equal(resolveShapeForText('mostly ASCII with 中文', { id: 'kimi-k3' }).font, '8x13')
  const mixedShape = resolveShapeForText('中文测试内容中文测试内容', { id: 'kimi-k3' }, '11on16-bw')
  assert.equal(mixedShape.font, '8x13')
  assert.equal(scanRenderability('English reasoning with 中文对话', { shape: mixedShape }).isSafe, true)
  const fusionShape = resolveShapeForText('English reasoning with 中文对话', { id: 'kimi-k3' }, 'hybrid-fusion12-bw')
  assert.equal(fusionShape.font, '8x13')
  assert.equal(fusionShape.wideFont, 'fusion12')
  assert.equal(fusionShape.cellHeight, 12)
})

test('estimates height-aware provider image context tokens', () => {
  assert.equal(estimateImageContextTokens('google-generative-ai', 1568, 100), 1120)
  assert.equal(estimateImageContextTokens('openai-responses', 1568, 1568), 2882)
  assert.equal(estimateImageContextTokens(undefined, 1568, 1568), 3293)
  assert.equal(estimateImageContextTokens(undefined, 1568, 28), 59)
  assert.throws(() => estimateImageContextTokens(undefined, 0, 10), /Invalid image dimensions/)
})

test('keeps optical compaction for every strict context reduction', () => {
  assert.equal(opticalReducesContext(1000, 999), true)
  assert.equal(opticalReducesContext(1000, 1000), false)
  assert.equal(opticalReducesContext(1000, 1001), false)
})

test('caps Kimi dense visual working sets independently of its 1M context window', () => {
  assert.equal(effectiveFrameLimit(80, 20, 'kimi-coding'), 8)
  assert.equal(effectiveFrameLimit(6, 20, 'kimi-coding'), 6)
  assert.equal(effectiveFrameLimit(80, 4, 'kimi-coding'), 4)
  assert.equal(effectiveFrameLimit(80, 20, 'openai'), 20)
  assert.equal(informationFrameLimit(8, 0, 16_000), 1)
  assert.equal(informationFrameLimit(8, 16_001, 16_000), 2)
  assert.equal(informationFrameLimit(8, 114_267, 16_000), 8)
  assert.equal(informationFrameLimit(8, 1_000_000, 16_000), 8)
})

test('manual optical compaction pre-prunes tool results inside the idle maintenance lock', async () => {
  const trace = []
  const session = { id: 'manual-prune-session' }
  let locked = false
  const context = {
    get(name) {
      assert.equal(name, 'toolResultPruner')
      return {
        pruneSession(actualSession) {
          assert.equal(actualSession, session)
          assert.equal(locked, true)
          trace.push('prune')
          return { pruned: [{ originalSeq: 1 }], charsRemoved: 12_345 }
        },
      }
    },
    logger: {
      info(message) {
        assert.match(message, /manual pre-prune trimmed 1 tool results \(12345 chars removed\)/)
        trace.push('log')
      },
    },
    sessions: {
      async flush(actualSession) {
        assert.equal(actualSession, session)
        assert.equal(locked, true)
        trace.push('flush')
      },
    },
  }
  const agent = {
    session,
    runMaintenance(task) {
      assert.equal(locked, false)
      locked = true
      trace.push('lock')
      return task(new AbortController().signal).finally(() => {
        trace.push('unlock')
        locked = false
      })
    },
  }
  const wrapped = withManualToolResultPruning(context, agent, new AbortController().signal)
  const value = await wrapped.runMaintenance(async () => {
    assert.equal(locked, true)
    trace.push('compact')
    return 'done'
  })

  assert.equal(value, 'done')
  assert.deepEqual(trace, ['lock', 'prune', 'log', 'flush', 'compact', 'unlock'])
  assert.equal(locked, false)
})

test('manual optical compaction leaves the agent untouched without a pruner service', () => {
  const agent = { session: {} }
  const context = { get() { return undefined } }
  assert.equal(withManualToolResultPruning(context, agent, new AbortController().signal), agent)
})

test('native OMP renderer emits height-hugging PNG and renderMany agrees with frames()', async () => {
  const shape = pricedShape('8x8u-bw', 128)
  assert.deepEqual(geometry(shape), { cols: 16, rows: 16, capacity: 256 })
  const one = await render('hello', shape)
  const dimensions = pngDimensions(one.data)
  assert.equal(dimensions.width, 128)
  assert.ok(dimensions.height > 0 && dimensions.height <= 128)

  const text = 'word '.repeat(180)
  const expected = frames(text, { shape })
  const images = await renderMany(text, { shape })
  assert.equal(images.length, expected)
  assert.ok(images.every(image => image.mimeType === 'image/png'))
})

test('hybrid Fusion shape preserves Latin pixels and replaces only wide glyph cells', async () => {
  const hybrid = pricedShape('hybrid-fusion12-bw', 128)
  const silverFallback = { ...hybrid, wideFont: undefined }

  const hybridLatin = await render('English 126524', hybrid)
  const baselineLatin = await render('English 126524', silverFallback)
  assert.equal(hybridLatin.data, baselineLatin.data)

  const hybridMixed = await render('English 中文测试', hybrid)
  const baselineMixed = await render('English 中文测试', silverFallback)
  assert.notEqual(hybridMixed.data, baselineMixed.data)
  assert.deepEqual(pngDimensions(hybridMixed.data), pngDimensions(baselineMixed.data))
})

test('renders persisted newline markers as return arrows instead of solid black cells', async () => {
  const shape = pricedShape('11on16-bw', 128)
  const archived = await render(`a${NEWLINE_GLYPH}b`, shape)
  const lightweight = await render('a↵b', shape)

  assert.equal(archived.data, lightweight.data)
})

test('serializes roles and merges paired tool output with OMP caps and dim markers', () => {
  const serialized = serializeConversation([
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'reason first' },
        { type: 'toolCall', id: 'call-1', name: 'read_file', arguments: { path: '/tmp/a', body: 'x'.repeat(100) } },
        { type: 'text', text: 'done' },
      ],
    },
    { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'A'.repeat(200) }] },
  ], { toolArgMaxChars: 40, toolResultMaxChars: 60 })

  assert.match(serialized, /¶user:hello/)
  assert.match(serialized, /¶think:reason first/)
  assert.match(serialized, /¶call:read_file\(/)
  assert.match(serialized, /<out>/)
  assert.match(serialized, /ch elided/)
  assert.equal(serialized.includes(DIM_ON), true)
  assert.equal(serialized.includes(DIM_OFF), true)
})

test('elides complete and truncated data URLs before archival', () => {
  const payload = Buffer.from('image bytes').toString('base64')
  const serialized = serializeConversation([
    {
      role: 'toolResult',
      toolCallId: 'call-image',
      content: [{ type: 'text', text: `![x](data:image/png;base64,${payload})` }],
    },
  ])
  assert.equal(serialized.includes(payload), false)
  assert.match(serialized, /\[data URL omitted: image\/png, \d+ base64 chars\]/)
})

test('compact keeps text edges, images the middle, and unfolds its prior source', async () => {
  const shape = pricedShape('8x8u-bw', 128)
  const first = await compact({
    firstKeptEntryId: 'kept-1',
    messagesToSummarize: [{ role: 'user', content: 'old ' + 'alpha '.repeat(900) }],
    turnPrefixMessages: [],
    tokensBefore: 2000,
    fileOps: createFileOps(),
  }, { shape, maxFrames: 3 })
  const firstArchive = getPreservedArchive(first.preserveData)
  assert.ok(firstArchive)
  assert.equal(firstArchive.informationTokens, 2000)
  assert.equal(firstArchive.frames.length, 3)
  assert.ok(firstArchive.textHead)
  assert.ok(firstArchive.textTail)
  assert.match(first.summary, /Resume prior conversation/)

  const blocks = historyBlocks(firstArchive)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks.at(-1).type, 'text')
  assert.equal(blocks.filter(block => block.type === 'image').length, 3)

  const second = await compact({
    firstKeptEntryId: 'kept-2',
    messagesToSummarize: [{ role: 'user', content: 'new beta marker' }],
    turnPrefixMessages: [],
    tokensBefore: 100,
    previousPreserveData: first.preserveData,
    fileOps: createFileOps(),
  }, { shape, maxFrames: 3 })
  const secondArchive = getPreservedArchive(second.preserveData)
  assert.equal(secondArchive?.informationTokens, 2000)
  assert.ok(secondArchive?.text?.includes('alpha'))
  assert.ok(secondArchive?.text?.includes('new beta marker'))
})

test('12-hour sliding window lowers resolution without a blur filter and rerenders as history ages', async () => {
  const hour = 60 * 60 * 1000
  const period = 12 * hour
  const now = 2_000_000_000_000
  const shape = pricedShape('8on22-bw', 256)
  const timestamped = [
    { timestamp: now - 97 * hour, marker: 'floor-marker', fill: 'floor ' },
    { timestamp: now - 37 * hour, marker: 'oldest-marker', fill: 'old ' },
    { timestamp: now - 25 * hour, marker: 'older-marker', fill: 'older ' },
    { timestamp: now - 13 * hour, marker: 'middle-marker', fill: 'middle ' },
    { timestamp: now - 1 * hour, marker: 'recent-marker', fill: 'recent ' },
  ].map(({ timestamp, marker, fill }) => ({
    role: 'user',
    timestamp,
    content: `${marker} ${fill.repeat(700)} ${marker}`,
  }))
  const decay = { enabled: true, periodMs: period, scalePerPeriod: 0.9, minScale: 0.5, now }
  const first = await compact({
    firstKeptEntryId: 'decay-first',
    messagesToSummarize: timestamped,
    turnPrefixMessages: [],
    tokensBefore: 20_000,
    fileOps: createFileOps(),
  }, { shape, maxFrames: 80, memoryDecay: decay })
  const firstArchive = getPreservedArchive(first.preserveData)
  assert.ok(firstArchive?.segments?.length >= 5)
  const ages = [...new Set(firstArchive.frames.map(frame => frame.memoryAgePeriods))]
  assert.deepEqual(ages, [8, 3, 2, 1])
  const widths = new Map()
  for (const frame of firstArchive.frames) {
    if (!widths.has(frame.memoryAgePeriods)) widths.set(frame.memoryAgePeriods, pngDimensions(frame.data).width)
  }
  assert.equal(widths.get(1), 243)
  assert.equal(widths.get(2), 230)
  assert.equal(widths.get(3), 219)
  assert.equal(widths.get(8), 181)
  assert.equal(firstArchive.frames.some(frame => frame.memoryAgePeriods === 0), false)
  assert.match(firstArchive.textTail ?? '', /recent-marker/)

  const bounded = await compact({
    firstKeptEntryId: 'decay-bounded',
    messagesToSummarize: timestamped,
    turnPrefixMessages: [],
    tokensBefore: 20_000,
    fileOps: createFileOps(),
  }, { shape, maxFrames: 5, memoryDecay: decay })
  const boundedArchive = getPreservedArchive(bounded.preserveData)
  assert.equal(boundedArchive?.frames.length, 5)
  assert.deepEqual(
    [...new Set(boundedArchive?.frames.map(frame => frame.memoryAgePeriods))],
    [8, 3, 2, 1],
  )
  assert.equal(boundedArchive?.frames.filter(frame => frame.memoryAgePeriods === 1).length, 2)
  assert.ok((boundedArchive?.truncatedChars ?? 0) > 0)

  const oldestBucket = Math.floor((now - 37 * hour) / period) * period
  const firstOldFrame = firstArchive.frames.find(frame => frame.memoryBucketStart === oldestBucket)
  assert.ok(firstOldFrame)
  const laterNow = now + period
  const second = await compact({
    firstKeptEntryId: 'decay-second',
    messagesToSummarize: [{
      role: 'user',
      timestamp: laterNow,
      content: `newest-marker ${'new '.repeat(700)} newest-marker`,
    }],
    turnPrefixMessages: [],
    tokensBefore: 24_000,
    previousPreserveData: first.preserveData,
    fileOps: createFileOps(),
  }, { shape, maxFrames: 80, memoryDecay: { ...decay, now: laterNow } })
  const secondArchive = getPreservedArchive(second.preserveData)
  const secondOldFrame = secondArchive?.frames.find(frame => frame.memoryBucketStart === oldestBucket)
  assert.ok(secondOldFrame)
  assert.equal(secondOldFrame.memoryAgePeriods, (firstOldFrame.memoryAgePeriods ?? 0) + 1)
  assert.ok(pngDimensions(secondOldFrame.data).width < pngDimensions(firstOldFrame.data).width)
  assert.ok(secondArchive?.text?.includes('newest-marker'))
})

test('payload fitting retires one oldest visual prefix and keeps recent text verbatim', async () => {
  const hour = 60 * 60 * 1000
  const period = 12 * hour
  const now = 2_000_000_000_000
  const shape = pricedShape('8on22-bw', 256)
  const messages = [
    { role: 'user', timestamp: now - 73 * hour, content: `retire-first ${'first '.repeat(1200)}` },
    { role: 'user', timestamp: now - 49 * hour, content: `retire-second ${'second '.repeat(1200)}` },
    { role: 'user', timestamp: now - 25 * hour, content: `keep-visual ${'visual '.repeat(1200)} keep-visual` },
    { role: 'user', timestamp: now - 1 * hour, content: `keep-recent ${'recent '.repeat(1200)}` },
  ]
  const decay = { enabled: true, periodMs: period, scalePerPeriod: 0.9, minScale: 0.5, now }
  const unbounded = await compact({
    firstKeptEntryId: 'payload-probe',
    messagesToSummarize: messages,
    turnPrefixMessages: [],
    tokensBefore: 20_000,
    fileOps: createFileOps(),
  }, { shape, maxFrames: 80, memoryDecay: decay })
  const unboundedArchive = getPreservedArchive(unbounded.preserveData)
  assert.ok((unboundedArchive?.frames.length ?? 0) >= 3)
  const newestFrameBytes = unboundedArchive.frames.at(-1).data.length

  const bounded = await compact({
    firstKeptEntryId: 'payload-bounded',
    messagesToSummarize: messages,
    turnPrefixMessages: [],
    tokensBefore: 20_000,
    fileOps: createFileOps(),
  }, { shape, maxFrames: 80, maxFrameDataBytes: newestFrameBytes, memoryDecay: decay })
  const archive = getPreservedArchive(bounded.preserveData)
  assert.ok(archive)
  assert.equal(archive.frames.length, 1)
  assert.ok(frameDataBytes(archive.frames) <= newestFrameBytes)
  assert.doesNotMatch(archive.text ?? '', /retire-first|retire-second/)
  assert.match(archive.text ?? '', /keep-visual/)
  assert.match(archive.textTail ?? '', /keep-recent/)
  assert.ok(archive.truncatedChars > 0)
  assert.equal(historyBlocks(archive).filter(block => block.type === 'image').length, 1)
})

test('information volume shares pages without flattening time-derived resolution', async () => {
  const hour = 60 * 60 * 1000
  const period = 12 * hour
  const now = 2_000_000_000_000
  const shape = pricedShape('8on22-bw', 256)
  const decay = { enabled: true, periodMs: period, scalePerPeriod: 0.9, minScale: 0.5, now }

  const sparse = await compact({
    firstKeptEntryId: 'volume-sparse',
    messagesToSummarize: [{
      role: 'user',
      timestamp: now - 13 * hour,
      content: `sparse-marker ${'sparse '.repeat(100)} sparse-marker`,
    }],
    turnPrefixMessages: [],
    tokensBefore: 4_000,
    fileOps: createFileOps(),
  }, { shape, maxFrames: 8, memoryDecay: decay })
  const sparseArchive = getPreservedArchive(sparse.preserveData)
  assert.ok(sparseArchive?.frames.length)
  assert.equal(sparseArchive.frames[0].resolutionScale, 0.9)

  const weighted = await compact({
    firstKeptEntryId: 'volume-weighted',
    messagesToSummarize: [
      {
        role: 'user',
        timestamp: now - 49 * hour,
        content: `tiny-old-marker ${'tiny '.repeat(20)} tiny-old-marker`,
      },
      {
        role: 'user',
        timestamp: now - 25 * hour,
        content: `dense-marker ${'dense '.repeat(6000)} ${'dense-marker '.repeat(20)}`,
      },
      {
        role: 'user',
        timestamp: now - 13 * hour,
        content: `near-marker ${'near '.repeat(1000)} near-marker`,
      },
    ],
    turnPrefixMessages: [],
    tokensBefore: 40_000,
    fileOps: createFileOps(),
  }, { shape, maxFrames: 3, memoryDecay: decay })
  const archive = getPreservedArchive(weighted.preserveData)
  assert.equal(archive?.frames.length, 3)
  assert.equal(archive.frames.filter(frame => frame.memoryAgePeriods === 2).length, 2)
  assert.equal(archive.frames.filter(frame => frame.memoryAgePeriods === 1).length, 1)
  assert.deepEqual(
    [...new Set(archive.frames.map(frame => frame.resolutionScale))],
    [0.81, 0.9],
  )
  assert.doesNotMatch(archive.text ?? '', /tiny-old-marker/)
  assert.match(archive.text ?? '', /dense-marker/)
  assert.match(archive.text ?? '', /near-marker/)
})

test('maps DSH blocks to OMP serialization vocabulary', () => {
  const mapped = toSnapcompactMessages([
    { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
    {
      id: 'a',
      role: 'assistant',
      source: { kind: 'model', provider: 'p', model: 'm' },
      content: [
        { type: 'reasoning', text: 'think' },
        { type: 'tool-call', id: 'c', name: 'read', arguments: '{"path":"a"}' },
      ],
    },
    {
      id: 't',
      role: 'user',
      source: { kind: 'tool', callId: 'c' },
      content: [{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: 'ok' }] }],
    },
  ])
  assert.deepEqual(mapped[0], { role: 'user', content: [{ type: 'text', text: 'hello' }] })
  assert.equal(mapped[1].content[0].type, 'thinking')
  assert.deepEqual(mapped[1].content[1].arguments, { path: 'a' })
  assert.equal(mapped[2].role, 'toolResult')

  const timed = toSnapcompactMessages([{
    id: 'timed',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'clocked' }],
  }], new Map([['timed', 123456]]))
  assert.equal(timed[0].timestamp, 123456)
})

test('resolves OMP defaults and rejects an unknown shape or half fallback route', () => {
  const resolved = resolvePluginConfig({})
  assert.equal(resolved.optical.shape, 'auto')
  assert.equal(resolved.optical.maxFrames, 80)
  assert.equal(resolved.optical.toolResultMaxChars, 2000)
  assert.equal(resolved.optical.memoryDecay.enabled, true)
  assert.equal(resolved.optical.memoryDecay.periodMs, 12 * 60 * 60 * 1000)
  assert.equal(resolved.optical.memoryDecay.scalePerPeriod, 0.9)
  assert.equal(resolved.optical.memoryDecay.minScale, 0.5)
  assert.equal(resolved.optical.memoryDecay.informationTokensPerFrame, 16_000)
  assert.throws(() => resolvePluginConfig({ optical: { shape: 'not-an-omp-shape' } }), /unsupported OMP shape/)
  assert.throws(
    () => resolvePluginConfig({ summarizationProvider: 'only-provider' }),
    /must be set together/,
  )
})

test('DSH summarize hook saves OMP frames and persists re-render source in rawOutput', async () => {
  const saved = []
  const context = {
    logger: { info() {}, warn() {} },
    llm: {
      async resolveModelInfo(provider, id) {
        return { provider, id, name: id, inputModalities: ['text', 'image'] }
      },
    },
    tokenMeter: {
      estimateMessage(message) {
        return message.source.kind === 'plugin' ? 100 : 100_000
      },
    },
    attachments: {
      imageLimits: { maxImagesPerMessage: 4 },
      async saveImages(inputs) {
        saved.push(...inputs)
        return inputs.map((input, index) => ({
          id: `attachment-${index}`,
          mediaType: input.mediaType,
          width: 1568,
          height: 1568,
          byteLength: input.data.length,
          sha256: `sha-${index}`,
          ...(input.name === undefined ? {} : { name: input.name }),
        }))
      },
    },
  }
  const config = resolvePluginConfig({ optical: { maxFrames: 4, memoryDecay: { enabled: false } } })
  const engine = Object.create(OpticalCompactionEngine.prototype)
  engine.opticalContext = context
  engine.pluginConfig = config
  const agent = {
    options: {},
    session: {
      id: 'session-test',
      events: [],
      requestHeader() { return { config: { provider: 'kimi-coding', model: 'kimi-k3' } } },
    },
  }
  const input = {
    messages: [{
      id: 'message-long',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'alpha '.repeat(15_000) }],
    }],
  }

  const result = await engine.summarize(input, agent)
  assert.equal(result.provider, 'local')
  assert.equal(result.model, 'dsh-optical-compaction/omp-snapcompact-18.0.10')
  assert.ok(saved.length > 0)
  assert.equal(result.summary.some(block => block.type === 'image'), true)
  assert.match(result.rawOutput[0].text, /^dsh-snapcompact-preserve-v1\n/)
  const preserved = JSON.parse(result.rawOutput[0].text.split('\n').slice(1).join('\n'))
  const archive = getPreservedArchive(preserved)
  assert.ok(archive?.text?.includes('alpha'))
  assert.equal(archive?.frames.length, 0)
})

test('hybrid estimate counts source images with the same context-token rule', async () => {
  let saved = 0
  const context = {
    logger: { info() {}, warn() {} },
    llm: {
      async resolveModelInfo(provider, id) {
        return { provider, id, name: id, inputModalities: ['text', 'image'] }
      },
    },
    tokenMeter: {
      estimateMessage(message) {
        return message.source.kind === 'plugin' ? 100 : 10
      },
    },
    attachments: {
      imageLimits: { maxImagesPerMessage: 1 },
      async saveImages(inputs) {
        saved += inputs.length
        return inputs.map((input, index) => ({
          attachmentId: `sha256:hybrid-${index}`,
          mediaType: input.mediaType,
          bytes: input.data.length,
          width: 1568,
          height: 1568,
        }))
      },
    },
  }
  const engine = Object.create(OpticalCompactionEngine.prototype)
  engine.opticalContext = context
  engine.pluginConfig = resolvePluginConfig({ optical: { maxFrames: 1, memoryDecay: { enabled: false } } })
  const agent = {
    options: {},
    session: {
      id: 'session-source-image',
      events: [],
      requestHeader() { return { config: { provider: 'kimi-coding', model: 'kimi-k3' } } },
    },
  }
  const input = {
    messages: [{
      id: 'message-source-image',
      role: 'user',
      source: { kind: 'user' },
      content: [
        { type: 'text', text: 'alpha '.repeat(15_000) },
        {
          type: 'image',
          attachment: {
            attachmentId: 'sha256:source-image',
            mediaType: 'image/png',
            bytes: 1_000_000,
            width: 4096,
            height: 4096,
          },
        },
      ],
    }],
  }

  const result = await engine.summarize(input, agent)
  assert.equal(result.provider, 'local')
  assert.equal(saved, 1)
})

test('DSH summarize hook falls back when optical no longer reduces model context', async () => {
  const calls = []
  let saveCalls = 0
  const context = {
    logger: { info() {}, warn() {} },
    llm: {
      async resolveModelInfo(provider, id) {
        return { provider, id, name: id, inputModalities: ['text', 'image'] }
      },
      async *stream(options) {
        calls.push(options)
        const text = 'semantic checkpoint'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    tokenMeter: {
      estimateMessage(message) {
        return message.source.kind === 'plugin' ? 10 : 1_000
      },
    },
    attachments: {
      imageLimits: { maxImagesPerMessage: 4 },
      async saveImages() {
        saveCalls += 1
        return []
      },
    },
  }
  const config = resolvePluginConfig({
    summarizationProvider: 'summary-provider',
    summarizationModel: 'summary-model',
    optical: { maxFrames: 4, memoryDecay: { enabled: false } },
  })
  const engine = Object.create(OpticalCompactionEngine.prototype)
  engine.opticalContext = context
  engine.pluginConfig = config
  const agent = {
    options: {},
    session: {
      id: 'session-fallback',
      events: [],
      requestHeader() { return { config: { provider: 'kimi-coding', model: 'kimi-k3' } } },
    },
  }
  const input = {
    messages: [{
      id: 'message-expensive-optical',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'alpha '.repeat(15_000) }],
    }],
  }

  const result = await engine.summarize(input, agent)
  assert.equal(result.provider, 'summary-provider')
  assert.equal(result.model, 'summary-model')
  assert.deepEqual(result.summary, [{ type: 'text', text: 'semantic checkpoint' }])
  assert.equal(calls.length, 1)
  assert.equal(saveCalls, 0)
})
