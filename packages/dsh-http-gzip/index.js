import {
  brotliCompress,
  constants,
  gzip,
  zstdCompress,
} from 'node:zlib'

export const name = 'dsh-http-gzip'
export const inject = ['webServer']

const MIN_BYTES = 1024
const MAX_BUFFER_BYTES = 1024 * 1024 * 1024

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

const ENCODINGS = [
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

function acceptedEncodings(value) {
  if (typeof value !== 'string') return []

  const qualities = new Map()
  for (const part of value.split(',')) {
    const [rawName, ...parameters] = part.trim().split(';')
    const name = rawName.trim().toLowerCase()
    if (!name) continue

    let quality = 1
    const qualityParameter = parameters
      .map((parameter) => parameter.trim().match(/^q\s*=\s*(\d*(?:\.\d+)?)$/i))
      .find(Boolean)
    if (qualityParameter) quality = Number(qualityParameter[1])
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

function compressWithFallback(body, encodings, callback, index = 0) {
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

function toBuffer(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  return Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined)
}

function appendVary(res, value) {
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

function contentTypeIsCompressible(value) {
  const contentType = String(value ?? '').split(';', 1)[0].trim().toLowerCase()
  if (!contentType || contentType === 'text/event-stream') return false
  if (contentType.startsWith('text/')) return true
  if (contentType.endsWith('+json') || contentType.endsWith('+xml')) return true
  return COMPRESSIBLE_APPLICATION_TYPES.includes(contentType)
}

function responseMustBypass(res) {
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

function weakenEtag(res) {
  const etag = res.getHeader('etag')
  if (typeof etag === 'string' && etag.length > 0 && !etag.startsWith('W/')) {
    res.setHeader('ETag', `W/${etag}`)
  }
}

function applyDeferredHead(res, statusCode, statusMessageOrHeaders, maybeHeaders) {
  res.statusCode = statusCode

  let headers = statusMessageOrHeaders
  if (typeof statusMessageOrHeaders === 'string') {
    res.statusMessage = statusMessageOrHeaders
    headers = maybeHeaders
  }

  if (Array.isArray(headers)) {
    for (let index = 0; index + 1 < headers.length; index += 2) {
      res.setHeader(headers[index], headers[index + 1])
    }
  } else if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) res.setHeader(key, value)
    }
  }
}

function bufferResponse(res, encodings) {
  const originalWrite = res.write.bind(res)
  const originalEnd = res.end.bind(res)
  const originalWriteHead = res.writeHead.bind(res)
  const originalFlushHeaders = res.flushHeaders.bind(res)
  const chunks = []
  const writeCallbacks = []
  let bufferedBytes = 0
  let released = false
  let ending = false

  const restore = () => {
    res.write = originalWrite
    res.end = originalEnd
    res.writeHead = originalWriteHead
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

  res.writeHead = function deferredWriteHead(statusCode, statusMessageOrHeaders, maybeHeaders) {
    applyDeferredHead(res, statusCode, statusMessageOrHeaders, maybeHeaders)
    if (responseMustBypass(res)) {
      releaseUncompressed()
      if (!res.headersSent) return originalWriteHead(res.statusCode, res.statusMessage)
    }
    return res
  }

  res.write = function bufferedWrite(chunk, encoding, callback) {
    if (released) return originalWrite(chunk, encoding, callback)

    if (typeof encoding === 'function') {
      callback = encoding
      encoding = undefined
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

  res.flushHeaders = function uncompressedFlushHeaders() {
    releaseUncompressed()
    if (!res.headersSent) return originalFlushHeaders()
  }

  res.end = function bufferedEnd(chunk, encoding, callback) {
    if (released) return originalEnd(chunk, encoding, callback)
    if (ending) return res
    ending = true

    if (typeof chunk === 'function') {
      callback = chunk
      chunk = undefined
      encoding = undefined
    } else if (typeof encoding === 'function') {
      callback = encoding
      encoding = undefined
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

    const finish = (output, contentEncoding) => {
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

      const done = (...args) => {
        flushWriteCallbacks()
        if (typeof callback === 'function') callback(...args)
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
}

export function apply(ctx) {
  const server = ctx.webServer?.server
  if (!server || typeof server.prependListener !== 'function') {
    throw new Error('dsh-http-gzip requires an initialized WebServer')
  }

  const onRequest = (req, res) => {
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
