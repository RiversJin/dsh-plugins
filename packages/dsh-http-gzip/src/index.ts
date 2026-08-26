import type { Context } from '@deepseek-ai/cordis'
import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http'
import { Server as HttpServer } from 'node:http'
import {
  brotliCompress,
  constants,
  gzip,
  zstdCompress,
} from 'node:zlib'
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'dsh-http-gzip'
export const inject = ['webServer']

const MIN_BYTES = 1024
const MAX_BUFFER_BYTES = 1024 * 1024 * 1024

type ContentEncoding = 'br' | 'zstd' | 'gzip'
type CompressionCallback = (error: Error | null, output: Buffer) => void
type ResponseCallback = (error?: Error | null) => void
type ResponseWrite = (
  chunk: unknown,
  encodingOrCallback?: BufferEncoding | ResponseCallback,
  callback?: ResponseCallback,
) => boolean
type ResponseEnd = (
  chunkOrCallback?: unknown | ResponseCallback,
  encodingOrCallback?: BufferEncoding | ResponseCallback,
  callback?: ResponseCallback,
) => ServerResponse
type ResponseWriteHead = (
  statusCode: number,
  statusMessageOrHeaders?: string | OutgoingHttpHeaders | readonly string[],
  maybeHeaders?: OutgoingHttpHeaders | readonly string[],
) => ServerResponse

interface Encoding {
  name: ContentEncoding
  compress: (body: Buffer, callback: CompressionCallback) => void
}

interface NegotiatedEncoding extends Encoding {
  priority: number
  quality: number
}

const COMPRESSIBLE_APPLICATION_TYPES = [
  'application/ecmascript',
  'application/graphql',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/manifest+json',
  'application/sql',
  'application/toml',
  'application/wasm',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-toml',
  'application/x-yaml',
  'application/xhtml+xml',
  'application/xml',
  'application/yaml',
  'font/otf',
  'font/ttf',
  'image/svg+xml',
]

const ENCODINGS: readonly Encoding[] = [
  {
    name: 'br',
    compress: (body, callback) => brotliCompress(body, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 6,
      },
    }, callback),
  },
  {
    name: 'zstd',
    compress: (body, callback) => zstdCompress(body, {
      params: {
        [constants.ZSTD_c_compressionLevel]: 3,
      },
    }, callback),
  },
  {
    name: 'gzip',
    compress: (body, callback) => gzip(body, { level: 6 }, callback),
  },
]

export function acceptedEncodings(value: string | string[] | undefined): NegotiatedEncoding[] {
  if (typeof value !== 'string') return []

  const qualities = new Map()
  for (const part of value.split(',')) {
    const [rawName, ...parameters] = part.trim().split(';')
    const name = rawName?.trim().toLowerCase()
    if (!name) continue

    let quality = 1
    const qualityParameter = parameters
      .map((parameter) => parameter.trim().match(/^q\s*=\s*(\d*(?:\.\d+)?)$/i))
      .find(Boolean)
    if (qualityParameter?.[1] !== undefined) quality = Number(qualityParameter[1])
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) quality = 0
    qualities.set(name, Math.max(qualities.get(name) ?? 0, quality))
  }

  const wildcardQuality = qualities.get('*') ?? 0
  return ENCODINGS
    .map((encoding, priority) => ({
      ...encoding,
      priority,
      quality: qualities.get(encoding.name) ?? wildcardQuality,
    }))
    .filter((encoding) => encoding.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.priority - right.priority)
}

function compressWithFallback(
  body: Buffer,
  encodings: readonly NegotiatedEncoding[],
  callback: (contentEncoding: ContentEncoding | null, output: Buffer) => void,
  index = 0,
): void {
  const encoding = encodings[index]
  if (!encoding) {
    callback(null, body)
    return
  }

  encoding.compress(body, (error, compressed) => {
    if (error || compressed.length >= body.length) {
      compressWithFallback(body, encodings, callback, index + 1)
      return
    }
    callback(encoding.name, compressed)
  })
}

function toBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  return Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined)
}

function appendVary(res: ServerResponse, value: string): void {
  const current = res.getHeader('vary')
  const values = Array.isArray(current)
    ? current.flatMap((item) => String(item).split(','))
    : current == null
      ? []
      : String(current).split(',')

  if (values.some((item) => item.trim() === '*')) return
  if (!values.some((item) => item.trim().toLowerCase() === value.toLowerCase())) {
    values.push(value)
  }
  res.setHeader('Vary', values.map((item) => item.trim()).filter(Boolean).join(', '))
}

export function contentTypeIsCompressible(value: unknown): boolean {
  const contentType = (String(value ?? '').split(';', 1)[0] ?? '').trim().toLowerCase()
  if (!contentType || contentType === 'text/event-stream') return false
  if (contentType.startsWith('text/')) return true
  if (contentType.endsWith('+json') || contentType.endsWith('+xml')) return true
  return COMPRESSIBLE_APPLICATION_TYPES.includes(contentType)
}

function responseMustBypass(res: ServerResponse): boolean {
  const status = res.statusCode
  if (status < 200 || status === 204 || status === 205 || status === 206 || status === 304) {
    return true
  }
  if (res.hasHeader('content-encoding') || res.hasHeader('content-range')) return true

  const cacheControl = String(res.getHeader('cache-control') ?? '').toLowerCase()
  if (cacheControl.split(',').some((item) => item.trim() === 'no-transform')) return true

  const contentType = res.getHeader('content-type')
  return contentType != null && !contentTypeIsCompressible(contentType)
}

function weakenEtag(res: ServerResponse): void {
  const etag = res.getHeader('etag')
  if (typeof etag === 'string' && etag.length > 0 && !etag.startsWith('W/')) {
    res.setHeader('ETag', `W/${etag}`)
  }
}

function applyDeferredHead(
  res: ServerResponse,
  statusCode: number,
  statusMessageOrHeaders?: string | OutgoingHttpHeaders | readonly string[],
  maybeHeaders?: OutgoingHttpHeaders | readonly string[],
): void {
  res.statusCode = statusCode

  let headers = statusMessageOrHeaders
  if (typeof statusMessageOrHeaders === 'string') {
    res.statusMessage = statusMessageOrHeaders
    headers = maybeHeaders
  }

  if (Array.isArray(headers)) {
    for (let index = 0; index + 1 < headers.length; index += 2) {
      const key = headers[index]
      const value = headers[index + 1]
      if (key !== undefined && value !== undefined) res.setHeader(key, value)
    }
  } else if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) res.setHeader(key, value)
    }
  }
}

function bufferResponse(res: ServerResponse, encodings: readonly NegotiatedEncoding[]): void {
  const originalWrite = res.write.bind(res) as ResponseWrite
  const originalEnd = res.end.bind(res) as ResponseEnd
  const originalWriteHead = res.writeHead.bind(res) as ResponseWriteHead
  const originalFlushHeaders = res.flushHeaders.bind(res)
  const chunks: Buffer[] = []
  const writeCallbacks: ResponseCallback[] = []
  let bufferedBytes = 0
  let released = false
  let ending = false

  const restore = () => {
    res.write = originalWrite as typeof res.write
    res.end = originalEnd as typeof res.end
    res.writeHead = originalWriteHead as typeof res.writeHead
    res.flushHeaders = originalFlushHeaders
  }

  const flushWriteCallbacks = () => {
    const callbacks = writeCallbacks.splice(0)
    for (const callback of callbacks) callback()
  }

  const releaseUncompressed = () => {
    if (released) return
    released = true
    restore()
    if (chunks.length > 0) originalWrite(Buffer.concat(chunks), flushWriteCallbacks)
    else flushWriteCallbacks()
  }

  const deferredWriteHead: ResponseWriteHead = function deferredWriteHead(
    statusCode,
    statusMessageOrHeaders,
    maybeHeaders,
  ) {
    applyDeferredHead(res, statusCode, statusMessageOrHeaders, maybeHeaders)
    if (responseMustBypass(res)) {
      releaseUncompressed()
      if (!res.headersSent) return originalWriteHead(res.statusCode, res.statusMessage)
    }
    return res
  }
  res.writeHead = deferredWriteHead as typeof res.writeHead

  const bufferedWrite: ResponseWrite = function bufferedWrite(chunk, encodingOrCallback, callback) {
    if (released) return originalWrite(chunk, encodingOrCallback, callback)

    let encoding: BufferEncoding | undefined
    if (typeof encodingOrCallback === 'function') {
      callback = encodingOrCallback
    } else {
      encoding = encodingOrCallback
    }
    if (chunk != null) {
      const buffered = toBuffer(chunk, encoding)
      chunks.push(buffered)
      bufferedBytes += buffered.length
    }
    if (typeof callback === 'function') writeCallbacks.push(callback)
    if (bufferedBytes > MAX_BUFFER_BYTES) releaseUncompressed()
    return true
  }
  res.write = bufferedWrite as typeof res.write

  res.flushHeaders = function uncompressedFlushHeaders() {
    releaseUncompressed()
    if (!res.headersSent) return originalFlushHeaders()
  }

  const bufferedEnd: ResponseEnd = function bufferedEnd(chunkOrCallback, encodingOrCallback, callback) {
    if (released) return originalEnd(chunkOrCallback, encodingOrCallback, callback)
    if (ending) return res
    ending = true

    let chunk = chunkOrCallback
    let encoding: BufferEncoding | undefined
    if (typeof chunkOrCallback === 'function') {
      callback = () => chunkOrCallback()
      chunk = undefined
    } else if (typeof encodingOrCallback === 'function') {
      callback = encodingOrCallback
    } else {
      encoding = encodingOrCallback
    }
    if (chunk != null) {
      const buffered = toBuffer(chunk, encoding)
      chunks.push(buffered)
      bufferedBytes += buffered.length
    }

    const body = Buffer.concat(chunks)
    const shouldCompress = !responseMustBypass(res)
      && body.length >= MIN_BYTES
      && body.length <= MAX_BUFFER_BYTES
      && contentTypeIsCompressible(res.getHeader('content-type'))

    const finish = (output: Buffer, contentEncoding: ContentEncoding | null) => {
      if (released) return
      released = true

      if (contentEncoding) {
        res.setHeader('Content-Encoding', contentEncoding)
        appendVary(res, 'Accept-Encoding')
        weakenEtag(res)
        res.removeHeader('Accept-Ranges')
      }
      res.removeHeader('Transfer-Encoding')
      res.setHeader('Content-Length', String(output.length))
      restore()

      const done = () => {
        flushWriteCallbacks()
        callback?.()
      }
      originalEnd(output, done)
    }

    if (!shouldCompress) {
      finish(body, null)
      return res
    }

    compressWithFallback(body, encodings, (contentEncoding, compressed) => {
      finish(compressed, contentEncoding)
    })
    return res
  }
  res.end = bufferedEnd as typeof res.end
}

export function apply(ctx: Context): void {
  const server: unknown = Reflect.get(ctx.webServer, 'server')
  if (!(server instanceof HttpServer)) {
    throw new Error('dsh-http-gzip requires an initialized WebServer')
  }

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'HEAD' || req.method === 'CONNECT') return
    if (req.headers.range || req.headers.upgrade) return
    if (String(req.headers.accept ?? '').toLowerCase().includes('text/event-stream')) return

    const encodings = acceptedEncodings(req.headers['accept-encoding'])
    if (encodings.length === 0) return
    bufferResponse(res, encodings)
  }

  server.prependListener('request', onRequest)
  ctx.effect(() => () => server.removeListener('request', onRequest), name)
  ctx.logger.info(`[${name}] br/zstd/gzip enabled for compressible web responses`)
}
