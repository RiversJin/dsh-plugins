import assert from 'node:assert/strict'
import test from 'node:test'

import { filterCheckpointRows } from '../lib/index.js'

const row = value => ({ ver: 1, seq: 3, val: value })

test('filters selected heavy projections without mutating the source', () => {
  const source = {
    contextHeaders: row({ headers: ['large'] }),
    contextTimeline: row({ surface: ['large'] }),
    sessionStats: row({ turns: 4 }),
    title: row('kept'),
  }

  const filtered = filterCheckpointRows(
    source,
    new Set(['contextHeaders', 'contextTimeline']),
  )

  assert.deepEqual(Object.keys(filtered), ['sessionStats', 'title'])
  assert.equal(filtered.sessionStats, source.sessionStats)
  assert.equal(Object.hasOwn(source, 'contextHeaders'), true)
  assert.equal(Object.hasOwn(source, 'contextTimeline'), true)
})

test('preserves every row when the exclusion set is empty', () => {
  const source = { title: row('kept') }
  assert.deepEqual(filterCheckpointRows(source, new Set()), source)
})
