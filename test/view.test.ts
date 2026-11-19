import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nextResult, pendingResult } from '../src/logic.ts'
import { footerText, rowsOf, rowView } from '../src/view.ts'

const target = { name: 'staging', url: 'https://staging.example/health' }
const down = [null, null].reduce(
  previous => nextResult(previous, target, { status: 503, ms: 30, body: '{"checks":{"database":"down"}}', error: null }, 60_000),
  nextResult(undefined, target, { status: 200, ms: 120, body: '{}', error: null }, 0),
)

test('a panel row shows state, since, reason with latency, sparkline and URL', () => {
  assert.deepEqual(rowView(down), {
    key: 'staging',
    name: 'staging',
    health: 'down',
    icon: '✗',
    tone: 'danger',
    since: 60_000,
    detail: '503 · database · 30 ms',
    spark: '█××',
    url: 'https://staging.example/health',
  })
})

test('a pending row has no since and says it was not checked yet', () => {
  const row = rowView(pendingResult(target, 5))
  assert.equal(row.since, null)
  assert.equal(row.detail, 'not checked yet')
  assert.equal(row.spark, '')
  assert.equal(row.tone, 'neutral')
})

test('rows follow the snapshot order and the footer names the interval', () => {
  const snapshot = { isOff: false, pollMs: 60_000, checkedAt: 1, deployments: [down, pendingResult({ name: 'prod', url: 'x' }, 0)] }
  assert.deepEqual(rowsOf(snapshot).map(row => row.name), ['staging', 'prod'])
  assert.equal(footerText(snapshot), 'every 60 s')
})
