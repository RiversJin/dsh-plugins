import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { createCanvas, loadImage } from '@napi-rs/canvas'

/** Independent from the transcript archive, including on semantic fallback. */
export const ORIGINAL_IMAGE_PREVIEWS_PREFIX = 'dsh-optical-original-images-v1\n'
export const ORIGINAL_IMAGE_PREVIEW_MAX_EDGE = 512

export interface OriginalImagePreview {
  readonly messageId: string
  readonly imageIndex: number
  readonly original: ImageAttachmentRef
  readonly preview: ImageAttachmentRef
  readonly originalPath?: string
}

export interface PreparedOriginalImages {
  readonly images: readonly OriginalImagePreview[]
  readonly summary: readonly ContentBlock[]
  readonly rawOutput: readonly ContentBlock[]
  readonly semanticMessages: readonly Message[]
  readonly transcriptMessages: readonly Message[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function imageRef(value: unknown): value is ImageAttachmentRef {
  return record(value) && typeof value.attachmentId === 'string'
    && typeof value.mediaType === 'string' && typeof value.bytes === 'number'
    && typeof value.width === 'number' && value.width > 0
    && typeof value.height === 'number' && value.height > 0
}

export function readOriginalImagePreviews(blocks: readonly ContentBlock[] = []): OriginalImagePreview[] {
  const images: OriginalImagePreview[] = []
  for (const block of blocks) {
    if (block.type !== 'text' || !block.text.startsWith(ORIGINAL_IMAGE_PREVIEWS_PREFIX)) continue
    const parsed: unknown = JSON.parse(block.text.slice(ORIGINAL_IMAGE_PREVIEWS_PREFIX.length))
    if (!record(parsed) || parsed.version !== 1 || !Array.isArray(parsed.images)) {
      throw new Error('dsh-optical-compaction: invalid original-image preview sidecar')
    }
    for (const entry of parsed.images) {
      if (!record(entry) || typeof entry.messageId !== 'string'
        || !Number.isSafeInteger(entry.imageIndex) || (entry.imageIndex as number) < 0
        || !imageRef(entry.original) || !imageRef(entry.preview)
        || (entry.originalPath !== undefined && typeof entry.originalPath !== 'string')) {
        throw new Error('dsh-optical-compaction: invalid original-image preview entry')
      }
      images.push(entry as unknown as OriginalImagePreview)
    }
  }
  return images
}

function originalLabel(image: OriginalImagePreview): string {
  return `[Original image: message ${JSON.stringify(image.messageId)}, image ${image.imageIndex + 1}; `
    + `original ${image.original.width}x${image.original.height}; `
    + `attachment ${image.original.attachmentId}; `
    + (image.originalPath === undefined ? 'host path unavailable' : `original path ${JSON.stringify(image.originalPath)}`)
    + `; preview ${image.preview.width}x${image.preview.height}]`
}

function generatedPage(message: Message, attachment: ImageAttachmentRef): boolean {
  if (isCompactCheckpointSource(message.source)) return true
  const source: unknown = message.source
  return record(source) && Array.isArray(source.compressedImageIds)
    && source.compressedImageIds.includes(attachment.attachmentId)
}

/** Preserve each original occurrence and make one immutable small raster per
 * original attachment. Offloaded is a request projection, so it does not stop
 * us reading the original durable reference here. */
export async function prepareOriginalImages(
  attachments: AttachmentStore,
  messages: readonly Message[],
  summaries: ReadonlyMap<string, readonly ContentBlock[]>,
  signal?: AbortSignal,
): Promise<PreparedOriginalImages> {
  const images: OriginalImagePreview[] = []
  const identities = new Set<string>()
  const byOriginal = new Map<string, OriginalImagePreview>()
  const byPreview = new Map<string, OriginalImagePreview>()
  const include = (image: OriginalImagePreview): void => {
    const identity = JSON.stringify([image.messageId, image.imageIndex, image.original.attachmentId])
    if (!identities.has(identity)) {
      identities.add(identity)
      images.push(image)
    }
    byOriginal.set(image.original.attachmentId, image)
    byPreview.set(image.preview.attachmentId, image)
  }
  for (const message of messages) {
    if (!isCompactCheckpointSource(message.source)) continue
    for (const image of readOriginalImagePreviews(summaries.get(message.source.compactionId))) include(image)
  }

  const semanticMessages: Message[] = []
  const transcriptMessages: Message[] = []
  for (const message of messages) {
    const semantic: ContentBlock[] = []
    const transcript: ContentBlock[] = []
    let imageIndex = 0
    for (const block of message.content) {
      signal?.throwIfAborted()
      if (block.type !== 'image') {
        semantic.push(block)
        transcript.push(block)
        continue
      }
      const index = imageIndex++
      const inherited = byPreview.get(block.attachment.attachmentId)
      if (inherited !== undefined && isCompactCheckpointSource(message.source)) {
        semantic.push({ type: 'image', attachment: inherited.preview })
        transcript.push({ type: 'text', text: originalLabel(inherited) })
        continue
      }
      if (generatedPage(message, block.attachment)) {
        semantic.push(block)
        continue
      }
      const cached = byOriginal.get(block.attachment.attachmentId)
      let preview = cached?.preview
      if (preview === undefined) {
        const stored = await attachments.readImage(block.attachment, signal)
        const decoded = await loadImage(Buffer.from(stored.data))
        signal?.throwIfAborted()
        const scale = Math.min(1, ORIGINAL_IMAGE_PREVIEW_MAX_EDGE / Math.max(decoded.width, decoded.height))
        const canvas = createCanvas(Math.max(1, Math.round(decoded.width * scale)), Math.max(1, Math.round(decoded.height * scale)))
        const graphics = canvas.getContext('2d')
        graphics.imageSmoothingEnabled = true
        graphics.imageSmoothingQuality = 'high'
        graphics.drawImage(decoded, 0, 0, canvas.width, canvas.height)
        const refs = await attachments.saveImages([{
          data: canvas.toBuffer('image/png'),
          mediaType: 'image/png',
          name: 'optical-original-preview.png',
        }])
        preview = refs[0]
        if (preview === undefined || refs.length !== 1) {
          throw new Error('dsh-optical-compaction: original-image preview attachment count mismatch')
        }
      }
      const originalPath = cached?.originalPath ?? attachments.imageHostPath(block.attachment)
      const image: OriginalImagePreview = {
        messageId: message.id,
        imageIndex: index,
        original: block.attachment,
        preview,
        ...(originalPath === undefined ? {} : { originalPath }),
      }
      include(image)
      const label: ContentBlock = { type: 'text', text: originalLabel(image) }
      semantic.push(label, { type: 'image', attachment: preview })
      transcript.push(label)
    }
    semanticMessages.push({ ...message, content: semantic })
    transcriptMessages.push({ ...message, content: transcript })
  }
  const summary: ContentBlock[] = images.flatMap(image => [
    { type: 'text' as const, text: originalLabel(image) },
    { type: 'image' as const, attachment: image.preview },
  ])
  return {
    images,
    summary,
    rawOutput: images.length === 0 ? [] : [{
      type: 'text',
      text: ORIGINAL_IMAGE_PREVIEWS_PREFIX + JSON.stringify({ version: 1, images }),
    }],
    semanticMessages,
    transcriptMessages,
  }
}
