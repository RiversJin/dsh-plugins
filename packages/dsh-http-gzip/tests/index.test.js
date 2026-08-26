import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  acceptedEncodings,
  contentTypeIsCompressible,
} from '../lib/index.js'

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

