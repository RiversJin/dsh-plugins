import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import {
  OpticalCompactionEngine,
  ORIGINAL_IMAGE_PREVIEWS_PREFIX,
  prepareOriginalImages,
  readOriginalImagePreviews,
  resolvePluginConfig,
  toSnapcompactMessages,
} from '../lib/index.js'

function attachmentFixture() {
  const originals = new Map()
  const stored = new Map()
  const saved = []
  const read = []
  const refFor = (data, width, height, name) => ({
    attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`,
    mediaType: 'image/png', bytes: data.length, width, height, name,
  })
  const source = (width, height, color) => {
    const canvas = createCanvas(width, height)
    const graphics = canvas.getContext('2d')
    graphics.fillStyle = color
    graphics.fillRect(0, 0, width, height)
    const data = canvas.toBuffer('image/png')
    const ref = refFor(data, width, height, 'original.png')
    originals.set(ref.attachmentId, data)
    stored.set(ref.attachmentId, data)
    return ref
  }
  const attachments = {
    imageLimits: { maxImagesPerMessage: 20 },
    async readImage(ref) {
      read.push(ref.attachmentId)
      return { ref, data: stored.get(ref.attachmentId) }
    },
    imageHostPath(ref) { return `/attachments/${ref.attachmentId.slice(7)}.png` },
    async saveImages(inputs) {
      saved.push(inputs)
      return Promise.all(inputs.map(async input => {
        const decoded = await loadImage(input.data)
        const ref = refFor(input.data, decoded.width, decoded.height, input.name)
        stored.set(ref.attachmentId, Buffer.from(input.data))
        return ref
      }))
    },
  }
  return { source, attachments, originals, stored, saved, read }
}

test('original image previews preserve occurrence, position, host path and immutable source bytes', async () => {
  const fixture = attachmentFixture()
  const wide = fixture.source(1600, 800, '#3085c0')
  const small = fixture.source(240, 360, '#c08530')
  const sourceHashes = [...fixture.originals].map(([id, data]) => [id, createHash('sha256').update(data).digest('hex')])
  const messages = [{
    id: 'source-message', role: 'user', source: { kind: 'user' },
    content: [
      { type: 'text', text: 'before wide image' },
      { type: 'image', attachment: wide, offloaded: true },
      { type: 'text', text: 'between images' },
      { type: 'image', attachment: small },
      { type: 'text', text: 'after small image' },
    ],
  }]
  const prepared = await prepareOriginalImages(fixture.attachments, messages, new Map())
  assert.equal(prepared.images.length, 2)
  assert.deepEqual(prepared.images.map(image => [image.messageId, image.imageIndex]), [['source-message', 0], ['source-message', 1]])
  assert.deepEqual(prepared.images.map(image => [image.preview.width, image.preview.height]), [[512, 256], [240, 360]])
  assert.deepEqual(prepared.images.map(image => image.original), [wide, small])
  assert.equal(prepared.images[0].originalPath, fixture.attachments.imageHostPath(wide))
  assert.ok(fixture.saved.every(batch => batch.length === 1))
  assert.equal(messages[0].content[1].offloaded, true)
  assert.equal(prepared.semanticMessages[0].content[2].offloaded, undefined)
  assert.equal(prepared.semanticMessages[0].content[2].attachment.attachmentId, prepared.images[0].preview.attachmentId)
  const transcript = toSnapcompactMessages(prepared.transcriptMessages)[0].content
  assert.equal(transcript[0].text, 'before wide image')
  assert.ok(transcript[1].text.includes(fixture.attachments.imageHostPath(wide)))
  assert.equal(transcript[2].text, 'between images')
  assert.ok(transcript[3].text.includes(fixture.attachments.imageHostPath(small)))
  assert.equal(transcript[4].text, 'after small image')
  assert.deepEqual(readOriginalImagePreviews(prepared.rawOutput), prepared.images)
  assert.ok(prepared.rawOutput[0].text.startsWith(ORIGINAL_IMAGE_PREVIEWS_PREFIX))
  assert.deepEqual([...fixture.originals].map(([id, data]) => [id, createHash('sha256').update(data).digest('hex')]), sourceHashes)

  const frame = fixture.source(1568, 1568, '#ffffff')
  const checkpoint = {
    id: 'checkpoint-message', role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'compact-one' },
    content: [
      { type: 'text', text: 'checkpoint' },
      { type: 'image', attachment: { ...frame, name: 'snapcompact-frame-001.png' } },
      ...prepared.summary.map(block => block.type === 'image' ? { ...block, offloaded: true } : block),
    ],
  }
  const savedBefore = fixture.saved.length
  const readBefore = fixture.read.length
  const inherited = await prepareOriginalImages(fixture.attachments, [checkpoint], new Map([['compact-one', prepared.rawOutput]]))
  assert.deepEqual(inherited.images, prepared.images)
  assert.equal(fixture.saved.length, savedBefore)
  assert.equal(fixture.read.length, readBefore)
  assert.deepEqual(inherited.summary, prepared.summary)
  assert.deepEqual(readOriginalImagePreviews(inherited.rawOutput), prepared.images)
})

test('semantic compaction sees original previews and carries their sidecar into the next checkpoint', async () => {
  const fixture = attachmentFixture()
  const original = fixture.source(2000, 1200, '#90ab30')
  const requests = []
  const engine = Object.create(OpticalCompactionEngine.prototype)
  engine.pluginConfig = resolvePluginConfig({ optical: { enabled: false } })
  engine.opticalContext = {
    attachments: fixture.attachments,
    logger: { warn() {}, info() {} },
    sessions: { flush: async () => true },
    sessionPersistence: { open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }) },
    llm: {
      async *stream(request) {
        requests.push(request)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'The user shared an image.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'The user shared an image.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const result = await engine.summarize({ messages: [{
    id: 'semantic-original', role: 'user', source: { kind: 'user' },
    content: [{ type: 'image', attachment: original, offloaded: true }],
  }] }, {
    options: {}, session: { id: 'semantic-session', seq: 0, requestHeader: () => ({ config: { provider: 'kimi-coding', model: 'k3' } }) },
  })
  const [image] = readOriginalImagePreviews(result.rawOutput)
  assert.deepEqual(image.original, original)
  assert.equal(image.preview.width, 512)
  assert.equal(image.preview.height, 307)
  const requestImage = requests[0].messages[0].content.find(block => block.type === 'image')
  assert.deepEqual(requestImage, { type: 'image', attachment: image.preview })
  assert.deepEqual(result.summary.find(block => block.type === 'image'), requestImage)
  assert.equal(result.llmStreamCall, true)
})
