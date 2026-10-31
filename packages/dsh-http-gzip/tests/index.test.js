import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, get } from 'node:http'
import { once } from 'node:events'
import { brotliDecompressSync, zstdDecompressSync, gunzipSync } from 'node:zlib'
import {
  acceptedEncodings,
  contentTypeIsCompressible,
  apply,
} from '../lib/index.js'

test('real HTTP responses decode identically and SSE reaches the client before end', async () => {
  const body = 'native DSH compression acceptance\n'.repeat(200)
  let releaseStream
  const server = createServer((req, res) => {
    if (req.url === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: first\n\n')
      releaseStream = () => res.end('data: last\n\n')
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"fixture"' })
      res.end(body)
    }
  })
  let cleanup
  apply({ webServer: { server }, effect: callback => { cleanup = callback() }, logger: { info() {} } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  try {
    for (const [encoding, decode] of [['br', brotliDecompressSync], ['zstd', zstdDecompressSync], ['gzip', gunzipSync]]) {
      const response = await new Promise((resolve, reject) => get({ host: '127.0.0.1', port, headers: { 'Accept-Encoding': encoding } }, resolve).on('error', reject))
      const chunks = []; for await (const chunk of response) chunks.push(chunk)
      assert.equal(response.headers['content-encoding'], encoding)
      assert.equal(decode(Buffer.concat(chunks)).toString(), body)
      assert.equal(response.headers.etag, 'W/"fixture"')
    }
    const response = await new Promise((resolve, reject) => get({ host: '127.0.0.1', port, path: '/stream', headers: { 'Accept-Encoding': 'gzip' } }, resolve).on('error', reject))
    assert.equal(response.headers['content-encoding'], undefined)
    const [chunk] = await once(response, 'data', { signal: AbortSignal.timeout(2000) })
    assert.equal(chunk.toString(), 'data: first\n\n')
    const ended = once(response, 'end'); response.resume(); releaseStream(); await ended
  } finally { releaseStream?.(); cleanup(); server.closeAllConnections(); server.close() }
})

test('encoding negotiation respects quality and stable preference order', () => {
  assert.deepEqual(
    acceptedEncodings('gzip;q=0.8, zstd;q=1, br;q=1').map(({ name, quality }) => ({ name, quality })),
    [
      { name: 'br', quality: 1 },
      { name: 'zstd', quality: 1 },
      { name: 'gzip', quality: 0.8 },
    ],
  )
})

test('encoding negotiation applies wildcard and rejects disabled encodings', () => {
  assert.deepEqual(
    acceptedEncodings('*;q=0.4, br;q=0').map(({ name }) => name),
    ['zstd', 'gzip'],
  )
  assert.deepEqual(acceptedEncodings('br;q=2, gzip;q=0'), [])
  assert.deepEqual(acceptedEncodings(undefined), [])
})

test('compressible content types include text and structured suffixes', () => {
  assert.equal(contentTypeIsCompressible('text/plain; charset=utf-8'), true)
  assert.equal(contentTypeIsCompressible('application/problem+json'), true)
  assert.equal(contentTypeIsCompressible('image/svg+xml'), true)
})

test('streaming and opaque binary content types bypass compression', () => {
  assert.equal(contentTypeIsCompressible('text/event-stream'), false)
  assert.equal(contentTypeIsCompressible('image/png'), false)
  assert.equal(contentTypeIsCompressible(undefined), false)
})
